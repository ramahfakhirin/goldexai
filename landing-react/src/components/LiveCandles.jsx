import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

// Small animated candlestick strip — purely decorative, re-randomizes
// periodically to sell the "live scanning" feeling in the hero terminal.
function makeCandles(n = 22) {
  return Array.from({ length: n }, () => ({
    h: 18 + Math.random() * 46,
    up: Math.random() > 0.42,
  }));
}

export default function LiveCandles({ count = 22 }) {
  const [candles, setCandles] = useState(() => makeCandles(count));

  useEffect(() => {
    const id = setInterval(() => {
      setCandles((prev) => {
        const next = prev.slice(1);
        next.push({ h: 18 + Math.random() * 46, up: Math.random() > 0.42 });
        return next;
      });
    }, 900);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="live-candles">
      {candles.map((c, i) => (
        <motion.span
          key={i}
          className={`live-candle live-candle--${c.up ? 'up' : 'dn'}`}
          animate={{ height: c.h }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}
