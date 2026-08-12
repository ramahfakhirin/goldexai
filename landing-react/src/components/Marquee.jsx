import { marquee } from '../data/content';
import './Marquee.css';

export default function Marquee() {
  const loop = [...marquee, ...marquee];
  return (
    <div className="marquee">
      <div className="marquee-inner">
        {loop.map((m, i) => <span className="marquee-item" key={i}>{m}</span>)}
      </div>
    </div>
  );
}
