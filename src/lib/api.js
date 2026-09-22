// Accès aux données ESPN.
// Dans l'app, la requête passe par Rust (commande `espn_get`) : pas de CORS,
// et le domaine appelé est verrouillé côté Rust.
// Hors de l'app (aperçu navigateur), on retombe sur fetch() puis sur les données de démo.
import { LEAGUES_BY_ID } from './leagues.js';
import { DEMO_EVENTS } from './demo.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

function inTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI__;
}

async function getJson(path, query = '') {
  const suffix = `${path}${query}`;
  if (inTauri()) {
    const raw = await window.__TAURI__.core.invoke('espn_get', { path: suffix });
    return JSON.parse(raw);
  }
  const res = await fetch(`${BASE}/${suffix}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
