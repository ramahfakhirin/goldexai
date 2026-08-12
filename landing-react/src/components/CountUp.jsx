import { useEffect, useRef, useState } from 'react';
import { useInView, animate } from 'framer-motion';

// Animated number counter — counts up from 0 to `value` once it scrolls
// into view. Non-numeric values (e.g. "146W/16L") render as-is.
export function CountUp({ value, prefix = '', suffix = '', duration = 1.4 }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  const [display, setDisplay] = useState('0');
  const isNumeric = typeof value === 'number';

  useEffect(() => {
    if (!inView || !isNumeric) return;
    const controls = animate(0, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate(v) {
        setDisplay(Number.isInteger(value) ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));
      },
    });
    return () => controls.stop();
  }, [inView, isNumeric, value, duration]);

  return (
    <span ref={ref}>
      {prefix}{isNumeric ? display : value}{suffix}
    </span>
  );
}
