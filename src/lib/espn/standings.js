// Classements, championnat de F1 et tableau des séries éliminatoires.
// (Découpé de api.js : les autres fichiers importent toujours depuis api.js.)
import { LEAGUES_BY_ID } from '../leagues.js';
import { diskCache } from '../cache.js';
import { autoFr } from '../translate.js';
import { boardQuery, driverPhoto, getJson } from './core.js';
import { fillLogos } from './logos.js';
import { normalizeCompetitor } from './scoreboard.js';

export const GROUP_FR = [
  [/eastern/i, "Association de l'Est"], [/western/i, "Association de l'Ouest"],
  [/atlantic/i, 'Atlantique'], [/metropolitan/i, 'Métropolitaine'], [/central/i, 'Centrale'],
  [/pacific/i, 'Pacifique'], [/american league|^al\b/i, 'Ligue américaine'], [/national league|^nl\b/i, 'Ligue nationale'],
];
export const groupFr = (name) => GROUP_FR.find(([re]) => re.test(name ?? ''))?.[1] ?? autoFr(name);

export const STANDINGS_TTL = 60 * 60 * 1000;
// idLigue -> groupes du classement, gardés sur le disque 1 h.
export const standingsCache = diskCache('standings.v2', STANDINGS_TTL);

/** Vrai pour un classement de pré-saison (type de saison 1 chez ESPN). */
export const isPreseason = (st) => [st?.seasonType, st?.seasonType?.type, st?.season?.type]
  .some((t) => Number(t?.type ?? t) === 1);

/** Pré-saison : les matchs préparatoires ne comptent pas, tout le monde à zéro. */
export const ZERO_STATS = { winPercent: '.000', gamesBehind: '-' };
export function zeroStats(stats) {
  return Object.fromEntries(Object.keys(stats).map((k) => [k, ZERO_STATS[k] ?? '0']));
}

/** Rang de chaque équipe dans son groupe, trié comme ESPN le calcule. */
export function rankEntries(entries) {
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

// Ligues qui ont un tableau des séries : quand il se joue (mois et jour, de
// `from` à `to`), le nom de chaque ronde et les victoires qu'il faut pour
// la gagner. Une ronde absente de la ligue vaut null.
export const BRACKETS = {
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
export function roundOf(headline) {
  const h = String(headline ?? '');
  if (!h || /play-?in|pro bowl/i.test(h)) return null;
  if (/stanley cup final|nba finals|wnba finals|world series|super bowl/i.test(h)) return 3;
  if (/\b(conference|conf\.?|east(ern)?|west(ern)?|afc|nfc|al|nl)\s+(finals?|championship)|\b(alcs|nlcs)\b|championship series/i.test(h)) return 2;
  if (/2nd round|second round|semi|\b(alds|nlds)\b|division(al)?\b/i.test(h)) return 1;
  if (/1st round|first round|wild ?card/i.test(h)) return 0;
  return null;
}

/** Côté du tableau : association, conférence ou ligue. */
export function confOf(headline) {
  const h = String(headline ?? '');
  if (/\beast/i.test(h)) return 'Est';
  if (/\bwest/i.test(h)) return 'Ouest';
  if (/\bafc\b/i.test(h)) return 'AFC';
  if (/\bnfc\b/i.test(h)) return 'NFC';
  if (/\b(al|alds|alcs|american)\b/i.test(h)) return 'Américaine';
  if (/\b(nl|nlds|nlcs|national)\b/i.test(h)) return 'Nationale';
  return '';
}

export const bracketCache = diskCache('bracket', 15 * 60 * 1000);

/** Les matchs éliminatoires d'une année, regroupés en séries. */
export function buildBracket(events, leagueId) {
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
