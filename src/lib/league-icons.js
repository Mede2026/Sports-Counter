// Icônes des ligues sans logo fourni par ESPN (tennis, golf, compétitions
// internationales, football universitaire) : dessinées ici, en SVG, pour ne
// dépendre d'aucune adresse externe.

const svg = (body) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`,
)}`;

/** Balle de tennis, sur un fond à la couleur du circuit. */
const tennis = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <circle cx="32" cy="32" r="19" fill="#d9f24b"/>
  <path d="M15.5 22.5c7 4.5 7 14.5 0 19M48.5 22.5c-7 4.5-7 14.5 0 19" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`);

/** Drapeau de golf planté sur le vert. */
const golf = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <ellipse cx="32" cy="48" rx="18" ry="5" fill="#7ee08a"/>
  <path d="M28 47V13" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <path d="M29.5 14l16 6.5-16 6.5z" fill="#ff5c5c"/>
  <circle cx="38" cy="46" r="2.6" fill="#fff"/>`);

/** Coupe, pour les compétitions internationales. */
const trophy = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <path d="M22 14h20v10c0 7-4.5 12-10 12s-10-5-10-12z" fill="#ffd166"/>
  <path d="M22 18h-6c0 6 3 9 7 10M42 18h6c0 6-3 9-7 10" fill="none" stroke="#ffd166" stroke-width="3" stroke-linecap="round"/>
  <path d="M29 36h6v7h-6z" fill="#e8b33a"/>
  <rect x="22" y="43" width="20" height="6" rx="2" fill="#e8b33a"/>`);

/** Globe, pour les matchs amicaux entre pays. */
const globe = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <circle cx="32" cy="32" r="17" fill="none" stroke="#fff" stroke-width="3"/>
  <ellipse cx="32" cy="32" rx="7.5" ry="17" fill="none" stroke="#fff" stroke-width="2.5"/>
  <path d="M15 32h34M18 23h28M18 41h28" stroke="#fff" stroke-width="2.5"/>`);

/** Ballon de football. */
const football = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <ellipse cx="32" cy="32" rx="20" ry="12" transform="rotate(-35 32 32)" fill="#9b5a2e"/>
  <path d="M25 39l14-14M28 30l3 3M31 27l3 3M34 24l3 3" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`);

/** Ballon de volleyball. */
const volleyball = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <circle cx="32" cy="32" r="19" fill="#fff"/>
  <path d="M32 13c-3 9-1 17 6 23M51 32c-9-2-17 1-22 8M20 47c4-8 3-16-3-23" fill="none" stroke="#f2c55c" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="32" cy="32" r="19" fill="none" stroke="#1b2a4a" stroke-width="2"/>`);

/** Octogone de combat, pour l'UFC. */
const octagon = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <path d="M24 12h16l12 12v16L40 52H24L12 40V24z" fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round"/>
  <text x="32" y="37.5" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="13" fill="#fff">UFC</text>`);

/** Skieur alpin qui descend, bâtons en arrière. */
const skier = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <path d="M10 50l44-14" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <circle cx="38" cy="15" r="5" fill="#fff"/>
  <path d="M35 21l-9 9 7 5-4 9M26 30l-8-2M35 23l8 7 6-2" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);

/** Fondeur en pas de patin, deux bâtons. */
const nordic = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <path d="M8 50h48" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <circle cx="30" cy="14" r="5" fill="#fff"/>
  <path d="M29 20l-4 13 9 6v8M25 33l-9 10M30 22l10 6M18 24l-6 24M44 26l4 22" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`);

/** Sauteur à ski en vol, skis en V. */
const jumper = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <circle cx="46" cy="18" r="5" fill="#fff"/>
  <path d="M42 22L18 38" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <path d="M12 30l40 18M12 40l40 10" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`);

/** Planche à neige sur une pente. */
const board = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <circle cx="34" cy="13" r="5" fill="#fff"/>
  <path d="M33 19l-3 11 8 6M30 30l-9 5M33 21l10-2M21 23l9-2" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="10" y="42" width="44" height="7" rx="3.5" transform="rotate(-14 32 45)" fill="#fff"/>`);

/** Flocon, pour le ski acrobatique. */
const flake = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <g stroke="#fff" stroke-width="3.4" stroke-linecap="round">
    <path d="M32 12v40M14.7 22l34.6 20M14.7 42l34.6-20"/>
    <path d="M27 15l5 5 5-5M27 49l5-5 5 5M15 28l7-1-2-6M49 36l-7 1 2 6M15 36l7 1-2 6M49 28l-7-1 2-6"/>
  </g>`);

/** Cible de biathlon. */
const target = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <circle cx="32" cy="32" r="19" fill="#fff"/>
  <circle cx="32" cy="32" r="12" fill="#1b2a4a"/>
  <circle cx="32" cy="32" r="5" fill="#fff"/>`);

/** Coureur, pour les marathons. */
const runner = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <circle cx="38" cy="13" r="5" fill="#fff"/>
  <path d="M36 20l-6 13 8 6-3 12M30 33l-11 7M35 22l9 7 7-2M33 22l-9 3-4 8" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);

/** Anneaux olympiques. */
const rings = (bg) => svg(`
  <rect width="64" height="64" rx="16" fill="${bg}"/>
  <g fill="none" stroke-width="3.2">
    <circle cx="17" cy="27" r="8" stroke="#2f8fe0"/><circle cx="32" cy="27" r="8" stroke="#fff"/><circle cx="47" cy="27" r="8" stroke="#e8363d"/>
    <circle cx="24.5" cy="36" r="8" stroke="#f2c55c"/><circle cx="39.5" cy="36" r="8" stroke="#3fbf6a"/>
  </g>`);

export const LEAGUE_ICONS = {
  ufc: octagon('#c8102e'),
  atp: tennis('#1d4f91'),
  wta: tennis('#6a2c91'),
  pga: golf('#12344d'),
  lpga: golf('#23546b'),
  wc: trophy('#8a1538'),
  wwc: trophy('#b0306a'),
  euro: trophy('#143cdb'),
  copa: trophy('#0a3a7a'),
  unl: trophy('#2b2f7a'),
  gold: trophy('#1f2a44'),
  intl: globe('#2d6a8f'),
  ncaaf: football('#1c5d4d'),
  vbw: volleyball('#8a5a12'),
  vbm: volleyball('#1f3f7a'),
  olyhm: rings('#14304f'),
  olyhw: rings('#4a1f3a'),
  olybm: rings('#4a3412'),
  olybw: rings('#3a1f4a'),
  skial: skier('#1b4f7a'),
  skifond: nordic('#1d5a4a'),
  saut: jumper('#3d2f6b'),
  combine: nordic('#284a7a'),
  snow: board('#7a3a24'),
  freeski: flake('#5e5a1c'),
  biathlon: target('#7a2830'),
  marathon: runner('#7a5214'),
};
