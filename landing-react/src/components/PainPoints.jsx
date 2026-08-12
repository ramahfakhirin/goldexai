import { motion } from 'framer-motion';
import { painPoints } from '../data/content';
import { Icon } from './Icons';
import { Reveal, RevealGroup, RevealItem } from './Reveal';
import './PainPoints.css';

function renderRich(parts) {
  return parts.map((p, i) => {
    if (typeof p === 'string') return <span key={i}>{p}</span>;
    if (p?.em) return <em key={i}>{p.em}</em>;
    return p;
  });
}

export default function PainPoints() {
  return (
    <section className="pain-section band">
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{painPoints.eyebrow}</p>
          <h2 className="section-title">{painPoints.title}</h2>
          <p className="section-sub">{painPoints.sub}</p>
        </Reveal>

        <RevealGroup className="pain-grid">
          {painPoints.cards.map((c) => (
            <RevealItem className="pain-card" key={c.title}>
              <motion.div className="pain-icon" whileHover={{ scale: 1.08, rotate: -4 }}>
                <Icon name={c.icon} />
              </motion.div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </RevealItem>
          ))}
        </RevealGroup>

        <Reveal className="pain-cta" delay={0.1}>
          {renderRich(painPoints.cta)}
        </Reveal>
      </div>
    </section>
  );
}
