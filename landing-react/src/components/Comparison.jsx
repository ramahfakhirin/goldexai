import { comparison } from '../data/content';
import { Reveal } from './Reveal';
import './Comparison.css';

export default function Comparison() {
  return (
    <section className="band">
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{comparison.eyebrow}</p>
          <h2 className="section-title">{comparison.title}</h2>
        </Reveal>

        <Reveal className="comp-wrap" delay={0.1}>
          <table className="comp-table">
            <thead>
              <tr>
                <th>Kriteria</th>
                <th>Sinyal Manual / Mentor</th>
                <th className="comp-highlight">GOLDEX AI</th>
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((r) => (
                <tr key={r[0]}>
                  <td className="comp-crit">{r[0]}</td>
                  <td className={r[1].startsWith('✗') ? 'comp-no' : ''}>{r[1]}</td>
                  <td className={`comp-highlight${r[2].startsWith('✓') ? ' comp-yes' : ''}`}>{r[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>
      </div>
    </section>
  );
}
