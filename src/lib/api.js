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
import { ordinal } from './format.js';
import { statusFr, weightFr, resultFr, segmentFr } from './status-fr.js';

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

  // 3. Ligue hors saison (WNBA l'hiver, MLS en décembre) : on remonte le
  //    temps par tranches de deux semaines, jusqu'à dix mois en arrière, pour
  //    retrouver les équipes de la dernière saison.
  const ranges = [];
  for (let end = -31; end > -310; end -= 14) ranges.push([end - 13, end]);
  for (let i = 0; i < ranges.length && seen.size < target; i += 4) {
    const results = await Promise.allSettled(
      ranges.slice(i, i + 4).map(([a, b]) => getJson(`${league.path}/scoreboard`, `?dates=${ymd(a)}-${ymd(b)}`)),
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

function normalizeCompetitor(c, state) {
  const t = c?.team ?? {};
  return {
    id: String(t.id ?? ''),
    abbr: t.abbreviation ?? t.shortDisplayName ?? '???',
    name: t.shortDisplayName ?? t.displayName ?? '',
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
  return SESSION_LABELS[abbr] ?? comp?.type?.text ?? '';
}

/**
 * Photo d'un pilote. ESPN range les portraits de la course automobile sous
 * « rpm » ; on prend celle de la réponse quand elle y est.
 */
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
  };
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
 * Même pilote ? L'identifiant ESPN d'abord ; à défaut, le nom de famille
 * (un favori noté avec une autre forme du nom reste reconnu).
 */
export function sameDriver(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  const last = (d) => String(d.name || d.short || '').trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  return !!last(a) && last(a) === last(b);
}

/** Toutes les séances du week-end, pour la fenêtre de détail. */
function weekendSessions(event) {
  return (event?.competitions ?? [])
    .filter((c) => c?.date)
    .map((c) => ({
      label: sessionLabel(c),
      startsAt: new Date(c.date),
      state: c?.status?.type?.state ?? 'pre',
    }))
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
 * Buteur du dernier but d'une équipe, lu dans le résumé détaillé du match.
 * Sert quand le tableau des scores ne donne pas le nom (au hockey). Renvoie
 * '' si ESPN ne le fournit pas ou si l'adresse est illisible depuis l'app.
 */
export async function fetchScorer(leagueId, eventId, teamId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !eventId) return '';
  try {
    const data = await getJson(`${league.path}/summary`, `?event=${encodeURIComponent(eventId)}`);
    const pools = [data?.scoringPlays, data?.plays, data?.keyEvents, data?.header?.competitions?.[0]?.details];
    let last = null;
    for (const pool of pools) {
      for (const p of pool ?? []) {
        if (isScoring(p) && String(p?.team?.id ?? '') === String(teamId)) last = p;
      }
      if (last) break; // première source qui connaît le but : on s'y tient
    }
    return last ? scorerName(last) : '';
  } catch {
    return '';
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
  const p = Number(period) || 0;
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
function liveClock(leagueId, state, frStatus, clock) {
  if (state !== 'in' || frStatus?.startsWith('Fin de')) return '';
  if (LEAGUES_BY_ID[leagueId]?.path.startsWith('baseball/')) return '';
  return clock ?? '';
}

/* ---------- UFC : galas et combats ---------- */

/** Un combattant, tel qu'ESPN le décrit dans un combat. */
function fighterOf(c) {
  const a = c?.athlete ?? {};
  const id = String(a.id ?? c?.id ?? '');
  const photo = a.headshot?.href ?? (id ? `https://a.espncdn.com/i/headshots/mma/players/full/${id}.png` : '');
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

function normalizeEvent(event, leagueId, logo = '') {
  const comp = event?.competitions?.[0];
  const status = event?.status ?? comp?.status ?? {};
  const state = status?.type?.state ?? 'pre';
  // Saison de type 3 = séries éliminatoires chez ESPN.
  const playoffs = Number(event?.season?.type) === 3 || !!comp?.series;
  const frStatus = leagueId === 'nhl'
    ? hockeyStatus({ state, period: status?.period, clock: status?.displayClock, detail: status?.type?.shortDetail }, playoffs)
    : null;
  const base = {
    id: String(event?.id ?? ''),
    leagueId,
    state,
    statusText: frStatus ?? statusFr(status?.type?.shortDetail ?? status?.type?.description ?? ''),
    playoffs,
    clock: liveClock(leagueId, state, frStatus, status?.displayClock),
    startsAt: event?.date ? new Date(event.date) : null,
    link: pickLink(event),
  };

  // UFC : un gala = un évènement, un combat = une « competition ».
  if (LEAGUES_BY_ID[leagueId]?.kind === 'card') return normalizeCard(event, base, logo);

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
  const data = await getJson(`${league.path}/scoreboard`);
  const logo = league.logo || leagueLogo(data);
  return (data?.events ?? []).map((e) => normalizeEvent(e, leagueId, logo));
}

// Calendrier des jours à venir : il change peu, inutile de le redemander à
// chaque rafraîchissement du widget (toutes les 25 s pendant un match).
// Horizon d'affichage : le widget ne montre que les matchs des 4 prochains
// jours. Au-delà, inutile de chercher.
export const LOOKAHEAD_DAYS = 4;
const DAY_TTL = 30 * 60 * 1000;
const dayCache = new Map(); // "ligue:AAAAMMJJ" -> { at, events }

async function fetchDay(leagueId, offsetDays) {
  const league = LEAGUES_BY_ID[leagueId];
  const date = ymd(offsetDays);
  const key = `${leagueId}:${date}`;
  const hit = dayCache.get(key);
  if (hit && Date.now() - hit.at < DAY_TTL) return hit.events;

  const data = await getJson(`${league.path}/scoreboard`, `?dates=${date}`);
  const logo = league.logo || leagueLogo(data);
  const events = (data?.events ?? []).map((e) => normalizeEvent(e, leagueId, logo));
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
  return rows;
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
  return {
    id: String(eventId),
    leagueId,
    state,
    playoffs,
    statusText: frStatus ?? statusFr(status?.type?.shortDetail ?? ''),
    clock: liveClock(leagueId, state, frStatus, status?.displayClock),
    startsAt: comp?.date ? new Date(comp.date) : null,
    home,
    away,
    stats: teamStats(data, leagueId, home.id, away.id),
    ...keyPlays(data),
    series: seriesInfo(comp, homeC, awayC),
    venue: data?.gameInfo?.venue?.fullName ?? '',
    link: pickLink(data?.header) || '',
  };
}

/* ---------- Classements ---------- */

const GROUP_FR = [
  [/eastern/i, "Association de l'Est"], [/western/i, "Association de l'Ouest"],
  [/atlantic/i, 'Atlantique'], [/metropolitan/i, 'Métropolitaine'], [/central/i, 'Centrale'],
  [/pacific/i, 'Pacifique'], [/american league|^al\b/i, 'Ligue américaine'], [/national league|^nl\b/i, 'Ligue nationale'],
];
const groupFr = (name) => GROUP_FR.find(([re]) => re.test(name ?? ''))?.[1] ?? name ?? '';

const standingsCache = new Map(); // idLigue -> { at, table }
const STANDINGS_TTL = 60 * 60 * 1000;

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

/**
 * Classement d'une ligue : Map idÉquipe -> { rank, group, points }. Vide si
 * ESPN ne le fournit pas à l'app (adresse différente de celle des scores).
 */
export async function fetchStandings(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return new Map();
  const hit = standingsCache.get(leagueId);
  if (hit && Date.now() - hit.at < STANDINGS_TTL) return hit.table;

  const table = new Map();
  try {
    const data = await viaPage(`https://site.api.espn.com/apis/v2/sports/${league.path}/standings`);
    const walk = (node) => {
      const entries = node?.standings?.entries;
      if (entries?.length) {
        rankEntries(entries).forEach((e, i) => {
          const id = String(e?.team?.id ?? '');
          const pts = e?.stats?.find((s) => s?.name === 'points')?.displayValue ?? '';
          if (id) table.set(id, { rank: i + 1, group: groupFr(node?.name), points: pts });
        });
      }
      (node?.children ?? []).forEach(walk);
    };
    walk(data);
  } catch { /* classement indisponible : la fenêtre s'en passe */ }
  standingsCache.set(leagueId, { at: Date.now(), table });
  return table;
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
  try { absorb(await getJson(`${league.path}/scoreboard`)); } catch (err) { lastErr = err; }
  // Entre deux Grands Prix, on remonte le calendrier par tranches d'un mois.
  for (let end = 0; end > -240 && !sessions.some((x) => x.rank === 2); end -= 30) {
    try { absorb(await getJson(`${league.path}/scoreboard`, `?dates=${ymd(end - 29)}-${ymd(end)}`)); } catch (err) { lastErr = err; }
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
const teamGamesCache = new Map(); // "ligue:équipe" -> { at, games }

/**
 * Matchs de la saison d'une équipe (passés et à venir), triés par date.
 * Source : le calendrier de l'équipe chez ESPN ; s'il est illisible depuis
 * l'app, on reconstitue autour d'aujourd'hui à partir des tableaux des scores.
 */
export async function fetchTeamGames(leagueId, teamId, { back = 21, ahead = 30 } = {}) {
  const key = `${leagueId}:${teamId}`;
  const hit = teamGamesCache.get(key);
  if (hit && Date.now() - hit.at < TEAM_TTL && hit.back >= back && hit.ahead >= ahead) return hit.games;
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return [];

  let games = null;
  let span = { back, ahead };
  try {
    const data = await getJson(`${league.path}/teams/${encodeURIComponent(teamId)}/schedule`);
    games = (data?.events ?? []).map((e) => normalizeEvent(e, leagueId)).filter((g) => g.kind === 'match');
    span = { back: Infinity, ahead: Infinity }; // toute la saison
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
  teamGamesCache.set(key, { at: Date.now(), games, ...span });
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
  const data = await getJson(`${league.path}/scoreboard`, `?dates=${ymd(fromOffset)}-${ymd(toOffset)}`);
  const logo = league.logo || leagueLogo(data);
  return (data?.events ?? []).map((e) => {
    const g = normalizeEvent(e, leagueId, logo);
    if (leagueId !== 'f1') return { ...g, raceState: g.state };
    const race = (g.sessions ?? []).find((s) => /course/i.test(s.label)) ?? g.sessions?.at(-1);
    return { ...g, startsAt: race?.startsAt ?? g.startsAt, raceState: race?.state ?? g.state };
  });
}

/* ---------- Alignement d'une équipe (joueurs favoris) ---------- */

/** Joueurs d'une équipe, avec photo. Lève une erreur si ESPN ne les donne pas à l'app. */
export async function fetchRoster(leagueId, teamId) {
  const league = LEAGUES_BY_ID[leagueId];
  const data = await getJson(`${league.path}/teams/${encodeURIComponent(teamId)}/roster`);
  // Au hockey, les joueurs sont groupés par position ({ position, items }).
  const flat = (data?.athletes ?? []).flatMap((a) => (Array.isArray(a?.items) ? a.items : [a]));
  const sport = league.path.split('/')[1];
  return flat
    .filter((a) => a?.id && a?.displayName)
    .map((a) => ({
      id: String(a.id),
      name: a.displayName,
      short: a.shortName ?? a.displayName,
      jersey: a.jersey ?? '',
      pos: a.position?.abbreviation ?? '',
      photo: a.headshot?.href ?? `https://a.espncdn.com/i/headshots/${sport}/players/full/${a.id}.png`,
      teamId: String(teamId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Données factices : aperçu navigateur et première ouverture hors ligne. */
export function demoEvents() {
  return DEMO_EVENTS.map((e) => ({ ...e, startsAt: e.startsAt ? new Date(e.startsAt) : null }));
}
