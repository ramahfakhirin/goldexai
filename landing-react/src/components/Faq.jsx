import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { faq, checkoutUrl } from '../data/content';
import { Reveal, RevealGroup, RevealItem } from './Reveal';
import './Faq.css';

function FaqRow({ item, open, onToggle }) {
  return (
    <div className={`faq-item${open ? ' faq-item--open' : ''}`}>
      <button className="faq-q" onClick={onToggle} aria-expanded={open}>
        <span>{item.q}</span>
        <motion.span className="faq-icon" animate={{ rotate: open ? 45 : 0 }} transition={{ duration: 0.2 }}>+</motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="faq-a-wrap"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            <p className="faq-a">{item.a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Faq() {
  const [openIdx, setOpenIdx] = useState(0);

  return (
    <section id="faq">
      <div className="container">
        <Reveal className="section-head">
          <p className="eyebrow">{faq.eyebrow}</p>
          <h2 className="section-title">{faq.title}</h2>
        </Reveal>

        <RevealGroup className="faq-list">
          {faq.items.map((item, i) => (
            <RevealItem key={item.q}>
              <FaqRow item={item} open={openIdx === i} onToggle={() => setOpenIdx(openIdx === i ? -1 : i)} />
            </RevealItem>
          ))}
        </RevealGroup>

        <Reveal className="faq-cta-wrap" delay={0.1}>
          <a href={checkoutUrl} className="btn btn-primary">{faq.cta}</a>
          <div className="faq-cta-sub">{faq.ctaSub}</div>
        </Reveal>
      </div>
    </section>
  );
}
