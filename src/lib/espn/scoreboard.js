// Scores du jour, équipes, calendriers : ce qu'ESPN appelle le « scoreboard ».
// (Découpé de api.js : les autres fichiers importent toujours depuis api.js.)
import { LEAGUES_BY_ID } from '../leagues.js';
import { DEMO_EVENTS, DEMO_EXTRA } from '../demo.js';
import { errText } from '../err.js';
import { NHL_TEAMS } from '../teams-nhl.js';
import { ordinal } from '../format.js';
import { statusFr, weightFr, resultFr, segmentFr, roundFr, drawFr } from '../status-fr.js';
import { diskCache } from '../cache.js';
import { autoFr } from '../translate.js';
import { SHOT_STATS, assistNames, athletePhoto, boardQuery, byName, driverPhoto, getJson, headshotUrl, isScoring, readTeamsCache, safe, scoreText, scorerName, sportOfLeague, statOf, teamsFromCore, teamsFromDirectory, toTeam, writeTeamsCache, ymd } from './core.js';
import { fillGameLogos, fillLogos, logoError } from './logos.js';

/** Listes intégrées à l'app, pour les ligues dont on a une copie vérifiée. */
export const BUNDLED_TEAMS = { nhl: NHL_TEAMS };

/**
 * Secours : les équipes qui jouent autour d'aujourd'hui, tirées du calendrier.
 * `/scoreboard` est lisible depuis l'app, contrairement à `/teams`.
 */
export async function teamsFromSchedule(league) {
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
/**
 * Équipe invitée d'un match amical (équipe nationale) : nom de pays tout en
 * majuscules (« JAPAN », « NIGERIA ») ou drapeau d'un pays pour logo. Les
 * clubs au nom en majuscules (« LAFC ») ne sont pas touchés.
 */
export function isGuestTeam(t) {
  const name = String(t?.name ?? '').trim();
  // 5 lettres ou plus, et pas un club (« LAFC ») : un pays écrit en majuscules.
  const shouting = name.length >= 5 && name === name.toUpperCase() && /^[A-Z .'-]+$/.test(name) && !/FC\b/.test(name);
  return shouting || /\/countries\//.test(String(t?.logo ?? ''));
}

export async function fetchTeams(leagueId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || league.kind !== 'team') return [];

  if (BUNDLED_TEAMS[leagueId]) return [...BUNDLED_TEAMS[leagueId]].sort(byName);

  const cached = readTeamsCache(leagueId);
  if (cached) {
    const clean = league.tournament || league.id === 'intl' ? cached : cached.filter((t) => !isGuestTeam(t));
    return fillLogos(leagueId, clean);
  }

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
      // Au calendrier, il y a aussi les matchs amicaux contre des équipes
      // nationales (la WNBA contre le Japon) : elles ne sont pas de la ligue.
      const seen = await teamsFromSchedule(league);
      merge(league.tournament || league.id === 'intl' ? seen : seen.filter((t) => !isGuestTeam(t)));
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

export function normalizeCompetitor(c, state) {
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

/** Fiche de l'équipe (« 12-5-3 »), sous l'une ou l'autre forme d'ESPN. */
export function recordOf(c) {
  const list = c?.records ?? c?.record ?? [];
  if (!Array.isArray(list)) return '';
  const total = list.find((r) => /total|overall/i.test(`${r?.type ?? ''} ${r?.name ?? ''}`)) ?? list[0];
  return total?.summary ?? total?.displayValue ?? '';
}

// Un week-end de F1 regroupe plusieurs séances. La date de l'évènement est
// celle de la première (les essais libres du jeudi ou du vendredi) : l'afficher
// seule donnerait l'impression que le Grand Prix a lieu ce jour-là.
export const SESSION_LABELS = {
  FP1: 'Essais 1',
  FP2: 'Essais 2',
  FP3: 'Essais 3',
  QUAL: 'Qualifications',
  SS: 'Qualifs sprint',
  SQ: 'Qualifs sprint',
  SPRINT: 'Sprint',
  RACE: 'Course',
};

export function sessionLabel(comp) {
  const abbr = String(comp?.type?.abbreviation ?? '').toUpperCase();
  return SESSION_LABELS[abbr] ?? autoFr(comp?.type?.text ?? '');
}

/** Un pilote, tel qu'ESPN le décrit dans une séance. */
export function toDriver(c, i) {
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
    // Qualifications : meilleur temps en Q1, Q2 et Q3 (vide si non couru).
    q: qualiTimes(c?.statistics),
  };
}

/** Temps de Q1, Q2 et Q3 d'un pilote, quel que soit le nom qu'ESPN leur donne. */
export function qualiTimes(stats) {
  const out = ['', '', ''];
  for (const x of stats ?? []) {
    const m = /^(?:q|qual(?:ifying)?[ _-]?)([123])(?:[ _-]?time)?$/i.exec(String(x?.name ?? x?.abbreviation ?? ''));
    const v = String(x?.displayValue ?? '').trim();
    if (m && v && v !== '-' && v !== '0') out[Number(m[1]) - 1] = v;
  }
  return out.some(Boolean) ? out : [];
}

/** Séance de qualifications (ou de qualifs sprint) ? */
export const isQualSession = (comp) => /^(QUAL|SQ|SS)$/.test(String(comp?.type?.abbreviation ?? '').toUpperCase());

/**
 * Phase des qualifications en cours : 1, 2 ou 3 (Q1, Q2, Q3), d'après le
 * statut d'ESPN ; 3 une fois finies ; null hors qualifications.
 */
export function qualPhase(comp) {
  if (!isQualSession(comp)) return null;
  const st = comp?.status ?? {};
  if (st.type?.state === 'post') return 3;
  const text = `${st.type?.detail ?? ''} ${st.type?.shortDetail ?? ''}`;
  const fromText = Number(/\b(?:S?Q)([123])\b/i.exec(text)?.[1]);
  if (fromText) return fromText;
  const p = Number(st.period);
  return p >= 1 && p <= 3 ? p : 1;
}

/**
 * Pilotes qualifiés pour la phase suivante : 10 en Q3 ; les autres
 * partagés en deux (20 voitures : 15 passent en Q2 ; 22 voitures : 16).
 */
export const qualCuts = (n) => ({ q2: 10 + Math.floor(Math.max(0, n - 10) / 2), q3: 10 });

/** « +1.234 », « 1:02.345 » -> secondes ; null pour « +1 tour » ou vide. */
export function gapSeconds(gap) {
  const t = String(gap ?? '').trim().replace(/^\+/, '');
  if (!t || /lap|tour/i.test(t)) return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null;
}

/**
 * Écart avec le pilote juste devant (« +0.812 »), d'après les écarts avec le
 * premier. '' si l'un des deux n'est pas un temps (tour de retard…).
 */
export function intervalText(results, i) {
  if (i <= 0) return '';
  const here = gapSeconds(results[i]?.gap);
  const ahead = i === 1 ? 0 : gapSeconds(results[i - 1]?.gap);
  if (here === null || ahead === null || here < ahead) return '';
  return `+${(here - ahead).toFixed(3)}`;
}

export const PIT_STATS = ['pitStops', 'pits', 'pitstops', 'numPitStops', 'stops'];

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
export const GAP_STATS = ['behindTime', 'behind', 'gapToLeader', 'timeBehind', 'gap', 'interval'];

export function gapOf(c) {
  const direct = c?.behindTime ?? c?.behind ?? c?.gap;
  if (direct != null && typeof direct !== 'object' && String(direct) !== '') return String(direct);
  return statOf(c?.statistics, GAP_STATS);
}

/**
 * Classement complet d'une séance. Chez ESPN, chaque pilote est un
 * « competitor » ; `order` donne sa position. Liste vide si la structure ne
 * correspond pas : on n'affiche rien plutôt qu'un faux classement.
 */
export function classification(session) {
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
export function weekendSessions(event) {
  return (event?.competitions ?? [])
    .filter((c) => c?.date)
    .map((c) => {
      const state = c?.status?.type?.state ?? 'pre';
      return {
        id: String(c?.id ?? ''),
        label: sessionLabel(c),
        startsAt: new Date(c.date),
        state,
        qual: isQualSession(c),
        phase: qualPhase(c),
        // Classement de chaque séance (essais, qualifs, sprint, course).
        results: state === 'pre' ? [] : classification(c),
      };
    })
    .sort((a, b) => a.startsAt - b.startsAt);
}

/** Séance en cours, sinon la prochaine, sinon la dernière du week-end. */
export function pickSession(event) {
  const comps = (event?.competitions ?? []).filter((c) => c?.date);
  if (comps.length < 2) return null;
  const live = comps.find((c) => c?.status?.type?.state === 'in');
  if (live) return live;
  const upcoming = comps
    .filter((c) => c?.status?.type?.state === 'pre')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  return upcoming[0] ?? comps[comps.length - 1];
}

/**
 * Dernier buteur de chaque équipe, si le tableau des scores le fournit
 * (champ `details`, présent au soccer). Sinon, objet vide.
 */
export function lastScorers(comp) {
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
export function leagueLogo(data) {
  const logos = data?.leagues?.[0]?.logos ?? [];
  const dark = logos.find((l) => Array.isArray(l?.rel) && l.rel.includes('dark') && l.href);
  return (dark ?? logos.find((l) => l?.href))?.href ?? '';
}

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

export const ROUNDS = [
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
export function seriesInfo(comp, homeC, awayC) {
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

// Sigles des chaînes d'ESPN -> leur nom d'ici.
const CHANNEL_FR = [
  [/^TVAS\s*2$/i, 'TVA Sports 2'], [/^TVAS$|^TVA Sports$/i, 'TVA Sports'],
  [/^SN\s*1$/i, 'Sportsnet One'], [/^SN\s*360$/i, 'Sportsnet 360'], [/^SN[EOPW]?$|^Sportsnet( (East|West|Ontario|Pacific))?$/i, 'Sportsnet'],
  [/^Prime Video$|^Amazon Prime/i, 'Prime Video'], [/^Apple TV\+?$|^MLS Season Pass$/i, 'Apple TV'],
];
/** Chaînes en français d'abord, puis canadiennes, puis le reste. */
const channelRank = (name) => (/^(RDS|TVA)/i.test(name) ? 0
  : /^(Sportsnet|TSN|CBC|Citytv|Prime Video|Apple TV|DAZN|Crave|OneSoccer)/i.test(name) ? 1 : 2);

/**
 * Où regarder le match : 3 chaînes au plus, RDS et TVA Sports en tête. Lit
 * `broadcasts` (listes de noms) comme `geoBroadcasts` (objets « media »).
 */
export function broadcastsOf(...lists) {
  const names = [];
  for (const list of lists) {
    for (const b of Array.isArray(list) ? list : []) {
      if (typeof b === 'string') names.push(b);
      else if (Array.isArray(b?.names)) names.push(...b.names);
      else if (b?.media?.shortName || b?.media?.name) {
        // Radio : on ne garde que la télé et la diffusion en ligne.
        if (/radio/i.test(b?.type?.shortName ?? '')) continue;
        names.push(b.media.shortName ?? b.media.name);
      }
    }
  }
  const seen = new Set();
  return names
    .map((n) => String(n ?? '').trim())
    .filter(Boolean)
    .map((n) => CHANNEL_FR.find(([re]) => re.test(n))?.[1] ?? n)
    .filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
    .map((n, i) => [n, channelRank(n), i])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .slice(0, 3)
    .map(([n]) => n);
}

/** Page ESPN du match (feuille de match, statistiques), si l'API la fournit. */
export function pickLink(event) {
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
export function liveClock(leagueId, state, frStatus, clock, statusText = '') {
  if (state !== 'in' || /^(Fin|Début) de/.test(frStatus ?? '')) return '';
  if (LEAGUES_BY_ID[leagueId]?.path.startsWith('baseball/')) return '';
  // Déjà dans le statut (« 7:42 · 3e quart ») : pas deux fois la même heure.
  if (clock && String(statusText).includes(clock)) return '';
  return clock ?? '';
}

/** Un combattant, tel qu'ESPN le décrit dans un combat. */
export function fighterOf(c) {
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
export function fightOf(comp) {
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
export function normalizeCard(event, base, logo) {
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

/** Un golfeur au tableau : rang (« T3 »), score par rapport à la normale. */
export function golferOf(c, i) {
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

export function normalizeGolf(event, base, logo) {
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

export function tennisPlayer(c, leagueId) {
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
export function normalizeTennis(event, leagueId, logo) {
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
export function normalizeEvents(event, leagueId, logo = '') {
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

export function normalizeEvent(event, leagueId, logo = '') {
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
      qual: isQualSession(session),
      phase: qualPhase(session),
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
    broadcasts: safe(() => broadcastsOf(comp?.broadcasts, comp?.geoBroadcasts), []),
    situation: base.state === 'in' ? safe(() => baseballSituation(comp?.situation, leagueId), null) : null,
  };
}

// Abréviations d'ESPN dans les résumés (« 5.0 IP, 3 H, 1 ER, 7 K ») -> québécois.
export const PITCH_ABBR = { IP: 'ML', H: 'CS', R: 'P', ER: 'PM', BB: 'BB', K: 'RB', SO: 'RB', HR: 'CC', PC: 'lancers', P: 'lancers', HBP: 'AL', RBI: 'PP', SB: 'BV', AB: 'VB' };

/** « 5.0 IP, 3 H, 1 ER, 7 K » -> « 5.0 ML, 3 CS, 1 PM, 7 RB ». Frappeur : « 1-2, HR » -> « 1 en 2, CC ». */
export function baseballLineFr(summary) {
  return String(summary ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const hits = /^(\d+)-(\d+)$/.exec(part);
      if (hits) return `${hits[1]} en ${hits[2]}`;
      const m = /^([\d.]+)?\s*([A-Za-z]+)$/.exec(part);
      if (!m) return part;
      const label = PITCH_ABBR[m[2].toUpperCase()] ?? m[2];
      return m[1] ? `${m[1]} ${label}` : label;
    })
    .join(', ');
}

/**
 * Situation d'un match de baseball en direct : { pitcher, batter, balls,
 * strikes, outs, bases: [1re, 2e, 3e] }. null hors baseball ou sans données.
 */
export function baseballSituation(sit, leagueId) {
  if (sportOfLeague(leagueId) !== 'baseball' || !sit) return null;
  const person = (x) => {
    const a = x?.athlete;
    if (!a) return null;
    return {
      id: String(a.id ?? x.playerId ?? ''),
      name: a.displayName ?? a.fullName ?? '',
      short: a.shortName ?? a.displayName ?? '',
      teamId: String(a.team?.id ?? ''),
      photo: athletePhoto(a, leagueId),
      line: baseballLineFr(x.summary),
    };
  };
  const out = {
    pitcher: person(sit.pitcher),
    batter: person(sit.batter),
    balls: Number(sit.balls) || 0,
    strikes: Number(sit.strikes) || 0,
    outs: Number(sit.outs) || 0,
    bases: [!!sit.onFirst, !!sit.onSecond, !!sit.onThird],
  };
  return out.pitcher || out.batter ? out : null;
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
export const DAY_TTL = 30 * 60 * 1000;
// "ligue:AAAAMMJJ" -> matchs du jour, gardés sur le disque 30 min.
export const dayCache = diskCache('days', DAY_TTL);

export async function fetchDay(leagueId, offsetDays) {
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

export const TEAM_TTL = 3 * 3600 * 1000;
// "ligue:équipe" -> { games, back, ahead }, gardé sur le disque 3 h.
export const teamGamesCache = diskCache('teamGames', TEAM_TTL);
export const WHOLE_SEASON = 9999; // jours : calendrier complet de la saison

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

/** Données factices : aperçu navigateur et première ouverture hors ligne. */
export function demoEvents(extra = false) {
  return [...DEMO_EVENTS, ...(extra ? DEMO_EXTRA : [])].map((e) => ({ ...e, startsAt: e.startsAt ? new Date(e.startsAt) : null }));
}

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
