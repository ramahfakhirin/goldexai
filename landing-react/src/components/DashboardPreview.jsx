import './DashboardPreview.css';

export default function DashboardPreview() {
  return (
    <div className="dp-shell">
      <div className="dp-topbar">
        <div className="dp-topbar-left">
          <span className="dp-pair">● XAU/USD</span>
          <span className="dp-terminal-lbl">AI TERMINAL</span>
          <span className="dp-live-badge">● LIVE</span>
        </div>
        <div className="dp-topbar-right">
          <span className="dp-clock">22:47:13</span>
          <span className="dp-price">$4,203.18</span>
          <span className="dp-source-badge">MT5 Live</span>
        </div>
      </div>

      <div className="dp-tabs">
        <div className="dp-tab dp-tab--active">📊 Signal & Analysis</div>
        <div className="dp-tab">📰 News & Sentiment</div>
      </div>

      <div className="dp-grid">
        <div className="dp-col dp-col--left">
          <div className="dp-card">
            <div className="dp-card-label">SERVER SCHEDULER</div>
            <div className="dp-scheduler-row"><span className="dp-status-dot" />Scheduler active — 22:48:00</div>
            <div className="dp-row"><span>Timeframe</span><span className="dp-val">1M</span></div>
            <div className="dp-row"><span>Interval</span><span className="dp-val">1 min</span></div>
          </div>
          <div className="dp-card">
            <div className="dp-card-label">SIGNAL STATS</div>
            <div className="dp-mini-stats">
              <div><div className="dp-mini-num">30</div><div className="dp-mini-lbl">Total</div></div>
              <div><div className="dp-mini-num" style={{ color: 'var(--green)' }}>27</div><div className="dp-mini-lbl">BUY+SELL</div></div>
            </div>
            <div className="dp-row"><span>Avg Confidence</span><span style={{ color: 'var(--gold)' }}>78%</span></div>
          </div>
        </div>

        <div className="dp-col dp-col--center">
          <div className="dp-signal-card">
            <div className="dp-signal-corner">● Berkah Signal Active</div>
            <div className="dp-signal-header">
              <div>
                <div className="dp-signal-badge">BUY</div>
                <div className="dp-signal-time">22/06/2026, 22:47:13</div>
              </div>
              <div className="dp-signal-price-wrap">
                <div className="dp-signal-price-lbl">PRICE</div>
                <div className="dp-signal-price">$4,203.18</div>
                <div className="dp-signal-price-src">● MT5 Live · 1M</div>
              </div>
              <div className="dp-conf-wrap">
                <div className="dp-signal-price-lbl">CONF</div>
                <svg viewBox="0 0 64 64" className="dp-conf-ring">
                  <circle cx="32" cy="32" r="28" fill="none" stroke="#1E2433" strokeWidth="6" />
                  <circle cx="32" cy="32" r="28" fill="none" stroke="#26C17E" strokeWidth="6"
                    strokeDasharray="175.9" strokeDashoffset="17.6" strokeLinecap="round" />
                </svg>
                <div className="dp-conf-val">90%</div>
              </div>
            </div>
            <div className="dp-sltp-grid">
              <div className="dp-sltp dp-sltp--green"><div className="dp-sltp-lbl">ENTRY ZONE</div><div className="dp-sltp-val">4,201.80–4,203.50</div></div>
              <div className="dp-sltp dp-sltp--red"><div className="dp-sltp-lbl">STOP LOSS</div><div className="dp-sltp-val" style={{ color: 'var(--red)' }}>4,197.20</div></div>
              <div className="dp-sltp dp-sltp--green"><div className="dp-sltp-lbl">TP 1</div><div className="dp-sltp-val">4,208.40</div></div>
              <div className="dp-sltp dp-sltp--green"><div className="dp-sltp-lbl">TP 2</div><div className="dp-sltp-val">4,211.60</div></div>
              <div className="dp-sltp dp-sltp--green"><div className="dp-sltp-lbl">TP 3</div><div className="dp-sltp-val">4,216.30</div></div>
              <div className="dp-sltp dp-sltp--gold"><div className="dp-sltp-lbl">RISK/REWARD</div><div className="dp-sltp-val" style={{ color: 'var(--gold)' }}>1:1.0</div></div>
            </div>
          </div>
          <div className="dp-card">
            <div className="dp-card-label">AI ANALYSIS — gemini-3.5-flash</div>
            <div className="dp-ai-text">
              Bullish BoS confirmed at 4,199 following liquidity sweep at 4,197. Bullish pin bar + ADX 26.3 shows strong momentum in NY session.{' '}
              <span style={{ color: 'var(--text)' }}>Critical level: maintain position above 4,197 for invalidation — if broken, exit immediately.</span>
            </div>
          </div>
        </div>

        <div className="dp-col dp-col--right">
          <div className="dp-card">
            <div className="dp-card-label">📊 TRADE PERFORMANCE</div>
            <div className="dp-perf-stats">
              <div><div className="dp-perf-num">30</div><div className="dp-mini-lbl">Total</div></div>
              <div><div className="dp-perf-num" style={{ color: 'var(--green)' }}>27</div><div className="dp-mini-lbl">Win</div></div>
              <div><div className="dp-perf-num" style={{ color: 'var(--red)' }}>3</div><div className="dp-mini-lbl">Loss</div></div>
              <div><div className="dp-perf-num" style={{ color: 'var(--gold)' }}>90%</div><div className="dp-mini-lbl">Win Rate</div></div>
            </div>
            <div className="dp-pnl-box">
              <div className="dp-row"><span>Total PnL</span><span style={{ color: 'var(--green)' }}>+$1,847</span></div>
              <div className="dp-row"><span>Avg/Trade</span><span style={{ color: 'var(--green)' }}>+$61.6</span></div>
            </div>
          </div>
          <div className="dp-card">
            <div className="dp-card-label">🔴 LIVE MONITORS</div>
            <div className="dp-monitor-box">
              <div className="dp-row dp-monitor-top"><span style={{ color: 'var(--green)', fontWeight: 600 }}>▲ BUY ACTIVE</span><span style={{ color: 'var(--green)', fontWeight: 600 }}>+$32 live</span></div>
              <div className="dp-monitor-detail">Entry $4,203.18 · SL $4,197.20</div>
              <div className="dp-monitor-detail">TP1 $4,208.40 · TP2 $4,211.60</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
