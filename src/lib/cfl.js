// LCF : ESPN ne la suit plus (son tableau des scores est figé sur la Coupe
// Grey 2022, sans aucun match des saisons suivantes). Les matchs viennent du
// tableau des scores officiel de la ligue (cflscoreboard.cfl.ca) : une seule
// réponse JSON pour toute la saison, pré-saison et séries comprises.
import { diskCache } from './cache.js';
import { getText } from './races.js';

const MIN = 60 * 1000;

// Sigle de la LCF → identifiant ESPN de l'équipe : les favoris déjà cochés
// (« cfl:83 » pour Montréal) et les logos de l'app restent valables.
export const CFL_TEAMS = {
  BC: { id: '79', division: 'Ouest' },
  CGY: { id: '80', division: 'Ouest' },
  EDM: { id: '81', division: 'Ouest' },
  HAM: { id: '82', division: 'Est' },
  MTL: { id: '83', division: 'Est' },
  SSK: { id: '84', division: 'Ouest' },
  TOR: { id: '85', division: 'Est' },
  WPG: { id: '86', division: 'Ouest' },
  OTT: { id: '87', division: 'Est' },
};

/** Nom français d'un tour : « Semi-Finals » → « Demi-finale de division ». */
export function cflRoundFr(round) {
  const name = String(round?.name ?? '');
  const n = /(\d+)(?:st|nd|rd|th)\s+Grey Cup/i.exec(name);
  if (/grey cup/i.test(name)) return n ? `${n[1]}e Coupe Grey` : 'Coupe Grey';
  if (/semi/i.test(name)) return 'Demi-finale de division';
  if (/final/i.test(name)) return 'Finale de division';
  if (round?.type === 'PRE') return 'Pré-saison';
  if (round?.type === 'REG' && round?.number) return `Semaine ${round.number}`;
  return name;
}

const PERIODS = ['', '1er quart', '2e quart', '3e quart', '4e quart'];

/** Un match du tableau des scores de la LCF, sous la forme d'un match du widget. */
export function cflGame(round, t) {
  const status = String(t?.status ?? '').toLowerCase();
  const state = status === 'scheduled' || status === 'pre' ? 'pre'
    : /complete|final|cancel|postpon/.test(status) ? 'post' : 'in';
  const playoffs = round?.type === 'POST';
  const side = (sq) => {
    const known = CFL_TEAMS[sq?.shortName];
    const tbd = !known;
    return {
      id: known?.id ?? '',
      abbr: tbd ? '?' : sq.shortName,
      name: tbd ? 'À déterminer' : sq.name,
      short: tbd ? 'À déterminer' : String(sq.name ?? '').split(' ').pop(),
      logo: '',
      color: '',
      score: state === 'pre' ? '–' : String(sq?.score ?? 0),
      winner: state === 'post' && t?.winner != null && String(t.winner) === String(sq?.id),
      record: '',
      tbd,
    };
  };
  const period = Number(t?.activePeriod) || null;
  const live = state === 'in'
    ? (/half/.test(status) ? 'Mi-temps' : period > 4 ? 'Prolongation' : PERIODS[period] ?? '')
    : '';
  const round_ = cflRoundFr(round);
  return {
    id: `cfl-${t.id}`,
    leagueId: 'cfl',
    kind: 'match',
    state,
    statusText: state === 'post' ? (/cancel/.test(status) ? 'Annulé' : /postpon/.test(status) ? 'Reporté' : 'Final')
      : state === 'in' ? live || 'En cours' : '',
    clock: state === 'in' && t?.clock ? String(t.clock) : '',
    period,
    playoffs,
    phase: round?.type ?? '', // PRE (pré-saison), REG (saison régulière), POST (séries)
    session: playoffs ? round_ : '',
    series: playoffs ? { text: round_ } : null,
    startsAt: t?.date ? new Date(t.date) : null,
    home: side(t?.homeSquad),
    away: side(t?.awaySquad),
    link: 'https://www.cfl.ca/schedule/',
  };
}

// Toute la saison, gardée sur le disque : relue toutes les 30 s pendant un
// match (ou dans l'heure qui précède), sinon toutes les 30 min.
const store = diskCache('cfl', 2 * 24 * 3600e3);
let pending = null;

/** Tous les matchs de la saison, dans l'ordre. */
export async function fetchCflSeason(now = new Date()) {
  const old = store.get('season');
  const hot = (old ?? []).some((g) => g.state === 'in'
    || (g.state === 'pre' && g.startsAt && new Date(g.startsAt) - now < 60 * MIN && new Date(g.startsAt) - now > -6 * 60 * MIN));
  if (old && store.age('season') < (hot ? 30 * 1000 : 30 * MIN)) return revive(old);
  pending ??= (async () => {
    try {
      const rounds = JSON.parse(await getText('cfl', 'rounds.json'));
      const games = (Array.isArray(rounds) ? rounds : [])
        .flatMap((r) => (r?.tournaments ?? []).filter((t) => !t?.isHidden).map((t) => cflGame(r, t)))
        .sort((a, b) => (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0));
      store.set('season', games);
      return games;
    } catch (err) {
      if (old) return revive(old); // ligue muette : la dernière saison connue
      throw err;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

const revive = (games) => games.map((g) => ({ ...g, startsAt: g.startsAt ? new Date(g.startsAt) : null }));

const dayStart = (now, offset) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

/** Matchs de `fromOffset` à `toOffset` jours d'aujourd'hui. */
export async function cflRange(fromOffset, toOffset, now = new Date()) {
  const from = dayStart(now, fromOffset);
  const to = dayStart(now, toOffset + 1);
  return (await fetchCflSeason(now)).filter((g) => g.startsAt >= from && g.startsAt < to);
}

/** Tableau des scores du jour (comme ESPN) : d'hier à demain, et les matchs en cours. */
export async function cflBoard(now = new Date()) {
  const from = dayStart(now, -1);
  const to = dayStart(now, 2);
  return (await fetchCflSeason(now)).filter((g) => g.state === 'in' || (g.startsAt >= from && g.startsAt < to));
}

/** Matchs d'une équipe (identifiant ESPN). */
export async function cflTeamGames(teamId, now = new Date()) {
  const id = String(teamId);
  return (await fetchCflSeason(now)).filter((g) => g.home.id === id || g.away.id === id);
}

/**
 * Classement calculé à partir des matchs de la saison régulière : 2 points
 * par victoire, 1 par match nul, par division (Est, Ouest).
 */
export async function cflStandings(now = new Date()) {
  const rows = new Map();
  for (const [abbr, t] of Object.entries(CFL_TEAMS)) rows.set(t.id, { id: t.id, abbr, division: t.division, w: 0, l: 0, t: 0, name: '' });
  for (const g of await fetchCflSeason(now)) {
    if (g.state !== 'post' || g.phase !== 'REG' || g.statusText !== 'Final') continue;
    const a = rows.get(g.away.id);
    const h = rows.get(g.home.id);
    if (!a || !h) continue;
    a.name ||= g.away.name;
    h.name ||= g.home.name;
    const [sa, sh] = [Number(g.away.score), Number(g.home.score)];
    if (sa > sh) { a.w += 1; h.l += 1; } else if (sh > sa) { h.w += 1; a.l += 1; } else { a.t += 1; h.t += 1; }
  }
  return ['Est', 'Ouest'].map((div) => {
    const list = [...rows.values()].filter((r) => r.division === div)
      .sort((x, y) => (2 * y.w + y.t) - (2 * x.w + x.t) || y.w - x.w);
    return {
      name: `Division ${div}`,
      preseason: list.every((r) => r.w + r.l + r.t === 0),
      rows: list.map((r, i) => {
        const gp = r.w + r.l + r.t;
        return {
          id: r.id, name: r.name || r.abbr, short: (r.name || r.abbr).split(' ').pop(), abbr: r.abbr, logo: '', rank: i + 1,
          stats: {
            wins: String(r.w), losses: String(r.l), ties: String(r.t), points: String(2 * r.w + r.t), gamesPlayed: String(gp),
            winPercent: gp ? ((r.w + r.t / 2) / gp).toFixed(3).replace(/^0/, '') : '.000',
          },
        };
      }),
    };
  });
}
