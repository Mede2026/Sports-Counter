// Requêtes à ESPN et petits outils communs (adresses, cache des réponses, photos).
// (Découpé de api.js : les autres fichiers importent toujours depuis api.js.)
import { LEAGUES_BY_ID } from '../leagues.js';
import { errText } from '../err.js';

export const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
export const BASE_V2 = 'https://site.api.espn.com/apis/v2/sports';

export function inTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI__;
}

export async function viaPage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function viaRust(suffix) {
  const raw = await window.__TAURI__.core.invoke('espn_get', { path: suffix });
  return JSON.parse(raw);
}

/**
 * `opts.v2` : API « v2 » d'ESPN (classements), à une autre adresse que celle
 * des scores. Le relais Rust la reconnaît au préfixe « v2/ ».
 */
// Réponses partagées : pendant un match, le widget cherche le buteur, les
// pénalités et les tirs de barrage dans le même résumé ; une seule requête
// sert tout le monde pendant 10 s. Seulement dans l'app : l'aperçu et les
// tests veulent voir chaque réponse.
export const MEMO_MS = 10 * 1000;
export const memo = new Map(); // adresse -> { at, promise }

export function getJson(path, query = '', opts = {}) {
  if (!inTauri()) return fetchJson(path, query, opts);
  const key = `${opts.v2 ? 'v2/' : ''}${path}${query}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.promise;
  const promise = fetchJson(path, query, opts);
  memo.set(key, { at: Date.now(), promise });
  // Une erreur n'est pas gardée : on réessaie au prochain appel.
  promise.catch(() => memo.delete(key));
  if (memo.size > 200) for (const [k, v] of memo) if (Date.now() - v.at >= MEMO_MS) memo.delete(k);
  return promise;
}

export async function fetchJson(path, query = '', opts = {}) {
  const suffix = `${opts.v2 ? 'v2/' : ''}${path}${query}`;
  const url = opts.v2 ? `${BASE_V2}/${path}${query}` : `${BASE}/${suffix}`;

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

export const DAY = 24 * 3600 * 1000;
export const TEAMS_TTL = 7 * DAY;
export const teamsKey = (leagueId) => `sports-counter.teams.${leagueId}.v3`;

export function toTeam(t) {
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

export const byName = (a, b) => a.name.localeCompare(b.name, 'fr');

export function readTeamsCache(leagueId) {
  try {
    const raw = localStorage.getItem(teamsKey(leagueId));
    if (!raw) return null;
    const { at, teams } = JSON.parse(raw);
    return Date.now() - at < TEAMS_TTL && teams?.length ? teams : null;
  } catch {
    return null;
  }
}

export function writeTeamsCache(leagueId, teams) {
  try {
    localStorage.setItem(teamsKey(leagueId), JSON.stringify({ at: Date.now(), teams }));
  } catch { /* stockage plein ou indisponible : on s'en passe */ }
}

/**
 * Paramètres du tableau des scores : ceux de la ligue (football universitaire :
 * toute la première division, pas seulement les matchs vedettes) et `extra`.
 */
export function boardQuery(league, extra = '') {
  const parts = [String(extra).replace(/^\?/, ''), league?.query ?? ''].filter(Boolean);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Source principale : la liste officielle des équipes de la ligue. */
export async function teamsFromDirectory(league) {
  // Pas de paramètre dans l'adresse : `/scoreboard` passe sans paramètre, alors
  // que `/teams?limit=200` était refusé. La liste complète vient de toute façon
  // sans limite.
  const data = await getJson(`${league.path}/teams`, league.teamsQuery ?? '');
  const raw = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return raw.map((entry) => entry.team).filter(Boolean).map(toTeam);
}

/**
 * Équipes par l'API « core » d'ESPN : la liste donne une adresse par équipe,
 * lue ensuite une à une (10 à la fois).
 */
export async function teamsFromCore(league) {
  const [sport, code] = league.path.split('/');
  // Football universitaire : la première division seulement (groupe 80),
  // pas les 700 équipes de toutes les divisions.
  const path = league.coreTeams ?? 'teams';
  const list = await getCore(`/v2/sports/${sport}/leagues/${code}/${path}?limit=200&lang=en&region=us`);
  const refs = (list?.items ?? []).map((x) => corePath(x?.$ref)).filter(Boolean);
  const teams = [];
  for (let i = 0; i < refs.length; i += 10) {
    const results = await Promise.allSettled(refs.slice(i, i + 10).map((r) => getCore(r.includes('?') ? r : `${r}?lang=en&region=us`)));
    for (const r of results) if (r.status === 'fulfilled' && r.value?.id) teams.push(toTeam(r.value));
  }
  return teams;
}

export const squash = (text) => String(text ?? '').normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase();
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

export const scoreText = (s) => (typeof s === 'object' ? String(s?.displayValue ?? s?.value ?? '–') : String(s));

// Tirs au but : ESPN les nomme différemment selon la source.
export const SHOT_STATS = ['shotsOnGoal', 'shots', 'shotsTotal', 'SOG'];

/** Valeur d'une statistique d'ESPN parmi plusieurs noms possibles. */
export function statOf(stats, names) {
  for (const n of names) {
    const s = (stats ?? []).find((x) => x?.name === n || x?.abbreviation === n);
    if (s?.displayValue != null && s.displayValue !== '') return String(s.displayValue);
  }
  return '';
}

/**
 * Photo d'un pilote. ESPN range les portraits de la course automobile sous
 * « rpm » ; on prend celle de la réponse quand elle y est.
 */
/**
 * Adresse de la photo d'un joueur sur les serveurs d'images d'ESPN, quand la
 * réponse n'en donne pas : ESPN la range par ligue (« nhl », « soccer »…).
 */
export function headshotUrl(leagueId, id) {
  if (!id) return '';
  const path = LEAGUES_BY_ID[leagueId]?.path ?? '';
  const dir = { f1: 'rpm', ufc: 'mma' }[leagueId]
    ?? (/^(soccer|golf|tennis)\//.exec(path)?.[1] ?? path.split('/')[1]);
  return dir ? `https://a.espncdn.com/i/headshots/${dir}/players/full/${id}.png` : '';
}

export function driverPhoto(athlete, id) {
  const href = athlete?.headshot?.href ?? athlete?.headshot ?? '';
  if (typeof href === 'string' && href.startsWith('https://')) return href;
  return id ? `https://a.espncdn.com/i/headshots/rpm/players/full/${id}.png` : '';
}

/** Le jeu est-il un but / des points ? Selon la source, ESPN le dit autrement. */
export const isScoring = (p) => p?.scoringPlay === true || /goal|but/i.test(p?.type?.text ?? '');

/** Nom du joueur qui a marqué, quelle que soit la forme de la donnée ESPN. */
export function scorerName(p) {
  const people = p?.participants ?? [];
  const scorer = people.find((x) => /scor/i.test(String(x?.type?.text ?? x?.type ?? ''))) ?? people[0];
  return scorer?.athlete?.displayName
    ?? p?.athletesInvolved?.[0]?.displayName
    ?? p?.athletesInvolved?.[0]?.shortName
    ?? '';
}

export const sportOfLeague = (leagueId) => LEAGUES_BY_ID[leagueId]?.path.split('/')[0] ?? '';

export const assistNames = (p) => (p?.participants ?? [])
  .filter((x) => /assist/i.test(String(x?.type?.text ?? x?.type ?? '')))
  .map((x) => x?.athlete?.displayName ?? x?.athlete?.shortName)
  .filter(Boolean);

export function playOf(p) {
  const period = p?.period?.number ?? p?.period ?? null;
  return {
    teamId: String(p?.team?.id ?? ''),
    period: Number(period) || null,
    clock: p?.clock?.displayValue ?? '',
    who: scorerName(p),
    assists: assistNames(p),
    text: p?.text ?? p?.shortText ?? '',
  };
}

/** Lit une partie du résumé ; en cas d'erreur, `fallback` (et la trace en console). */
export function safe(read, fallback) {
  try {
    return read() ?? fallback;
  } catch (err) {
    console.warn('Partie du résumé illisible :', err);
    return fallback;
  }
}

/** Photo d'un athlète : celle de la réponse, sinon l'adresse habituelle d'ESPN. */
export const athletePhoto = (a, leagueId) => {
  const href = a?.headshot?.href ?? a?.headshot ?? '';
  return typeof href === 'string' && href.startsWith('https://') ? href : headshotUrl(leagueId, a?.id);
};

export const WEB_API = 'https://site.web.api.espn.com/apis/common/v3/sports';
export async function getWeb(path) {
  try {
    return await viaPage(`${WEB_API}/${path}`);
  } catch (err) {
    if (!inTauri()) throw err;
    return viaRust(`web/${path}`);
  }
}

export const CORE = 'https://sports.core.api.espn.com';

/**
 * API « core » d'ESPN : page d'abord, puis relais Rust (préfixe « core/ »).
 * `path` commence par « /v2/… » (les liens $ref d'ESPN y mènent aussi).
 */
export async function getCore(path) {
  try {
    return await viaPage(`${CORE}${path}`);
  } catch (err) {
    if (!inTauri()) throw err;
    return viaRust(`core${path}`);
  }
}

/** Lien $ref d'ESPN → chemin relatif à l'API core (en https). */
export const corePath = (ref) => String(ref ?? '').replace(/^https?:\/\/sports\.core\.api\.espn\.com/, '');
