// Accès aux données ESPN.
// Deux chemins, essayés dans l'ordre :
//   1. fetch() depuis la page. Dans l'app, la page tourne dans WebView2, qui est
//      Chromium : la requête est celle d'un vrai navigateur, jusqu'à la poignée
//      de main TLS et au protocole HTTP/2. C'est ce que le pare-feu d'ESPN
//      laisse passer.
//   2. Le relais Rust (commande `espn_get`), si le premier chemin échoue.
//      reqwest n'imite pas un navigateur, donc ESPN peut le refuser, mais il
//      contourne un éventuel blocage CORS.
// Quand les deux échouent, l'erreur rapporte le résultat de chacun.
import { LEAGUES_BY_ID } from './leagues.js';
import { DEMO_EVENTS } from './demo.js';
import { errText } from './err.js';
import { NHL_TEAMS } from './teams-nhl.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

function inTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI__;
}

async function viaPage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function viaRust(suffix) {
  const raw = await window.__TAURI__.core.invoke('espn_get', { path: suffix });
  return JSON.parse(raw);
}

async function getJson(path, query = '') {
  const suffix = `${path}${query}`;
  const url = `${BASE}/${suffix}`;

  let pageErr;
  try {
    return await viaPage(url);
  } catch (err) {
    pageErr = errText(err);
    if (!inTauri()) throw new Error(pageErr);
  }

  try {
    return await viaRust(suffix);
  } catch (err) {
    throw new Error(`Navigateur : ${pageErr}\nRelais : ${errText(err)}`);
  }
}

const DAY = 24 * 3600 * 1000;
const TEAMS_TTL = 7 * DAY;
const teamsKey = (leagueId) => `sports-counter.teams.${leagueId}.v2`;

function toTeam(t) {
  return {
    id: String(t.id),
    abbr: t.abbreviation ?? '',
    name: t.displayName ?? t.name ?? '',
    short: t.shortDisplayName ?? t.name ?? '',
    logo: t.logo ?? t.logos?.[0]?.href ?? '',
    color: t.color ? `#${t.color}` : null,
    alt: t.alternateColor ? `#${t.alternateColor}` : null,
  };
}

const byName = (a, b) => a.name.localeCompare(b.name, 'fr');

function readTeamsCache(leagueId) {
  try {
    const raw = localStorage.getItem(teamsKey(leagueId));
    if (!raw) return null;
    const { at, teams } = JSON.parse(raw);
    return Date.now() - at < TEAMS_TTL && teams?.length ? teams : null;
  } catch {
    return null;
  }
}

function writeTeamsCache(leagueId, teams) {
  try {
    localStorage.setItem(teamsKey(leagueId), JSON.stringify({ at: Date.now(), teams }));
  } catch { /* stockage plein ou indisponible : on s'en passe */ }
}

/** Source principale : la liste officielle des équipes de la ligue. */
async function teamsFromDirectory(league) {
  // Pas de paramètre dans l'adresse : `/scoreboard` passe sans paramètre, alors
  // que `/teams?limit=200` était refusé. La liste complète vient de toute façon
  // sans limite.
  const data = await getJson(`${league.path}/teams`);
  const raw = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return raw.map((entry) => entry.team).filter(Boolean).map(toTeam);
}

/** Listes intégrées à l'app, pour les ligues dont on a une copie vérifiée. */
const BUNDLED_TEAMS = { nhl: NHL_TEAMS };

/**
 * Date AAAAMMJJ, décalée de `offsetDays` jours, dans le fuseau de l'ordinateur.
 * toISOString() donnerait la date UTC : au Québec, après 20 h, « aujourd'hui »
 * serait déjà devenu demain.
 */
export function ymd(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${mm}${dd}`;
}

/**
 * Secours : les équipes qui jouent autour d'aujourd'hui, tirées du calendrier.
 * `/scoreboard` est lisible depuis l'app, contrairement à `/teams`.
 */
async function teamsFromSchedule(league) {
  const seen = new Map();
  const absorb = (data) => {
    for (const event of data?.events ?? []) {
      for (const c of event?.competitions?.[0]?.competitors ?? []) {
        const id = c?.team?.id != null ? String(c.team.id) : null;
        if (id && !seen.has(id)) seen.set(id, toTeam(c.team));
      }
    }
  };
  const target = league.teams ?? Infinity;
  const errors = [];

  // 1. Une seule requête sur trois semaines. ESPN a refusé (HTTP 400) une
  //    plage de 60 jours avec limit=1000 : on raccourcit et on retire limit.
  try {
    absorb(await getJson(`${league.path}/scoreboard`, `?dates=${ymd(-7)}-${ymd(14)}`));
  } catch (err) {
    errors.push(`plage : ${errText(err)}`);
  }

  // 2. Jour par jour, en s'éloignant d'aujourd'hui, jusqu'à avoir toute la
  //    ligue. `?dates=AAAAMMJJ` est le format de base de l'API.
  const offsets = [0];
  for (let d = 1; d <= 30; d += 1) offsets.push(d, -d);
  for (let i = 0; i < offsets.length && seen.size < target; i += 6) {
    const batch = offsets.slice(i, i + 6);
    const results = await Promise.allSettled(
      batch.map((d) => getJson(`${league.path}/scoreboard`, `?dates=${ymd(d)}`)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') absorb(r.value);
      else if (errors.length < 3) errors.push(`jour : ${errText(r.reason)}`);
    }
  }

  if (!seen.size && errors.length) throw new Error(errors.join('\n'));
  return [...seen.values()];
}

/** Liste des équipes d'une ligue, pour l'écran de réglages. */
export async function fetchTeams(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return [];

  if (BUNDLED_TEAMS[leagueId]) return [...BUNDLED_TEAMS[leagueId]].sort(byName);

  const cached = readTeamsCache(leagueId);
  if (cached) return cached;

  let teams = [];
  let directoryErr = null;
  try {
    teams = await teamsFromDirectory(league);
  } catch (err) {
    directoryErr = err;
  }

  if (!teams.length) {
    try {
      teams = await teamsFromSchedule(league);
    } catch (err) {
      throw new Error(
        `Liste : ${errText(directoryErr ?? 'vide')}\nCalendrier : ${errText(err)}`,
      );
    }
  }

  if (!teams.length) throw new Error(errText(directoryErr ?? 'aucune équipe trouvée'));

  teams.sort(byName);
  // Une liste incomplète (ligue hors saison, peu de matchs au calendrier) n'est
  // pas gardée : on retentera à la prochaine ouverture des réglages.
  if (teams.length >= (league.teams ?? 0)) writeTeamsCache(leagueId, teams);
  return teams;
}

function normalizeCompetitor(c) {
  const t = c?.team ?? {};
  return {
    id: String(t.id ?? ''),
    abbr: t.abbreviation ?? t.shortDisplayName ?? '???',
    name: t.shortDisplayName ?? t.displayName ?? '',
    logo: t.logo ?? t.logos?.[0]?.href ?? '',
    color: t.color ? `#${t.color}` : null,
    alt: t.alternateColor ? `#${t.alternateColor}` : null,
    score: c?.score != null ? String(c.score) : '–',
    winner: c?.winner === true,
  };
}

// Un week-end de F1 regroupe plusieurs séances. La date de l'évènement est
// celle de la première (les essais libres du jeudi ou du vendredi) : l'afficher
// seule donnerait l'impression que le Grand Prix a lieu ce jour-là.
const SESSION_LABELS = {
  FP1: 'Essais 1',
  FP2: 'Essais 2',
  FP3: 'Essais 3',
  QUAL: 'Qualifications',
  SS: 'Qualifs sprint',
  SQ: 'Qualifs sprint',
  SPRINT: 'Sprint',
  RACE: 'Course',
};

function sessionLabel(comp) {
  const abbr = String(comp?.type?.abbreviation ?? '').toUpperCase();
  return SESSION_LABELS[abbr] ?? comp?.type?.text ?? '';
}

/**
 * Les trois premiers d'une séance. Chez ESPN, chaque pilote est un
 * « competitor » ; `order` donne sa position. Renvoie une liste vide si la
 * structure ne correspond pas : on n'affiche rien plutôt qu'un faux classement.
 */
function topThree(session) {
  return (session?.competitors ?? [])
    .map((c, i) => ({
      pos: Number(c?.order ?? c?.place ?? i + 1),
      name: c?.athlete?.shortName ?? c?.athlete?.displayName ?? c?.displayName ?? '',
    }))
    .filter((d) => d.name && Number.isFinite(d.pos) && d.pos > 0)
    .sort((a, b) => a.pos - b.pos)
    .slice(0, 3);
}

/** Séance en cours, sinon la prochaine, sinon la dernière du week-end. */
function pickSession(event) {
  const comps = (event?.competitions ?? []).filter((c) => c?.date);
  if (comps.length < 2) return null;
  const live = comps.find((c) => c?.status?.type?.state === 'in');
  if (live) return live;
  const upcoming = comps
    .filter((c) => c?.status?.type?.state === 'pre')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  return upcoming[0] ?? comps[comps.length - 1];
}

/** Page ESPN du match (feuille de match, statistiques), si l'API la fournit. */
function pickLink(event) {
  const links = event?.links ?? [];
  const withRel = (rel) => links.find((l) => Array.isArray(l?.rel) && l.rel.includes(rel) && l.href);
  const link = withRel('summary') ?? withRel('desktop') ?? links.find((l) => l?.href);
  const href = link?.href ?? '';
  return href.startsWith('https://') ? href : '';
}

function normalizeEvent(event, leagueId) {
  const comp = event?.competitions?.[0];
  const status = event?.status ?? comp?.status ?? {};
  const state = status?.type?.state ?? 'pre';
  const base = {
    id: String(event?.id ?? ''),
    leagueId,
    state,
    statusText: status?.type?.shortDetail ?? status?.type?.description ?? '',
    clock: state === 'in' ? status?.displayClock ?? '' : '',
    startsAt: event?.date ? new Date(event.date) : null,
    link: pickLink(event),
  };

  const competitors = comp?.competitors ?? [];
  // Une course de F1 n'a pas deux camps : on la traite comme un simple évènement.
  if (LEAGUES_BY_ID[leagueId]?.kind === 'event' || competitors.length !== 2) {
    const title = event?.shortName || event?.name || 'Évènement';
    const session = pickSession(event);
    if (!session) return { ...base, kind: 'event', title };

    const sState = session.status?.type?.state ?? base.state;
    return {
      ...base,
      kind: 'event',
      title,
      state: sState,
      // Pas de classement avant le départ : il n'existe pas encore.
      top3: sState === 'pre' ? [] : topThree(session),
      session: sessionLabel(session),
      statusText: session.status?.type?.shortDetail ?? base.statusText,
      startsAt: session.date ? new Date(session.date) : base.startsAt,
      clock: '',
    };
  }

  const home = competitors.find((c) => c.homeAway === 'home') ?? competitors[0];
  const away = competitors.find((c) => c.homeAway === 'away') ?? competitors[1];
  return {
    ...base,
    kind: 'match',
    home: normalizeCompetitor(home),
    away: normalizeCompetitor(away),
  };
}

/** Tous les évènements du jour pour une ligue, sous une forme uniforme. */
export async function fetchScoreboard(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league) return [];
  const data = await getJson(`${league.path}/scoreboard`);
  return (data?.events ?? []).map((e) => normalizeEvent(e, leagueId));
}

// Calendrier des jours à venir : il change peu, inutile de le redemander à
// chaque rafraîchissement du widget (toutes les 25 s pendant un match).
const LOOKAHEAD_DAYS = 10;
const DAY_TTL = 30 * 60 * 1000;
const dayCache = new Map(); // "ligue:AAAAMMJJ" -> { at, events }

async function fetchDay(leagueId, offsetDays) {
  const league = LEAGUES_BY_ID[leagueId];
  const date = ymd(offsetDays);
  const key = `${leagueId}:${date}`;
  const hit = dayCache.get(key);
  if (hit && Date.now() - hit.at < DAY_TTL) return hit.events;

  const data = await getJson(`${league.path}/scoreboard`, `?dates=${date}`);
  const events = (data?.events ?? []).map((e) => normalizeEvent(e, leagueId));
  dayCache.set(key, { at: Date.now(), events });
  return events;
}

/**
 * Prochain match de chacune des équipes demandées, cherché jour après jour à
 * partir de demain. S'arrête dès que toutes les équipes sont trouvées. Un
 * match entre deux équipes demandées n'est rendu qu'une fois.
 */
export async function fetchNextGames(leagueId, teamIds) {
  const missing = new Set(teamIds.map(String));
  const found = [];
  for (let start = 1; start <= LOOKAHEAD_DAYS && missing.size; start += 3) {
    const offsets = [start, start + 1, start + 2].filter((d) => d <= LOOKAHEAD_DAYS);
    const days = await Promise.allSettled(offsets.map((d) => fetchDay(leagueId, d)));
    // Dans l'ordre des jours : le match le plus proche l'emporte.
    for (const day of days) {
      if (day.status !== 'fulfilled') continue;
      for (const game of day.value) {
        if (game.kind !== 'match') continue;
        const ids = [game.home.id, game.away.id].filter((id) => missing.has(id));
        if (!ids.length) continue;
        found.push(game);
        ids.forEach((id) => missing.delete(id));
      }
    }
  }
  return found;
}

/** Données factices : aperçu navigateur et première ouverture hors ligne. */
export function demoEvents() {
  return DEMO_EVENTS.map((e) => ({ ...e, startsAt: e.startsAt ? new Date(e.startsAt) : null }));
}
