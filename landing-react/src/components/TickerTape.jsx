import { ticker } from '../data/content';
import './TickerTape.css';

function Item({ t }) {
  return (
    <div className="tick-item">
      <span className="tick-sym">{t.sym}</span>
      <span className="tick-price">{t.price}</span>
      <span className={`tick-chg tick-chg--${t.dir}`}>{t.chg}</span>
    </div>
  );
}

export default function TickerTape() {
  const loop = [...ticker, ...ticker, ...ticker];
  return (
    <div className="tick-tape">
      <div className="tick-inner">
        {loop.map((t, i) => <Item key={i} t={t} />)}
      </div>
    </div>
  );
}
