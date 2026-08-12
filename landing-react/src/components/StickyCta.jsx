import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { pricing, checkoutUrl } from '../data/content';
import './StickyCta.css';

export default function StickyCta() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const pastHero = window.scrollY > window.innerHeight * 0.9;
      const nearBottom = window.scrollY + window.innerHeight > document.body.scrollHeight - 200;
      setShow(pastHero && !nearBottom);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="sticky-cta"
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="sticky-cta-info">
            <div className="sticky-cta-price"><s>{pricing.priceOld}</s>{pricing.priceNew}</div>
            <div className="sticky-cta-sub">Founding Member · {pricing.slotsLeft}/{pricing.slotsTotal} slot tersisa</div>
          </div>
          <a href={checkoutUrl} className="sticky-cta-btn">Dapatkan Akses →</a>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
