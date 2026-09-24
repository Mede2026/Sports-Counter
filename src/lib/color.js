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

/** Écart entre deux couleurs (0 = identiques, ~441 = noir contre blanc). */
function distance(a, b) {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// En dessous, deux barres côte à côte se confondent (rouge contre rouge).
const MIN_DISTANCE = 110;

/**
 * Couleurs des deux équipes pour des barres côte à côte : si elles se
 * ressemblent trop, l'une passe à sa couleur secondaire, sinon à un gris clair.
 * Renvoie [visiteurs, locaux].
 */
export function distinctColors(away, home, fallback = ['#4aa3ff', '#ff7a45']) {
  const a = visibleTeamColor(away?.color, away?.alt) ?? fallback[0];
  const h = visibleTeamColor(home?.color, home?.alt) ?? fallback[1];
  if (distance(a, h) >= MIN_DISTANCE) return [a, h];
  const awayAlt = away?.alt ? visibleTeamColor(away.alt) : null;
  if (awayAlt && distance(awayAlt, h) >= MIN_DISTANCE) return [awayAlt, h];
  const homeAlt = home?.alt ? visibleTeamColor(home.alt) : null;
  if (homeAlt && distance(a, homeAlt) >= MIN_DISTANCE) return [a, homeAlt];
  return [distance('#d7dce5', h) >= MIN_DISTANCE ? '#d7dce5' : '#4aa3ff', h];
}

/** Texte lisible posé sur cette couleur : presque noir ou blanc. */
export const inkOn = (hex) => (luminance(hex) > 0.35 ? '#06111f' : '#ffffff');

/**
 * La couleur éclaircie juste assez pour se lire en texte ou en petit élément
 * (onglet choisi, interrupteur) sur un fond sombre.
 */
export function brightAccent(hex, min = 0.2) {
  const base = rgb(hex);
  if (!base) return null;
  if (luminance(hex) >= min) return hex.toLowerCase();
  for (let t = 0.05; t <= 0.95; t += 0.05) {
    const mixed = toHex(base.map((v) => v + (255 - v) * t));
    if (luminance(mixed) >= min) return mixed;
  }
  return '#ffffff';
}

/**
 * Couleurs de l'équipe choisie dans les réglages (« Couleur »), posées sur la
 * page : --team (la couleur), --accent (sa version lisible) et --accent-ink
 * (le texte à poser dessus). Sans équipe choisie, les couleurs de l'app.
 */
/** Réglage « Couleur » : suivre l'équipe favorite qui joue. */
export const LIVE_THEME = 'live';
// Deux favorites en même temps : leurs couleurs alternent toutes les 5 min.
export const LIVE_SWITCH_MS = 5 * 60 * 1000;

/**
 * Couleurs des équipes favorites qui jouent en ce moment (2 au plus). Sans
 * match en direct : l'équipe du prochain match, sinon la 1re favorite.
 */
export function playingColors(prefs, games = []) {
  const favs = new Set(prefs?.favorites ?? []);
  const colorOf = (g, t) => {
    const key = `${g.leagueId}:${t?.id}`;
    if (!t || !favs.has(key)) return null;
    const info = prefs.favInfo?.[key];
    return visibleTeamColor(info?.color ?? t.color, info?.alt ?? t.alt);
  };
  const pick = (list) => [...new Set(list.flatMap((g) => [colorOf(g, g.away), colorOf(g, g.home)]).filter(Boolean))];
  const matches = games.filter((g) => g?.kind === 'match');
  let colors = pick(matches.filter((g) => g.state === 'in'));
  if (!colors.length) colors = pick(matches.filter((g) => g.state === 'pre')).slice(0, 1);
  if (!colors.length) {
    const info = prefs?.favInfo?.[prefs?.favorites?.[0]];
    const c = info ? visibleTeamColor(info.color, info.alt) : null;
    if (c) colors = [c];
  }
  return colors.slice(0, 2);
}

/** [couleur du moment, l'autre] : avec deux couleurs, elles s'échangent toutes les 5 min. */
export function alternating(colors, now = Date.now()) {
  if (!colors?.length) return [null, null];
  if (colors.length < 2) return [colors[0], null];
  const phase = Math.floor(now / LIVE_SWITCH_MS) % 2;
  return [colors[phase], colors[1 - phase]];
}

export function applyTeamAccent(prefs, root = document.documentElement) {
  // « Équipe qui joue » : hors du widget, pas de matchs sous la main ; la 1re favorite.
  const key = prefs?.theme === LIVE_THEME ? prefs?.favorites?.find((k) => prefs.favInfo?.[k]?.color) : prefs?.theme;
  const info = prefs?.favInfo?.[key];
  const team = info ? visibleTeamColor(info.color, info.alt) : null;
  root.classList.toggle('team-theme', !!team);
  if (!team) {
    for (const v of ['--team', '--accent', '--accent-ink']) root.style.removeProperty(v);
    return;
  }
  const accent = brightAccent(team);
  root.style.setProperty('--team', team);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-ink', inkOn(accent));
}
