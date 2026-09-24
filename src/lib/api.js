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
import { DEMO_EVENTS, DEMO_EXTRA } from './demo.js';
import { errText } from './err.js';
import { NHL_TEAMS } from './teams-nhl.js';
import { ordinal } from './format.js';
import { statusFr, weightFr, resultFr, segmentFr, roundFr, drawFr } from './status-fr.js';
import { diskCache } from './cache.js';
import { autoFr } from './translate.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const BASE_V2 = 'https://site.api.espn.com/apis/v2/sports';

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

/**
 * `opts.v2` : API « v2 » d'ESPN (classements), à une autre adresse que celle
 * des scores. Le relais Rust la reconnaît au préfixe « v2/ ».
 */
async function getJson(path, query = '', opts = {}) {
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

/**
 * Paramètres du tableau des scores : ceux de la ligue (football universitaire :
 * toute la première division, pas seulement les matchs vedettes) et `extra`.
 */
function boardQuery(league, extra = '') {
  const parts = [String(extra).replace(/^\?/, ''), league?.query ?? ''].filter(Boolean);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Source principale : la liste officielle des équipes de la ligue. */
async function teamsFromDirectory(league) {
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
async function teamsFromCore(league) {
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

/* ---------- Logos de secours (TheSportsDB) ---------- */

// ESPN n'a pas de logo pour certaines ligues (la LCF) : on les prend chez
// TheSportsDB, une base sportive gratuite, une fois par semaine.
const SPORTSDB = 'https://www.thesportsdb.com/api/v1/json';
// Clés publiques gratuites de TheSportsDB : « 123 » depuis 2025, « 3 » avant.
const SPORTSDB_KEYS = ['123', '3'];
const logoCache = diskCache('logos.sportsdb.v2', TEAMS_TTL);
const logoLoads = new Map();
// idLigue -> raison du dernier échec, affichée par le Diagnostic.
const logoErrors = new Map();
const squash = (text) => String(text ?? '').normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase();
// Espaces en « _ » et rien d'autre que des lettres : le relais Rust n'accepte
// que des adresses simples, et TheSportsDB comprend les « _ ».
const tsdbName = (text) => String(text ?? '').normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '_');

async function getSportsDb(query) {
  let lastErr = null;
  for (const key of SPORTSDB_KEYS) {
    try {
      let data;
      try {
        data = await viaPage(`${SPORTSDB}/${key}/${query}`);
      } catch (err) {
        if (!inTauri()) throw err;
        data = await viaRust(`tsdb/${key}/${query}`);
      }
      if (data && typeof data === 'object') return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('réponse vide');
}

const tsdbTeams = (data) => (data?.teams ?? [])
  .map((t) => ({ name: squash(t?.strTeam), alt: squash(t?.strTeamAlternate), league: squash(t?.strLeague), logo: t?.strBadge ?? t?.strTeamBadge ?? t?.strLogo ?? '' }))
  .filter((t) => t.name && /^https:\/\//.test(t.logo));

/** Logos de la ligue chez TheSportsDB : [{ name, alt, logo }] (noms tassés). */
function sportsDbLogos(league) {
  if (!league?.sportsDb) return Promise.resolve([]);
  const hit = logoCache.get(league.id);
  if (hit) return Promise.resolve(hit);
  if (!logoLoads.has(league.id)) {
    const load = (async () => {
      const errors = [];
      // Toute la ligue d'un coup : par son nom, puis par son numéro.
      const queries = [`search_all_teams.php?l=${tsdbName(league.sportsDb)}`];
      if (league.sportsDbId) queries.push(`lookup_all_teams.php?id=${league.sportsDbId}`);
      for (const q of queries) {
        try {
          const list = tsdbTeams(await getSportsDb(q));
          if (list.length) {
            logoCache.set(league.id, list);
            logoErrors.delete(league.id);
            return list;
          }
          errors.push(`${q.split('.')[0]} : aucune équipe`);
        } catch (err) {
          errors.push(`${q.split('.')[0]} : ${errText(err).split('\n')[0]}`);
        }
      }
      logoErrors.set(league.id, errors.join(' · '));
      return [];
    })().finally(() => logoLoads.delete(league.id));
    logoLoads.set(league.id, load);
  }
  return logoLoads.get(league.id);
}

/** Dernier recours : chercher une équipe par son nom chez TheSportsDB. */
async function sportsDbTeamLogo(league, team) {
  const names = [team.full, team.name].filter((n) => n && n.length > 3);
  for (const name of names) {
    try {
      // Seulement les équipes de cette ligue : « Edmonton » ne doit pas donner les Oilers.
      const list = tsdbTeams(await getSportsDb(`searchteams.php?t=${tsdbName(name)}`))
        .filter((t) => !t.league || t.league === squash(league.sportsDb));
      const logo = matchLogo(list, team.full, team.name, team.short) || (list.length === 1 ? list[0].logo : '');
      if (logo) return { name: squash(name), alt: '', logo };
    } catch (err) {
      if (!logoErrors.has(league.id)) logoErrors.set(league.id, `searchteams : ${errText(err).split('\n')[0]}`);
    }
  }
  return null;
}

// Photos de joueurs de secours (TheSportsDB), quand ESPN n'a pas de portrait
// (joueurs des équipes nationales, par exemple). Gardées 30 jours, même
// quand rien n'est trouvé : on ne redemande pas sans cesse le même nom.
const playerPhotoCache = diskCache('photos.sportsdb', 30 * DAY);
const playerPhotoLoads = new Map();

/** Photo d'un joueur chez TheSportsDB, d'après son nom ; '' si introuvable. */
export function sportsDbPlayerPhoto(name) {
  const key = squash(name);
  if (key.length < 5) return Promise.resolve('');
  const hit = playerPhotoCache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (!playerPhotoLoads.has(key)) {
    const load = getSportsDb(`searchplayers.php?p=${tsdbName(name)}`)
      .then((data) => {
        const players = (data?.player ?? data?.players ?? []).filter((p) => p && typeof p === 'object');
        const same = players.filter((p) => squash(p.strPlayer) === key);
        const pick = same.length === 1 ? same[0] : players.length === 1 ? players[0] : null;
        const photo = [pick?.strCutout, pick?.strThumb, pick?.strRender].find((u) => typeof u === 'string' && u.startsWith('https://')) ?? '';
        playerPhotoCache.set(key, photo);
        return photo;
      })
      .catch(() => '') // réseau : on réessaiera à la prochaine ouverture
      .finally(() => playerPhotoLoads.delete(key));
    playerPhotoLoads.set(key, load);
  }
  return playerPhotoLoads.get(key);
}

/** Pourquoi les logos de secours manquent, pour le Diagnostic ('' si tout va bien). */
export const logoError = (leagueId) => logoErrors.get(leagueId) ?? '';

/** Le logo d'une équipe d'après son nom complet, puis son surnom (« Alouettes »). */
export function matchLogo(list, ...names) {
  for (const raw of names) {
    const q = squash(raw);
    if (q.length < 3) continue;
    const exact = list.find((t) => t.name === q || t.alt === q);
    if (exact) return exact.logo;
    if (q.length < 4) continue;
    const near = list.filter((t) => t.name.endsWith(q) || t.name.startsWith(q));
    if (near.length === 1) return near[0].logo;
  }
  return '';
}

// Après un échec, TheSportsDB n'est pas réinterrogé avant 30 min : le widget
// rafraîchit toutes les 25 s pendant un match.
const LOGO_RETRY_MS = 30 * 60 * 1000;
const logoFailedAt = new Map();

/** Complète, sur place, les logos manquants d'une liste d'équipes. */
async function fillLogos(leagueId, teams) {
  const league = LEAGUES_BY_ID[leagueId];
  const missing = teams.filter((t) => t && !t.logo);
  if (!league?.sportsDb || !missing.length) return teams;
  // Puis le surnom seul (« Lions » pour « British Columbia Lions »), et en
  // dernier la ville : une équipe renommée (Eskimos → Elks) garde sa ville.
  const words = (t) => String(t.full || t.name || '').trim().split(/\s+/);
  const apply = (list) => missing.forEach((t) => {
    if (!t.logo) t.logo = matchLogo(list, t.full, t.name, t.short, words(t).slice(-1)[0], words(t)[0]);
  });

  // 1. Ce qu'on sait déjà (gardé une semaine) : aucune requête.
  apply(logoCache.get(leagueId) ?? []);
  if (missing.every((t) => t.logo)) return teams;
  if (Date.now() - (logoFailedAt.get(leagueId) ?? 0) < LOGO_RETRY_MS) return teams;

  // 2. Toute la ligue d'un coup.
  const list = await sportsDbLogos(league);
  apply(list);

  // 3. Une recherche par équipe restante (au plus 12), gardée avec les autres.
  const still = missing.filter((t) => !t.logo).slice(0, 12);
  if (still.length) {
    const found = (await Promise.all(still.map((t) => sportsDbTeamLogo(league, t)))).filter(Boolean);
    if (found.length) {
      const merged = [...(logoCache.get(leagueId) ?? list), ...found];
      logoCache.set(leagueId, merged);
      apply(merged);
    }
  }
  if (missing.some((t) => !t.logo)) logoFailedAt.set(leagueId, Date.now());
  else logoFailedAt.delete(leagueId);
  return teams;
}

/** Même chose pour les deux équipes de chaque match. */
async function fillGameLogos(leagueId, games) {
  await fillLogos(leagueId, games.flatMap((g) => [g?.home, g?.away]).filter(Boolean));
  return games;
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
    absorb(await getJson(`${league.path}/scoreboard`, boardQuery(league, `?dates=${ymd(-7)}-${ymd(14)}`)));
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
      batch.map((d) => getJson(`${league.path}/scoreboard`, boardQuery(league, `?dates=${ymd(d)}`))),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') absorb(r.value);
      else if (errors.length < 3) errors.push(`jour : ${errText(r.reason)}`);
    }
  }

  // 3. Ligue hors saison (WNBA l'hiver, MLS en décembre) : on remonte le
  //    temps par tranches de deux semaines, jusqu'à dix mois en arrière, pour
  //    retrouver les équipes de la dernière saison.
  const ranges = [];
  for (let end = -31; end > -310; end -= 14) ranges.push([end - 13, end]);
  for (let i = 0; i < ranges.length && seen.size < target; i += 4) {
    const results = await Promise.allSettled(
      ranges.slice(i, i + 4).map(([a, b]) => getJson(`${league.path}/scoreboard`, boardQuery(league, `?dates=${ymd(a)}-${ymd(b)}`))),
    );
    for (const r of results) if (r.status === 'fulfilled') absorb(r.value);
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
  if (cached) return fillLogos(leagueId, cached);

  // Trois sources, dans l'ordre, jusqu'à avoir toute la ligue : une liste
  // partielle est complétée par la suivante au lieu d'être gardée telle quelle.
  const target = league.teams || 1;
  const byId = new Map();
  const merge = (list) => list.forEach((t) => {
    const had = byId.get(t.id);
    // Même équipe vue deux fois : on garde le logo et les couleurs trouvés.
    byId.set(t.id, had ? { ...t, ...Object.fromEntries(Object.entries(had).filter(([, v]) => v)) } : t);
  });
  let directoryErr = null;
  try {
    merge(await teamsFromDirectory(league));
  } catch (err) {
    directoryErr = err;
  }

  // 2. Liste refusée ou incomplète (la LNH et la LCF, par exemple) : l'API
  //    « core » d'ESPN, qui donne aussi les équipes, une adresse par équipe.
  if (byId.size < target) {
    try {
      merge(await teamsFromCore(league));
    } catch { /* on passe au calendrier */ }
  }

  // 3. Les équipes vues au calendrier.
  if (byId.size < target) {
    try {
      merge(await teamsFromSchedule(league));
    } catch (err) {
      if (!byId.size) {
        throw new Error(
          `Liste : ${errText(directoryErr ?? 'vide')}\nCalendrier : ${errText(err)}`,
        );
      }
    }
  }

  const teams = [...byId.values()];
  if (!teams.length) throw new Error(errText(directoryErr ?? 'aucune équipe trouvée'));

  teams.sort(byName);
  await fillLogos(leagueId, teams);
  // Une liste incomplète (ligue hors saison, peu de matchs au calendrier) n'est
  // pas gardée : on retentera à la prochaine ouverture des réglages.
  if (teams.length >= (league.teams ?? 0)) writeTeamsCache(leagueId, teams);
  return teams;
}

function normalizeCompetitor(c, state) {
  const t = c?.team ?? {};
  return {
    id: String(t.id ?? ''),
    abbr: t.abbreviation ?? t.shortDisplayName ?? '???',
    name: t.shortDisplayName ?? t.displayName ?? '',
    full: t.displayName ?? '',
    logo: t.logo ?? t.logos?.[0]?.href ?? '',
    color: t.color ? `#${t.color}` : null,
    alt: t.alternateColor ? `#${t.alternateColor}` : null,
    // Avant le coup d'envoi, ESPN envoie « 0 » : on affiche « – ». Dans le
    // calendrier d'une équipe, le score est un objet { value, displayValue }.
    score: state !== 'pre' && c?.score != null ? scoreText(c.score) : '–',
    winner: c?.winner === true,
    record: recordOf(c),
    shots: statOf(c?.statistics, SHOT_STATS),
  };
}

const scoreText = (s) => (typeof s === 'object' ? String(s?.displayValue ?? s?.value ?? '–') : String(s));

/** Fiche de l'équipe (« 12-5-3 »), sous l'une ou l'autre forme d'ESPN. */
function recordOf(c) {
  const list = c?.records ?? c?.record ?? [];
  if (!Array.isArray(list)) return '';
  const total = list.find((r) => /total|overall/i.test(`${r?.type ?? ''} ${r?.name ?? ''}`)) ?? list[0];
  return total?.summary ?? total?.displayValue ?? '';
}

// Tirs au but : ESPN les nomme différemment selon la source.
const SHOT_STATS = ['shotsOnGoal', 'shots', 'shotsTotal', 'SOG'];

/** Valeur d'une statistique d'ESPN parmi plusieurs noms possibles. */
function statOf(stats, names) {
  for (const n of names) {
    const s = (stats ?? []).find((x) => x?.name === n || x?.abbreviation === n);
    if (s?.displayValue != null && s.displayValue !== '') return String(s.displayValue);
  }
  return '';
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
  return SESSION_LABELS[abbr] ?? autoFr(comp?.type?.text ?? '');
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

/** Un pilote, tel qu'ESPN le décrit dans une séance. */
function toDriver(c, i) {
  const a = c?.athlete ?? {};
  const id = String(a.id ?? c?.id ?? '');
  return {
    id,
    pos: Number(c?.order ?? c?.place ?? i + 1),
    name: a.displayName ?? c?.displayName ?? '',
    short: a.shortName ?? a.displayName ?? c?.displayName ?? '',
    photo: driverPhoto(a, id),
    flag: a.flag?.href ?? '',
    team: c?.vehicle?.manufacturer ?? c?.team?.displayName ?? c?.team?.name ?? '',
    gap: gapOf(c),
    // Arrêts aux puits, quand ESPN les compte (nom de statistique variable).
    pits: Number(statOf(c?.statistics, PIT_STATS)) || 0,
  };
}

const PIT_STATS = ['pitStops', 'pits', 'pitstops', 'numPitStops', 'stops'];

/**
 * Drapeau d'une séance de F1 d'après le statut d'ESPN : 'red' (drapeau
 * rouge), 'sc' (voiture de sécurité), 'vsc' (voiture de sécurité virtuelle)
 * ou '' (course normale).
 */
export function flagOf(status) {
  const t = status?.type ?? {};
  const text = `${t.name ?? ''} ${t.description ?? ''} ${t.detail ?? ''} ${t.shortDetail ?? ''}`;
  if (/red[ _-]?flag/i.test(text)) return 'red';
  if (/virtual/i.test(text)) return 'vsc';
  if (/safety[ _-]?car|caution|yellow[ _-]?flag/i.test(text)) return 'sc';
  return '';
}

// Écart avec le meneur : ESPN le range sous des noms variables selon la séance.
const GAP_STATS = ['behindTime', 'behind', 'gapToLeader', 'timeBehind', 'gap', 'interval'];

function gapOf(c) {
  const direct = c?.behindTime ?? c?.behind ?? c?.gap;
  if (direct != null && typeof direct !== 'object' && String(direct) !== '') return String(direct);
  return statOf(c?.statistics, GAP_STATS);
}

/**
 * Classement complet d'une séance. Chez ESPN, chaque pilote est un
 * « competitor » ; `order` donne sa position. Liste vide si la structure ne
 * correspond pas : on n'affiche rien plutôt qu'un faux classement.
 */
function classification(session) {
  return (session?.competitors ?? [])
    .map(toDriver)
    .filter((d) => d.name && Number.isFinite(d.pos) && d.pos > 0)
    .sort((a, b) => a.pos - b.pos);
}

/**
 * Même personne (pilote, joueur, combattant) ? Deux identifiants ESPN
 * connus décident seuls : deux « Silva » différents ne se confondent pas.
 * Sinon (buteur connu par son nom seulement, favori ajouté à la main), le
 * nom de famille suffit, quelle que soit la forme du prénom.
 */
export function sameDriver(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return String(a.id) === String(b.id);
  const last = (d) => String(d.name || d.short || '').trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  return !!last(a) && last(a) === last(b);
}

/** Toutes les séances du week-end, pour la fenêtre de détail. */
function weekendSessions(event) {
  return (event?.competitions ?? [])
    .filter((c) => c?.date)
    .map((c) => {
      const state = c?.status?.type?.state ?? 'pre';
      return {
        id: String(c?.id ?? ''),
        label: sessionLabel(c),
        startsAt: new Date(c.date),
        state,
        // Classement de chaque séance (essais, qualifs, sprint, course).
        results: state === 'pre' ? [] : classification(c),
      };
    })
    .sort((a, b) => a.startsAt - b.startsAt);
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

/** Le jeu est-il un but / des points ? Selon la source, ESPN le dit autrement. */
const isScoring = (p) => p?.scoringPlay === true || /goal|but/i.test(p?.type?.text ?? '');

/** Nom du joueur qui a marqué, quelle que soit la forme de la donnée ESPN. */
function scorerName(p) {
  const people = p?.participants ?? [];
  const scorer = people.find((x) => /scor/i.test(String(x?.type?.text ?? x?.type ?? ''))) ?? people[0];
  return scorer?.athlete?.displayName
    ?? p?.athletesInvolved?.[0]?.displayName
    ?? p?.athletesInvolved?.[0]?.shortName
    ?? '';
}

/**
 * Dernier buteur de chaque équipe, si le tableau des scores le fournit
 * (champ `details`, présent au soccer). Sinon, objet vide.
 */
function lastScorers(comp) {
  const out = {};
  for (const d of comp?.details ?? []) {
    const team = d?.team?.id != null ? String(d.team.id) : null;
    const name = isScoring(d) ? scorerName(d) : '';
    if (team && name) out[team] = name;
  }
  return out;
}

/**
 * Dernier but d'une équipe, lu dans le résumé détaillé du match : { scorer,
 * assists }. Sert quand le tableau des scores ne donne pas les noms (au
 * hockey). Noms vides si ESPN ne les fournit pas ou si l'adresse est illisible.
 */
export async function fetchGoal(leagueId, eventId, teamId) {
  const none = { scorer: '', assists: [], goals: 0, text: '' };
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !eventId) return none;
  try {
    const data = await getJson(`${league.path}/summary`, `?event=${encodeURIComponent(eventId)}`);
    const pools = [data?.scoringPlays, data?.plays, data?.keyEvents, data?.header?.competitions?.[0]?.details];
    let last = null;
    let used = [];
    for (const pool of pools) {
      for (const p of pool ?? []) {
        if (isScoring(p) && String(p?.team?.id ?? '') === String(teamId)) last = p;
      }
      used = pool ?? [];
      if (last) break; // première source qui connaît le but : on s'y tient
    }
    if (!last) return none;
    const scorer = scorerName(last);
    // Buts de ce joueur dans le match, celui-ci compris (3 = tour du chapeau).
    const goals = scorer ? used.filter((p) => isScoring(p) && scorerName(p) === scorer).length : 0;
    return { scorer, assists: assistNames(last), goals, text: String(last?.text ?? last?.shortText ?? '') };
  } catch {
    return none;
  }
}

/** Logo de la ligue fourni par ESPN (sert pour la F1), variante sombre d'abord. */
function leagueLogo(data) {
  const logos = data?.leagues?.[0]?.logos ?? [];
  const dark = logos.find((l) => Array.isArray(l?.rel) && l.rel.includes('dark') && l.href);
  return (dark ?? logos.find((l) => l?.href))?.href ?? '';
}

/* ---------- Hockey : statut en français et séries éliminatoires ---------- */


/**
 * Statut d'un match de hockey en français, à partir de la période. ESPN
 * l'écrit en anglais (« 7:42 - 2nd », « Final/OT »). En saison, la 4e période
 * est la prolongation et la 5e les tirs de barrage ; en séries, on joue des
 * prolongations jusqu'au but gagnant (4e = 1re prolongation, 5e = 2e…).
 */
export function hockeyStatus({ state, period, clock, detail }, playoffs) {
  // Période absente : on la lit dans le texte d'ESPN (« 20:00 - 3rd », « OT »).
  let p = Number(period) || 0;
  if (!p) {
    const m = /\b(\d)(?:st|nd|rd|th)\b|\b(OT|SO)\b/i.exec(detail ?? '');
    p = m ? (m[1] ? Number(m[1]) : m[2].toUpperCase() === 'OT' ? 4 : 5) : 0;
  }
  const periodName = (n) =>
    n <= 3 ? `${ordinal(n)} période`
    : playoffs ? `${ordinal(n - 3)} prolongation`
    : n === 4 ? 'Prolongation' : 'Tirs de barrage';

  if (state === 'post') {
    if (p <= 3) return 'Final';
    if (playoffs) return p === 4 ? 'Final (prol.)' : `Final (${ordinal(p - 3)} prol.)`;
    return p === 4 ? 'Final (prol.)' : 'Final (TB)';
  }
  if (state === 'in' && p > 0) {
    if (/end of|intermission/i.test(detail ?? '')) return `Fin de la ${periodName(p)}`;
    // Horloge encore à 20:00 : la période n'a pas commencé (fin de l'entracte).
    if (p <= 3 && /^20:00$/.test(String(clock ?? '').trim())) return `Début de la ${periodName(p)}`;
    return periodName(p);
  }
  return null; // à venir : l'heure est formatée ailleurs
}

const ROUNDS = [
  [/stanley cup final/i, 'Finale de la Coupe Stanley'],
  [/(conference|conf\.?|east|west)[^-]*final/i, "Finale d'association"],
  [/2nd round|second round/i, '2e ronde'],
  [/1st round|first round/i, '1re ronde'],
];

/**
 * État d'une série éliminatoire, si ESPN la décrit (`series`, `notes`).
 * Construit en français à partir des victoires de chaque équipe plutôt que
 * de reprendre le résumé anglais. null hors séries.
 */
function seriesInfo(comp, homeC, awayC) {
  const s = comp?.series;
  if (!s) return null;
  const wins = new Map((s.competitors ?? []).map((c) => [String(c?.id), Number(c?.wins ?? 0)]));
  const h = homeC?.team ?? {};
  const a = awayC?.team ?? {};
  const hw = wins.get(String(h.id));
  const aw = wins.get(String(a.id));
  if (hw == null || aw == null) return null;

  const hi = Math.max(hw, aw);
  const lo = Math.min(hw, aw);
  const leader = hw > aw ? h : aw > hw ? a : null;
  // Série au meilleur de 7 : 4 victoires la gagnent.
  const done = s.completed === true || hi >= 4;
  const text = !leader ? `Série égale ${hw}-${aw}`
    : `${leader.abbreviation} ${done ? 'remporte' : 'mène'} la série ${hi}-${lo}`;

  const headline = comp?.notes?.[0]?.headline ?? '';
  const game = Number(/game\s+(\d+)/i.exec(headline)?.[1]) || null;
  const round = ROUNDS.find(([re]) => re.test(headline))?.[1] ?? '';
  return { text, round, game, done, leaderId: leader ? String(leader.id) : null };
}

/** Page ESPN du match (feuille de match, statistiques), si l'API la fournit. */
function pickLink(event) {
  const links = event?.links ?? [];
  const withRel = (rel) => links.find((l) => Array.isArray(l?.rel) && l.rel.includes(rel) && l.href);
  const link = withRel('summary') ?? withRel('desktop') ?? links.find((l) => l?.href);
  const href = link?.href ?? '';
  return href.startsWith('https://') ? href : '';
}

/**
 * Horloge d'un match en cours. Vide à l'entracte (ESPN laisse 0:00) et au
 * baseball, qui n'a pas d'horloge (ESPN y met aussi 0:00).
 */
function liveClock(leagueId, state, frStatus, clock, statusText = '') {
  if (state !== 'in' || /^(Fin|Début) de/.test(frStatus ?? '')) return '';
  if (LEAGUES_BY_ID[leagueId]?.path.startsWith('baseball/')) return '';
  // Déjà dans le statut (« 7:42 · 3e quart ») : pas deux fois la même heure.
  if (clock && String(statusText).includes(clock)) return '';
  return clock ?? '';
}

/* ---------- UFC : galas et combats ---------- */

/** Un combattant, tel qu'ESPN le décrit dans un combat. */
function fighterOf(c) {
  const a = c?.athlete ?? {};
  const id = String(a.id ?? c?.id ?? '');
  const photo = a.headshot?.href ?? headshotUrl('ufc', id);
  return {
    id,
    name: a.displayName ?? a.fullName ?? c?.displayName ?? '',
    short: a.shortName ?? a.displayName ?? '',
    photo,
    flag: a.flag?.href ?? '',
    record: recordOf(c),
    winner: c?.winner === true,
  };
}

/** Un combat : les deux combattants, la catégorie, l'état et le résultat. */
function fightOf(comp) {
  const st = comp?.status ?? {};
  const [a, b] = [...(comp?.competitors ?? [])]
    .sort((x, y) => (x?.order ?? 0) - (y?.order ?? 0))
    .map(fighterOf);
  const state = st.type?.state ?? 'pre';
  return {
    id: String(comp?.id ?? ''),
    a,
    b,
    state,
    round: Number(st.period) || null,
    clock: st.displayClock ?? '',
    // « KO/TKO », « Décision unanime »… quand ESPN le précise.
    result: state === 'post'
      ? resultFr(st.result?.displayName ?? st.result?.name ?? st.type?.detail ?? st.type?.shortDetail ?? '')
      : '',
    weight: weightFr(comp?.type?.text ?? comp?.note ?? ''),
    segment: segmentFr(comp?.cardSegment?.description ?? comp?.cardSegment?.name ?? ''),
    startsAt: comp?.date ? new Date(comp.date) : null,
  };
}

/**
 * Un gala de l'UFC. Le combat principal est le dernier de la soirée ; le
 * gala est « en cours » dès qu'un combat a commencé et jusqu'au dernier.
 */
function normalizeCard(event, base, logo) {
  const fights = (event?.competitions ?? []).map(fightOf).filter((f) => f.a?.name && f.b?.name);
  const byTime = [...fights].sort((x, y) => (x.startsAt?.getTime() ?? 0) - (y.startsAt?.getTime() ?? 0));
  const main = byTime.at(-1) ?? null;
  const live = fights.find((f) => f.state === 'in') ?? null;
  const allDone = fights.length > 0 && fights.every((f) => f.state === 'post');
  const started = fights.some((f) => f.state !== 'pre');
  const state = allDone ? 'post' : started ? 'in' : 'pre';
  return {
    ...base,
    kind: 'card',
    title: event?.name || event?.shortName || 'UFC',
    logo,
    state,
    main,
    live,
    // Début du gala (premier combat) ; le combat principal a sa propre heure.
    startsAt: byTime[0]?.startsAt ?? base.startsAt,
    mainAt: main?.startsAt ?? null,
    fights: [...byTime].reverse(), // combat principal en premier
    session: '',
    statusText: live ? `Round ${live.round ?? 1}${live.clock ? ` · ${live.clock}` : ''}` : allDone ? 'Gala terminé' : started ? 'Entre deux combats' : '',
    clock: '',
  };
}

/* ---------- Golf : un tournoi, son tableau des meneurs ---------- */

/** Un golfeur au tableau : rang (« T3 »), score par rapport à la normale. */
function golferOf(c, i) {
  // Épreuve par équipes (Coupe des Présidents, Ryder Cup) : une équipe, pas un joueur.
  if (!c?.athlete && c?.team) {
    const t = c.team;
    const raw = typeof c?.score === 'object' ? c.score?.displayValue ?? c.score?.value : c?.score;
    return {
      id: String(t.id ?? c?.id ?? ''), team: true, name: t.displayName ?? t.name ?? '', short: t.abbreviation ?? t.shortDisplayName ?? '',
      photo: t.logo ?? t.logos?.[0]?.href ?? '', flag: '', order: Number(c?.order) || i + 1, pos: i + 1, posText: '',
      score: raw == null ? '' : String(raw), thru: '', winner: c?.winner === true,
    };
  }
  const a = c?.athlete ?? {};
  const id = String(a.id ?? c?.id ?? '');
  const raw = typeof c?.score === 'object' ? c.score?.displayValue ?? c.score?.value : c?.score;
  const score = raw == null || raw === '' ? '' : String(raw) === '0' ? 'E' : String(raw);
  const posText = String(c?.status?.position?.displayName ?? c?.position?.displayName ?? '');
  const order = Number(c?.order ?? c?.sortOrder) || i + 1;
  return {
    id,
    name: a.displayName ?? a.fullName ?? '',
    short: a.shortName ?? a.displayName ?? '',
    photo: a.headshot?.href ?? headshotUrl('pga', id),
    flag: a.flag?.href ?? '',
    order,
    pos: Number(posText.replace(/\D/g, '')) || order,
    posText: posText || String(order),
    score: score === 'E' || /^[+-]/.test(score) ? score : score && Number(score) > 0 ? `+${score}` : score,
    thru: String(c?.status?.thru ?? c?.status?.displayThru ?? ''),
  };
}

function normalizeGolf(event, base, logo) {
  const comp = event?.competitions?.[0] ?? {};
  const status = comp.status ?? event?.status ?? {};
  const state = status?.type?.state ?? base.state;
  const players = (comp.competitors ?? []).map(golferOf).filter((p) => p.name).sort((x, y) => x.order - y.order);
  const round = Number(status?.period) || null;
  return {
    ...base,
    kind: 'golf',
    // Coupe des Présidents, Ryder Cup : deux équipes et leurs points.
    teamEvent: players.length > 0 && players.every((p) => p.team),
    // Un tournoi commence « le jeudi », sans heure : ESPN met minuit.
    allDay: true,
    state,
    title: event?.name || event?.shortName || 'Tournoi',
    logo,
    round,
    players: players.slice(0, 70),
    leader: state === 'pre' ? null : players[0] ?? null,
    session: round && state !== 'pre' ? `Ronde ${round}` : '',
    // En cours, la ronde est déjà dans `session` : pas deux fois « Ronde 3 ».
    statusText: state === 'post' ? 'Terminé' : state === 'in' ? (round ? '' : 'En cours') : base.statusText,
    clock: '',
  };
}

/* ---------- Tennis : un match par rencontre ---------- */

function tennisPlayer(c, leagueId) {
  const a = c?.athlete ?? c?.roster?.athletes?.[0] ?? {};
  const id = String(a.id ?? c?.id ?? '');
  return {
    id,
    name: a.displayName ?? a.fullName ?? c?.displayName ?? '',
    short: a.shortName ?? a.displayName ?? '',
    photo: a.headshot?.href ?? headshotUrl(leagueId, id),
    flag: a.flag?.href ?? '',
    seed: Number(c?.seed ?? c?.curatedRank?.current) || null,
    winner: c?.winner === true,
    // Jeux gagnés dans chaque manche.
    sets: (c?.linescores ?? []).map((l) => Number(l?.value ?? l?.displayValue)).filter(Number.isFinite),
  };
}

/**
 * Les matchs de simple d'un tournoi (ESPN les range par tableau :
 * « Men's Singles », « Women's Singles »…). Les doubles sont laissés de côté.
 */
function normalizeTennis(event, leagueId, logo) {
  const groups = event?.groupings?.length
    ? event.groupings
    : [{ grouping: { displayName: '' }, competitions: event?.competitions ?? [] }];
  const tournament = event?.name || event?.shortName || 'Tournoi';
  const out = [];
  for (const grp of groups) {
    const draw = grp?.grouping?.displayName ?? grp?.displayName ?? '';
    if (/double/i.test(draw)) continue;
    for (const comp of grp?.competitions ?? []) {
      const cs = [...(comp?.competitors ?? [])].sort((x, y) => (x?.order ?? 0) - (y?.order ?? 0));
      if (cs.length !== 2) continue;
      const [a, b] = cs.map((c) => tennisPlayer(c, leagueId));
      if (!a.name || !b.name) continue;
      const st = comp?.status ?? {};
      const state = st?.type?.state ?? 'pre';
      out.push({
        id: String(comp?.id ?? `${a.id}-${b.id}`),
        leagueId,
        kind: 'tennis',
        state,
        title: tournament,
        draw: drawFr(draw),
        round: roundFr(comp?.round?.displayName ?? comp?.type?.text ?? ''),
        a,
        b,
        statusText: state === 'post' ? 'Terminé' : statusFr(st?.type?.shortDetail ?? ''),
        startsAt: comp?.date ? new Date(comp.date) : comp?.startDate ? new Date(comp.startDate) : null,
        link: pickLink(comp) || pickLink(event),
        logo,
        session: '',
        clock: '',
      });
    }
  }
  return out;
}

/** Évènements d'ESPN → matchs de l'app (un tournoi de tennis en donne plusieurs). */
function normalizeEvents(event, leagueId, logo = '') {
  // Un évènement décrit autrement que prévu est laissé de côté, sans
  // empêcher d'afficher les autres matchs de la ligue.
  try {
    if (LEAGUES_BY_ID[leagueId]?.kind === 'tennis') return normalizeTennis(event, leagueId, logo);
    return [normalizeEvent(event, leagueId, logo)];
  } catch (err) {
    console.warn('Évènement illisible :', leagueId, event?.id, err);
    return [];
  }
}

function normalizeEvent(event, leagueId, logo = '') {
  const comp = event?.competitions?.[0];
  const status = event?.status ?? comp?.status ?? {};
  const state = status?.type?.state ?? 'pre';
  // Saison de type 3 = séries éliminatoires chez ESPN.
  const playoffs = Number(event?.season?.type) === 3 || !!comp?.series;
  const frStatus = leagueId === 'nhl'
    ? hockeyStatus({ state, period: status?.period, clock: status?.displayClock, detail: status?.type?.shortDetail }, playoffs)
    : null;
  const statusText = frStatus ?? statusFr(status?.type?.shortDetail ?? status?.type?.description ?? '');
  const base = {
    id: String(event?.id ?? ''),
    leagueId,
    state,
    statusText,
    playoffs,
    clock: liveClock(leagueId, state, frStatus, status?.displayClock, statusText),
    period: Number(status?.period) || null,
    startsAt: event?.date ? new Date(event.date) : null,
    link: pickLink(event),
  };

  // UFC : un gala = un évènement, un combat = une « competition ».
  if (LEAGUES_BY_ID[leagueId]?.kind === 'card') return normalizeCard(event, base, logo);
  if (LEAGUES_BY_ID[leagueId]?.kind === 'golf') return normalizeGolf(event, base, logo);

  const competitors = comp?.competitors ?? [];
  // Une course de F1 n'a pas deux camps : on la traite comme un simple évènement.
  if (LEAGUES_BY_ID[leagueId]?.kind === 'event' || competitors.length !== 2) {
    const title = event?.shortName || event?.name || 'Évènement';
    const session = pickSession(event);
    if (!session) return { ...base, kind: 'event', title, logo };

    const sState = session.status?.type?.state ?? base.state;
    // Pas de classement avant le départ : il n'existe pas encore.
    const results = sState === 'pre' ? [] : classification(session);
    return {
      ...base,
      kind: 'event',
      title,
      logo,
      state: sState,
      results,
      top3: results.slice(0, 3),
      sessions: weekendSessions(event),
      // Tour en cours / total, quand ESPN le donne (course et sprint).
      laps: session.status?.period && session.laps ? `Tour ${session.status.period} / ${session.laps}` : '',
      session: sessionLabel(session),
      flag: flagOf(session.status),
      statusText: statusFr(session.status?.type?.shortDetail ?? '') || base.statusText,
      startsAt: session.date ? new Date(session.date) : base.startsAt,
      clock: '',
    };
  }

  const home = competitors.find((c) => c.homeAway === 'home') ?? competitors[0];
  const away = competitors.find((c) => c.homeAway === 'away') ?? competitors[1];
  return {
    ...base,
    kind: 'match',
    home: normalizeCompetitor(home, base.state),
    away: normalizeCompetitor(away, base.state),
    scorers: lastScorers(comp),
    series: seriesInfo(comp, home, away),
  };
}

/** Tous les évènements du jour pour une ligue, sous une forme uniforme. */
export async function fetchScoreboard(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league) return [];
  const data = await getJson(`${league.path}/scoreboard`, boardQuery(league));
  const logo = league.logo || leagueLogo(data);
  return fillGameLogos(leagueId, (data?.events ?? []).flatMap((e) => normalizeEvents(e, leagueId, logo)));
}

// Calendrier des jours à venir : il change peu, inutile de le redemander à
// chaque rafraîchissement du widget (toutes les 25 s pendant un match).
// Horizon d'affichage : le widget ne montre que les matchs des 4 prochains
// jours. Au-delà, inutile de chercher.
export const LOOKAHEAD_DAYS = 4;
const DAY_TTL = 30 * 60 * 1000;
// "ligue:AAAAMMJJ" -> matchs du jour, gardés sur le disque 30 min.
const dayCache = diskCache('days', DAY_TTL);

async function fetchDay(leagueId, offsetDays) {
  const league = LEAGUES_BY_ID[leagueId];
  const date = ymd(offsetDays);
  const key = `${leagueId}:${date}`;
  const hit = dayCache.get(key);
  if (hit) return hit;

  const data = await getJson(`${league.path}/scoreboard`, boardQuery(league, `?dates=${date}`));
  const logo = league.logo || leagueLogo(data);
  const events = await fillGameLogos(leagueId, (data?.events ?? []).flatMap((e) => normalizeEvents(e, leagueId, logo)));
  dayCache.set(key, events);
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

/* ---------- Fenêtre de détail d'un match ---------- */

// Statistiques d'équipe, dans l'ordre d'affichage, avec leur nom en français.
// Les noms absents de cette liste sont ignorés : la fenêtre reste lisible.
const STAT_LABELS = {
  hockey: [
    ['shotsTotal', 'Tirs au but'], ['shots', 'Tirs au but'], ['powerPlayGoals', 'Buts en avantage numérique'],
    ['powerPlayOpportunities', 'Avantages numériques'], ['faceoffPercent', 'Mises en jeu (%)'],
    ['faceoffsWon', 'Mises en jeu gagnées'], ['hits', 'Mises en échec'], ['blockedShots', 'Tirs bloqués'],
    ['takeaways', 'Revirements provoqués'], ['giveaways', 'Revirements'], ['penaltyMinutes', 'Minutes de pénalité'],
  ],
  basketball: [
    ['fieldGoalPct', 'Tirs (%)'], ['threePointFieldGoalPct', 'Tirs à 3 points (%)'], ['freeThrowPct', 'Lancers francs (%)'],
    ['totalRebounds', 'Rebonds'], ['assists', 'Passes décisives'], ['steals', 'Interceptions'],
    ['blocks', 'Contres'], ['turnovers', 'Pertes de balle'],
  ],
  soccer: [
    ['possessionPct', 'Possession (%)'], ['totalShots', 'Tirs'], ['shotsOnTarget', 'Tirs cadrés'],
    ['wonCorners', 'Corners'], ['foulsCommitted', 'Fautes'], ['yellowCards', 'Cartons jaunes'],
    ['redCards', 'Cartons rouges'], ['offsides', 'Hors-jeu'], ['saves', 'Arrêts'],
  ],
  football: [
    ['totalYards', 'Verges totales'], ['netPassingYards', 'Verges par la passe'], ['rushingYards', 'Verges au sol'],
    ['firstDowns', 'Premiers essais'], ['turnovers', 'Revirements'], ['possessionTime', 'Temps de possession'],
  ],
  baseball: [['hits', 'Coups sûrs'], ['errors', 'Erreurs'], ['homeRuns', 'Circuits'], ['strikeouts', 'Retraits au bâton']],
};

function teamStats(data, leagueId, homeId, awayId) {
  const sport = LEAGUES_BY_ID[leagueId]?.path.split('/')[0];
  const wanted = STAT_LABELS[sport] ?? [];
  const byTeam = new Map((data?.boxscore?.teams ?? []).map((t) => [String(t?.team?.id), t?.statistics ?? []]));
  const home = byTeam.get(String(homeId));
  const away = byTeam.get(String(awayId));
  if (!home || !away) return [];
  const rows = [];
  const labels = new Set();
  for (const [name, label] of wanted) {
    if (labels.has(label)) continue; // deux noms pour la même statistique
    const h = statOf(home, [name]);
    const a = statOf(away, [name]);
    if (h === '' || a === '') continue;
    labels.add(label);
    rows.push({ label, home: h, away: a });
  }
  // Zéro des deux côtés : souvent, ESPN n'a simplement pas cette statistique
  // pour ce match (pré-saison, petite ligue : « Possession 0 – 0 »). On
  // n'affiche pas de faux zéros ; un vrai 0 – 0 n'apprend rien de toute façon.
  const zero = (v) => !/[1-9]/.test(v);
  rows.splice(0, rows.length, ...rows.filter((r) => !(zero(r.home) && zero(r.away))));
  // Hockey : moins de tirs que de buts, le compte des tirs est faux.
  const goals = (team) => Number.parseInt(scoreText(team?.score ?? 0), 10) || 0;
  const comps = data?.header?.competitions?.[0]?.competitors ?? [];
  const scored = (id) => goals(comps.find((c) => String(c?.team?.id ?? c?.id) === String(id)));
  return rows.filter((r) => r.label !== 'Tirs au but'
    || (Number.parseInt(r.home, 10) >= scored(homeId) && Number.parseInt(r.away, 10) >= scored(awayId)));
}

const assistNames = (p) => (p?.participants ?? [])
  .filter((x) => /assist/i.test(String(x?.type?.text ?? x?.type ?? '')))
  .map((x) => x?.athlete?.displayName ?? x?.athlete?.shortName)
  .filter(Boolean);

function playOf(p) {
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

/** Buts (ou points) et pénalités, lus dans le résumé détaillé d'ESPN. */
function keyPlays(data) {
  const pools = [data?.scoringPlays, data?.plays, data?.keyEvents, data?.header?.competitions?.[0]?.details];
  let goals = [];
  for (const pool of pools) {
    goals = (pool ?? []).filter(isScoring);
    if (goals.length) break;
  }
  const penalties = (data?.plays ?? []).filter((p) => /penalty/i.test(p?.type?.text ?? '') && !isScoring(p));
  return { goals: goals.map(playOf), penalties: penalties.map(playOf) };
}

/**
 * Tout ce que la fenêtre « Match » affiche, à partir du résumé d'ESPN :
 * pointage par période, statistiques d'équipe, buts, pénalités, série.
 */
export async function fetchMatchDetail(leagueId, eventId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !eventId) throw new Error('match inconnu');
  const data = await getJson(`${league.path}/summary`, `?event=${encodeURIComponent(eventId)}`);
  const comp = data?.header?.competitions?.[0] ?? {};
  const status = comp?.status ?? {};
  const state = status?.type?.state ?? 'pre';
  const playoffs = Number(data?.header?.season?.type) === 3 || !!comp?.series;
  const competitors = comp?.competitors ?? [];
  const homeC = competitors.find((c) => c.homeAway === 'home') ?? competitors[0];
  const awayC = competitors.find((c) => c.homeAway === 'away') ?? competitors[1];
  if (!homeC || !awayC) throw new Error('résumé du match illisible');

  const side = (c) => ({
    ...normalizeCompetitor(c, state),
    logo: c?.team?.logos?.[0]?.href ?? c?.team?.logo ?? '',
    periods: (c?.linescores ?? []).map((l) => String(l?.displayValue ?? l?.value ?? '')),
  });
  const frStatus = leagueId === 'nhl'
    ? hockeyStatus({ state, period: status?.period, clock: status?.displayClock, detail: status?.type?.shortDetail }, playoffs)
    : null;
  const home = side(homeC);
  const away = side(awayC);
  const statusText = frStatus ?? statusFr(status?.type?.shortDetail ?? '');
  return {
    id: String(eventId),
    leagueId,
    state,
    playoffs,
    statusText,
    clock: liveClock(leagueId, state, frStatus, status?.displayClock, statusText),
    startsAt: comp?.date ? new Date(comp.date) : null,
    home,
    away,
    // Chaque partie est lue à part : une forme de donnée inattendue d'ESPN
    // dans l'une ne doit pas empêcher d'afficher les autres.
    stats: safe(() => teamStats(data, leagueId, home.id, away.id), []),
    ...safe(() => keyPlays(data), { goals: [], penalties: [] }),
    series: safe(() => seriesInfo(comp, homeC, awayC), null),
    venue: data?.gameInfo?.venue?.fullName ?? '',
    link: pickLink(data?.header) || '',
    stars: safe(() => threeStars(data, comp, leagueId), []),
    leaders: safe(() => gameLeaders(data, home.id, away.id, leagueId), []),
    winProb: safe(() => winProbability(data, state), null),
    videos: safe(() => highlights(data), []),
    box: safe(() => boxScore(data, LEAGUES_BY_ID[leagueId]?.path.split('/')[0]), []),
    probables: safe(() => probablePitchers(competitors, leagueId), {}),
    allPlays: safe(() => allPlays(data, LEAGUES_BY_ID[leagueId]?.path.split('/')[0]), []),
  };
}

/** Lit une partie du résumé ; en cas d'erreur, `fallback` (et la trace en console). */
function safe(read, fallback) {
  try {
    return read() ?? fallback;
  } catch (err) {
    console.warn('Partie du résumé illisible :', err);
    return fallback;
  }
}

/**
 * Baseball : lanceurs partants annoncés, par équipe : { idÉquipe: { name,
 * photo, line } } (« 12-6, MPM 3,21 »). Vide hors baseball.
 */
function probablePitchers(competitors, leagueId) {
  if (LEAGUES_BY_ID[leagueId]?.path.split('/')[0] !== 'baseball') return {};
  const out = {};
  for (const c of competitors ?? []) {
    const p = (c?.probables ?? [])[0];
    const a = p?.athlete;
    if (!a?.displayName) continue;
    const stats = Array.isArray(p?.statistics) ? p.statistics : Array.isArray(p?.statistics?.splits?.categories) ? p.statistics.splits.categories : [];
    const stat = (n) => stats.find((x) => x?.name === n || x?.abbreviation === n)?.displayValue;
    const record = p?.record ?? (stat('wins') && stat('losses') ? `${stat('wins')}-${stat('losses')}` : '');
    const era = stat('ERA') ?? stat('earnedRunAverage');
    out[String(c?.team?.id ?? c?.id ?? '')] = {
      name: a.displayName,
      photo: athletePhoto(a, leagueId),
      line: [record, era ? `MPM ${era}` : ''].filter(Boolean).join(', '),
    };
  }
  return out;
}

/* ---------- Hockey : trios et paires, d'après la grille de profondeur ---------- */

const linesCache = diskCache('lines', 12 * 3600 * 1000);

/**
 * Trios, paires de défense et gardiens d'une équipe de la LNH, d'après la
 * grille de profondeur d'ESPN (le rang de chaque joueur à sa position) :
 * { forwards: [[AG, C, AD]…], defense: [[D, D]…], goalies: [G…] }. C'est
 * l'alignement d'ESPN, pas forcément celui du dernier match.
 */
export async function fetchHockeyLines(teamId) {
  const hit = linesCache.get(teamId);
  if (hit) return hit;
  const league = LEAGUES_BY_ID.nhl;
  let data = null;
  for (const year of await leaderSeasons(league)) {
    try {
      data = await getCore(`/v2/sports/hockey/leagues/nhl/seasons/${year}/teams/${encodeURIComponent(teamId)}/depthcharts?lang=en&region=us`);
      if ((data?.items ?? []).length) break;
    } catch { data = null; }
  }
  const positions = data?.items?.[0]?.positions ?? {};
  // Joueurs d'une position, du 1er au dernier rang.
  const at = (...keys) => {
    for (const k of keys) {
      const p = positions[k] ?? positions[k.toUpperCase()];
      if (p?.athletes?.length) return [...p.athletes].sort((x, y) => (x?.rank ?? 99) - (y?.rank ?? 99)).map((x) => corePath(x?.athlete?.$ref)).filter(Boolean);
    }
    return [];
  };
  const refs = { lw: at('lw', 'l'), c: at('c'), rw: at('rw', 'r'), ld: at('ld'), rd: at('rd'), d: at('d'), g: at('g') };
  const all = [...new Set(Object.values(refs).flat())];
  const people = new Map();
  await Promise.allSettled(all.map(async (ref) => people.set(ref, await fetchAthlete(ref))));
  const who = (ref) => people.get(ref) ?? null;

  const forwards = [];
  for (let i = 0; i < 4; i++) {
    const line = [refs.lw[i], refs.c[i], refs.rw[i]].map(who);
    if (line.some(Boolean)) forwards.push(line);
  }
  const defense = [];
  if (refs.ld.length || refs.rd.length) {
    for (let i = 0; i < 3; i++) {
      const pair = [refs.ld[i], refs.rd[i]].map(who);
      if (pair.some(Boolean)) defense.push(pair);
    }
  } else {
    for (let i = 0; i < Math.min(6, refs.d.length); i += 2) defense.push([who(refs.d[i]), who(refs.d[i + 1])]);
  }
  const lines = { forwards, defense, goalies: refs.g.map(who).filter(Boolean).slice(0, 3) };
  if (forwards.length || defense.length) linesCache.set(teamId, lines);
  return lines;
}

/* ---------- Fenêtre Match : box score et tous les jeux ---------- */

// Nom français des groupes de joueurs d'ESPN.
const BOX_GROUPS = [
  [/forward/i, 'Attaquants'], [/defen[cs]e/i, 'Défenseurs'], [/goalie|goalkeep/i, 'Gardiens'],
  [/batting/i, 'Frappeurs'], [/pitching/i, 'Lanceurs'],
  [/passing/i, 'Passes'], [/rushing/i, 'Course'], [/receiving/i, 'Réception'], [/fumble/i, 'Échappés'],
  [/defensive/i, 'Défense'], [/interception/i, 'Interceptions'], [/kickreturn/i, 'Retours de botté'],
  [/puntreturn/i, 'Retours de dégagement'], [/kicking/i, 'Placements'], [/punting/i, 'Dégagements'],
];

// Colonnes du box score : abréviation française (le détail est en infobulle).
// Les colonnes sans intérêt pour suivre un match sont cachées (null).
const BOX_LABELS = {
  hockey: {
    G: 'B', A: 'A', PTS: 'PTS', '+/-': '+/-', SOG: 'TB', S: 'T', SM: 'TR', TOI: 'TG', HT: 'MÉ', BS: 'TBL',
    PIM: 'PUN', FW: 'MJG', FL: 'MJP', 'FO%': '%MJ', GV: 'REV', TK: 'RP', PN: 'PÉN', SHFT: 'PRÉS',
    SA: 'TC', GA: 'BA', SV: 'ARR', 'SV%': '%ARR',
    YTDG: null, PPTOI: null, SHTOI: null, ESTOI: null, ESSV: null, PPSV: null, SHSV: null,
  },
  basketball: {
    MIN: 'MIN', PTS: 'PTS', FG: 'TIRS', '3PT': '3PTS', FT: 'LF', REB: 'REB', OREB: 'RO', DREB: 'RD',
    AST: 'PD', STL: 'INT', BLK: 'CT', TO: 'BP', PF: 'F', '+/-': '+/-',
  },
  baseball: {
    'H-AB': 'CS-VB', AB: 'VB', R: 'P', H: 'CS', RBI: 'PP', HR: 'CC', BB: 'BB', K: 'RB', AVG: 'MOY',
    IP: 'ML', ER: 'PM', ERA: 'MPM', 'PC-ST': 'LAN-PR', '#P': 'LAN',
  },
  football: {
    'C/ATT': 'RÉU/ESS', YDS: 'VG', AVG: 'MOY', TD: 'TC', INT: 'INT', SACKS: 'SACS', CAR: 'PORT',
    REC: 'RÉC', LONG: 'LONG', TGTS: 'CIB', TOT: 'PLAQ', SOLO: 'SEUL', TFL: 'PLAQ-P', PD: 'PD',
  },
};

// Soccer : ESPN n'a pas de box score, mais la feuille de match des joueurs.
const SOCCER_COLS = [
  ['totalGoals', 'B', 'Buts'], ['goalAssists', 'PD', 'Passes décisives'], ['totalShots', 'T', 'Tirs'],
  ['shotsOnTarget', 'TC', 'Tirs cadrés'], ['foulsCommitted', 'F', 'Fautes commises'],
  ['yellowCards', '🟨', 'Cartons jaunes'], ['redCards', '🟥', 'Cartons rouges'], ['saves', 'ARR', 'Arrêts'],
];

function boxPlayer(x) {
  const a = x?.athlete ?? {};
  return {
    id: String(a.id ?? ''),
    name: a.displayName ?? a.shortName ?? '',
    short: a.shortName ?? a.displayName ?? '',
    jersey: String(x?.jersey ?? a.jersey ?? ''),
    pos: a.position?.abbreviation ?? x?.position?.abbreviation ?? '',
    starter: x?.starter === true,
    // Baseball : rang dans l'ordre des frappeurs (1 à 9).
    order: Number(x?.batOrder ?? x?.battingOrder) || null,
    photo: athletePhoto(a, ''),
  };
}

/**
 * Stats de chaque joueur : [{ teamId, groups: [{ name, cols: [{ label, tip }],
 * players: [{ name, jersey, pos, stats: [...] }] }] }]. Vide si ESPN n'en a pas.
 */
function boxScore(data, sport) {
  const teams = data?.boxscore?.players ?? [];
  if (teams.length) {
    return teams.map((t) => ({
      teamId: String(t?.team?.id ?? ''),
      groups: (t?.statistics ?? []).map((grp) => {
        const labels = grp?.labels ?? [];
        const map = BOX_LABELS[sport] ?? {};
        // Colonnes gardées : leur position dans les stats d'ESPN.
        const keep = labels.map((l, i) => [l, i]).filter(([l]) => map[String(l).toUpperCase()] !== null);
        return {
          name: BOX_GROUPS.find(([re]) => re.test(`${grp?.name ?? ''} ${grp?.type ?? ''}`))?.[1] ?? '',
          cols: keep.map(([l, i]) => ({ label: map[String(l).toUpperCase()] ?? l, tip: grp?.descriptions?.[i] ?? '' })),
          players: (grp?.athletes ?? [])
            .filter((x) => x?.athlete && (x.stats ?? []).length && x.didNotPlay !== true)
            .map((x) => ({ ...boxPlayer(x), stats: keep.map(([, i]) => String(x.stats[i] ?? '')) })),
        };
      }).filter((grp) => grp.players.length && grp.cols.length),
    })).filter((t) => t.teamId && t.groups.length);
  }

  // Soccer : partants puis remplaçants entrés en jeu.
  return (data?.rosters ?? []).map((r) => {
    const roster = (r?.roster ?? []).filter((x) => x?.athlete);
    const statsOf = (x) => new Map((x?.stats ?? []).map((st) => [st?.name, String(st?.displayValue ?? st?.value ?? '')]));
    const cols = SOCCER_COLS.filter(([name]) => roster.some((x) => statsOf(x).has(name)));
    const group = (name, list) => ({
      name,
      cols: cols.map(([, label, tip]) => ({ label, tip })),
      players: list.map((x) => {
        const st = statsOf(x);
        return { ...boxPlayer(x), stats: cols.map(([n]) => st.get(n) ?? '') };
      }),
    });
    return {
      teamId: String(r?.team?.id ?? ''),
      groups: [
        group('Partants', roster.filter((x) => x.starter)),
        group('Remplaçants', roster.filter((x) => !x.starter && x.subbedIn)),
      ].filter((grp) => grp.players.length && grp.cols.length),
    };
  }).filter((t) => t.teamId && t.groups.length);
}

function basePlay(p) {
  const score = (v) => (v == null || v === '' ? null : String(v));
  return {
    id: String(p?.id ?? ''),
    text: String(p?.text ?? p?.shortText ?? '').trim(),
    period: Number(p?.period?.number ?? p?.period) || null,
    // Baseball : « Top » ou « Bottom » de la manche.
    half: String(p?.period?.type ?? ''),
    clock: p?.clock?.displayValue ?? '',
    teamId: String(p?.team?.id ?? ''),
    scoring: p?.scoringPlay === true,
    type: String(p?.type?.text ?? p?.type?.type ?? ''),
    away: score(p?.awayScore),
    home: score(p?.homeScore),
  };
}

// Baseball : ESPN décrit chaque lancer (« Pitch 3 : Ball 2 ») et les débuts
// de présence au bâton ; on garde seulement le résultat de chaque jeu.
const BASEBALL_NOISE = /^(pitch \d+\s*:|(start|end) (batter|inning|game))/i;

/**
 * Tous les jeux du match, du premier au dernier :
 * [{ id, text, period, clock, teamId, scoring, away, home }].
 */
function allPlays(data, sport) {
  let raw;
  if (sport === 'soccer') {
    raw = [...(data?.commentary ?? [])]
      .sort((x, y) => (Number(x?.sequence) || 0) - (Number(y?.sequence) || 0))
      .map((c) => ({
        ...basePlay(c?.play ?? {}),
        id: String(c?.sequence ?? c?.play?.id ?? ''),
        text: String(c?.text ?? c?.play?.text ?? '').trim(),
        clock: c?.time?.displayValue ?? c?.play?.clock?.displayValue ?? '',
        scoring: c?.play?.scoringPlay === true || /^goal!/i.test(c?.text ?? ''),
      }));
    if (!raw.length) raw = (data?.keyEvents ?? []).map(basePlay);
  } else if (sport === 'football') {
    const drives = [...(data?.drives?.previous ?? []), ...(data?.drives?.current ? [data.drives.current] : [])];
    raw = drives.flatMap((d) => (d?.plays ?? []).map((p) => ({
      ...basePlay(p),
      teamId: String(p?.team?.id ?? p?.start?.team?.id ?? d?.team?.id ?? ''),
    })));
    if (!raw.length) raw = (data?.plays ?? []).map(basePlay);
  } else {
    raw = (data?.plays ?? []).map(basePlay);
  }

  const seen = new Set();
  return raw.filter((p) => {
    if (!p.text) return false;
    if (sport === 'baseball' && (BASEBALL_NOISE.test(p.text) || /^(start|end)[ -]/i.test(p.type))) return false;
    const key = p.id || `${p.period}|${p.clock}|${p.text}`;
    return seen.has(key) ? false : seen.add(key);
  });
}

/* ---------- Fenêtre Match : étoiles, meneurs, chances, vidéos ---------- */

/** Photo d'un athlète : celle de la réponse, sinon l'adresse habituelle d'ESPN. */
const athletePhoto = (a, leagueId) => {
  const href = a?.headshot?.href ?? a?.headshot ?? '';
  return typeof href === 'string' && href.startsWith('https://') ? href : headshotUrl(leagueId, a?.id);
};

/**
 * Les 3 étoiles du match (hockey), quand ESPN les nomme (« firstStar »…).
 * Liste vide sinon.
 */
function threeStars(data, comp, leagueId) {
  const pools = [comp?.status?.featuredAthletes, comp?.featuredAthletes, data?.header?.featuredAthletes, data?.featuredAthletes];
  const order = (x) => (/first|1/i.test(x) ? 1 : /second|2/i.test(x) ? 2 : /third|3/i.test(x) ? 3 : 9);
  for (const pool of pools) {
    const stars = (pool ?? [])
      .filter((f) => /star/i.test(`${f?.name ?? ''} ${f?.displayName ?? ''}`) && f?.athlete)
      .map((f) => ({
        rank: order(`${f.name ?? ''} ${f.displayName ?? ''}`),
        name: f.athlete.displayName ?? f.athlete.shortName ?? '',
        photo: athletePhoto(f.athlete, leagueId),
        teamId: String(f.team?.id ?? f.athlete.team?.id ?? ''),
        line: f.statistics?.map?.((s) => s?.displayValue).filter(Boolean).join(' · ') ?? '',
      }))
      .filter((s) => s.name && s.rank <= 3)
      .sort((a, b) => a.rank - b.rank);
    if (stars.length) return stars;
  }
  return [];
}

// Noms français des catégories de meneurs d'ESPN.
export const LEADER_FR = {
  goals: 'Buts', assists: 'Passes', points: 'Points', saves: 'Arrêts', savePct: "% d'arrêts",
  plusMinus: '+/-', penaltyMinutes: 'Minutes de pénalité', powerPlayGoals: 'Buts en avantage numérique',
  wins: 'Victoires', shutouts: 'Blanchissages', goalsAgainstAverage: 'Moyenne de buts alloués',
  rebounds: 'Rebonds', pointsPerGame: 'Points par match', reboundsPerGame: 'Rebonds par match',
  assistsPerGame: 'Passes par match', stealsPerGame: 'Interceptions par match', blocksPerGame: 'Contres par match',
  passingYards: 'Verges par la passe', rushingYards: 'Verges au sol', receivingYards: 'Verges en réception',
  passingTouchdowns: 'Touchés par la passe', rushingTouchdowns: 'Touchés au sol', receptions: 'Réceptions',
  sacks: 'Sacs du quart', interceptions: 'Interceptions', totalTackles: 'Plaqués',
  homeRuns: 'Circuits', RBIs: 'Points produits', battingAverage: 'Moyenne au bâton', strikeouts: 'Retraits au bâton',
  hits: 'Coups sûrs', ERA: 'Moyenne de points mérités', stolenBases: 'Buts volés', saves_baseball: 'Sauvetages',
};

/**
 * Meneurs du match, par catégorie : le meilleur de chaque équipe.
 * [{ label, away: { name, photo, value }, home: {…} }], 3 catégories au plus.
 */
function gameLeaders(data, homeId, awayId, leagueId) {
  const byTeam = new Map((data?.leaders ?? []).map((t) => [String(t?.team?.id ?? ''), t?.leaders ?? []]));
  const home = byTeam.get(String(homeId)) ?? [];
  const away = byTeam.get(String(awayId)) ?? [];
  const best = (cats, name) => {
    const l = cats.find((c) => c?.name === name)?.leaders?.[0];
    return l?.athlete ? { name: l.athlete.displayName ?? l.athlete.shortName ?? '', photo: athletePhoto(l.athlete, leagueId), value: l.displayValue ?? '' } : null;
  };
  const names = [...new Set([...home, ...away].map((c) => c?.name).filter(Boolean))];
  return names
    .map((name) => ({
      label: LEADER_FR[name] ?? autoFr([...home, ...away].find((c) => c?.name === name)?.displayName ?? name),
      home: best(home, name),
      away: best(away, name),
    }))
    .filter((r) => r.home || r.away)
    .slice(0, 3);
}

/**
 * Chances de victoire (en %) : { home, away, live }. En direct : le dernier
 * calcul d'ESPN ; avant le match : sa prédiction. null si ESPN n'en donne pas.
 */
function winProbability(data, state) {
  if (state === 'post') return null;
  const live = data?.winprobability;
  if (state === 'in' && Array.isArray(live) && live.length) {
    const last = live[live.length - 1];
    const h = Number(last?.homeWinPercentage);
    if (Number.isFinite(h)) {
      // Arrondir chaque équipe à part donnait parfois 101 % (97,5 → 98 et
      // 2,5 → 3) : la seconde est le reste, pour un total de 100 %.
      const home = Math.round(h * 100);
      const tie = Math.round((Number(last?.tiePercentage) || 0) * 100);
      return { home, away: Math.max(0, 100 - home - tie), live: true };
    }
  }
  // Avant le match : la projection d'ESPN, sinon 100 moins sa chance de défaite.
  const p = data?.predictor;
  const chance = (t) => {
    const win = parseFloat(t?.gameProjection);
    if (Number.isFinite(win)) return win;
    const loss = parseFloat(t?.teamChanceLoss);
    return Number.isFinite(loss) ? 100 - loss : NaN;
  };
  const h = chance(p?.homeTeam);
  const a = chance(p?.awayTeam);
  if (Number.isFinite(h) && Number.isFinite(a) && h + a > 0) {
    const home = Math.round((h / (h + a)) * 100);
    return { home, away: 100 - home, live: false };
  }
  return null;
}

/** Faits saillants vidéo d'ESPN : [{ title, thumb, href }], 4 au plus. */
function highlights(data) {
  return (data?.videos ?? [])
    .map((v) => ({
      title: v?.headline ?? v?.title ?? '',
      thumb: v?.thumbnail ?? v?.images?.[0]?.url ?? '',
      href: v?.links?.web?.href ?? v?.links?.mobile?.href ?? '',
    }))
    .filter((v) => v.title && /^https:\/\/(www\.)?espn\.(com|ca|co\.uk)\//.test(v.href))
    .slice(0, 4);
}

/* ---------- Classements ---------- */

const GROUP_FR = [
  [/eastern/i, "Association de l'Est"], [/western/i, "Association de l'Ouest"],
  [/atlantic/i, 'Atlantique'], [/metropolitan/i, 'Métropolitaine'], [/central/i, 'Centrale'],
  [/pacific/i, 'Pacifique'], [/american league|^al\b/i, 'Ligue américaine'], [/national league|^nl\b/i, 'Ligue nationale'],
];
const groupFr = (name) => GROUP_FR.find(([re]) => re.test(name ?? ''))?.[1] ?? autoFr(name);

const STANDINGS_TTL = 60 * 60 * 1000;
// idLigue -> groupes du classement, gardés sur le disque 1 h.
const standingsCache = diskCache('standings.v2', STANDINGS_TTL);

/** Vrai pour un classement de pré-saison (type de saison 1 chez ESPN). */
const isPreseason = (st) => [st?.seasonType, st?.seasonType?.type, st?.season?.type]
  .some((t) => Number(t?.type ?? t) === 1);

/** Pré-saison : les matchs préparatoires ne comptent pas, tout le monde à zéro. */
const ZERO_STATS = { winPercent: '.000', gamesBehind: '-' };
function zeroStats(stats) {
  return Object.fromEntries(Object.keys(stats).map((k) => [k, ZERO_STATS[k] ?? '0']));
}

/** Rang de chaque équipe dans son groupe, trié comme ESPN le calcule. */
function rankEntries(entries) {
  const stat = (e, n) => e?.stats?.find((s) => s?.name === n)?.value;
  const seeded = entries.every((e) => Number.isFinite(stat(e, 'playoffSeed')));
  const key = seeded ? null : entries.some((e) => Number.isFinite(stat(e, 'points'))) ? 'points' : 'winPercent';
  const sorted = seeded
    ? [...entries].sort((a, b) => stat(a, 'playoffSeed') - stat(b, 'playoffSeed'))
    : [...entries].sort((a, b) => (stat(b, key) ?? 0) - (stat(a, key) ?? 0));
  return sorted;
}

// Colonnes du tableau de classement, par sport : [nom ESPN, en-tête].
export const STANDING_COLS = {
  hockey: [['gamesPlayed', 'PJ'], ['wins', 'V'], ['losses', 'D'], ['otLosses', 'DP'], ['points', 'PTS']],
  basketball: [['wins', 'V'], ['losses', 'D'], ['winPercent', '%'], ['gamesBehind', 'Écart']],
  football: [['wins', 'V'], ['losses', 'D'], ['ties', 'N'], ['winPercent', '%']],
  baseball: [['wins', 'V'], ['losses', 'D'], ['winPercent', '%'], ['gamesBehind', 'Écart']],
  soccer: [['gamesPlayed', 'PJ'], ['wins', 'V'], ['ties', 'N'], ['losses', 'D'], ['pointDifferential', 'Diff'], ['points', 'PTS']],
};

/**
 * Classement complet d'une ligue, par groupe (association, division,
 * ligue) : [{ name, rows: [{ id, name, abbr, logo, rank, stats }] }].
 */
export async function fetchStandingsTable(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return [];
  const hit = standingsCache.get(leagueId);
  if (hit) return hit;

  // La saison régulière : sans précision, ESPN donne les matchs préparatoires
  // pendant la pré-saison.
  // Le tableau des matchs dit aussi si on est en pré-saison.
  const board = getJson(`${league.path}/scoreboard`).catch(() => null);
  const load = (query) => getJson(`${league.path}/standings`, query, { v2: true }).catch(() => null);
  let data = await load('?seasontype=2');
  const boardPre = isPreseason({ seasonType: (await board)?.leagues?.[0]?.season?.type });
  const groups = [];
  const walk = (node) => {
    const entries = node?.standings?.entries;
    if (entries?.length) {
      const preseason = boardPre || isPreseason(node.standings);
      const ranked = preseason
        ? [...entries].sort((a, b) => String(a?.team?.displayName ?? '').localeCompare(String(b?.team?.displayName ?? ''), 'fr'))
        : rankEntries(entries);
      const rows = ranked.map((e, i) => {
        const t = e?.team ?? {};
        return {
          id: String(t.id ?? ''),
          name: t.displayName ?? t.name ?? '',
          short: t.shortDisplayName ?? t.name ?? '',
          abbr: t.abbreviation ?? '',
          logo: t.logos?.[0]?.href ?? t.logo ?? '',
          rank: i + 1,
          stats: Object.fromEntries((e?.stats ?? []).filter((x) => x?.name).map((x) => [x.name, x.displayValue ?? String(x.value ?? '')])),
        };
      }).filter((r) => r.id);
      if (preseason) rows.forEach((r) => { r.stats = zeroStats(r.stats); });
      groups.push({ name: groupFr(node?.name ?? node?.abbreviation ?? league.label), rows, preseason });
    }
    (node?.children ?? []).forEach(walk);
  };
  walk(data);
  // Saison régulière encore vide : le classement par défaut, remis à zéro.
  if (!groups.length) {
    data = await getJson(`${league.path}/standings`, '', { v2: true });
    walk(data);
  }
  for (const g of groups) await fillLogos(leagueId, g.rows);
  if (groups.length) standingsCache.set(leagueId, groups);
  return groups;
}

/**
 * Classement d'une ligue pour la fenêtre Match : Map idÉquipe -> { rank,
 * group, points }. Vide si ESPN ne le fournit pas.
 */
export async function fetchStandings(leagueId) {
  const table = new Map();
  try {
    for (const g of await fetchStandingsTable(leagueId)) {
      if (g.preseason) continue; // pas de rang avant la saison régulière
      for (const r of g.rows) table.set(r.id, { rank: r.rank, group: g.name, points: r.stats.points ?? '' });
    }
  } catch { /* classement indisponible : la fenêtre s'en passe */ }
  return table;
}

/**
 * Championnat de F1 : pilotes et constructeurs, avec leurs points.
 * { drivers: [{ rank, name, photo, team, points }], teams: [{ rank, name, points }] }
 */
export async function fetchF1Standings() {
  const hit = standingsCache.get('f1');
  if (hit) return hit;
  const data = await getJson('racing/f1/standings', '', { v2: true });
  const drivers = [];
  const teams = [];
  const points = (e) => {
    const s = (e?.stats ?? []).find((x) => /championshippts|points/i.test(x?.name ?? '') || /^pts$/i.test(x?.abbreviation ?? ''));
    return s?.displayValue ?? String(s?.value ?? '');
  };
  const rankOf = (e, i) => {
    const s = (e?.stats ?? []).find((x) => /^rank$/i.test(x?.name ?? ''));
    return Number(s?.value) || i + 1;
  };
  const walk = (node) => {
    (node?.standings?.entries ?? []).forEach((e, i) => {
      if (e?.athlete) {
        const a = e.athlete;
        drivers.push({ rank: rankOf(e, i), id: String(a.id ?? ''), name: a.displayName ?? '', short: a.shortName ?? '',
          photo: driverPhoto(a, a.id), team: e.team?.displayName ?? a.team?.displayName ?? '', points: points(e) });
      } else if (e?.team) {
        teams.push({ rank: rankOf(e, i), name: e.team.displayName ?? e.team.name ?? '', logo: e.team.logos?.[0]?.href ?? '', points: points(e) });
      }
    });
    (node?.children ?? []).forEach(walk);
  };
  walk(data);
  drivers.sort((a, b) => a.rank - b.rank);
  teams.sort((a, b) => a.rank - b.rank);
  const result = { drivers, teams };
  if (drivers.length) standingsCache.set('f1', result);
  return result;
}

/* ---------- Meneurs de la ligue (classement des joueurs) ---------- */

const CORE = 'https://sports.core.api.espn.com';

/**
 * API « core » d'ESPN : page d'abord, puis relais Rust (préfixe « core/ »).
 * `path` commence par « /v2/… » (les liens $ref d'ESPN y mènent aussi).
 */
async function getCore(path) {
  try {
    return await viaPage(`${CORE}${path}`);
  } catch (err) {
    if (!inTauri()) throw err;
    return viaRust(`core${path}`);
  }
}

/** Lien $ref d'ESPN → chemin relatif à l'API core (en https). */
const corePath = (ref) => String(ref ?? '').replace(/^https?:\/\/sports\.core\.api\.espn\.com/, '');

// Catégories affichées d'abord, par sport (les autres suivent).
const LEADER_ORDER = {
  hockey: ['points', 'goals', 'assists', 'plusMinus', 'wins', 'savePct', 'goalsAgainstAverage', 'shutouts'],
  basketball: ['pointsPerGame', 'reboundsPerGame', 'assistsPerGame', 'stealsPerGame', 'blocksPerGame'],
  football: ['passingYards', 'rushingYards', 'receivingYards', 'sacks', 'interceptions'],
  baseball: ['battingAverage', 'homeRuns', 'RBIs', 'hits', 'stolenBases', 'ERA', 'strikeouts', 'wins'],
  soccer: ['goals', 'assists'],
};

const LEADERS_TTL = 60 * 60 * 1000;
// v2 : les meneurs de la saison en cours (la v1 gardait ceux de tous les
// temps) et les photos reconstituées quand ESPN n'en donne pas.
const leadersCache = diskCache('leaders.v2', LEADERS_TTL);
const athleteCache = diskCache('athletes.v2', 7 * 24 * 3600 * 1000);

// Noms français des catégories, d'après le nom affiché par ESPN (en minuscules).
// La traduction automatique donnait des contresens (« Goals » → « Objectifs »).
const LEADER_FR_TEXT = {
  goals: 'Buts', assists: 'Passes', points: 'Points', 'penalty minutes': 'Minutes de pénalité',
  wins: 'Victoires', 'games played': 'Matchs joués', 'plus/minus': '+/-', 'plus minus': '+/-',
  'save percentage': "% d'arrêts", 'save pct': "% d'arrêts", 'goals against average': 'Moyenne de buts alloués',
  shutouts: 'Blanchissages', saves: 'Arrêts', 'power play goals': 'Buts en avantage numérique',
  'shots': 'Tirs', 'time on ice': 'Temps de glace', 'game-winning goals': 'Buts gagnants',
  defensive: 'Défense', offensive: 'Attaque', rebounds: 'Rebonds', steals: 'Interceptions', blocks: 'Contres',
  'points per game': 'Points par match', 'rebounds per game': 'Rebonds par match',
  'assists per game': 'Passes par match', 'steals per game': 'Interceptions par match',
  'blocks per game': 'Contres par match', 'field goal percentage': 'Tirs réussis (%)',
  'passing yards': 'Verges par la passe', 'rushing yards': 'Verges au sol', 'receiving yards': 'Verges en réception',
  sacks: 'Sacs du quart', interceptions: 'Interceptions', tackles: 'Plaqués', touchdowns: 'Touchés',
  'batting average': 'Moyenne au bâton', 'home runs': 'Circuits', 'runs batted in': 'Points produits', rbis: 'Points produits',
  hits: 'Coups sûrs', 'stolen bases': 'Buts volés', 'earned run average': 'Moyenne de points mérités',
  era: 'Moyenne de points mérités', strikeouts: 'Retraits au bâton',
};

const leaderLabel = (c) => LEADER_FR[c?.name]
  ?? LEADER_FR_TEXT[String(c?.displayName ?? '').toLowerCase()]
  ?? LEADER_FR_TEXT[String(c?.name ?? '').toLowerCase()]
  ?? autoFr(c?.displayName ?? c?.name ?? '');

/**
 * Saison affichée : « 2025-2026 » au hockey et au basket (ESPN la nomme par
 * son année de fin), « 2025-2026 » au soccer (année de début), l'année seule ailleurs.
 */
function seasonLabel(leagueId, year) {
  const sport = LEAGUES_BY_ID[leagueId]?.path.split('/')[0];
  if (leagueId === 'wnba' || leagueId === 'mls') return String(year);
  if (sport === 'hockey' || sport === 'basketball') return `${year - 1}-${year}`;
  if (sport === 'soccer') return `${year}-${year + 1}`;
  return String(year);
}

/**
 * Saisons où chercher les meneurs, la plus pertinente d'abord : celle en
 * cours d'après le tableau des scores, ou la précédente en présaison.
 */
async function leaderSeasons(league) {
  let year = new Date().getFullYear();
  let type = 2;
  try {
    const board = await getJson(`${league.path}/scoreboard`, boardQuery(league));
    const season = board?.leagues?.[0]?.season ?? board?.season ?? {};
    year = Number(season.year) || year;
    type = Number(season.type?.type ?? season.type) || type;
  } catch { /* année civile par défaut */ }
  return type === 1 ? [year - 1, year] : [year, year - 1];
}

/**
 * Meneurs de la ligue, par catégorie : [{ name, label, leaders: [{ rank,
 * value, ref, teamId }] }]. Les joueurs eux-mêmes sont chargés à part.
 */
export async function fetchLeagueLeaders(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return [];
  const hit = leadersCache.get(leagueId);
  if (hit) return hit;
  const [sport, code] = league.path.split('/');
  // Saison régulière (type 2) : sans saison précise, ESPN renvoie les
  // meneurs de tous les temps (Gretzky, Ovechkin…).
  let data = null;
  let year = null;
  for (const y of await leaderSeasons(league)) {
    try {
      const d = await getCore(`/v2/sports/${sport}/leagues/${code}/seasons/${y}/types/2/leaders?limit=10&lang=en&region=us`);
      if ((d?.categories ?? []).some((c) => (c?.leaders ?? []).length)) { data = d; year = y; break; }
    } catch { /* saison pas encore commencée : on essaie la suivante */ }
  }
  if (!data) return [];
  const order = LEADER_ORDER[sport] ?? [];
  const rankOf = (key) => { const i = order.indexOf(key); return i === -1 ? 99 : i; };
  const season = seasonLabel(leagueId, year);
  const used = new Set();
  const cats = (data?.categories ?? [])
    .map((c) => ({
      key: c?.name ?? '',
      // Identifiant unique de la catégorie (ESPN peut répéter un même nom).
      name: (() => {
        const base = c?.name || c?.displayName || 'cat';
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        return id;
      })(),
      label: leaderLabel(c),
      season,
      leaders: (c?.leaders ?? []).slice(0, 10).map((l, i) => ({
        rank: i + 1,
        value: l?.displayValue ?? String(l?.value ?? ''),
        ref: corePath(l?.athlete?.$ref),
        teamId: /\/teams\/(\d+)/.exec(l?.team?.$ref ?? '')?.[1] ?? '',
      })).filter((l) => l.ref),
    }))
    .filter((c) => c.name && c.leaders.length)
    .sort((a, b) => rankOf(a.key) - rankOf(b.key))
    .slice(0, 8);
  if (cats.length) leadersCache.set(leagueId, cats);
  return cats;
}

/** Un joueur (nom, photo, position), gardé une semaine sur le disque. */
export async function fetchAthlete(ref) {
  const hit = athleteCache.get(ref);
  if (hit) return hit;
  const a = await getCore(ref.includes('?') ? ref : `${ref}?lang=en&region=us`);
  // Ligue lue dans l'adresse (« …/leagues/nhl/… ») pour la photo de secours.
  const code = /\/leagues\/([^/]+)\//.exec(ref)?.[1] ?? '';
  const leagueId = Object.keys(LEAGUES_BY_ID).find((id) => LEAGUES_BY_ID[id].path.split('/')[1] === code) ?? '';
  const athlete = {
    id: String(a?.id ?? ''),
    name: a?.displayName ?? a?.fullName ?? '',
    short: a?.shortName ?? '',
    photo: athletePhoto(a, leagueId),
    pos: a?.position?.abbreviation ?? '',
    jersey: a?.jersey ?? '',
  };
  if (athlete.name) athleteCache.set(ref, athlete);
  return athlete;
}

/* ---------- Combattants de l'UFC (réglages) ---------- */

const fightersCache = diskCache('fighters', 24 * 3600 * 1000);

/**
 * Combattants des galas récents et à venir, pour choisir ses favoris :
 * [{ id, name, short, photo, record, weight }], triés par nom.
 */
export async function fetchFighters() {
  const hit = fightersCache.get('ufc');
  if (hit) return hit;
  const path = LEAGUES_BY_ID.ufc.path;
  const found = new Map();
  const absorb = (data) => {
    for (const ev of data?.events ?? []) {
      for (const comp of ev?.competitions ?? []) {
        const f = fightOf(comp);
        for (const x of [f.a, f.b]) {
          if (x?.id && x.name && !found.has(x.id)) {
            found.set(x.id, { id: x.id, name: x.name, short: x.short, photo: x.photo, record: x.record, weight: f.weight });
          }
        }
      }
    }
  };
  let lastErr = null;
  // Galas des 4 derniers mois et des 2 prochains, par tranches d'un mois.
  const ranges = [[0, 60]];
  for (let end = -1; end > -120; end -= 30) ranges.push([end - 29, end]);
  const results = await Promise.allSettled([
    getJson(`${path}/scoreboard`),
    ...ranges.map(([a, b]) => getJson(`${path}/scoreboard`, `?dates=${ymd(a)}-${ymd(b)}`)),
  ]);
  for (const r of results) {
    if (r.status === 'fulfilled') absorb(r.value);
    else lastErr = r.reason;
  }
  if (!found.size) throw lastErr ?? new Error('aucun combattant trouvé');
  const fighters = [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  fightersCache.set('ufc', fighters);
  return fighters;
}

/* ---------- Joueurs de tennis (réglages) ---------- */

const tennisCache = diskCache('tennis-players', 24 * 3600 * 1000);

/**
 * Joueurs des tournois récents et en cours d'un circuit (ATP, WTA), pour
 * choisir ses favoris : [{ id, name, short, photo, flag, leagueId }], triés
 * par nom.
 */
export async function fetchTennisPlayers(leagueId) {
  const hit = tennisCache.get(leagueId);
  if (hit) return hit;
  const path = LEAGUES_BY_ID[leagueId]?.path;
  if (!path) return [];
  const found = new Map();
  const absorb = (data) => {
    for (const ev of data?.events ?? []) {
      for (const m of normalizeTennis(ev, leagueId, '')) {
        for (const x of [m.a, m.b]) {
          if (x.id && x.name && !found.has(x.id)) {
            found.set(x.id, { id: x.id, name: x.name, short: x.short, photo: x.photo, flag: x.flag, leagueId });
          }
        }
      }
    }
  };
  let lastErr = null;
  // Tournois en cours et des 2 derniers mois, par tranches de deux semaines.
  const ranges = [];
  for (let end = 0; end > -60; end -= 14) ranges.push([end - 13, end]);
  const results = await Promise.allSettled([
    getJson(`${path}/scoreboard`),
    ...ranges.map(([a, b]) => getJson(`${path}/scoreboard`, `?dates=${ymd(a)}-${ymd(b)}`)),
  ]);
  for (const r of results) {
    if (r.status === 'fulfilled') absorb(r.value);
    else lastErr = r.reason;
  }
  if (!found.size) throw lastErr ?? new Error('aucun joueur trouvé');
  const players = [...found.values()].sort((x, y) => x.name.localeCompare(y.name, 'fr'));
  tennisCache.set(leagueId, players);
  return players;
}

/* ---------- Golfeurs (réglages) ---------- */

const golfersCache = diskCache('golfers', 24 * 3600 * 1000);

/**
 * Golfeurs du tournoi en cours et des récents, pour choisir ses favoris :
 * [{ id, name, short, photo, flag, leagueId }], triés par nom. Chaque tranche
 * de dates est demandée à part : une refusée n'empêche pas les autres.
 */
export async function fetchGolfers(leagueId) {
  const hit = golfersCache.get(leagueId);
  if (hit) return hit;
  const league = LEAGUES_BY_ID[leagueId];
  if (!league) return [];
  const found = new Map();
  const absorb = (data) => {
    for (const ev of data?.events ?? []) {
      for (const c of ev?.competitions?.[0]?.competitors ?? []) {
        if (!c?.athlete) continue;
        const p = golferOf(c, 0);
        if (p.id && p.name && !found.has(p.id)) found.set(p.id, { id: p.id, name: p.name, short: p.short, photo: p.photo, flag: p.flag, leagueId });
      }
    }
  };
  let lastErr = null;
  const ranges = [];
  for (let end = 0; end > -84; end -= 14) ranges.push([end - 13, end]);
  const results = await Promise.allSettled([
    getJson(`${league.path}/scoreboard`),
    ...ranges.map(([a, b]) => getJson(`${league.path}/scoreboard`, `?dates=${ymd(a)}-${ymd(b)}`)),
  ]);
  for (const r of results) {
    if (r.status === 'fulfilled') absorb(r.value);
    else lastErr = r.reason;
  }
  if (!found.size) throw lastErr ?? new Error('aucun golfeur trouvé');
  const golfers = [...found.values()].sort((x, y) => x.name.localeCompare(y.name, 'fr'));
  golfersCache.set(leagueId, golfers);
  return golfers;
}

/* ---------- Pilotes de F1 (réglages) ---------- */

const DRIVERS_KEY = 'sports-counter.drivers.f1.v2';
const FULL_GRID = 20;

/**
 * Pilotes titulaires, pour choisir son favori : ceux de la dernière course
 * (ou des dernières qualifications). Les essais libres sont ignorés : des
 * pilotes de réserve y roulent, qui ne sont pas sur la grille.
 */
export async function fetchDrivers() {
  try {
    const { at, drivers } = JSON.parse(localStorage.getItem(DRIVERS_KEY) ?? 'null') ?? {};
    if (drivers?.length >= FULL_GRID && Date.now() - at < TEAMS_TTL) return drivers;
  } catch { /* cache illisible */ }

  const league = LEAGUES_BY_ID.f1;
  // Séances de course et de qualifications trouvées : { rank, date, drivers }.
  const sessions = [];
  const absorb = (data) => {
    for (const ev of data?.events ?? []) {
      for (const comp of ev?.competitions ?? []) {
        const abbr = String(comp?.type?.abbreviation ?? '').toUpperCase();
        const rank = abbr === 'RACE' ? 2 : abbr === 'QUAL' ? 1 : 0;
        const list = (comp?.competitors ?? []).map(toDriver).filter((d) => d.id && d.name);
        if (!rank || list.length < FULL_GRID - 2) continue;
        sessions.push({ rank, date: new Date(comp.date ?? ev.date ?? 0).getTime(), drivers: list });
      }
    }
  };
  let lastErr = null;
  try { absorb(await getJson(`${league.path}/scoreboard`, boardQuery(league))); } catch (err) { lastErr = err; }
  // Entre deux Grands Prix, on remonte le calendrier par tranches d'un mois.
  for (let end = 0; end > -240 && !sessions.some((x) => x.rank === 2); end -= 30) {
    try { absorb(await getJson(`${league.path}/scoreboard`, boardQuery(league, `?dates=${ymd(end - 29)}-${ymd(end)}`))); } catch (err) { lastErr = err; }
  }
  if (!sessions.length) throw lastErr ?? new Error('aucun pilote trouvé');

  // La course la plus récente d'abord ; à défaut, les qualifications.
  sessions.sort((x, y) => y.rank - x.rank || y.date - x.date);
  const drivers = sessions[0].drivers
    .map(({ id, name, short, photo, team }) => ({ id, name, short, photo, team }))
    .sort((x, y) => x.name.localeCompare(y.name, 'fr'));
  try { localStorage.setItem(DRIVERS_KEY, JSON.stringify({ at: Date.now(), drivers })); } catch { /* plein */ }
  return drivers;
}

/* ---------- Calendrier et historique d'une équipe ---------- */

const TEAM_TTL = 3 * 3600 * 1000;
// "ligue:équipe" -> { games, back, ahead }, gardé sur le disque 3 h.
const teamGamesCache = diskCache('teamGames', TEAM_TTL);
const WHOLE_SEASON = 9999; // jours : calendrier complet de la saison

/**
 * Matchs de la saison d'une équipe (passés et à venir), triés par date.
 * Source : le calendrier de l'équipe chez ESPN ; s'il est illisible depuis
 * l'app, on reconstitue autour d'aujourd'hui à partir des tableaux des scores.
 */
export async function fetchTeamGames(leagueId, teamId, { back = 21, ahead = 30 } = {}) {
  const key = `${leagueId}:${teamId}`;
  const hit = teamGamesCache.get(key);
  if (hit && hit.back >= back && hit.ahead >= ahead) return hit.games;
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return [];

  let games = null;
  let span = { back, ahead };
  try {
    const data = await getJson(`${league.path}/teams/${encodeURIComponent(teamId)}/schedule`);
    games = (data?.events ?? []).flatMap((e) => normalizeEvents(e, leagueId)).filter((g) => g.kind === 'match');
    span = { back: WHOLE_SEASON, ahead: WHOLE_SEASON }; // toute la saison
  } catch { /* calendrier illisible : on passe aux tableaux des scores */ }

  if (!games?.length) {
    const offsets = [];
    for (let d = -back; d <= ahead; d += 1) offsets.push(d);
    const found = [];
    for (let i = 0; i < offsets.length; i += 7) {
      const days = await Promise.allSettled(offsets.slice(i, i + 7).map((d) => fetchDay(leagueId, d)));
      for (const r of days) {
        if (r.status !== 'fulfilled') continue;
        found.push(...r.value.filter((g) => g.kind === 'match' && (g.home.id === String(teamId) || g.away.id === String(teamId))));
      }
    }
    games = found;
  }
  games.sort((a, b) => (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0));
  teamGamesCache.set(key, { games, ...span });
  return games;
}

/**
 * Les derniers résultats d'une équipe, du plus ancien au plus récent :
 * { res: 'V' | 'D' | 'N', score, opp, date }.
 */
export async function fetchTeamForm(leagueId, teamId, n = 5) {
  const games = await fetchTeamGames(leagueId, teamId, { back: 21, ahead: 0 });
  return games
    .filter((g) => g.state === 'post')
    .slice(-n)
    .map((g) => {
      const me = g.home.id === String(teamId) ? g.home : g.away;
      const opp = me === g.home ? g.away : g.home;
      const res = me.winner ? 'V' : opp.winner ? 'D' : 'N';
      return { res, score: `${me.score}-${opp.score}`, opp: opp.abbr, date: g.startsAt };
    });
}

/** Grands Prix d'une période : une ligne par week-end, à la date de la course. */
export async function fetchF1Calendar(fromOffset, toOffset) {
  return fetchLeagueCalendar('f1', fromOffset, toOffset);
}

/**
 * Évènements d'une ligue suivie en entier (F1, UFC) sur une période. F1 :
 * une ligne par week-end, à la date de la course.
 */
export async function fetchLeagueCalendar(leagueId, fromOffset, toOffset) {
  const league = LEAGUES_BY_ID[leagueId];
  let events;
  let logo = league.logo ?? '';
  try {
    const data = await getJson(`${league.path}/scoreboard`, boardQuery(league, `?dates=${ymd(fromOffset)}-${ymd(toOffset)}`));
    logo = league.logo || leagueLogo(data);
    events = (data?.events ?? []).flatMap((e) => normalizeEvents(e, leagueId, logo));
  } catch (err) {
    // Certaines ligues refusent les plages de dates (HTTP 400 : LCF, Coupe du
    // monde…) : on demande jour par jour, 7 à la fois (gardés 30 min).
    events = [];
    let ok = 0;
    for (let d = fromOffset; d <= toOffset; d += 7) {
      const days = await Promise.allSettled(Array.from({ length: Math.min(7, toOffset - d + 1) }, (_, i) => fetchDay(leagueId, d + i)));
      for (const r of days) if (r.status === 'fulfilled') { ok += 1; events.push(...r.value); }
    }
    if (!ok) throw err;
  }
  return events.map((g) => {
    if (leagueId !== 'f1') return { ...g, raceState: g.state };
    const race = (g.sessions ?? []).find((s) => /course/i.test(s.label)) ?? g.sessions?.at(-1);
    return { ...g, startsAt: race?.startsAt ?? g.startsAt, raceState: race?.state ?? g.state };
  });
}

/* ---------- Alignement d'une équipe (joueurs favoris) ---------- */

// "ligue:équipe" -> joueurs, gardés un jour sur le disque (la recherche dans
// toute la LNH en charge 32 d'un coup).
const rosterCache = diskCache('rosters', 24 * 3600 * 1000);

/** Joueurs d'une équipe, avec photo. Lève une erreur si ESPN ne les donne pas à l'app. */
export async function fetchRoster(leagueId, teamId) {
  const key = `${leagueId}:${teamId}`;
  const hit = rosterCache.get(key);
  if (hit) return hit;
  const players = await loadRoster(leagueId, teamId);
  if (players.length) rosterCache.set(key, players);
  return players;
}

/**
 * Tous les joueurs d'une ligue, pour les chercher par leur nom : les
 * alignements de toutes ses équipes, 8 à la fois. `onProgress(faites, total)`
 * suit le chargement. Une équipe illisible est sautée ; rien de lisible du
 * tout lève l'erreur.
 */
export async function fetchAllPlayers(leagueId, onProgress = () => {}) {
  const teams = leagueId === 'nhl' ? NHL_TEAMS : await fetchTeams(leagueId);
  const all = [];
  let done = 0;
  let lastErr = null;
  for (let i = 0; i < teams.length; i += 8) {
    const batch = teams.slice(i, i + 8);
    const results = await Promise.allSettled(batch.map((t) => fetchRoster(leagueId, t.id)));
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') all.push(...r.value.map((p) => ({ ...p, team: batch[k].abbr, leagueId })));
      else lastErr = r.reason;
    });
    done += batch.length;
    onProgress(done, teams.length);
  }
  if (!all.length && lastErr) throw lastErr;
  return all.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export const fetchAllNhlPlayers = (onProgress) => fetchAllPlayers('nhl', onProgress);

async function loadRoster(leagueId, teamId) {
  const league = LEAGUES_BY_ID[leagueId];
  const data = await getJson(`${league.path}/teams/${encodeURIComponent(teamId)}/roster`);
  // Au hockey, les joueurs sont groupés par position ({ position, items }).
  const flat = (data?.athletes ?? []).flatMap((a) => (Array.isArray(a?.items) ? a.items : [a]));
  return flat
    .filter((a) => a?.id && a?.displayName)
    .map((a) => ({
      id: String(a.id),
      name: a.displayName,
      short: a.shortName ?? a.displayName,
      jersey: a.jersey ?? '',
      pos: a.position?.abbreviation ?? '',
      photo: athletePhoto(a, leagueId),
      teamId: String(teamId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Données factices : aperçu navigateur et première ouverture hors ligne. */
export function demoEvents(extra = false) {
  return [...DEMO_EVENTS, ...(extra ? DEMO_EXTRA : [])].map((e) => ({ ...e, startsAt: e.startsAt ? new Date(e.startsAt) : null }));
}

/* ---------- Séries éliminatoires : le tableau ---------- */

// Ligues qui ont un tableau des séries : quand il se joue (mois et jour, de
// `from` à `to`), le nom de chaque ronde et les victoires qu'il faut pour
// la gagner. Une ronde absente de la ligue vaut null.
const BRACKETS = {
  nhl: { from: '0410', to: '0630', wins: [4, 4, 4, 4],
    rounds: ['1re ronde', '2e ronde', "Finales d'association", 'Finale de la Coupe Stanley'] },
  nba: { from: '0412', to: '0625', wins: [4, 4, 4, 4],
    rounds: ['1re ronde', 'Demi-finales de conférence', 'Finales de conférence', 'Finale de la NBA'] },
  wnba: { from: '0910', to: '1025', wins: [2, 3, null, 4],
    rounds: ['1re ronde', 'Demi-finales', null, 'Finale de la WNBA'] },
  mlb: { from: '0928', to: '1108', wins: [2, 3, 4, 4],
    rounds: ['Meilleurs deuxièmes', 'Séries de division', 'Séries de championnat', 'Série mondiale'] },
  nfl: { from: '0108', to: '0215', wins: [1, 1, 1, 1],
    rounds: ['Meilleurs deuxièmes', 'Matchs de division', 'Finales de conférence', 'Super Bowl'] },
};

export const hasBracket = (leagueId) => !!BRACKETS[leagueId];

/** Ronde d'un match éliminatoire (0 = 1re ronde … 3 = finale), d'après ESPN. */
function roundOf(headline) {
  const h = String(headline ?? '');
  if (!h || /play-?in|pro bowl/i.test(h)) return null;
  if (/stanley cup final|nba finals|wnba finals|world series|super bowl/i.test(h)) return 3;
  if (/\b(conference|conf\.?|east(ern)?|west(ern)?|afc|nfc|al|nl)\s+(finals?|championship)|\b(alcs|nlcs)\b|championship series/i.test(h)) return 2;
  if (/2nd round|second round|semi|\b(alds|nlds)\b|division(al)?\b/i.test(h)) return 1;
  if (/1st round|first round|wild ?card/i.test(h)) return 0;
  return null;
}

/** Côté du tableau : association, conférence ou ligue. */
function confOf(headline) {
  const h = String(headline ?? '');
  if (/\beast/i.test(h)) return 'Est';
  if (/\bwest/i.test(h)) return 'Ouest';
  if (/\bafc\b/i.test(h)) return 'AFC';
  if (/\bnfc\b/i.test(h)) return 'NFC';
  if (/\b(al|alds|alcs|american)\b/i.test(h)) return 'Américaine';
  if (/\b(nl|nlds|nlcs|national)\b/i.test(h)) return 'Nationale';
  return '';
}

const bracketCache = diskCache('bracket', 15 * 60 * 1000);

/** Les matchs éliminatoires d'une année, regroupés en séries. */
function buildBracket(events, leagueId) {
  const cfg = BRACKETS[leagueId];
  const series = new Map();
  for (const e of events) {
    const comp = e?.competitions?.[0];
    const headline = comp?.notes?.[0]?.headline ?? comp?.series?.title ?? e?.name ?? '';
    const round = roundOf(headline);
    if (round == null || !cfg.rounds[round]) continue;
    const state = e?.status?.type?.state ?? comp?.status?.type?.state ?? 'pre';
    const cs = comp?.competitors ?? [];
    const away = cs.find((c) => c.homeAway === 'away') ?? cs[1];
    const home = cs.find((c) => c.homeAway === 'home') ?? cs[0];
    const a = normalizeCompetitor(away, state);
    const h = normalizeCompetitor(home, state);
    if (!a.id || !h.id) continue;

    const key = `${round}:${[a.id, h.id].sort().join('-')}`;
    if (!series.has(key)) {
      const total = Number(comp?.series?.totalCompetitions) || 0;
      series.set(key, {
        key, round, conf: confOf(headline),
        teams: [h, a], // l'équipe qui reçoit le 1er match : la mieux classée
        wins: { [h.id]: 0, [a.id]: 0 },
        need: total ? Math.floor(total / 2) + 1 : cfg.wins[round] ?? 4,
        games: [],
      });
    }
    const s = series.get(key);
    const winner = state === 'post'
      ? (h.winner ? h.id : a.winner ? a.id : Number(h.score) > Number(a.score) ? h.id : Number(a.score) > Number(h.score) ? a.id : null)
      : null;
    if (winner) s.wins[winner] = (s.wins[winner] ?? 0) + 1;
    s.games.push({ id: String(e?.id ?? ''), state, date: e?.date ?? null, away: a.score, home: h.score, awayId: a.id, homeId: h.id });
  }

  // Une ronde par colonne, les séries rangées pour que chaque paire de la
  // ronde précédente mène à la série suivante (comme un vrai tableau).
  const byRound = new Map();
  for (const s of series.values()) {
    s.games.sort((x, y) => new Date(x.date) - new Date(y.date));
    const [t1, t2] = s.teams;
    const w1 = s.wins[t1.id] ?? 0;
    const w2 = s.wins[t2.id] ?? 0;
    s.winnerId = w1 >= s.need ? t1.id : w2 >= s.need ? t2.id : null;
    s.next = s.games.find((g) => g.state !== 'post') ?? null;
    s.last = [...s.games].reverse().find((g) => g.state === 'post') ?? null;
    if (!byRound.has(s.round)) byRound.set(s.round, []);
    byRound.get(s.round).push(s);
  }
  const indexes = [...byRound.keys()].sort((x, y) => x - y);
  const confRank = (c) => ['Est', 'Américaine', 'AFC', '', 'Ouest', 'Nationale', 'NFC'].indexOf(c);
  for (const i of indexes) byRound.get(i).sort((x, y) => confRank(x.conf) - confRank(y.conf));
  for (let k = indexes.length - 2; k >= 0; k--) {
    const later = byRound.get(indexes[k + 1]);
    const pool = [...byRound.get(indexes[k])];
    const ordered = [];
    for (const s of later) {
      for (const t of s.teams) {
        const i = pool.findIndex((p) => p.teams.some((x) => x.id === t.id));
        if (i >= 0) ordered.push(...pool.splice(i, 1));
      }
    }
    byRound.set(indexes[k], [...ordered, ...pool]);
  }
  return indexes.map((i) => ({ index: i, label: cfg.rounds[i], series: byRound.get(i) }));
}

/**
 * Tableau des séries éliminatoires de la saison en cours, ou de la dernière
 * jouée : { year, rounds: [{ label, series: [{ teams, wins, need, winnerId,
 * conf, next, last, games }] }] }. null si ESPN n'a aucun match éliminatoire.
 */
export async function fetchBracket(leagueId) {
  const cfg = BRACKETS[leagueId];
  const league = LEAGUES_BY_ID[leagueId];
  if (!cfg || !league) return null;
  const now = new Date();
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  // Pas encore commencées cette année : on montre celles de l'an dernier.
  const thisYear = now.getFullYear();
  const years = today >= cfg.from ? [thisYear, thisYear - 1] : [thisYear - 1];

  for (const year of years) {
    const key = `${leagueId}:${year}`;
    let rounds = bracketCache.get(key);
    if (!rounds) {
      // Par tranches de 14 jours : ESPN refuse (HTTP 400) les longues plages.
      const from = new Date(year, Number(cfg.from.slice(0, 2)) - 1, Number(cfg.from.slice(2)));
      const to = new Date(year, Number(cfg.to.slice(0, 2)) - 1, Number(cfg.to.slice(2)));
      const fmt = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const chunks = [];
      for (let a = new Date(from); a <= to; a.setDate(a.getDate() + 14)) {
        const b = new Date(a); b.setDate(b.getDate() + 13);
        chunks.push([fmt(a), fmt(b > to ? to : b)]);
      }
      const events = new Map();
      let lastErr = null;
      const results = await Promise.allSettled(chunks.map(([a, b]) => getJson(`${league.path}/scoreboard`, boardQuery(league, `?seasontype=3&dates=${a}-${b}`))));
      for (const r of results) {
        if (r.status === 'fulfilled') for (const e of r.value?.events ?? []) events.set(String(e?.id), e);
        else lastErr = r.reason;
      }
      if (!events.size && lastErr) throw lastErr;
      rounds = buildBracket([...events.values()], leagueId);
      bracketCache.set(key, rounds);
    }
    if (rounds.length) return { year, rounds };
  }
  return null;
}

/** Matchs d'hier d'une ligue (résumé du matin). */
export function fetchYesterday(leagueId) {
  return fetchDay(leagueId, -1);
}

/**
 * Équipes qui ont retiré leur gardien pour un attaquant de plus, d'après les
 * jeux du match : [idÉquipe]. Vide si ESPN ne le signale pas.
 */
// Infractions au hockey : le nom anglais d'ESPN -> le terme québécois.
const INFRACTIONS_FR = [
  [/too many men|too many players/i, 'Trop de joueurs sur la glace'],
  [/goaltender interference|goalie interference/i, 'Obstruction sur le gardien'],
  [/game misconduct/i, 'Inconduite de partie'],
  [/misconduct/i, 'Inconduite'],
  [/unsportsmanlike/i, 'Conduite antisportive'],
  [/delay(ing)? (of )?game/i, 'Retarder le match'],
  [/holding the stick/i, 'Retenir le bâton'],
  [/high[- ]?stick/i, 'Bâton élevé'],
  [/cross[- ]?check/i, 'Double-échec'],
  [/interference/i, 'Obstruction'],
  [/tripping/i, 'Faire trébucher'],
  [/hooking/i, 'Accrocher'],
  [/slashing/i, 'Cingler'],
  [/holding/i, 'Retenir'],
  [/roughing/i, 'Rudesse'],
  [/fighting/i, 'Bagarre'],
  [/boarding/i, 'Mise en échec contre la bande'],
  [/charging/i, 'Charge'],
  [/elbowing/i, 'Coup de coude'],
  [/kneeing/i, 'Coup de genou'],
  [/spearing/i, 'Darder'],
  [/butt[- ]?ending/i, 'Six-pouces'],
  [/head[- ]?butt/i, 'Coup de tête'],
  [/illegal check to (the )?head|check to the head/i, 'Coup à la tête'],
  [/check(ing)? from behind/i, 'Mise en échec par derrière'],
  [/embellishment|diving/i, 'Embellissement'],
  [/instigator/i, 'Instigateur'],
  [/abuse of official/i, 'Abus envers un officiel'],
  [/closing hand on puck|hand pass/i, 'Refermer la main sur la rondelle'],
  [/broken stick/i, 'Bâton brisé'],
  [/bench/i, 'Pénalité de banc'],
];

/** « Faire trébucher », d'après le texte d'une pénalité d'ESPN ; '' sinon. */
export function infractionFr(text) {
  return INFRACTIONS_FR.find(([re]) => re.test(String(text ?? '')))?.[1] ?? '';
}

/**
 * Pénalités d'un match de hockey, d'après les jeux du résumé d'ESPN :
 * [{ id, teamId, period, clock, who, minutes, infraction, text }].
 */
export async function fetchPenalties(leagueId, eventId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !eventId) return [];
  const data = await getJson(`${league.path}/summary`, `?event=${encodeURIComponent(eventId)}`);
  return (data?.plays ?? [])
    .filter((p) => /penalty/i.test(p?.type?.text ?? '') && !isScoring(p))
    .map((p) => {
      const play = playOf(p);
      const minutes = Number(/(\d+)\s*(?:min|minutes?)\b/i.exec(p?.text ?? '')?.[1]) || null;
      return {
        ...play,
        id: String(p?.id ?? `${play.period}-${play.clock}-${p?.text ?? ''}`),
        minutes,
        infraction: infractionFr(`${p?.text ?? ''} ${p?.type?.text ?? ''}`),
      };
    });
}

export async function fetchPulledGoalies(leagueId, eventId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !eventId) return [];
  try {
    const data = await getJson(`${league.path}/summary`, `?event=${encodeURIComponent(eventId)}`);
    return [...new Set((data?.plays ?? [])
      .filter((p) => /goalie pulled|pulled goalie|pulls? (the )?goalie|extra attacker|empty net(?! goal)/i.test(`${p?.type?.text ?? ''} ${p?.text ?? ''}`))
      .map((p) => String(p?.team?.id ?? ''))
      .filter(Boolean))];
  } catch {
    return [];
  }
}

/* ---------- Diagnostic : ce qu'ESPN répond, ligue par ligue ---------- */

/**
 * Teste une ligue depuis l'ordinateur de l'utilisateur : tableau des scores
 * du jour, liste des équipes (ligues d'équipes). Pour chaque essai :
 * { ok, text } — le nombre trouvé, ou l'erreur d'ESPN telle quelle.
 */
export async function probeLeague(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  const out = { scores: null, teams: null };
  try {
    const data = await getJson(`${league.path}/scoreboard`, boardQuery(league));
    const n = (data?.events ?? []).length;
    out.scores = { ok: true, text: n ? `${n} évènement${n > 1 ? 's' : ''}` : 'aucun aujourd’hui' };
  } catch (err) {
    out.scores = { ok: false, text: errText(err).split('\n').slice(0, 2).join(' · ') };
  }
  if (league.kind === 'team') {
    try {
      const teams = await fetchTeams(leagueId);
      const want = league.teams || 0;
      const bare = teams.filter((t) => !t.logo).length;
      out.teams = {
        ok: teams.length > 0 && teams.length >= want && !bare,
        text: [
          want ? `${teams.length}/${want} équipes` : `${teams.length} équipe${teams.length > 1 ? 's' : ''}`,
          bare ? `${bare} sans logo` : '',
          bare && logoError(leagueId) ? `(${logoError(leagueId)})` : '',
        ].filter(Boolean).join(' · '),
      };
    } catch (err) {
      out.teams = { ok: false, text: errText(err).split('\n').slice(0, 2).join(' · ') };
    }
  }
  return out;
}
