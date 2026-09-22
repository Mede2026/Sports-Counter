// Catalogue des ligues supportées.
// `path` correspond au segment {sport}/{league} de l'API ESPN.
export const LEAGUES = [
  { id: 'nhl',  label: 'LNH',                path: 'hockey/nhl',            kind: 'team',  accent: '#4aa3ff', short: 'LNH' },
  { id: 'nba',  label: 'NBA',                path: 'basketball/nba',        kind: 'team',  accent: '#ff7a45', short: 'NBA' },
  { id: 'nfl',  label: 'NFL',                path: 'football/nfl',          kind: 'team',  accent: '#7bd88f', short: 'NFL' },
  { id: 'mlb',  label: 'MLB',                path: 'baseball/mlb',          kind: 'team',  accent: '#f2c55c', short: 'MLB' },
  { id: 'epl',  label: 'Premier League',     path: 'soccer/eng.1',          kind: 'team',  accent: '#c77dff', short: 'PL' },
  { id: 'ucl',  label: 'Ligue des champions', path: 'soccer/uefa.champions', kind: 'team',  accent: '#5ee0d0', short: 'LDC' },
  { id: 'f1',   label: 'Formule 1',          path: 'racing/f1',             kind: 'event', accent: '#ff4d6d', short: 'F1' },
];

export const LEAGUES_BY_ID = Object.fromEntries(LEAGUES.map((l) => [l.id, l]));
