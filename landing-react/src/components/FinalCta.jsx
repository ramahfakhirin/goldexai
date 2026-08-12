import { finalCta, checkoutUrl } from '../data/content';
import { Reveal } from './Reveal';
import './FinalCta.css';

function renderRich(parts) {
  return parts.map((p, i) => {
    if (typeof p === 'string') return <span key={i}>{p}</span>;
    if (p?.strong) return <strong key={i}>{p.strong}</strong>;
    return p;
  });
}

export default function FinalCta() {
  return (
    <section className="payment-section band" id="order">
      <div className="container">
        <Reveal className="final-head">
          <p className="final-eyebrow">{finalCta.eyebrow}</p>
          <h2 className="final-title">{renderRich(finalCta.title)}</h2>
          <p className="final-sub">{renderRich(finalCta.sub)}</p>
        </Reveal>

        <Reveal className="checkout-wrap" delay={0.1}>
          <div className="checkout-icon">💳</div>
          <div className="checkout-title">{finalCta.checkoutTitle}</div>
          <div className="checkout-sub">{finalCta.checkoutSub}</div>

          <div className="price-banner">
            <div>
              <div className="price-banner-name">{finalCta.priceName}</div>
              <div className="price-banner-sub">{finalCta.priceSub}</div>
            </div>
            <div className="price-banner-right">
              <div className="price-banner-old">{finalCta.priceOld}</div>
              <div className="price-banner-new">{finalCta.priceNew}</div>
            </div>
          </div>

          <div className="what-you-get">
            <div className="wyg-title">Yang kamu dapatkan:</div>
            {finalCta.whatYouGet.map((g) => <div key={g}>✓ {g}</div>)}
          </div>

          <a href={checkoutUrl} className="checkout-btn">{finalCta.checkoutBtn}</a>
          <div className="secure-note">{finalCta.secureNote}</div>
        </Reveal>

        <Reveal className="trust-row" delay={0.15}>
          {finalCta.trust.map((t) => <div key={t}>{t}</div>)}
          <div>✓ <span>37</span> dari 50 slot tersisa</div>
        </Reveal>
      </div>
    </section>
  );
}
