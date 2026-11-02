// Inline SVG icon set (24×24 grid, stroke = currentColor). Icons are decorative: callers provide the text label.
const PATHS = {
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  exit: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
  view: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  click: ['M5 3l14 7-6 2-2 6z', 'M13 13l6 6'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7z'],
  unknown: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5', 'M12 17h.01'],
  cart: ['M3 4h2l2.4 11h10.2L20 8H6.5', 'M9 20.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M17 20.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  pin: ['M12 16v6', 'M8 3h8l-1 6 3 4H6l3-4z'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M4.9 4.9 7 7', 'M17 17l2.1 2.1', 'M4.9 19.1 7 17', 'M17 7l2.1-2.1'],
  star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  warn: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17h.01'],
  fail: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9 9l6 6', 'M15 9l-6 6'],
};
const NS = 'http://www.w3.org/2000/svg';

export function icon(name, { filled = false, size = 14, weight = 2 } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': weight, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(k, v);
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
