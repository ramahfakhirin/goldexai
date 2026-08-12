import { motion } from 'framer-motion';
import { pricing, checkoutUrl } from '../data/content';
import Countdown from './Countdown';
import { Reveal } from './Reveal';
import './Pricing.css';

export default function Pricing() {
  return (
    <section id="harga" className="pricing-section band">
      <div className="container pricing-container">
        <Reveal className="section-head center">
          <p className="eyebrow">{pricing.eyebrow}</p>
          <h2 className="section-title">{pricing.title}</h2>
          <p className="section-sub">{pricing.sub}</p>
        </Reveal>

        <motion.div
          className="pricing-card"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="pricing-badge">{pricing.badge}</div>
          <div className="pricing-label">GOLDEX AI</div>
          <div className="pricing-name">{pricing.name}</div>
          <div className="pricing-price">
            <span className="pricing-price-old">{pricing.priceOld}</span>
            <span className="pricing-price-new">{pricing.priceNew}</span>
          </div>
          <div className="pricing-period">{pricing.period}</div>
          <div className="pricing-note">{pricing.note}</div>

          <ul className="pricing-features">
            {pricing.features.map((f) => <li key={f}>{f}</li>)}
          </ul>

          <a href={checkoutUrl} className="pricing-btn">{pricing.btn}</a>
          <div className="pricing-slots"><span className="pricing-slots-num">{pricing.slotsLeft}</span> dari {pricing.slotsTotal} slot Founding Member tersisa</div>

          <div className="urgency-bar">
            <div className="urgency-text">Harga naik ke Rp399.000 setelah <span>50 slot terisi</span></div>
            <Countdown />
          </div>
        </motion.div>

        <Reveal className="payment-methods" delay={0.1}>
          <div className="payment-methods-label">Metode pembayaran:</div>
          {pricing.paymentMethods.map((m) => <div className="payment-method" key={m}>{m}</div>)}
        </Reveal>

        <Reveal className="payment-confirm-note" delay={0.15}>
          {pricing.confirmNote}
        </Reveal>
      </div>
    </section>
  );
}
