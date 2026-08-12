import { trackRecord, checkoutUrl } from '../data/content';
import { CountUp } from './CountUp';
import { Reveal, RevealGroup, RevealItem } from './Reveal';
import DashboardPreview from './DashboardPreview';
import './TrackRecord.css';

export default function TrackRecord() {
  return (
    <section id="track-record" className="track-section band">
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{trackRecord.eyebrow}</p>
          <h2 className="section-title">{trackRecord.title}</h2>
          <p className="section-sub">{trackRecord.sub}</p>
        </Reveal>

        <RevealGroup className="stats-bar">
          {trackRecord.stats.map((s) => (
            <RevealItem className="stats-bar-item" key={s.lbl}>
              <span className={`stats-bar-num${s.color ? ` stats-bar-num--${s.color}` : ''}`}>
                {s.isText ? s.num : <CountUp value={s.num} prefix={s.prefix} suffix={s.suffix} />}
              </span>
              <span className="stats-bar-lbl">{s.lbl}</span>
            </RevealItem>
          ))}
        </RevealGroup>

        <Reveal className="weekly-block">
          <div className="block-label">📅 WEEKLY SUMMARY</div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Week</th><th>Period</th><th>Total Trades</th><th>WIN</th><th>LOSS</th><th>Win Rate</th><th>Net P/L</th></tr>
              </thead>
              <tbody>
                {trackRecord.weekly.map((row) => (
                  <tr key={row[0]}>
                    <td className="cell-gold">{row[0]}</td>
                    <td>{row[1]}</td>
                    <td>{row[2]}</td>
                    <td className="cell-pos">{row[3]}</td>
                    <td className="cell-neg">{row[4]}</td>
                    <td className="cell-green">{row[5]}</td>
                    <td className="cell-pos">{row[6]}</td>
                  </tr>
                ))}
                <tr className="row-total">
                  <td className="cell-gold" colSpan={2}>{trackRecord.weeklyTotal[0]}</td>
                  <td style={{ fontWeight: 700 }}>{trackRecord.weeklyTotal[1]}</td>
                  <td className="cell-green" style={{ fontWeight: 700 }}>{trackRecord.weeklyTotal[2]}</td>
                  <td className="cell-neg" style={{ fontWeight: 700 }}>{trackRecord.weeklyTotal[3]}</td>
                  <td className="cell-green" style={{ fontWeight: 700 }}>{trackRecord.weeklyTotal[4]}</td>
                  <td className="cell-green" style={{ fontWeight: 700 }}>{trackRecord.weeklyTotal[5]}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Reveal>

        <Reveal className="preview-block" delay={0.05}>
          <div className="block-label">📊 DASHBOARD PREVIEW — XAU/USD AI TERMINAL</div>
          <DashboardPreview />
          <div className="preview-note">* Preview of actual dashboard received by GOLDEX AI members</div>
        </Reveal>

        <Reveal className="table-wrap" delay={0.1}>
          <table className="data-table">
            <thead>
              <tr><th>Date & Time</th><th>Direction</th><th>Entry</th><th>Exit</th><th>Points</th><th>P/L</th><th>Status</th></tr>
            </thead>
            <tbody>
              {trackRecord.trades.map((t, i) => (
                <tr key={i}>
                  <td>{t[0]}</td>
                  <td className={t[1] === 'BUY' ? 'cell-green' : 'cell-neg'}>{t[1]}</td>
                  <td>{t[2]}</td>
                  <td>{t[3]}</td>
                  <td className={t[4].startsWith('+') ? 'cell-pos' : 'cell-neg'}>{t[4]}</td>
                  <td className={t[5].startsWith('+') ? 'cell-pos' : 'cell-neg'}>{t[5]}</td>
                  <td><span className={t[6] === 'WIN' ? 'badge badge-win' : 'badge badge-loss'}>{t[6]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
        <p className="table-note">{trackRecord.disclaimer}</p>

        <Reveal className="track-cta-wrap" delay={0.1}>
          <a href={checkoutUrl} className="btn btn-primary">{trackRecord.cta}</a>
          <div className="track-cta-note">{trackRecord.slotsNote}</div>
        </Reveal>
      </div>
    </section>
  );
}
