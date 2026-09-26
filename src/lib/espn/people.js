// Joueurs, meneurs de la ligue, combattants, joueurs de tennis, golfeurs, pilotes.
// (Découpé de api.js : les autres fichiers importent toujours depuis api.js.)
import { LEAGUES_BY_ID } from '../leagues.js';
import { NHL_TEAMS } from '../teams-nhl.js';
import { diskCache } from '../cache.js';
import { autoFr } from '../translate.js';
import { TEAMS_TTL, athletePhoto, boardQuery, corePath, getCore, getJson, getWeb, ymd } from './core.js';
import { LEADER_FR } from './detail.js';
import { fetchTeams, fightOf, golferOf, normalizeTennis, toDriver } from './scoreboard.js';

// Catégories affichées d'abord, par sport (les autres suivent).
export const LEADER_ORDER = {
  hockey: ['points', 'goals', 'assists', 'plusMinus', 'wins', 'savePct', 'goalsAgainstAverage', 'shutouts'],
  basketball: ['pointsPerGame', 'reboundsPerGame', 'assistsPerGame', 'stealsPerGame', 'blocksPerGame'],
  football: ['passingYards', 'rushingYards', 'receivingYards', 'sacks', 'interceptions'],
  baseball: ['battingAverage', 'homeRuns', 'RBIs', 'hits', 'stolenBases', 'ERA', 'strikeouts', 'wins'],
  soccer: ['goals', 'assists'],
};

export const LEADERS_TTL = 60 * 60 * 1000;
// v2 : les meneurs de la saison en cours (la v1 gardait ceux de tous les
// temps) et les photos reconstituées quand ESPN n'en donne pas.
export const leadersCache = diskCache('leaders.v2', LEADERS_TTL);
export const athleteCache = diskCache('athletes.v2', 7 * 24 * 3600 * 1000);

// Noms français des catégories, d'après le nom affiché par ESPN (en minuscules).
// La traduction automatique donnait des contresens (« Goals » → « Objectifs »).
export const LEADER_FR_TEXT = {
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

export const leaderLabel = (c) => LEADER_FR[c?.name]
  ?? LEADER_FR_TEXT[String(c?.displayName ?? '').toLowerCase()]
  ?? LEADER_FR_TEXT[String(c?.name ?? '').toLowerCase()]
  ?? autoFr(c?.displayName ?? c?.name ?? '');

/**
 * Saison affichée : « 2025-2026 » au hockey et au basket (ESPN la nomme par
 * son année de fin), « 2025-2026 » au soccer (année de début), l'année seule ailleurs.
 */
export function seasonLabel(leagueId, year) {
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
export async function leaderSeasons(league) {
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

// Positions, en français.
const POS_FR = [
  [/^center$/i, 'Centre'], [/^left wing$/i, 'Ailier gauche'], [/^right wing$/i, 'Ailier droit'], [/^wing$/i, 'Ailier'],
  [/^defen[cs]e(man)?$/i, 'Défenseur'], [/^goalie|goalkeeper|goaltender$/i, 'Gardien'], [/^forward$/i, 'Attaquant'],
  [/^midfielder$/i, 'Milieu'], [/^guard$/i, 'Arrière'], [/^point guard$/i, 'Meneur'], [/^shooting guard$/i, 'Arrière'],
  [/^small forward$/i, 'Ailier'], [/^power forward$/i, 'Ailier fort'], [/^quarterback$/i, 'Quart-arrière'],
  [/^running back$/i, 'Porteur de ballon'], [/^wide receiver$/i, 'Receveur'], [/^tight end$/i, 'Ailier rapproché'],
  [/^linebacker$/i, 'Secondeur'], [/^cornerback$/i, 'Demi de coin'], [/^safety$/i, 'Maraudeur'],
  [/^starting pitcher$/i, 'Lanceur partant'], [/^relief pitcher$/i, 'Releveur'], [/^pitcher$/i, 'Lanceur'],
  [/^catcher$/i, 'Receveur'], [/^first base(man)?$/i, 'Premier but'], [/^second base(man)?$/i, 'Deuxième but'],
  [/^third base(man)?$/i, 'Troisième but'], [/^shortstop$/i, 'Arrêt-court'], [/^outfielder$/i, 'Voltigeur'],
  [/^designated hitter$/i, 'Frappeur désigné'],
];
export const positionFr = (name) => POS_FR.find(([re]) => re.test(String(name ?? '').trim()))?.[1] ?? autoFr(name ?? '');

const BIRTH_FMT = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** « 2019: Rd 1, Pk 15 (MTL) » -> « 2019, 1re ronde, 15e choix (MTL) ». */
export function draftFr(raw) {
  const m = /(\d{4})\D+(?:Rd|Round)\s*(\d+)\D+(?:Pk|Pick)\s*(\d+)(?:\s*\((\w+)\))?/i.exec(String(raw ?? ''));
  if (!m) return raw ? autoFr(raw) : '';
  const nth = (n) => `${n}${Number(n) === 1 ? 're' : 'e'}`;
  return `${m[1]}, ${nth(m[2])} ronde, ${m[3]}${Number(m[3]) === 1 ? 'er' : 'e'} choix${m[4] ? ` (${m[4]})` : ''}`;
}

/**
 * Fiche d'un joueur : poste, numéro, équipe, âge, date et lieu de naissance,
 * taille et poids (en cm et kg), repêchage, main (hockey). null sans données.
 */
export async function fetchPlayerBio(leagueId, athleteId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !athleteId) return null;
  let a = null;
  try {
    a = (await getWeb(`${league.path}/athletes/${encodeURIComponent(athleteId)}`))?.athlete ?? null;
  } catch { /* on essaie l'API « core » */ }
  if (!a?.displayName) {
    const [sport, code] = league.path.split('/');
    a = await getCore(`/v2/sports/${sport}/leagues/${code}/athletes/${encodeURIComponent(athleteId)}?lang=en&region=us`);
  }
  if (!a?.displayName) return null;
  const inches = Number(a.height);
  const pounds = Number(a.weight);
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(a.displayDOB ?? '');
  const dob = a.dateOfBirth ? new Date(a.dateOfBirth) : dm ? new Date(Date.UTC(Number(dm[3]), Number(dm[1]) - 1, Number(dm[2]))) : null;
  const bp = a.birthPlace ?? {};
  const years = Number(a.experience?.years);
  const nth = /(\d+)(?:st|nd|rd|th)\s+season/i.exec(a.displayExperience ?? '');
  const experience = /rookie/i.test(a.displayExperience ?? '') ? 'Recrue'
    : nth ? `${nth[1]}${nth[1] === '1' ? 're' : 'e'} saison`
      : Number.isFinite(years) && years > 0 ? `${years} an${years > 1 ? 's' : ''} d'expérience` : '';
  const team = a.team && typeof a.team === 'object' && a.team.id ? {
    id: String(a.team.id), abbr: a.team.abbreviation ?? '', name: a.team.displayName ?? a.team.name ?? '',
    logo: a.team.logos?.[0]?.href ?? a.team.logo ?? '', color: a.team.color ? `#${a.team.color}` : '',
  } : null;
  const hand = a.hand?.displayValue ?? a.shoots?.displayValue ?? '';
  return {
    id: String(a.id ?? athleteId),
    name: a.displayName,
    photo: a.headshot?.href ?? athletePhoto(a, leagueId),
    pos: positionFr(a.position?.displayName ?? a.position?.name ?? ''),
    posAbbr: a.position?.abbreviation ?? '',
    jersey: a.jersey ?? a.displayJersey?.replace('#', '') ?? '',
    team,
    age: Number(a.age) || null,
    born: dob && !Number.isNaN(dob.getTime()) ? BIRTH_FMT.format(dob) : '',
    place: a.displayBirthPlace ?? [bp.city, bp.state, bp.country].filter(Boolean).join(', '),
    height: inches > 0 ? `${Math.round(inches * 2.54)} cm` : '',
    weight: pounds > 0 ? `${Math.round(pounds * 0.4536)} kg` : '',
    draft: draftFr(a.displayDraft ?? a.draft?.displayText ?? ''),
    experience,
    hand: /^l/i.test(hand) ? 'Gauche' : /^r/i.test(hand) ? 'Droite' : '',
    injured: (a.injuries ?? []).length > 0,
  };
}

export const fightersCache = diskCache('fighters', 24 * 3600 * 1000);

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

export const tennisCache = diskCache('tennis-players', 24 * 3600 * 1000);

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

export const golfersCache = diskCache('golfers', 24 * 3600 * 1000);

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

export const DRIVERS_KEY = 'sports-counter.drivers.f1.v2';
export const FULL_GRID = 20;

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

// "ligue:équipe" -> joueurs, gardés un jour sur le disque (la recherche dans
// toute la LNH en charge 32 d'un coup).
export const rosterCache = diskCache('rosters', 24 * 3600 * 1000);

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

/**
 * Secours : l'alignement par l'API « core » d'ESPN (la LCF, par exemple, où
 * l'adresse habituelle ne répond pas). La liste donne une adresse par joueur,
 * lue ensuite 10 à la fois.
 */
export async function rosterFromCore(league, teamId) {
  const [sport, code] = league.path.split('/');
  const year = new Date().getFullYear();
  let refs = [];
  for (const y of [year, year - 1]) {
    try {
      const list = await getCore(`/v2/sports/${sport}/leagues/${code}/seasons/${y}/teams/${encodeURIComponent(teamId)}/athletes?limit=200&lang=en&region=us`);
      refs = (list?.items ?? []).map((x) => corePath(x?.$ref)).filter(Boolean);
      if (refs.length) break;
    } catch { /* saison précédente */ }
  }
  const athletes = [];
  for (let i = 0; i < refs.length; i += 10) {
    const results = await Promise.allSettled(refs.slice(i, i + 10).map((r) => getCore(r.includes('?') ? r : `${r}?lang=en&region=us`)));
    for (const r of results) if (r.status === 'fulfilled' && r.value?.id) athletes.push(r.value);
  }
  return athletes;
}

export async function loadRoster(leagueId, teamId) {
  const league = LEAGUES_BY_ID[leagueId];
  let flat = [];
  let siteErr = null;
  try {
    const data = await getJson(`${league.path}/teams/${encodeURIComponent(teamId)}/roster`);
    // Au hockey, les joueurs sont groupés par position ({ position, items }).
    flat = (data?.athletes ?? []).flatMap((a) => (Array.isArray(a?.items) ? a.items : [a]));
  } catch (err) {
    siteErr = err;
  }
  if (!flat.some((a) => a?.id && a?.displayName)) {
    flat = await rosterFromCore(league, teamId).catch(() => []);
    if (!flat.length && siteErr) throw siteErr;
  }
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
