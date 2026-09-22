// Choix d'une couleur d'équipe lisible sur le fond sombre du widget.

function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = ([r, g, b]) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Luminance relative (0 = noir, 1 = blanc), au sens des normes d'accessibilité. */
export function luminance(hex) {
  const c = rgb(hex);
  if (!c) return 0;
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Assez claire pour se voir sur le fond du widget, sans être presque blanche
// (une bordure blanche n'évoque plus l'équipe).
const MIN_LUM = 0.07;
const MAX_LUM = 0.8;
const usable = (hex) => rgb(hex) && luminance(hex) >= MIN_LUM && luminance(hex) <= MAX_LUM;

/**
 * Couleur principale si elle se voit, sinon la secondaire, sinon la
 * principale éclaircie progressivement jusqu'à devenir visible.
 */
export function visibleTeamColor(primary, alternate) {
  if (usable(primary)) return primary.toLowerCase();
  if (usable(alternate)) return alternate.toLowerCase();
  const base = rgb(primary) ?? rgb(alternate);
  if (!base) return null;
  for (let t = 0.1; t <= 0.9; t += 0.05) {
    const mixed = toHex(base.map((v) => v + (255 - v) * t));
    if (luminance(mixed) >= MIN_LUM) return mixed;
  }
  return null;
}
