// Hand-authored icon set themed around gold/XAU trading — replaces the
// generic crypto-ICO imagery (event*.webp, brand_img*.png) from the
// reference theme. Single-color stroke icons, inherit currentColor.

const base = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };

export function IconCandle(props) {
  return (
    <svg {...base} {...props}>
      <path d="M6 3v3M6 13v8" /><rect x="3.5" y="6" width="5" height="7" rx="1" />
      <path d="M12 3v2M12 15v6" /><rect x="9.5" y="5" width="5" height="10" rx="1" />
      <path d="M18 3v5M18 17v4" /><rect x="15.5" y="8" width="5" height="9" rx="1" />
    </svg>
  );
}

export function IconTrap(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5h16" /><path d="M4 5l7 8v6l2 1v-7l7-8" />
      <path d="M9 5l3 3.5L15 5" strokeDasharray="1.5 2.2" />
    </svg>
  );
}

export function IconNews(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M7.5 8.5h6M7.5 12h9M7.5 15.5h9" />
      <circle cx="17.5" cy="8.5" r="0" />
    </svg>
  );
}

export function IconPanic(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 17l5-6 4 3 7-9" />
      <path d="M20 5l-4.5.5L20 9.5V5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconClock(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </svg>
  );
}

export function IconTarget(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.7" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconBridge(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 15c2-3 4-4.5 9-4.5s7 1.5 9 4.5" />
      <path d="M3 15v3M8 12.5V18M12 11v7M16 12.5V18M21 15v3" />
    </svg>
  );
}

export function IconScan(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M4 12h16" strokeDasharray="1.6 2.4" />
    </svg>
  );
}

export function IconAI(props) {
  return (
    <svg {...base} {...props}>
      <rect x="5" y="7" width="14" height="11" rx="2.5" />
      <path d="M9 7V4.5M15 7V4.5M9 11.5h.01M15 11.5h.01" />
      <path d="M9 15c1 .8 5 .8 6 0" />
    </svg>
  );
}

export function IconSend(props) {
  return (
    <svg {...base} {...props}>
      <path d="M20.5 3.5L3 10.7l6.4 2.4M20.5 3.5L14.5 21l-5.1-7.9M20.5 3.5L9.4 13.1" />
    </svg>
  );
}

export function IconBolt(props) {
  return (
    <svg {...base} {...props}>
      <path d="M13 3L5 13.5h5.5L11 21l8-10.5h-5.5L13 3z" fill="currentColor" fillOpacity="0.12" />
    </svg>
  );
}

export function IconShield(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5l7 2.8v5.6c0 4.5-3 7.6-7 8.6-4-1-7-4.1-7-8.6V6.3l7-2.8z" />
      <path d="M9 12l2 2 4-4.2" />
    </svg>
  );
}

export function IconBar(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 20L10 4h4l6 16H4z" />
      <path d="M8.5 20l3.5-9 3.5 9" />
    </svg>
  );
}

export function IconChart(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 20h18" />
      <path d="M4 16l4-5 3.5 3L16 8l4 4" />
      <circle cx="20" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconCoin(props) {
  return (
    <svg {...base} {...props}>
      <ellipse cx="12" cy="7" rx="8" ry="3.2" />
      <path d="M4 7v10c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V7" />
      <path d="M4 12.3c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" />
    </svg>
  );
}

const ICONS = {
  candle: IconCandle, trap: IconTrap, news: IconNews, panic: IconPanic,
  clock: IconClock, target: IconTarget, bridge: IconBridge, scan: IconScan,
  ai: IconAI, send: IconSend, bolt: IconBolt, shield: IconShield,
  bar: IconBar, chart: IconChart, coin: IconCoin,
};

export function Icon({ name, ...props }) {
  const Cmp = ICONS[name] || IconChart;
  return <Cmp {...props} />;
}
