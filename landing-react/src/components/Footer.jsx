import { footer } from '../data/content';
import './Footer.css';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-logo">GOLDEX AI</div>
      <div className="footer-tagline">{footer.tagline}</div>
      <div className="footer-links">
        {footer.links.map((l) => <a href="#" key={l}>{l}</a>)}
      </div>
      <div className="footer-disclaimer">{footer.disclaimer}</div>
    </footer>
  );
}
