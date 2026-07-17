import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const BASE_DIR = process.cwd();

function resolveDataDir(): string {
  // 1. Check /data
  if (fs.existsSync("/data")) {
    try {
      fs.mkdirSync("/data", { recursive: true });
      const testFile = path.join("/data", `.write_test_${process.pid}`);
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      console.log("[DB] 💾 Using /data (Coolify Persistent Volume)");
      return "/data";
    } catch (e: any) {
      console.log(`[DB] ⚠️ /data exists but is not writable: ${e.message}. Falling back...`);
    }
  }

  // 2. Check RAILWAY_VOLUME_MOUNT_PATH
  const railwayVol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (railwayVol) {
    try {
      const p = path.resolve(railwayVol);
      fs.mkdirSync(p, { recursive: true });
      const testFile = path.join(p, `.write_test_${process.pid}`);
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      console.log(`[DB] 💾 Using Railway Volume: ${railwayVol}`);
      return p;
    } catch (e: any) {
      console.log(`[DB] ⚠️ Railway volume ${railwayVol} is not writable: ${e.message}. Falling back...`);
    }
  }

  // 3. Fallback to local baseDir/data
  const localDir = path.join(BASE_DIR, "data");
  try {
    fs.mkdirSync(localDir, { recursive: true });
    const testFile = path.join(localDir, `.write_test_${process.pid}`);
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
    console.log(`[DB] ⚠️ Using local directory: ${localDir}`);
    return localDir;
  } catch (e: any) {
    // 4. Ultimate fallback to /tmp/data
    const tmpDir = path.join("/tmp", "data");
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log(`[DB] ⚠️ Using /tmp/data directory: ${tmpDir} (Temporary!)`);
    return tmpDir;
  }
}

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, "db.json");

export interface User {
  id: number;
  username: string;
  password_hash: string;
  full_name: string;
  kota: string;
  no_wa: string;
  telegram: string;
  role: string;
  is_active: number;
  created_at: string;
  last_login?: string;
}

export interface Signal {
  id: number;
  timestamp: string;
  timeframe: string;
  price: number;
  signal: string;
  confidence: number;
  bias: string;
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  rr_ratio: string;
  trend: string;
  narrative: string;
  raw_json: string;
}

export interface TradeMonitor {
  id: number;
  signal_id: number;
  timestamp: string;
  timeframe: string;
  direction: string;
  entry_price: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  status: string; // 'ACTIVE' | 'CLOSED'
  outcome?: string; // 'SL_HIT' | 'BE_HIT' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT'
  outcome_price?: number;
  outcome_time?: string;
  closed_at?: string;
  pnl_pips?: number;
  tp_hit?: number;
  created_at?: string;
  realized_pnl?: number;
  be_moved?: number;
  mfe?: number;
  mae?: number;
}

interface DBStructure {
  users: User[];
  signals: Signal[];
  trade_monitors: TradeMonitor[];
  config: Record<string, string>;
}

class InMemoryDB {
  private data: DBStructure = {
    users: [],
    signals: [],
    trade_monitors: [],
    config: {},
  };

  constructor() {
    this.load();
    this.init();
  }

  private load() {
    if (fs.existsSync(DB_PATH)) {
      try {
        const raw = fs.readFileSync(DB_PATH, "utf-8");
        this.data = JSON.parse(raw);
      } catch (e) {
        console.error("[DB] Failed to load JSON database, using empty structures", e);
      }
    }
  }

  public save() {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (e) {
      console.error("[DB] Failed to write database", e);
    }
  }

  private init() {
    // Helper function to seed/update an admin user
    const seedUser = (username: string, pass: string) => {
      const hash = crypto.createHash("sha256").update(pass).digest("hex");
      const existing = this.data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
      if (!existing) {
        this.data.users.push({
          id: this.getNextId("users"),
          username: username,
          password_hash: hash,
          full_name: "Super Admin",
          kota: "Jakarta",
          no_wa: "081234567890",
          telegram: "@admin",
          role: "superadmin",
          is_active: 1,
          created_at: new Date().toISOString(),
        });
        this.save();
        console.log(`[DB] Seeded superadmin '${username}'`);
      } else {
        if (existing.password_hash !== hash || existing.is_active !== 1 || existing.username !== username) {
          existing.username = username;
          existing.password_hash = hash;
          existing.is_active = 1;
          this.save();
          console.log(`[DB] Synchronized password hash / status for superadmin '${username}'`);
        }
      }
    };

    // 1. Seed env admin or default admin ("admin" / "nano2026")
    const adminUser = (process.env.DASHBOARD_USER || "admin").trim();
    const adminPass = (process.env.DASHBOARD_PASS || "nano2026").trim();
    seedUser(adminUser, adminPass);

    // 2. Also seed the user's custom credentials ("xauxau" / "xauberkah99") to ensure immediate compatibility
    seedUser("xauxau", "xauberkah99");
  }

  private getNextId(table: keyof DBStructure): number {
    const list = this.data[table];
    if (Array.isArray(list)) {
      if (list.length === 0) return 1;
      const ids = list.map((item: any) => item.id).filter((id) => typeof id === "number");
      return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }
    return 1;
  }

  // Config helpers
  public configGet(key: string, defaultValue: string = ""): string {
    return this.data.config[key] !== undefined ? this.data.config[key] : defaultValue;
  }

  public configSet(key: string, value: any): void {
    this.data.config[key] = String(value);
    this.save();
  }

  // User CRUD
  public getUsers(): User[] {
    return this.data.users;
  }

  public getUserByCredentials(username: string, passHash: string): User | undefined {
    return this.data.users.find(
      (u) => u.username === username && u.password_hash === passHash && u.is_active === 1
    );
  }

  public createUser(user: Omit<User, "id" | "created_at">): User {
    const newUser: User = {
      ...user,
      id: this.getNextId("users"),
      created_at: new Date().toISOString(),
    };
    this.data.users.push(newUser);
    this.save();
    return newUser;
  }

  public updateUser(id: number, updates: Partial<User>): boolean {
    const idx = this.data.users.findIndex((u) => u.id === id);
    if (idx === -1) return false;
    this.data.users[idx] = { ...this.data.users[idx], ...updates };
    this.save();
    return true;
  }

  public deleteUser(id: number): boolean {
    const idx = this.data.users.findIndex((u) => u.id === id);
    if (idx === -1) return false;
    this.data.users[idx].is_active = 0; // soft delete
    this.save();
    return true;
  }

  // Signals CRUD
  public saveSignal(signalData: any, timeframe: string, price: number): number {
    const rm = signalData.risk_management || {};
    const entry = signalData.entry || {};
    const ms = signalData.market_structure || {};

    const newSignal: Signal = {
      id: this.getNextId("signals"),
      timestamp: new Date().toISOString(),
      timeframe,
      price,
      signal: signalData.signal || "WAIT",
      confidence: signalData.confidence || 0,
      bias: signalData.bias || "NEUTRAL",
      entry: entry.ideal_price || 0,
      stop_loss: rm.stop_loss || 0,
      tp1: rm.take_profit_1 || 0,
      tp2: rm.take_profit_2 || 0,
      tp3: rm.take_profit_3 || 0,
      rr_ratio: rm.risk_reward_ratio || "1:2",
      trend: ms.primary_trend || "RANGING",
      narrative: signalData.narrative || "",
      raw_json: JSON.stringify(signalData),
    };

    this.data.signals.push(newSignal);
    this.save();
    return newSignal.id;
  }

  public getHistory(limit: number = 50): Signal[] {
    return [...this.data.signals].sort((a, b) => b.id - a.id).slice(0, limit);
  }

  public clearHistory(): void {
    this.data.signals = [];
    this.save();
  }

  public getStats(): any {
    const rows = this.data.signals;
    const total = rows.length;
    if (total === 0) {
      return { total: 0, buy: 0, sell: 0, wait: 0, avg_confidence: 0 };
    }

    const buy = rows.filter((r) => r.signal === "BUY").length;
    const sell = rows.filter((r) => r.signal === "SELL").length;
    const wait = rows.filter((r) => r.signal === "WAIT").length;
    const avgConf = rows.reduce((sum, r) => sum + r.confidence, 0) / total;

    return {
      total,
      buy,
      sell,
      wait,
      avg_confidence: Math.round(avgConf * 10) / 10,
    };
  }

  // Trade Monitors CRUD
  public createTradeMonitor(
    signalId: number,
    direction: string,
    entry: number,
    sl: number,
    tp1: number,
    tp2: number,
    tp3: number,
    timeframe: string
  ): number {
    const nowIso = new Date().toISOString();
    const newMonitor: TradeMonitor = {
      id: this.getNextId("trade_monitors"),
      signal_id: signalId,
      timestamp: nowIso,
      created_at: nowIso,
      timeframe,
      direction,
      entry_price: entry,
      stop_loss: sl,
      tp1,
      tp2,
      tp3,
      status: "ACTIVE",
      tp_hit: 0,
      realized_pnl: 0,
      be_moved: 0,
      mfe: 0,
      mae: 0,
    };

    this.data.trade_monitors.push(newMonitor);
    this.save();
    return newMonitor.id;
  }

  public getActiveMonitors(): TradeMonitor[] {
    return this.data.trade_monitors.filter((m) => m.status === "ACTIVE");
  }

  public getMonitors(): TradeMonitor[] {
    return this.data.trade_monitors;
  }

  public updateMonitor(id: number, updates: Partial<TradeMonitor>): boolean {
    const idx = this.data.trade_monitors.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.data.trade_monitors[idx] = { ...this.data.trade_monitors[idx], ...updates };
    this.save();
    return true;
  }

  public updateMonitorOutcome(
    monitorId: number,
    outcome: string,
    outcomePrice: number,
    pnlPips: number,
    tpHit: number = 0
  ): boolean {
    const nowIso = new Date().toISOString();
    return this.updateMonitor(monitorId, {
      status: "CLOSED",
      outcome,
      outcome_price: outcomePrice,
      outcome_time: nowIso,
      closed_at: nowIso,
      pnl_pips: pnlPips,
      tp_hit: tpHit,
    });
  }

  public hasActiveMonitor(direction?: string): boolean {
    if (direction) {
      return this.data.trade_monitors.some((m) => m.status === "ACTIVE" && m.direction === direction);
    }
    return this.data.trade_monitors.some((m) => m.status === "ACTIVE");
  }

  public isDirectionBlocked(direction: string): { blocked: boolean; text: string } {
    const streakN = parseInt(process.env.LOSS_STREAK_COUNT || "2");
    const blockHours = parseFloat(process.env.LOSS_STREAK_BLOCK_HOURS || "3");

    const closed = this.data.trade_monitors
      .filter((m) => m.direction === direction && m.status === "CLOSED")
      .sort((a, b) => b.id - a.id)
      .slice(0, streakN);

    if (closed.length < streakN) return { blocked: false, text: "" };
    if (closed.some((m) => m.outcome !== "SL_HIT")) return { blocked: false, text: "" };

    const lastClosed = closed[0];
    const lastCt = lastClosed.closed_at || lastClosed.outcome_time;
    if (!lastCt) return { blocked: false, text: "" };

    const elapsedMs = Date.now() - new Date(lastCt).getTime();
    const elapsedH = elapsedMs / (1000 * 3600);

    if (elapsedH < blockHours) {
      const remainingH = blockHours - elapsedH;
      return {
        blocked: true,
        text: `${streakN}x SL beruntun arah ${direction}, blokir ${remainingH.toFixed(1)} jam lagi`,
      };
    }

    return { blocked: false, text: "" };
  }

  public getTradeHistory(limit: number = 30): any[] {
    const closed = this.data.trade_monitors
      .filter((m) => m.status === "CLOSED")
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);

    return closed.map((t) => {
      const signal = this.data.signals.find((s) => s.id === t.signal_id);
      return {
        ...t,
        confidence: signal ? signal.confidence : 0,
        narrative: signal ? signal.narrative : "",
      };
    });
  }

  public getPerformanceStats(days: number = 7): any {
    const now = Date.now();
    const closed = this.data.trade_monitors.filter((m) => {
      if (m.status !== "CLOSED") return false;
      if (days === 0) return true;
      const closedTime = m.closed_at || m.outcome_time || m.timestamp;
      const elapsedMs = now - new Date(closedTime).getTime();
      return elapsedMs <= days * 24 * 3600 * 1000;
    });

    const displayLotSize = parseFloat(process.env.DISPLAY_LOT_SIZE || "0.10");
    const pointValuePerLot = 100.0;
    const pnlMult = displayLotSize * pointValuePerLot;

    const money = (pts: number) => Math.round(pts * pnlMult * 100) / 100;

    const total = closed.length;
    if (total === 0) {
      return {
        total: 0,
        wins: 0,
        losses: 0,
        win_rate: 0,
        total_pips: 0,
        total_pnl: 0,
        avg_pips: 0,
        avg_pnl: 0,
        best: 0,
        worst: 0,
        tp1_hits: 0,
        tp2_hits: 0,
        tp3_hits: 0,
        gross_profit: 0,
        gross_loss: 0,
        profit_factor: 0,
        be_count: 0,
        sl_count: 0,
        lot_size: displayLotSize,
        pnl_mult: pnlMult,
        period_days: days,
      };
    }

    const pnlList = closed.map((t) => money(t.pnl_pips || 0));
    const wins = pnlList.filter((v) => v > 0).length;
    const losses = pnlList.filter((v) => v <= 0).length;
    const totalPnl = Math.round(pnlList.reduce((sum, v) => sum + v, 0) * 100) / 100;
    const avgPnl = Math.round((totalPnl / total) * 100) / 100;
    const best = Math.max(...pnlList);
    const worst = Math.min(...pnlList);

    const tp1_hits = closed.filter((t) => (t.tp_hit || 0) >= 1).length;
    const tp2_hits = closed.filter((t) => (t.tp_hit || 0) >= 2).length;
    const tp3_hits = closed.filter((t) => (t.tp_hit || 0) >= 3).length;

    const gross_profit = Math.round(pnlList.filter((v) => v > 0).reduce((sum, v) => sum + v, 0) * 100) / 100;
    const gross_loss = Math.round(Math.abs(pnlList.filter((v) => v < 0).reduce((sum, v) => sum + v, 0)) * 100) / 100;

    let profit_factor = 0;
    if (gross_loss > 0) {
      profit_factor = Math.round((gross_profit / gross_loss) * 100) / 100;
    } else {
      profit_factor = gross_profit > 0 ? gross_profit : 0;
    }

    const be_count = closed.filter((t) => t.outcome === "BE_HIT").length;
    const sl_count = closed.filter((t) => t.outcome === "SL_HIT").length;

    return {
      total,
      wins,
      losses,
      win_rate: Math.round((wins / total) * 1000) / 10,
      total_pips: totalPnl,
      total_pnl: totalPnl,
      avg_pips: avgPnl,
      avg_pnl: avgPnl,
      best,
      worst,
      tp1_hits,
      tp2_hits,
      tp3_hits,
      gross_profit,
      gross_loss,
      profit_factor,
      be_count,
      sl_count,
      lot_size: displayLotSize,
      pnl_mult: pnlMult,
      period_days: days,
    };
  }
}

export const db = new InMemoryDB();
