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

// Classement factice d'une course (aperçu seulement).
const DEMO_GRID = [
  ['demo-ant', 'Andrea Kimi Antonelli', 'K. Antonelli', 'Mercedes'],
  ['demo-rus', 'George Russell', 'G. Russell', 'Mercedes'],
  ['demo-ver', 'Max Verstappen', 'M. Verstappen', 'Red Bull'],
  ['demo-nor', 'Lando Norris', 'L. Norris', 'McLaren'],
  ['demo-lec', 'Charles Leclerc', 'C. Leclerc', 'Ferrari'],
  ['demo-pia', 'Oscar Piastri', 'O. Piastri', 'McLaren'],
].map(([id, name, short, team], i) => ({ id, pos: i + 1, name, short, team, photo: '', gap: i ? (i * 1.874).toFixed(3) : '' }));

// Gala UFC factice (aperçu seulement).
const F = (name, short, record, winner = false) => ({ id: short, name, short, photo: '', record, winner });
const DEMO_MAIN = { id: 'm', a: F('Alex Pereira', 'A. Pereira', '12-2-0'), b: F('Magomed Ankalaev', 'M. Ankalaev', '20-1-1'),
  state: 'pre', weight: 'Mi-lourds', segment: 'Carte principale', result: '', round: null, clock: '', startsAt: new Date(Date.now() + 2 * 3600e3) };
const DEMO_LIVE = { id: 'l', a: F('Merab Dvalishvili', 'M. Dvalishvili', '19-4-0'), b: F('Cory Sandhagen', 'C. Sandhagen', '18-5-0'),
  state: 'in', weight: 'Coqs', segment: 'Carte principale', result: '', round: 2, clock: '3:12', startsAt: new Date() };
const DEMO_DONE = { id: 'd', a: F('Jiri Prochazka', 'J. Prochazka', '31-5-1', true), b: F('Khalil Rountree', 'K. Rountree', '13-6-0'),
  state: 'post', weight: 'Mi-lourds', segment: 'Carte principale', result: 'KO/TKO', round: 3, clock: '', startsAt: new Date(Date.now() - 3600e3) };

export const DEMO_EVENTS = [
  {
    id: 'demo-nhl-1', leagueId: 'nhl', kind: 'match', state: 'in',
    statusText: '2e période', clock: '07:42', startsAt: null,
    home: { id: '10', abbr: 'MTL', name: 'Canadiens', logo: LOGOS.MTL, color: '#af1e2d', score: '3', winner: false, record: '12-5-3', shots: '27' },
    away: { id: '21', abbr: 'TOR', name: 'Maple Leafs', logo: LOGOS.TOR, color: '#00205b', score: '2', winner: false, record: '10-8-2', shots: '19' },
  },
  {
    id: 'demo-nhl-2', leagueId: 'nhl', kind: 'match', state: 'post',
    statusText: 'Final / Prol.', clock: '', startsAt: null,
    home: { id: '1', abbr: 'BOS', name: 'Bruins', logo: LOGOS.BOS, color: '#fcb514', score: '4', winner: true },
    away: { id: '13', abbr: 'NYR', name: 'Rangers', logo: LOGOS.NYR, color: '#0038a8', score: '3', winner: false },
  },
  {
    id: 'demo-nba-1', leagueId: 'nba', kind: 'match', state: 'pre',
    statusText: '19 h 30', clock: '', startsAt: Date.now() + (2 * 60 + 15) * 60000,
    home: { id: '13', abbr: 'LAL', name: 'Lakers', logo: LOGOS.LAL, color: '#552583', score: '–', winner: false },
    away: { id: '2', abbr: 'BOS', name: 'Celtics', logo: LOGOS.CEL, color: '#007a33', score: '–', winner: false },
  },
  {
    id: 'demo-f1-1', leagueId: 'f1', kind: 'event', state: 'in',
    statusText: 'Tour 34 / 70', clock: '', startsAt: null, session: 'Course',
    title: 'GP du Canada',
    top3: DEMO_GRID.slice(0, 3),
    results: DEMO_GRID,
    sessions: [
      { label: 'Essais 1', startsAt: new Date(Date.now() - 50 * 3600e3), state: 'post' },
      { label: 'Qualifications', startsAt: new Date(Date.now() - 24 * 3600e3), state: 'post' },
      { label: 'Course', startsAt: new Date(Date.now() - 3600e3), state: 'in' },
    ],
  },
  {
    id: 'demo-ufc-1', leagueId: 'ufc', kind: 'card', state: 'in', title: 'UFC 320 : Pereira vs Ankalaev',
    statusText: 'Round 2 · 3:12', clock: '', session: '', startsAt: null, logo: '',
    main: DEMO_MAIN,
    live: DEMO_LIVE,
    fights: [DEMO_MAIN, DEMO_LIVE, DEMO_DONE],
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

// Golf et tennis : aperçu seulement avec ?demo&extra (les captures du site
// restent celles des sports d'équipe).
const G = (i, name, short, posText, score, thru) => ({ id: `g${i}`, name, short, photo: '', flag: '', order: i + 1, pos: i + 1, posText, score, thru });
const T = (id, name, short, sets, winner = false, seed = null) => ({ id, name, short, photo: '', flag: '', seed, winner, sets });

export const DEMO_EXTRA = [
  {
    id: 'demo-pga-1', leagueId: 'pga', kind: 'golf', state: 'in', title: 'Tour Championship', logo: '',
    round: 3, session: 'Ronde 3', statusText: 'Ronde 3', clock: '', startsAt: null,
    players: [
      G(0, 'Scottie Scheffler', 'S. Scheffler', '1', '-14', '12'), G(1, 'Rory McIlroy', 'R. McIlroy', 'T2', '-11', '14'),
      G(2, 'Xander Schauffele', 'X. Schauffele', 'T2', '-11', 'F'), G(3, 'Nick Taylor', 'N. Taylor', '4', '-9', '10'),
      G(4, 'Corey Conners', 'C. Conners', 'T5', '-8', '11'), G(5, 'Collin Morikawa', 'C. Morikawa', 'T5', '-8', 'F'),
    ],
  },
  {
    id: 'demo-atp-1', leagueId: 'atp', kind: 'tennis', state: 'in', title: 'Omnium Banque Nationale', draw: 'Simple messieurs',
    round: 'Quart de finale', statusText: '3e manche', clock: '', session: '', startsAt: null, logo: '',
    a: T('fa', 'Félix Auger-Aliassime', 'F. Auger-Aliassime', [6, 3, 4], false, 8),
    b: T('cr', 'Casper Ruud', 'C. Ruud', [4, 6, 3], false, 6),
  },
  {
    id: 'demo-wta-1', leagueId: 'wta', kind: 'tennis', state: 'post', title: 'Omnium Banque Nationale', draw: 'Simple dames',
    round: 'Demi-finale', statusText: 'Terminé', clock: '', session: '', startsAt: null, logo: '',
    a: T('lf', 'Leylah Fernandez', 'L. Fernandez', [7, 6], true), b: T('cg', 'Coco Gauff', 'C. Gauff', [5, 4], false, 3),
  },
];
