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
const teamsKey = (leagueId) => `sports-counter.teams.${leagueId}.v1`;

function toTeam(t) {
  return {
    id: String(t.id),
    abbr: t.abbreviation ?? '',
    name: t.displayName ?? t.name ?? '',
    short: t.shortDisplayName ?? t.name ?? '',
    logo: t.logo ?? t.logos?.[0]?.href ?? '',
    color: t.color ? `#${t.color}` : null,
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

/** Secours : les équipes qui jouent dans le mois écoulé et le mois à venir. */
async function teamsFromSchedule(league) {
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
  const now = Date.now();
  const data = await getJson(
    `${league.path}/scoreboard`,
    `?dates=${ymd(now - 30 * DAY)}-${ymd(now + 30 * DAY)}&limit=1000`,
  );
  const seen = new Map();
  for (const event of data?.events ?? []) {
    for (const c of event?.competitions?.[0]?.competitors ?? []) {
      if (c?.team?.id && !seen.has(String(c.team.id))) seen.set(String(c.team.id), toTeam(c.team));
    }
  }
  return [...seen.values()];
}

/** Liste des équipes d'une ligue, pour l'écran de réglages. */
export async function fetchTeams(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return [];

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
  writeTeamsCache(leagueId, teams);
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

/** Données factices : aperçu navigateur et première ouverture hors ligne. */
export function demoEvents() {
  return DEMO_EVENTS.map((e) => ({ ...e, startsAt: e.startsAt ? new Date(e.startsAt) : null }));
}
