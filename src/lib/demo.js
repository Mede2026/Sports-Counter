// Données de démonstration : aperçu navigateur (`npm run preview`) et
// remplissage du widget quand aucune connexion n'est disponible.
// Les logos sont de simples SVG embarqués ; en usage réel ce sont ceux d'ESPN.

const svg = (body) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`
  );

// Logos transparents, comme ceux d'ESPN : aucun fond, aucun cercle.
const LOGOS = {
  MTL: svg(
    `<ellipse cx="32" cy="32" rx="27" ry="19" fill="none" stroke="#af1e2d" stroke-width="9"/>` +
      `<text x="32" y="40" font-family="Georgia,serif" font-size="23" font-weight="700"
         fill="#192168" text-anchor="middle">CH</text>`
  ),
  TOR: svg(
    `<path d="M32 6l6 14 11-5-5 15 12 4-13 7 5 12-16-6-16 6 5-12-13-7 12-4-5-15 11 5z"
       fill="#00205b"/>`
  ),
  BOS: svg(
    `<circle cx="32" cy="32" r="26" fill="#fcb514"/>` +
      `<circle cx="32" cy="32" r="18" fill="#111"/>` +
      `<text x="32" y="41" font-family="Georgia,serif" font-size="22" font-weight="700"
         fill="#fcb514" text-anchor="middle">B</text>`
  ),
  NYR: svg(
    `<path d="M32 5l24 7v23c0 13-11 19-24 24-13-5-24-11-24-24V12z" fill="#0038a8"/>` +
      `<text x="32" y="43" font-family="Georgia,serif" font-size="24" font-weight="700"
         fill="#fff" text-anchor="middle">R</text>`
  ),
  LAL: svg(
    `<text x="32" y="43" font-family="Arial,sans-serif" font-size="28" font-weight="800"
       fill="#552583" text-anchor="middle">LA</text>`
  ),
  CEL: svg(
    `<path d="M32 4l7 19 19 7-19 7-7 19-7-19-19-7 19-7z" fill="#007a33"/>`
  ),
};

export const DEMO_EVENTS = [
  {
    id: 'demo-nhl-1', leagueId: 'nhl', kind: 'match', state: 'in',
    statusText: '2e période', clock: '07:42', startsAt: null,
    home: { id: '10', abbr: 'MTL', name: 'Canadiens', logo: LOGOS.MTL, color: '#af1e2d', score: '3', winner: false },
    away: { id: '21', abbr: 'TOR', name: 'Maple Leafs', logo: LOGOS.TOR, color: '#00205b', score: '2', winner: false },
  },
  {
    id: 'demo-nhl-2', leagueId: 'nhl', kind: 'match', state: 'post',
    statusText: 'Final / Prol.', clock: '', startsAt: null,
    home: { id: '1', abbr: 'BOS', name: 'Bruins', logo: LOGOS.BOS, color: '#fcb514', score: '4', winner: true },
    away: { id: '13', abbr: 'NYR', name: 'Rangers', logo: LOGOS.NYR, color: '#0038a8', score: '3', winner: false },
  },
  {
    id: 'demo-nba-1', leagueId: 'nba', kind: 'match', state: 'pre',
    statusText: '19 h 30', clock: '', startsAt: null,
    home: { id: '13', abbr: 'LAL', name: 'Lakers', logo: LOGOS.LAL, color: '#552583', score: '–', winner: false },
    away: { id: '2', abbr: 'BOS', name: 'Celtics', logo: LOGOS.CEL, color: '#007a33', score: '–', winner: false },
  },
  {
    id: 'demo-f1-1', leagueId: 'f1', kind: 'event', state: 'in',
    statusText: 'Tour 34 / 70', clock: '', startsAt: null,
    title: 'GP du Canada',
  },
];

// Équipes factices : seulement pour l'aperçu (`?demo`) de l'écran de réglages.
export const DEMO_TEAMS = [
  { id: '1',  abbr: 'BOS', name: 'Boston Bruins',           short: 'Bruins',      logo: LOGOS.BOS, color: '#fcb514' },
  { id: '10', abbr: 'MTL', name: 'Canadiens de Montréal',   short: 'Canadiens',   logo: LOGOS.MTL, color: '#af1e2d' },
  { id: '21', abbr: 'TOR', name: 'Maple Leafs de Toronto',  short: 'Maple Leafs', logo: LOGOS.TOR, color: '#00205b' },
  { id: '13', abbr: 'NYR', name: 'New York Rangers',        short: 'Rangers',     logo: LOGOS.NYR, color: '#0038a8' },
  { id: '7',  abbr: 'OTT', name: "Sénateurs d'Ottawa",      short: 'Sénateurs',   logo: '',        color: '#c8102e' },
  { id: '17', abbr: 'TBL', name: 'Tampa Bay Lightning',     short: 'Lightning',   logo: '',        color: '#002868' },
  { id: '4',  abbr: 'COL', name: 'Colorado Avalanche',      short: 'Avalanche',   logo: '',        color: '#6f263d' },
  { id: '25', abbr: 'VAN', name: 'Vancouver Canucks',       short: 'Canucks',     logo: '',        color: '#00205b' },
];
