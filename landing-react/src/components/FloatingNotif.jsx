import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { socialProof } from '../data/content';
import './FloatingNotif.css';

export default function FloatingNotif() {
  const [idx, setIdx] = useState(-1);

  useEffect(() => {
    let timeout;
    const cycle = (i) => {
      setIdx(i);
      timeout = setTimeout(() => {
        setIdx(-1);
        timeout = setTimeout(() => cycle((i + 1) % socialProof.length), 4000);
      }, 5000);
    };
    timeout = setTimeout(() => cycle(0), 4000);
    return () => clearTimeout(timeout);
  }, []);

  const item = idx >= 0 ? socialProof[idx] : null;

  return (
    <div className="float-notif-slot">
      <AnimatePresence>
        {item && (
          <motion.div
            className="float-notif"
            initial={{ x: -320, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -320, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          >
            <div className="fn-avatar">{item.initial}</div>
            <div className="fn-body">
              <div className="fn-name">{item.name}</div>
              <div className="fn-action">{item.action}</div>
              <div className="fn-badge">GOLDEX AI ✓</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
