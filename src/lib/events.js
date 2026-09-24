// Détection des évènements à notifier, par comparaison de deux relevés.
// Module pur (sans fenêtre ni réseau) : testable isolément.

import { F1_LOGO } from './f1-logo.js';
import { sameDriver } from './api.js';
import { MEDALS, rank as place, ordinal } from './format.js';
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

// Ligues dont les équipes portent un surnom au pluriel : « But des
// Canadiens », « Victoire des Alouettes ». Ailleurs (clubs de soccer, pays,
// universités), « des » sonne faux : « But pour CF Montréal ».
const NICKNAMES = new Set(['nhl', 'nba', 'wnba', 'nfl', 'cfl', 'mlb']);
export const ofTeam = (leagueId, name) => (NICKNAMES.has(leagueId) ? `des ${name}` : `pour ${name}`);
const theTeam = (leagueId, name) => (NICKNAMES.has(leagueId) ? `Les ${name}` : name);
const teamIs = (leagueId, name, plural, single) => (NICKNAMES.has(leagueId) ? plural : single);

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
  if (g.kind === 'golf') {
    // Rang de chaque golfeur favori, pour voir ses remontées.
    const favs = Object.fromEntries((opts.favGolfers ?? [])
      .map((f) => [f.id || f.name, (g.players ?? []).find((p) => sameDriver(f, p))?.pos ?? null]));
    return { state: g.state, leader: g.state === 'in' ? g.players?.[0]?.name ?? '' : '', favs };
  }
  if (g.kind === 'tennis') return { state: g.state, sets: g.a?.sets?.length ?? 0 };
  if (g.kind === 'match') return { state: g.state, home: g.home.score, away: g.away.score, period: g.period ?? null };
  if (g.kind === 'card') {
    // État de chaque combat d'un combattant favori, pour voir son début et sa fin.
    const favs = Object.fromEntries(favFights(g, opts.favFighters).map(({ f }) => [f.id, f.state]));
    return { state: g.state, main: g.main?.state ?? 'pre', favs };
  }
  const favs = favList(opts);
  const pits = Object.fromEntries(favs.map((d) => [driverKey(d), (g.results ?? []).find((r) => sameDriver(r, d))?.pits ?? 0]));
  return { state: g.state, session: g.session ?? '', favPos: favPositions(g, favs), flag: g.flag ?? '', pits };
}

// Nombre de périodes du temps réglementaire, par sport.
const REGULATION = { hockey: 3, basketball: 4, football: 4, soccer: 2, baseball: 9 };

/**
 * Nom de la période supplémentaire qui commence, ou '' : « Prolongation »,
 * « 2e prolongation », « Tirs de barrage », « Tirs au but », « Manches
 * supplémentaires ».
 */
export function overtimeName(g, before) {
  const sport = sportOf(g.leagueId);
  const reg = REGULATION[sport];
  const p = Number(g.period) || 0;
  const was = Number(before.period) || 0;
  if (!reg || !was || p <= was || p <= reg) return '';
  if (sport === 'baseball') return was <= reg ? 'Manches supplémentaires' : '';
  if (sport === 'hockey') {
    // Saison : une prolongation (4e période), puis les tirs de barrage (5e).
    if (!g.playoffs) return p === 4 ? 'Prolongation' : 'Tirs de barrage';
    return p === 4 ? 'Prolongation' : `${ordinal(p - 3)} prolongation`;
  }
  if (sport === 'soccer') return p >= 5 ? 'Tirs au but' : p === 3 ? 'Prolongation' : '';
  return p === reg + 1 ? 'Prolongation' : `${ordinal(p - reg)} prolongation`;
}

/** Une de tes équipes ? (clés « ligue:id » des réglages) */
const isFavTeam = (g, t, opts) => (opts.favTeams ?? []).includes(`${g.leagueId}:${t.id}`);


/** Met à jour le relevé : les matchs absents cette fois sont conservés. */
export function remember(prev, games, opts = {}) {
  const next = new Map(prev ?? []);
  for (const g of games) next.set(g.id, snapshot(g, opts));
  return next;
}



function matchEvents(g, before, opts = {}) {
  const out = [];
  const link = g.link ?? '';

  if (before.state === 'pre' && g.state === 'in') {
    // Match 7 d'une série : tout se joue ce soir.
    const decisive = g.series?.game === 7;
    out.push({
      title: decisive ? '🔥 Match 7 : ça commence !' : 'Début du match',
      body: decisive ? `${g.away.abbr} @ ${g.home.abbr} · ${g.series.text}` : `${g.away.abbr} @ ${g.home.abbr}`,
      team: g.home,
      link,
      big: decisive,
    });
  }

  // Prolongation, tirs de barrage, manches supplémentaires.
  const extra = g.state === 'in' ? overtimeName(g, before) : '';
  if (extra) {
    out.push({ title: `⏱️ ${extra} !`, body: scoreLine(g), team: g.home, link });
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
        : scorer ? `But de ${scorer} !` : `But ${ofTeam(g.leagueId, team.name)} !`;
      const when = [g.clock, g.statusText].filter(Boolean).join(' · ');
      out.push({
        title,
        body: when ? `${scoreLine(g)} · ${when}` : scoreLine(g),
        team,
        link,
        scorer,
        // Pour chercher le buteur (s'il manque), les passes et ses buts du
        // match (tour du chapeau) dans le résumé détaillé.
        // Football et baseball aussi : pour reconnaître un de tes joueurs
        // favoris dans le jeu qui a fait marquer.
        goal: { leagueId: g.leagueId, eventId: g.id, teamId: team.id, points: !isGoal },
      });
    }
  }

  if (before.state !== 'post' && g.state === 'post') {
    const winner = g.home.winner ? g.home : g.away.winner ? g.away : null;
    const tie = !winner && num(g.home.score) !== null && num(g.home.score) === num(g.away.score);
    // Séries éliminatoires : le match qui termine la série a son propre titre.
    const clinched = winner && g.series?.done && g.series.leaderId === winner.id;
    const loser = winner ? (winner === g.home ? g.away : g.home) : null;
    const final = /finale de la coupe stanley|finale nba|finale de la nba|série mondiale|super bowl/i.test(g.series?.round ?? '');
    let title = winner ? `Victoire ${ofTeam(g.leagueId, winner.name)}` : tie ? 'Match nul' : 'Match terminé';
    let team = winner ?? g.home;
    let big = false;
    if (clinched) {
      // Série gagnée… ou perdue, si c'est ton équipe qui tombe.
      if (isFavTeam(g, loser, opts) && !isFavTeam(g, winner, opts)) {
        title = `💔 ${theTeam(g.leagueId, loser.name)} ${teamIs(g.leagueId, loser.name, 'sont éliminés', 'est éliminé')}`;
        team = loser;
      } else {
        title = final
          ? `🏆 ${theTeam(g.leagueId, winner.name)} ${teamIs(g.leagueId, winner.name, 'sont champions', 'est champion')} !`
          : `🏆 ${theTeam(g.leagueId, winner.name)} ${teamIs(g.leagueId, winner.name, 'remportent', 'remporte')} la série !`;
        big = true;
      }
    }
    const body = g.series ? `${scoreLine(g)} · ${g.series.text}` : scoreLine(g);
    out.push({ title, body, team, link, big });
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
  // Drapeau rouge, voiture de sécurité (réelle ou virtuelle).
  if (g.state === 'in' && before.state === 'in' && before.session === g.session && g.flag && g.flag !== before.flag) {
    const FLAGS = { red: '🟥 Drapeau rouge', sc: '🚨 Voiture de sécurité', vsc: '🟨 Voiture de sécurité virtuelle' };
    out.push({ title: FLAGS[g.flag], body: `${g.session} · ${g.title}`, team, link });
  }
  // Un pilote favori s'arrête aux puits.
  if (g.state === 'in' && before.state === 'in' && before.session === g.session) {
    for (const d of favs) {
      const r = (g.results ?? []).find((x) => sameDriver(x, d));
      const was = before.pits?.[driverKey(d)] ?? 0;
      if (r?.pits && r.pits > was) {
        out.push({
          title: `🔧 ${nameOf(d)} passe aux puits`,
          body: `${r.pits === 1 ? '1er arrêt' : `${r.pits}e arrêt`} · ${place(r.pos)} · ${g.title}`,
          team: faceOf(d),
          link,
        });
      }
    }
  }
  // Un pilote favori passe en tête pendant la séance, ou gagne des places
  // en course (en essais et en qualifs, l'ordre change à chaque tour rapide :
  // ce serait une avalanche).
  if (g.state === 'in' && before.state === 'in' && before.session === g.session) {
    const race = /course|sprint/i.test(g.session ?? '');
    for (const d of favs) {
      const pos = now[driverKey(d)];
      const prev = was[driverKey(d)];
      if (pos === 1 && prev !== 1) {
        out.push({ title: `${nameOf(d)} prend la tête !`, body: `${g.session} · ${g.title}`, team: faceOf(d), link });
      } else if (race && pos && prev && pos < prev) {
        const gained = prev - pos;
        // Une seule place : on nomme le pilote dépassé (celui juste derrière).
        const passed = gained === 1 ? (g.results ?? []).find((r) => r.pos === pos + 1) : null;
        out.push({
          title: passed ? `⬆️ ${nameOf(d)} dépasse ${nameOf(passed)}` : `⬆️ ${nameOf(d)} gagne ${gained} places`,
          body: `${place(pos)} · ${g.session} · ${g.title}`,
          team: faceOf(d),
          link,
        });
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

/* ---------- Golf : nouveau meneur, vainqueur ---------- */

function golfEvents(g, before, opts = {}) {
  const out = [];
  if (g.teamEvent) return out; // Coupe des Présidents : pas de meneur individuel
  const team = { abbr: '⛳', logo: g.logo ?? '', color: '#5bd38a' };
  const lead = g.players?.[0];
  const face = (p) => (p?.photo ? { ...team, logo: p.photo, round: true } : team);
  const link = g.link ?? '';
  const where = `${g.session ? `${g.session} · ` : ''}${g.title}`;
  const favs = opts.favGolfers ?? [];
  const favOf = (p) => favs.find((f) => sameDriver(f, p));
  const finished = before.state !== 'post' && g.state === 'post';

  if (finished && lead) {
    out.push({ title: `🏆 ${favOf(lead) ? '⭐ ' : ''}${lead.name} remporte le tournoi !`, body: `${lead.score} · ${g.title}`, team: face(lead), link, big: true });
  } else if (g.state === 'in' && before.state === 'in' && lead && before.leader && lead.name !== before.leader) {
    out.push({ title: `⛳ ${favOf(lead) ? '⭐ ' : ''}${lead.name} prend la tête`, body: `${lead.score} · ${where}`, team: face(lead), link, big: !!favOf(lead) });
  }
  // Tes golfeurs : entrée dans le top 10, rang final.
  for (const f of favs) {
    const p = (g.players ?? []).find((x) => sameDriver(f, x));
    if (!p || p === lead) continue;
    const was = before.favs?.[f.id || f.name];
    if (finished) {
      out.push({ title: `⛳ ${p.name} termine ${p.posText}`, body: `${p.score} · ${g.title}`, team: face(p), link });
    } else if (g.state === 'in' && before.state === 'in' && p.pos <= 10 && was != null && was > 10) {
      out.push({ title: `⛳ ${p.name} entre dans le top 10`, body: `${p.posText} · ${p.score} · ${where}`, team: face(p), link });
    }
  }
  return out;
}

/* ---------- Tennis : les matchs de tes joueurs ---------- */

function tennisEvents(g, before, opts) {
  const favs = opts.favTennis ?? [];
  const me = [g.a, g.b].find((p) => favs.some((f) => sameDriver(f, p)));
  if (!me) return []; // les autres matchs en direct : pas de notification
  const opp = me === g.a ? g.b : g.a;
  const face = me.photo ? { abbr: '🎾', logo: me.photo, color: '#c6f36b', round: true } : { abbr: '🎾', logo: '', color: '#c6f36b' };
  const where = [g.round, g.title].filter(Boolean).join(' · ');
  // Manches du point de vue de ton joueur : « 6-4 3-6 7-6 ».
  const sets = me.sets.map((n, i) => `${n}-${opp.sets[i] ?? 0}`).join(' ');
  if (before.state === 'pre' && g.state === 'in') {
    return [{ title: `🎾 ${me.name} entre sur le court`, body: `contre ${opp.name} · ${where}`, team: face, link: g.link ?? '' }];
  }
  // Une manche vient de se terminer (la suivante a commencé).
  const n = g.a?.sets?.length ?? 0;
  if (g.state === 'in' && before.state === 'in' && before.sets > 0 && n > before.sets) {
    const i = before.sets - 1;
    const mine = me.sets[i] ?? 0;
    const theirs = opp.sets[i] ?? 0;
    const title = mine > theirs ? `🎾 Manche pour ${me.name} (${mine}-${theirs})` : `🎾 ${me.name} perd la manche (${mine}-${theirs})`;
    return [{ title, body: `${sets} · contre ${opp.name} · ${where}`, team: face, link: g.link ?? '' }];
  }
  if (before.state !== 'post' && g.state === 'post') {
    if (me.winner) return [{ title: `🏆 Victoire de ${me.name} !`, body: [sets, `contre ${opp.name}`, where].filter(Boolean).join(' · '), team: face, link: g.link ?? '', big: true }];
    if (opp.winner) return [{ title: `${me.name} s'incline`, body: [sets, `contre ${opp.name}`, where].filter(Boolean).join(' · '), team: face, link: g.link ?? '' }];
  }
  return [];
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
    if (g.kind === 'match') out.push(...matchEvents(g, before, opts));
    else if (g.kind === 'card') out.push(...cardEvents(g, before, opts));
    else if (g.kind === 'golf') out.push(...golfEvents(g, before, opts));
    else if (g.kind === 'tennis') out.push(...tennisEvents(g, before, opts));
    else out.push(...sessionEvents(g, before, opts));
  }
  return out.slice(-MAX_PER_REFRESH);
}
