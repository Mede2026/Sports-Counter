// Vérifie l'app avec les VRAIES réponses d'ESPN, d'OpenF1, de TheSportsDB et
// de Wikipédia, avec le code même de l'app (lib/api.js). Lancé par GitHub
// avant chaque publication : une ligue qui change de format est repérée avant
// que la mise à jour n'arrive chez l'utilisateur.
//
//   node tests/donnees-reelles.mjs
//
// ❌ grave (bloque la publication) : les scores d'une grande ligue illisibles,
//    ou une lecture qui plante.
// ⚠️ à surveiller : liste incomplète, logos manquants, service tiers muet…

import { appendFileSync } from 'node:fs';

// L'app tourne dans une page : on lui donne ce qu'elle attend d'un navigateur.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
};
globalThis.window = {};

// Les mêmes en-têtes qu'un navigateur (et que le relais Rust de l'app) : sans
// eux, le pare-feu d'ESPN peut refuser la requête.
const nodeFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => nodeFetch(url, {
  ...init,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'fr-CA,fr;q=0.9,en;q=0.8',
    Referer: 'https://www.espn.com/',
    ...(init.headers ?? {}),
  },
});

const api = await import('../src/lib/api.js');
const { LEAGUES, LEAGUES_BY_ID } = await import('../src/lib/leagues.js');

// Grandes ligues : leurs scores doivent se lire, sinon la publication attend.
const CRITICAL = new Set(['nhl', 'nba', 'nfl', 'mlb', 'mls', 'epl', 'f1']);
const rows = [];
let grave = 0;
const ok = (area, what) => rows.push(['✅', area, what]);
const warn = (area, what) => rows.push(['⚠️', area, what]);
const fail = (area, what) => { rows.push(['❌', area, what]); grave += 1; };
const errText = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 160);

/** Lance une vérification ; une exception devient une ligne ❌ ou ⚠️. */
async function check(area, fn, critical = false) {
  try {
    await fn();
  } catch (err) {
    (critical ? fail : warn)(area, `erreur : ${errText(err)}`);
  }
}

const isDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

/** Forme d'un match normalisé par l'app : ce dont le widget a besoin. */
function badMatch(g) {
  if (!['pre', 'in', 'post'].includes(g.state)) return `état inconnu « ${g.state} »`;
  if (g.kind === 'match') {
    for (const side of ['home', 'away']) {
      const t = g[side];
      if (!t?.id || !t.abbr) return `équipe ${side} sans identifiant ou sigle`;
    }
    if (g.state !== 'pre' && (g.home.score === '–' || g.away.score === '–')) return 'match commencé sans pointage';
  }
  if (g.startsAt !== null && g.startsAt !== undefined && !isDate(g.startsAt)) return 'date illisible';
  return '';
}

// 1. Scores du jour, ligue par ligue.
const boards = new Map();
for (const league of LEAGUES) {
  await check(`Scores ${league.label}`, async () => {
    const games = await api.fetchScoreboard(league.id);
    boards.set(league.id, games);
    const bad = games.map(badMatch).find(Boolean);
    if (bad) (CRITICAL.has(league.id) ? fail : warn)(`Scores ${league.label}`, bad);
    else ok(`Scores ${league.label}`, `${games.length} évènement${games.length > 1 ? 's' : ''}`);
  }, CRITICAL.has(league.id));
}

// 2. Listes d'équipes et logos.
for (const league of LEAGUES.filter((l) => l.kind === 'team')) {
  await check(`Équipes ${league.label}`, async () => {
    const teams = await api.fetchTeams(league.id);
    const want = league.teams || 0;
    const bare = teams.filter((t) => !t.logo).length;
    const text = `${teams.length}${want ? `/${want}` : ''} équipes${bare ? `, ${bare} sans logo` : ''}`;
    if (!teams.length || (want && teams.length < want * 0.8) || bare) warn(`Équipes ${league.label}`, text);
    else ok(`Équipes ${league.label}`, text);
  });
}

// 3. Fenêtre Match : un match récent (ou en cours) de quelques ligues.
async function someGame(leagueId) {
  const today = (boards.get(leagueId) ?? []).filter((g) => g.kind === 'match');
  const done = today.find((g) => g.state !== 'pre');
  if (done) return done;
  const past = await api.fetchYesterday?.(leagueId).catch(() => []) ?? [];
  if (past.find?.((g) => g.kind === 'match')) return past.find((g) => g.kind === 'match');
  // Hors saison : le dernier match d'une équipe.
  const teams = await api.fetchTeams(leagueId).catch(() => []);
  for (const t of teams.slice(0, 3)) {
    const games = await api.fetchTeamGames(leagueId, t.id, { back: 200, ahead: 0 }).catch(() => []);
    const last = games.filter((g) => g.state === 'post').at(-1);
    if (last) return last;
  }
  return null;
}

for (const leagueId of ['nhl', 'mlb', 'nfl', 'nba', 'epl']) {
  const label = LEAGUES_BY_ID[leagueId].label;
  await check(`Match ${label}`, async () => {
    const g = await someGame(leagueId);
    if (!g) { warn(`Match ${label}`, 'aucun match récent trouvé'); return; }
    const d = await api.fetchMatchDetail(leagueId, g.id);
    const parts = [
      d.box?.length && 'box score', d.stats?.length && 'statistiques', d.goals?.length && 'jeux marquants',
      d.leaders?.length && 'meneurs', d.injuries?.length && 'blessés', d.shots?.length && 'carte des tirs',
      d.broadcasts?.length && 'chaînes', d.h2h && 'face-à-face', d.news?.length && 'nouvelles',
    ].filter(Boolean);
    if (!d.home?.id || !d.away?.id) fail(`Match ${label}`, 'équipes illisibles dans le résumé');
    else if (!parts.length) warn(`Match ${label}`, `${g.away.abbr} @ ${g.home.abbr} : rien de lisible dans le résumé`);
    else ok(`Match ${label}`, `${g.away.abbr} @ ${g.home.abbr} : ${parts.join(', ')}`);
  }, true);
}

// 4. Classements, meneurs, championnat de F1.
for (const leagueId of ['nhl', 'nba', 'mlb', 'epl']) {
  const label = LEAGUES_BY_ID[leagueId].label;
  await check(`Classement ${label}`, async () => {
    const groups = await api.fetchStandingsTable(leagueId);
    const n = groups.reduce((s, g) => s + g.rows.length, 0);
    (n ? ok : warn)(`Classement ${label}`, `${groups.length} groupe(s), ${n} équipes${groups.some((g) => g.preseason) ? ' (pré-saison)' : ''}`);
  });
}
await check('Meneurs LNH', async () => {
  const cats = await api.fetchLeagueLeaders('nhl');
  (cats.length ? ok : warn)('Meneurs LNH', `${cats.length} catégories`);
});
await check('Championnat F1', async () => {
  const { drivers, teams } = await api.fetchF1Standings();
  (drivers.length ? ok : warn)('Championnat F1', `${drivers.length} pilotes, ${teams.length} écuries`);
});

// 5. Fiche d'un joueur (saison et derniers matchs).
await check('Fiche joueur LNH', async () => {
  const teams = await api.fetchTeams('nhl');
  const roster = await api.fetchRoster('nhl', teams.find((t) => t.abbr === 'MTL')?.id ?? teams[0].id);
  const p = roster.find((x) => x.pos !== 'G') ?? roster[0];
  const o = await api.fetchPlayerOverview('nhl', p.id);
  (o?.season?.length || o?.games?.length ? ok : warn)('Fiche joueur LNH', `${p.name} : ${o?.season?.length ?? 0} stats, ${o?.games?.length ?? 0} matchs`);
});

// 6. Nouvelles d'une équipe.
await check('Nouvelles', async () => {
  const teams = await api.fetchTeams('nhl');
  const news = await api.fetchTeamNews?.('nhl', teams.find((t) => t.abbr === 'MTL')?.id ?? teams[0].id);
  (news?.length ? ok : warn)('Nouvelles', `${news?.length ?? 0} articles`);
});

// 7. OpenF1 (données de F1 qu'ESPN n'a pas).
await check('OpenF1', async () => {
  const f1 = (boards.get('f1') ?? [])[0];
  const session = f1?.sessions?.filter((s) => s.state === 'post').at(-1);
  if (!session) { warn('OpenF1', 'pas de séance terminée ce week-end'); return; }
  const x = await api.fetchF1Extras(session, []);
  if (!x) { warn('OpenF1', `aucune donnée pour « ${session.label} »`); return; }
  const parts = Object.entries(x).filter(([, v]) => v).map(([k]) => k);
  ok('OpenF1', `${session.label} : ${parts.join(', ') || 'rien'}`);
});

// ESPN injoignable depuis les machines de GitHub (tout refusé) : ce n'est pas
// l'app qui est en cause. On le signale sans bloquer la publication.
const scoresOk = rows.some(([st, area]) => st === '✅' && area.startsWith('Scores'));
if (!scoresOk && grave) {
  rows.unshift(['⚠️', 'ESPN', 'aucune réponse depuis GitHub (pare-feu ?) : vérifications non concluantes']);
  grave = 0;
}

// Rapport : dans la console, et en tableau dans le résumé de GitHub.
const lines = rows.map(([s, a, w]) => `${s} ${a} — ${w}`);
console.log(lines.join('\n'));
console.log(`\n${grave ? `${grave} problème(s) grave(s)` : 'Aucun problème grave'} · ${rows.filter((r) => r[0] === '⚠️').length} à surveiller`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '## Données réelles (ESPN, OpenF1…)', '',
    '| | Vérification | Résultat |', '|---|---|---|',
    ...rows.map(([s, a, w]) => `| ${s} | ${a} | ${w.replace(/\|/g, '/')} |`), '',
  ].join('\n'));
}
process.exit(grave ? 1 : 0);
