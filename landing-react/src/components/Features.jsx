import { features } from '../data/content';
import { Icon } from './Icons';
import { Reveal, RevealGroup, RevealItem } from './Reveal';
import './Features.css';

export default function Features() {
  return (
    <section>
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{features.eyebrow}</p>
          <h2 className="section-title">{features.title}</h2>
        </Reveal>

        <RevealGroup className="feat-grid">
          {features.cards.map((c) => (
            <RevealItem
              className={`feat-card${c.featured ? ' feat-card--featured' : ''}`}
              key={c.title}
              whileHover={{ y: -4 }}
            >
              {c.tag && <span className="feat-tag">{c.tag}</span>}
              <div className="feat-icon"><Icon name={c.icon} /></div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  );
}
