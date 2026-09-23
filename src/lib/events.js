// Détection des évènements à notifier, par comparaison de deux relevés.
// Module pur (sans fenêtre ni réseau) : testable isolément.

import { F1_LOGO } from './f1-logo.js';
import { sameDriver } from './api.js';
import { MEDALS, rank as place } from './format.js';
import { sportOf } from './leagues.js';

// Ligues où chaque point mérite une notification. Au basket, le score change
// toutes les vingt secondes : on s'en tient au début et à la fin du match.
// Par sport : hockey et soccer (toutes les ligues), football et baseball.
const SCORE_ALERTS_BY_SPORT = { hockey: 'goal', soccer: 'goal', football: 'points', baseball: 'points' };
const scoreAlert = (leagueId) => SCORE_ALERTS_BY_SPORT[sportOf(leagueId)];

// Au-delà, une série d'évènements (retour de veille, par exemple) deviendrait
// une avalanche : on garde les plus récents.
export const MAX_PER_REFRESH = 3;

const num = (s) => {
  const n = Number(s);
  return s !== '' && s != null && Number.isFinite(n) ? n : null;
};

const scoreLine = (g) => `${g.away.abbr} ${g.away.score} – ${g.home.score} ${g.home.abbr}`;

/** Position d'un pilote dans la séance, ou null. */
export function favPosition(g, driver) {
  if (!driver) return null;
  return (g.results ?? g.top3 ?? []).find((d) => sameDriver(d, driver))?.pos ?? null;
}

/** Pilotes favoris passés en options (liste, ou l'ancien pilote unique). */
const favList = (opts) => opts.favDrivers ?? (opts.favDriver ? [opts.favDriver] : []);
const driverKey = (d) => d.id || d.name;

/** Position de chaque pilote favori : { clé: position }. */
function favPositions(g, favs) {
  return Object.fromEntries(favs.map((d) => [driverKey(d), favPosition(g, d)]));
}

/** Ce qu'il faut retenir d'un match pour le comparer au relevé suivant. */
export function snapshot(g, opts = {}) {
  if (g.kind === 'match') return { state: g.state, home: g.home.score, away: g.away.score };
  if (g.kind === 'card') {
    // État de chaque combat d'un combattant favori, pour voir son début et sa fin.
    const favs = Object.fromEntries(favFights(g, opts.favFighters).map(({ f }) => [f.id, f.state]));
    return { state: g.state, main: g.main?.state ?? 'pre', favs };
  }
  return { state: g.state, session: g.session ?? '', favPos: favPositions(g, favList(opts)) };
}

/** Met à jour le relevé : les matchs absents cette fois sont conservés. */
export function remember(prev, games, opts = {}) {
  const next = new Map(prev ?? []);
  for (const g of games) next.set(g.id, snapshot(g, opts));
  return next;
}



function matchEvents(g, before) {
  const out = [];
  const link = g.link ?? '';

  if (before.state === 'pre' && g.state === 'in') {
    out.push({ title: 'Début du match', body: `${g.away.abbr} @ ${g.home.abbr}`, team: g.home, link });
  }

  if (g.state === 'in' && scoreAlert(g.leagueId)) {
    for (const side of ['away', 'home']) {
      const was = num(before[side]);
      const now = num(g[side].score);
      if (was === null || now === null || now <= was) continue;
      const team = g[side];
      const isGoal = scoreAlert(g.leagueId) === 'goal';
      const scorer = isGoal ? g.scorers?.[team.id] ?? '' : '';
      const title = !isGoal ? `${team.name} marque (+${now - was})`
        : scorer ? `But de ${scorer} !` : `But des ${team.name} !`;
      const when = [g.clock, g.statusText].filter(Boolean).join(' · ');
      out.push({
        title,
        body: when ? `${scoreLine(g)} · ${when}` : scoreLine(g),
        team,
        link,
        scorer,
        // Pour chercher le buteur ailleurs si le tableau des scores ne le donne pas.
        goal: isGoal && !scorer ? { leagueId: g.leagueId, eventId: g.id, teamId: team.id } : null,
      });
    }
  }

  if (before.state !== 'post' && g.state === 'post') {
    const winner = g.home.winner ? g.home : g.away.winner ? g.away : null;
    const tie = !winner && num(g.home.score) !== null && num(g.home.score) === num(g.away.score);
    // Séries éliminatoires : le match qui termine la série a son propre titre.
    const clinched = winner && g.series?.done && g.series.leaderId === winner.id;
    const title = clinched ? `Les ${winner.name} remportent la série !`
      : winner ? `Victoire des ${winner.name}` : tie ? 'Match nul' : 'Match terminé';
    const body = g.series ? `${scoreLine(g)} · ${g.series.text}` : scoreLine(g);
    out.push({ title, body, team: winner ?? g.home, link });
  }
  return out;
}

function sessionEvents(g, before, opts = {}) {
  const out = [];
  const link = g.link ?? '';
  const team = { abbr: 'F1', logo: g.logo || F1_LOGO, color: '#ff4d6d' };
  const favs = favList(opts);
  const was = before.favPos ?? {};
  const now = favPositions(g, favs);
  const faceOf = (d) => (d.photo ? { abbr: 'F1', logo: d.photo, color: '#ff4d6d', round: true } : team);
  const nameOf = (d) => d.short || d.name || '';

  // Une séance qui était en cours ne l'est plus : elle est finie, même si le
  // widget affiche maintenant la suivante (état « à venir »).
  if (before.state === 'in' && g.state !== 'in') {
    const ended = before.session || 'La séance';
    const first = g.state === 'post' ? g.top3?.[0] : null;
    const race = /course|sprint/i.test(ended);
    // Position finale : celle du résultat, sinon la dernière vue en direct.
    const finals = favs
      .map((d) => ({ d, pos: (g.state === 'post' ? now[driverKey(d)] : null) ?? was[driverKey(d)] ?? null }))
      .filter((x) => x.pos)
      .sort((x, y) => x.pos - y.pos);
    const podium = finals.filter((x) => x.pos <= 3);
    for (const { d, pos } of podium) {
      out.push({
        title: pos === 1 && race ? `${MEDALS[1]} Victoire de ${nameOf(d)} !` : `${MEDALS[pos]} ${nameOf(d)} termine ${place(pos)}`,
        body: `${ended} · ${g.title}`,
        team: faceOf(d),
        link,
      });
    }
    if (!podium.length) {
      const mine = finals.map(({ d, pos }) => `${nameOf(d)} ${place(pos)}`).join(', ');
      const parts = [first ? `1. ${first.short || first.name}` : '', mine, g.title];
      out.push({ title: `${ended} terminée`, body: parts.filter(Boolean).join(' · '), team, link });
    }
  }
  if (g.state === 'in' && (before.state !== 'in' || before.session !== g.session)) {
    out.push({ title: `${g.session || 'Séance'} : c'est parti`, body: g.title, team, link });
  }
  // Un pilote favori passe en tête pendant la séance.
  if (g.state === 'in' && before.state === 'in' && before.session === g.session) {
    for (const d of favs) {
      if (now[driverKey(d)] === 1 && was[driverKey(d)] !== 1) {
        out.push({ title: `${nameOf(d)} prend la tête !`, body: `${g.session} · ${g.title}`, team: faceOf(d), link });
      }
    }
  }
  return out;
}

/**
 * UFC : début du gala, début du combat principal, et son vainqueur. Les
 * autres combats de la soirée ne notifient pas : ce serait une avalanche.
 */
/** Combats d'un gala où se bat un combattant favori : [{ f, me, opp }]. */
export function favFights(g, favFighters = []) {
  if (!favFighters?.length) return [];
  const out = [];
  for (const f of g.fights ?? []) {
    const me = [f.a, f.b].find((x) => favFighters.some((fav) => sameDriver(x, fav)));
    if (me) out.push({ f, me, opp: me === f.a ? f.b : f.a });
  }
  return out;
}

function cardEvents(g, before, opts = {}) {
  const out = [];
  const link = g.link ?? '';
  const team = { abbr: 'UFC', logo: g.logo ?? '', color: '#e8363d' };
  const was = before.favs ?? {};
  const face = (x) => (x?.photo ? { ...team, logo: x.photo, round: true } : team);

  // Tes combattants : début de leur combat, puis victoire ou défaite.
  const mine = favFights(g, opts.favFighters);
  for (const { f, me, opp } of mine) {
    if (was[f.id] !== 'in' && was[f.id] !== 'post' && f.state === 'in') {
      out.push({ title: `🥊 ${me.name} entre dans l'octogone`, body: `contre ${opp.name} · ${g.title}`, team: face(me), link });
    }
    if (was[f.id] !== 'post' && f.state === 'post') {
      const title = me.winner ? `🏆 Victoire de ${me.name} !` : opp.winner ? `${me.name} s'incline` : `Combat de ${me.name} terminé`;
      out.push({ title, body: [`contre ${opp.name}`, f.result].filter(Boolean).join(' · '), team: face(me.winner ? me : opp.winner ? opp : me), big: me.winner, link });
    }
  }
  // Le combat principal, s'il n'est pas déjà celui d'un favori.
  const m = mine.some(({ f }) => f.id === g.main?.id) ? null : g.main;
  if (before.state === 'pre' && g.state === 'in') {
    out.push({ title: 'Le gala commence', body: g.title, team, link });
  }
  if (m && before.main !== 'in' && m.state === 'in') {
    out.push({ title: `Combat principal : ${m.a.short} vs ${m.b.short}`, body: g.title, team, link });
  }
  if (m && before.main !== 'post' && m.state === 'post') {
    const w = m.a.winner ? m.a : m.b.winner ? m.b : null;
    out.push({
      title: w ? `🏆 Victoire de ${w.name} !` : 'Combat principal terminé',
      body: [m.result, g.title].filter(Boolean).join(' · '),
      team: w?.photo ? { ...team, logo: w.photo, round: true } : team,
      link,
    });
  }
  return out;
}

/**
 * Évènements survenus entre deux relevés. `prev` à null (premier relevé) ne
 * donne rien : on ne notifie pas l'état trouvé au démarrage.
 */
export function detectEvents(prev, games, opts = {}) {
  if (!prev) return [];
  const out = [];
  for (const g of games) {
    const before = prev.get(g.id);
    if (!before) continue; // match apparu : rien n'a « changé »
    if (g.kind === 'match') out.push(...matchEvents(g, before));
    else if (g.kind === 'card') out.push(...cardEvents(g, before, opts));
    else out.push(...sessionEvents(g, before, opts));
  }
  return out.slice(-MAX_PER_REFRESH);
}
