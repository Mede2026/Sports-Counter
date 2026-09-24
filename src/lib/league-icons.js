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

export const LEAGUE_ICONS = {
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
};
