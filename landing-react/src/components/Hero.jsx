import { motion } from 'framer-motion';
import { hero, checkoutUrl } from '../data/content';
import LiveCandles from './LiveCandles';
import './Hero.css';

const fadeUp = {
  hidden: { opacity: 0, y: 26 },
  show: (i = 0) => ({
    opacity: 1, y: 0,
    transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.08 * i },
  }),
};

function renderRich(parts) {
  return parts.map((p, i) => {
    if (typeof p === 'string') return <span key={i}>{p}</span>;
    if (p?.em) return <em key={i}>{p.em}</em>;
    return p;
  });
}

export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="hero-glow" aria-hidden="true" />

      <motion.div className="hero-eyebrow" custom={0} initial="hidden" animate="show" variants={fadeUp}>
        <span className="hero-dot" />
        {hero.eyebrow}
      </motion.div>

      <motion.h1 custom={1} initial="hidden" animate="show" variants={fadeUp}>
        {renderRich(hero.h1)}
      </motion.h1>

      <motion.p className="hero-sub" custom={2} initial="hidden" animate="show" variants={fadeUp}>
        {hero.sub}
      </motion.p>

      <motion.div className="hero-stats" custom={3} initial="hidden" animate="show" variants={fadeUp}>
        {hero.stats.map((s) => (
          <div className="hero-stat" key={s.lbl}>
            <span className="hero-stat-num">{s.num}</span>
            <span className="hero-stat-lbl">{s.lbl}</span>
          </div>
        ))}
      </motion.div>

      <motion.div className="hero-ctas" custom={4} initial="hidden" animate="show" variants={fadeUp}>
        <a href={checkoutUrl} className="btn btn-primary">{hero.ctaPrimary}</a>
        <a href="#cara-kerja" className="btn btn-secondary">{hero.ctaSecondary}</a>
      </motion.div>

      <motion.div
        className="terminal"
        initial={{ opacity: 0, y: 40, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.5 }}
      >
        <div className="terminal-header">
          <div className="terminal-pair">XAU/USD <span>M1 · Gold Spot</span></div>
          <div className="terminal-live"><span className="hero-dot" /> MEMINDAI LIVE</div>
        </div>
        <div className="terminal-price-row">
          <div className="terminal-price">4,198.50</div>
          <div className="terminal-chg">+$34.20 (+0.82%)</div>
        </div>
        <div className="terminal-source">● MT5 Live · via FBS bridge</div>
        <LiveCandles />
        <div className="terminal-signal">
          <span>BERKAH SIGNAL ENGINE</span>
          <span className="terminal-signal-val">● SCANNING · ADX 23.4 · BoS TERDETEKSI</span>
        </div>
      </motion.div>
    </section>
  );
}
