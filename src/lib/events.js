// Détection des évènements à notifier, par comparaison de deux relevés.
// Module pur (sans fenêtre ni réseau) : testable isolément.

import { F1_LOGO } from './f1-logo.js';

// Ligues où chaque point mérite une notification. Au basket, le score change
// toutes les vingt secondes : on s'en tient au début et à la fin du match.
const SCORE_ALERTS = { nhl: 'goal', epl: 'goal', ucl: 'goal', mls: 'goal', nfl: 'points', mlb: 'points' };

// Au-delà, une série d'évènements (retour de veille, par exemple) deviendrait
// une avalanche : on garde les plus récents.
export const MAX_PER_REFRESH = 3;

const num = (s) => {
  const n = Number(s);
  return s !== '' && s != null && Number.isFinite(n) ? n : null;
};

const scoreLine = (g) => `${g.away.abbr} ${g.away.score} – ${g.home.score} ${g.home.abbr}`;

/** Ce qu'il faut retenir d'un match pour le comparer au relevé suivant. */
export function snapshot(g) {
  return g.kind === 'match'
    ? { state: g.state, home: g.home.score, away: g.away.score }
    : { state: g.state, session: g.session ?? '' };
}

/** Met à jour le relevé : les matchs absents cette fois sont conservés. */
export function remember(prev, games) {
  const next = new Map(prev ?? []);
  for (const g of games) next.set(g.id, snapshot(g));
  return next;
}

function matchEvents(g, before) {
  const out = [];
  const link = g.link ?? '';

  if (before.state === 'pre' && g.state === 'in') {
    out.push({ title: 'Début du match', body: `${g.away.abbr} @ ${g.home.abbr}`, team: g.home, link });
  }

  if (g.state === 'in' && SCORE_ALERTS[g.leagueId]) {
    for (const side of ['away', 'home']) {
      const was = num(before[side]);
      const now = num(g[side].score);
      if (was === null || now === null || now <= was) continue;
      const team = g[side];
      const isGoal = SCORE_ALERTS[g.leagueId] === 'goal';
      const scorer = isGoal ? g.scorers?.[team.id] ?? '' : '';
      const title = !isGoal ? `${team.name} marque (+${now - was})`
        : scorer ? `But de ${scorer} !` : `But des ${team.name} !`;
      const when = [g.clock, g.statusText].filter(Boolean).join(' · ');
      out.push({
        title,
        body: when ? `${scoreLine(g)} · ${when}` : scoreLine(g),
        team,
        link,
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

function sessionEvents(g, before) {
  const out = [];
  const link = g.link ?? '';
  const team = { abbr: 'F1', logo: g.logo || F1_LOGO, color: '#ff4d6d' };

  // Une séance qui était en cours ne l'est plus : elle est finie, même si le
  // widget affiche maintenant la suivante (état « à venir »).
  if (before.state === 'in' && g.state !== 'in') {
    const ended = before.session || 'La séance';
    const first = g.state === 'post' ? g.top3?.[0] : null;
    out.push({
      title: `${ended} terminée`,
      body: first ? `1. ${first.name} · ${g.title}` : g.title,
      team,
      link,
    });
  }
  if (g.state === 'in' && (before.state !== 'in' || before.session !== g.session)) {
    out.push({ title: `${g.session || 'Séance'} : c'est parti`, body: g.title, team, link });
  }
  return out;
}

/**
 * Évènements survenus entre deux relevés. `prev` à null (premier relevé) ne
 * donne rien : on ne notifie pas l'état trouvé au démarrage.
 */
export function detectEvents(prev, games) {
  if (!prev) return [];
  const out = [];
  for (const g of games) {
    const before = prev.get(g.id);
    if (!before) continue; // match apparu : rien n'a « changé »
    out.push(...(g.kind === 'match' ? matchEvents(g, before) : sessionEvents(g, before)));
  }
  return out.slice(-MAX_PER_REFRESH);
}
