import { F1_LOGO } from './f1-logo.js';

// Catalogue des ligues supportées.
// `path` correspond au segment {sport}/{league} de l'API ESPN.
// `teams` est le nombre d'équipes de la ligue : il dit quand arrêter de
// fouiller le calendrier à la recherche des équipes manquantes.
// `group` range les ligues par sport dans la colonne des réglages.
// `kind` : 'team' (on coche des équipes), 'event' (F1 : on suit la saison),
// 'card' (UFC : on suit les galas, combat par combat).
export const LEAGUES = [
  { id: 'nhl',  group: 'Hockey',     label: 'LNH',                path: 'hockey/nhl',            kind: 'team',  accent: '#4aa3ff', short: 'LNH', teams: 32 },
  { id: 'nba',  group: 'Basketball', label: 'NBA',                path: 'basketball/nba',        kind: 'team',  accent: '#ff7a45', short: 'NBA', teams: 30 },
  { id: 'wnba', group: 'Basketball', label: 'WNBA',               path: 'basketball/wnba',       kind: 'team',  accent: '#f58fd0', short: 'WNBA', teams: 15 },
  { id: 'nfl',  group: 'Football',   label: 'NFL',                path: 'football/nfl',          kind: 'team',  accent: '#7bd88f', short: 'NFL', teams: 32 },
  { id: 'mlb',  group: 'Baseball',   label: 'MLB',                path: 'baseball/mlb',          kind: 'team',  accent: '#f2c55c', short: 'MLB', teams: 30 },
  { id: 'epl',  group: 'Soccer',     label: 'Premier League',     path: 'soccer/eng.1',          kind: 'team',  accent: '#c77dff', short: 'PL', teams: 20 },
  { id: 'esp',  group: 'Soccer',     label: 'La Liga',            path: 'soccer/esp.1',          kind: 'team',  accent: '#ff6b5b', short: 'LIGA', teams: 20 },
  { id: 'ita',  group: 'Soccer',     label: 'Serie A',            path: 'soccer/ita.1',          kind: 'team',  accent: '#3fa7ff', short: 'SA', teams: 20 },
  { id: 'ger',  group: 'Soccer',     label: 'Bundesliga',         path: 'soccer/ger.1',          kind: 'team',  accent: '#ff5c5c', short: 'BUN', teams: 18 },
  { id: 'fra',  group: 'Soccer',     label: 'Ligue 1',            path: 'soccer/fra.1',          kind: 'team',  accent: '#d9f26b', short: 'L1', teams: 18 },
  { id: 'ucl',  group: 'Soccer',     label: 'Ligue des champions', path: 'soccer/uefa.champions', kind: 'team',  accent: '#5ee0d0', short: 'LDC', teams: 36 },
  { id: 'uel',  group: 'Soccer',     label: 'Ligue Europa',       path: 'soccer/uefa.europa',    kind: 'team',  accent: '#ffa53d', short: 'LE', teams: 36 },
  { id: 'mls',  group: 'Soccer',     label: 'MLS',                path: 'soccer/usa.1',          kind: 'team',  accent: '#8fb8de', short: 'MLS', teams: 30 },
  { id: 'f1',   group: 'Course',     label: 'Formule 1',          path: 'racing/f1',             kind: 'event', accent: '#ff4d6d', short: 'F1', logo: F1_LOGO },
  { id: 'ufc',  group: 'Combat',     label: 'UFC',                path: 'mma/ufc',               kind: 'card',  accent: '#e8363d', short: 'UFC' },
];

export const LEAGUES_BY_ID = Object.fromEntries(LEAGUES.map((l) => [l.id, l]));

/** Sport d'une ligue, d'après ESPN : 'hockey', 'soccer', 'racing', 'mma'… */
export const sportOf = (leagueId) => LEAGUES_BY_ID[leagueId]?.path.split('/')[0] ?? '';

/** Ligues qu'on suit en entier (sans cocher d'équipes) : F1, UFC. */
export const isWholeLeague = (leagueId) => ['event', 'card'].includes(LEAGUES_BY_ID[leagueId]?.kind);
