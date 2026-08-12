import { useEffect, useState } from 'react';

// Ticks down to a fixed target time (2h47m30s from first mount, persisted
// in sessionStorage so it doesn't reset on every re-render/navigation).
function getTarget() {
  const key = 'goldex_countdown_target';
  let target = sessionStorage.getItem(key);
  if (!target) {
    target = Date.now() + (2 * 3600 + 47 * 60 + 30) * 1000;
    sessionStorage.setItem(key, String(target));
  }
  return Number(target);
}

function pad(n) { return String(Math.max(0, n)).padStart(2, '0'); }

export default function Countdown() {
  const [target] = useState(getTarget);
  const [left, setLeft] = useState(() => Math.max(0, target - Date.now()));

  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, target - Date.now())), 1000);
    return () => clearInterval(id);
  }, [target]);

  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  const s = Math.floor((left % 60000) / 1000);

  return (
    <div className="countdown">
      <div className="count-unit"><span className="count-num">{pad(h)}</span><span className="count-lbl">JAM</span></div>
      <div className="count-sep">:</div>
      <div className="count-unit"><span className="count-num">{pad(m)}</span><span className="count-lbl">MNT</span></div>
      <div className="count-sep">:</div>
      <div className="count-unit"><span className="count-num">{pad(s)}</span><span className="count-lbl">DTK</span></div>
    </div>
  );
}
