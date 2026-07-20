import { execFileSync } from "child_process";
import dotenv from "dotenv";

dotenv.config();

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

class BridgeDB {
  private runBridge(action: string, ...args: any[]): any {
    try {
      const stringArgs = args.map((arg) =>
        typeof arg === "object" ? JSON.stringify(arg) : String(arg)
      );
      const stdout = execFileSync("python3", ["src/db_bridge.py", action, ...stringArgs], {
        encoding: "utf-8",
        env: process.env,
      });
      return JSON.parse(stdout.trim());
    } catch (err: any) {
      console.error(`[DB Bridge Error] Action: ${action}, args: ${JSON.stringify(args)}`, err.message);
      
      // Safe fallbacks for read operations
      if (action.startsWith("get_") || action.includes("get")) {
        if (action === "get_users") return [];
        if (action === "get_stats") return { total: 0, buy: 0, sell: 0, wait: 0, avg_confidence: 0 };
        if (action === "get_active_monitors") return [];
        if (action === "get_monitors") return [];
        if (action === "get_trade_history") return [];
        if (action === "get_performance_stats") {
          return {
            total: 0, wins: 0, losses: 0, win_rate: 0,
            total_pips: 0, total_pnl: 0, avg_pips: 0, avg_pnl: 0,
            best: 0, worst: 0, tp1_hits: 0, tp2_hits: 0, tp3_hits: 0,
            gross_profit: 0, gross_loss: 0, profit_factor: 0,
            be_count: 0, sl_count: 0, lot_size: 0.10, pnl_mult: 10, period_days: 7
          };
        }
      }
      return null;
    }
  }

  // Config helpers
  public configGet(key: string, defaultValue: string = ""): string {
    return this.runBridge("config_get", key, defaultValue);
  }

  public configSet(key: string, value: any): void {
    this.runBridge("config_set", key, value);
  }

  // User CRUD
  public getUsers(): User[] {
    return this.runBridge("get_users") || [];
  }

  public getUserByCredentials(username: string, passHash: string): User | undefined {
    const res = this.runBridge("get_user_by_credentials", username, passHash);
    return res ? res : undefined;
  }

  public createUser(user: Omit<User, "id" | "created_at">): User {
    return this.runBridge("create_user", user);
  }

  public updateUser(id: number, updates: Partial<User>): boolean {
    return !!this.runBridge("update_user", id, updates);
  }

  public deleteUser(id: number): boolean {
    return !!this.runBridge("delete_user", id);
  }

  // Signals CRUD
  public saveSignal(signalData: any, timeframe: string, price: number): number {
    return this.runBridge("save_signal", signalData, timeframe, price);
  }

  public getHistory(limit: number = 50): Signal[] {
    return this.runBridge("get_history", limit) || [];
  }

  public clearHistory(): void {
    this.runBridge("clear_history");
  }

  public getStats(): any {
    return this.runBridge("get_stats") || { total: 0, buy: 0, sell: 0, wait: 0, avg_confidence: 0 };
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
    return this.runBridge("create_trade_monitor", signalId, direction, entry, sl, tp1, tp2, tp3, timeframe);
  }

  public getActiveMonitors(): TradeMonitor[] {
    return this.runBridge("get_active_monitors") || [];
  }

  public getMonitors(): TradeMonitor[] {
    return this.runBridge("get_monitors") || [];
  }

  public updateMonitor(id: number, updates: Partial<TradeMonitor>): boolean {
    return !!this.runBridge("update_monitor", id, updates);
  }

  public updateMonitorOutcome(
    monitorId: number,
    outcome: string,
    outcomePrice: number,
    pnlPips: number,
    tpHit: number = 0
  ): boolean {
    return !!this.runBridge("update_monitor_outcome", monitorId, outcome, outcomePrice, pnlPips, tpHit);
  }

  public hasActiveMonitor(direction?: string): boolean {
    return !!this.runBridge("has_active_monitor", direction || "None");
  }

  public isDirectionBlocked(direction: string): { blocked: boolean; text: string } {
    return this.runBridge("is_direction_blocked", direction) || { blocked: false, text: "" };
  }

  public getTradeHistory(limit: number = 30): any[] {
    return this.runBridge("get_trade_history", limit) || [];
  }

  public getPerformanceStats(days: number = 7): any {
    return this.runBridge("get_performance_stats", days);
  }
}

export const db = new BridgeDB();
