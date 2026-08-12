import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { nav, checkoutUrl } from '../data/content';
import './Nav.css';

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <motion.nav
      className={`nav${scrolled ? ' nav--scrolled' : ''}`}
      initial={{ y: -60 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
    >
      <a href="#top" className="nav-logo">GOLDEX<span> AI</span></a>
      <ul className="nav-links">
        {nav.links.map((l) => (
          <li key={l.href}><a href={l.href}>{l.label}</a></li>
        ))}
        <li><a href="/login" className="nav-login">{nav.login}</a></li>
      </ul>
      <a href={checkoutUrl} className="nav-cta">{nav.cta}</a>
    </motion.nav>
  );
}
