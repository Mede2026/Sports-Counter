import { F1_LOGO } from './f1-logo.js';
import { LEAGUE_ICONS } from './league-icons.js';

// Catalogue des ligues supportées.
// `path` correspond au segment {sport}/{league} de l'API ESPN.
// `teams` est le nombre d'équipes de la ligue : il dit quand arrêter de
// fouiller le calendrier à la recherche des équipes manquantes.
// `group` range les ligues par sport dans la colonne des réglages.
// `kind` : 'team' (on coche des équipes), 'event' (F1 : on suit la saison),
// 'card' (UFC : on suit les galas, combat par combat), 'golf' (on suit les
// tournois : tableau des meneurs), 'tennis' (on choisit ses joueurs ; un
// tournoi donne un match par rencontre).
// `query` : paramètres ajoutés au tableau des scores d'ESPN ; `teamsQuery` : à
// la liste des équipes.
// `tournament` : compétition internationale — on peut suivre ses équipes
// nationales, ou toute la compétition (tous les matchs, tous les buts).
export const LEAGUES = [
  { id: 'nhl',  group: 'Hockey',     label: 'LNH',                path: 'hockey/nhl',            kind: 'team',  accent: '#4aa3ff', short: 'LNH', teams: 32 },
  { id: 'nba',  group: 'Basketball', label: 'NBA',                path: 'basketball/nba',        kind: 'team',  accent: '#ff7a45', short: 'NBA', teams: 30 },
  { id: 'wnba', group: 'Basketball', label: 'WNBA',               path: 'basketball/wnba',       kind: 'team',  accent: '#f58fd0', short: 'WNBA', teams: 15 },
  { id: 'nfl',  group: 'Football',   label: 'NFL',                path: 'football/nfl',          kind: 'team',  accent: '#7bd88f', short: 'NFL', teams: 32 },
  { id: 'cfl',  group: 'Football',   label: 'LCF',                path: 'football/cfl',          kind: 'team',  accent: '#e84a4a', short: 'LCF', teams: 9,
    // ESPN n'a pas les logos de la LCF : on les prend chez TheSportsDB.
    sportsDb: 'Canadian Football League', sportsDbId: 4405 },
  { id: 'ncaaf', group: 'Football',  label: 'Football universitaire', path: 'football/college-football', kind: 'team', accent: '#5fc4a8', short: 'NCAA', teams: 130,
    // Toute la première division (FBS), pas seulement les matchs du top 25.
    query: 'groups=80&limit=300', teamsQuery: '?groups=80&limit=1000', coreTeams: 'groups/80/teams' },
  { id: 'mlb',  group: 'Baseball',   label: 'MLB',                path: 'baseball/mlb',          kind: 'team',  accent: '#f2c55c', short: 'MLB', teams: 30 },
  { id: 'epl',  group: 'Soccer',     label: 'Premier League',     path: 'soccer/eng.1',          kind: 'team',  accent: '#c77dff', short: 'PL', teams: 20 },
  { id: 'esp',  group: 'Soccer',     label: 'La Liga',            path: 'soccer/esp.1',          kind: 'team',  accent: '#ff6b5b', short: 'LIGA', teams: 20 },
  { id: 'ita',  group: 'Soccer',     label: 'Serie A',            path: 'soccer/ita.1',          kind: 'team',  accent: '#3fa7ff', short: 'SA', teams: 20 },
  { id: 'ger',  group: 'Soccer',     label: 'Bundesliga',         path: 'soccer/ger.1',          kind: 'team',  accent: '#ff5c5c', short: 'BUN', teams: 18 },
  { id: 'fra',  group: 'Soccer',     label: 'Ligue 1',            path: 'soccer/fra.1',          kind: 'team',  accent: '#d9f26b', short: 'L1', teams: 18 },
  { id: 'ucl',  group: 'Soccer',     label: 'Ligue des champions', path: 'soccer/uefa.champions', kind: 'team',  accent: '#5ee0d0', short: 'LDC', teams: 36 },
  { id: 'uel',  group: 'Soccer',     label: 'Ligue Europa',       path: 'soccer/uefa.europa',    kind: 'team',  accent: '#ffa53d', short: 'LE', teams: 36 },
  { id: 'mls',  group: 'Soccer',     label: 'MLS',                path: 'soccer/usa.1',          kind: 'team',  accent: '#8fb8de', short: 'MLS', teams: 30 },
  { id: 'wc',   group: 'International', label: 'Coupe du monde',   path: 'soccer/fifa.world',     kind: 'team',  accent: '#ffd166', short: 'CDM', teams: 48, tournament: true },
  { id: 'wwc',  group: 'International', label: 'Coupe du monde féminine', path: 'soccer/fifa.wwc', kind: 'team', accent: '#ff9ecd', short: 'CDMF', teams: 32, tournament: true },
  { id: 'euro', group: 'International', label: 'Euro',             path: 'soccer/uefa.euro',      kind: 'team',  accent: '#6ea8ff', short: 'EURO', teams: 24, tournament: true },
  { id: 'copa', group: 'International', label: 'Copa América',     path: 'soccer/conmebol.america', kind: 'team', accent: '#ffb347', short: 'COPA', teams: 16, tournament: true },
  { id: 'unl',  group: 'International', label: 'Ligue des nations', path: 'soccer/uefa.nations',  kind: 'team',  accent: '#9fa8ff', short: 'LDN', teams: 54, tournament: true },
  { id: 'gold', group: 'International', label: 'Gold Cup',         path: 'soccer/concacaf.gold',  kind: 'team',  accent: '#e8c35a', short: 'GOLD', teams: 16, tournament: true },
  { id: 'intl', group: 'International', label: 'Matchs amicaux',   path: 'soccer/fifa.friendly',  kind: 'team',  accent: '#b8c4d6', short: 'AMI', teams: 0, tournament: true },
  { id: 'f1',   group: 'Course',     label: 'Formule 1',          path: 'racing/f1',             kind: 'event', accent: '#ff4d6d', short: 'F1', logo: F1_LOGO },
  { id: 'ufc',  group: 'Combat',     label: 'UFC',                path: 'mma/ufc',               kind: 'card',  accent: '#e8363d', short: 'UFC' },
  { id: 'pga',  group: 'Golf',       label: 'PGA Tour',           path: 'golf/pga',              kind: 'golf',  accent: '#5bd38a', short: 'PGA' },
  { id: 'lpga', group: 'Golf',       label: 'LPGA',               path: 'golf/lpga',             kind: 'golf',  accent: '#7fe0c0', short: 'LPGA' },
  { id: 'atp',  group: 'Tennis',     label: 'ATP',                path: 'tennis/atp',            kind: 'tennis', accent: '#c6f36b', short: 'ATP' },
  { id: 'wta',  group: 'Tennis',     label: 'WTA',                path: 'tennis/wta',            kind: 'tennis', accent: '#e59cff', short: 'WTA' },
];

// Icône dessinée pour les ligues dont ESPN ne donne pas de logo utilisable.
for (const l of LEAGUES) if (!l.logo && LEAGUE_ICONS[l.id]) l.logo = LEAGUE_ICONS[l.id];

export const LEAGUES_BY_ID = Object.fromEntries(LEAGUES.map((l) => [l.id, l]));

/** Sport d'une ligue, d'après ESPN : 'hockey', 'soccer', 'racing', 'mma'… */
export const sportOf = (leagueId) => LEAGUES_BY_ID[leagueId]?.path.split('/')[0] ?? '';

/** Ligues qu'on suit en entier (sans cocher d'équipes) : F1, UFC, golf, tennis. */
export const isWholeLeague = (leagueId) => ['event', 'card', 'golf', 'tennis'].includes(LEAGUES_BY_ID[leagueId]?.kind);
