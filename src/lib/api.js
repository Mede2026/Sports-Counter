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

/** Liste des équipes d'une ligue, pour l'écran de réglages. */
export async function fetchTeams(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return [];
  const data = await getJson(`${league.path}/teams`, '?limit=200');
  const raw = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return raw
    .map((entry) => entry.team)
    .filter(Boolean)
    .map((t) => ({
      id: String(t.id),
      abbr: t.abbreviation ?? '',
      name: t.displayName ?? t.name ?? '',
      short: t.shortDisplayName ?? t.name ?? '',
      logo: t.logos?.[0]?.href ?? '',
      color: t.color ? `#${t.color}` : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
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
    return { ...base, kind: 'event', title: event?.shortName || event?.name || 'Évènement' };
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
