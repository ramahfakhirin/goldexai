import { motion } from 'framer-motion';
import { howItWorks } from '../data/content';
import { Icon } from './Icons';
import { Reveal, RevealGroup, RevealItem } from './Reveal';
import './HowItWorks.css';

export default function HowItWorks() {
  return (
    <section id="cara-kerja">
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{howItWorks.eyebrow}</p>
          <h2 className="section-title">{howItWorks.title}</h2>
          <p className="section-sub">{howItWorks.sub}</p>
        </Reveal>

        <RevealGroup className="pipeline">
          <div className="pipeline-line" aria-hidden="true" />
          {howItWorks.steps.map((s, i) => (
            <RevealItem className="pipe-step" key={s.title}>
              <div className="pipe-num">{s.num}</div>
              <motion.div className="pipe-icon" whileHover={{ scale: 1.08 }}>
                <Icon name={s.icon} />
              </motion.div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <span className="pipe-badge">{s.badge}</span>
            </RevealItem>
          ))}
        </RevealGroup>

        <Reveal className="signal-example" delay={0.1}>
          <div className="signal-example-label">{howItWorks.signalExample.label}</div>
          <div className="signal-example-header">{howItWorks.signalExample.header}</div>
          <div className="signal-example-rows">
            {howItWorks.signalExample.rows.map(([k, v, color]) => (
              <div className="signal-row" key={k}>
                <span className="signal-row-k">{k} :</span>
                <span className={color ? `signal-row-v signal-row-v--${color}` : 'signal-row-v'}>{v}</span>
              </div>
            ))}
          </div>
          <div className="signal-narrative">📊 <em>{howItWorks.signalExample.narrative}</em></div>
        </Reveal>
      </div>
    </section>
  );
}
