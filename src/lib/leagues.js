// Catalogue des ligues supportées.
// `path` correspond au segment {sport}/{league} de l'API ESPN.
// `teams` est le nombre d'équipes de la ligue : il dit quand arrêter de
// fouiller le calendrier à la recherche des équipes manquantes.
export const LEAGUES = [
  { id: 'nhl',  label: 'LNH',                path: 'hockey/nhl',            kind: 'team',  accent: '#4aa3ff', short: 'LNH', teams: 32 },
  { id: 'nba',  label: 'NBA',                path: 'basketball/nba',        kind: 'team',  accent: '#ff7a45', short: 'NBA', teams: 30 },
  { id: 'nfl',  label: 'NFL',                path: 'football/nfl',          kind: 'team',  accent: '#7bd88f', short: 'NFL', teams: 32 },
  { id: 'mlb',  label: 'MLB',                path: 'baseball/mlb',          kind: 'team',  accent: '#f2c55c', short: 'MLB', teams: 30 },
  { id: 'epl',  label: 'Premier League',     path: 'soccer/eng.1',          kind: 'team',  accent: '#c77dff', short: 'PL', teams: 20 },
  { id: 'ucl',  label: 'Ligue des champions', path: 'soccer/uefa.champions', kind: 'team',  accent: '#5ee0d0', short: 'LDC', teams: 36 },
  { id: 'f1',   label: 'Formule 1',          path: 'racing/f1',             kind: 'event', accent: '#ff4d6d', short: 'F1' },
];

export const LEAGUES_BY_ID = Object.fromEntries(LEAGUES.map((l) => [l.id, l]));
