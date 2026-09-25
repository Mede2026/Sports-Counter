// Fenêtre Match : box score, jeux, meneurs, chances, blessés, tirs, pénalités…
// (Découpé de api.js : les autres fichiers importent toujours depuis api.js.)
import { LEAGUES_BY_ID } from '../leagues.js';
import { statusFr } from '../status-fr.js';
import { diskCache } from '../cache.js';
import { autoFr } from '../translate.js';
import { athletePhoto, corePath, getCore, getJson, getWeb, isScoring, playOf, safe, scoreText, scorerName, sportOfLeague, statOf } from './core.js';
import { fetchAthlete, leaderSeasons } from './people.js';
import { baseballSituation, broadcastsOf, fetchDay, hockeyStatus, liveClock, normalizeCompetitor, pickLink, seriesInfo } from './scoreboard.js';

// Statistiques d'équipe, dans l'ordre d'affichage, avec leur nom en français.
// Les noms absents de cette liste sont ignorés : la fenêtre reste lisible.
export const STAT_LABELS = {
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

export function teamStats(data, leagueId, homeId, awayId) {
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

/** Buts (ou points) et pénalités, lus dans le résumé détaillé d'ESPN. */
export function keyPlays(data) {
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
    winTimeline: safe(() => winTimeline(data), []),
    injuries: safe(() => injuriesOf(data), []),
    shots: sportOfLeague(leagueId) === 'hockey' ? safe(() => shotMap(data), []) : [],
    videos: safe(() => highlights(data), []),
    broadcasts: safe(() => broadcastsOf(comp?.broadcasts, data?.broadcasts), []),
    h2h: safe(() => headToHead(data, home.id), null),
    news: safe(() => newsOf(data?.news?.articles), []),
    box: safe(() => boxScore(data, LEAGUES_BY_ID[leagueId]?.path.split('/')[0]), []),
    probables: safe(() => probablePitchers(competitors, leagueId), {}),
    situation: safe(() => baseballSituation(data?.situation ?? data?.header?.competitions?.[0]?.situation, leagueId), null),
    shootout: sportOfLeague(leagueId) === 'hockey' ? safe(() => shootoutAttempts(data), []) : [],
    allPlays: safe(() => allPlays(data, LEAGUES_BY_ID[leagueId]?.path.split('/')[0]), []),
  };
}

/**
 * Baseball : lanceurs partants annoncés, par équipe : { idÉquipe: { name,
 * photo, line } } (« 12-6, MPM 3,21 »). Vide hors baseball.
 */
export function probablePitchers(competitors, leagueId) {
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
    const k = stat('strikeouts') ?? stat('SO') ?? stat('K');
    const ip = stat('innings') ?? stat('inningsPitched') ?? stat('IP');
    out[String(c?.team?.id ?? c?.id ?? '')] = {
      name: a.displayName,
      photo: athletePhoto(a, leagueId),
      line: [
        String(record).replace(/[()]/g, ''),
        era ? `MPM ${era}` : '',
        k ? `${k} RB` : '',
        ip ? `${ip} ML` : '',
      ].filter(Boolean).join(', '),
    };
  }
  return out;
}

export const linesCache = diskCache('lines', 12 * 3600 * 1000);

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

// Nom français des groupes de joueurs d'ESPN.
export const BOX_GROUPS = [
  [/forward/i, 'Attaquants'], [/defen[cs]e/i, 'Défenseurs'], [/goalie|goalkeep/i, 'Gardiens'],
  [/batting/i, 'Frappeurs'], [/pitching/i, 'Lanceurs'],
  [/passing/i, 'Passes'], [/rushing/i, 'Course'], [/receiving/i, 'Réception'], [/fumble/i, 'Échappés'],
  [/defensive/i, 'Défense'], [/interception/i, 'Interceptions'], [/kickreturn/i, 'Retours de botté'],
  [/puntreturn/i, 'Retours de dégagement'], [/kicking/i, 'Placements'], [/punting/i, 'Dégagements'],
];

// Colonnes du box score : abréviation française (le détail est en infobulle).
// Les colonnes sans intérêt pour suivre un match sont cachées (null).
export const BOX_LABELS = {
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
export const SOCCER_COLS = [
  ['totalGoals', 'B', 'Buts'], ['goalAssists', 'PD', 'Passes décisives'], ['totalShots', 'T', 'Tirs'],
  ['shotsOnTarget', 'TC', 'Tirs cadrés'], ['foulsCommitted', 'F', 'Fautes commises'],
  ['yellowCards', '🟨', 'Cartons jaunes'], ['redCards', '🟥', 'Cartons rouges'], ['saves', 'ARR', 'Arrêts'],
];

export function boxPlayer(x) {
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
export function boxScore(data, sport) {
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

export function basePlay(p) {
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
export const BASEBALL_NOISE = /^(pitch \d+\s*:|(start|end) (batter|inning|game))/i;

/**
 * Tous les jeux du match, du premier au dernier :
 * [{ id, text, period, clock, teamId, scoring, away, home }].
 */
export function allPlays(data, sport) {
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

/**
 * Les 3 étoiles du match (hockey), quand ESPN les nomme (« firstStar »…).
 * Liste vide sinon.
 */
export function threeStars(data, comp, leagueId) {
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
export function gameLeaders(data, homeId, awayId, leagueId) {
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
export function winProbability(data, state) {
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

/**
 * Chances de victoire des locaux, jeu après jeu (0 à 100), pour le petit
 * graphique de la fenêtre Match. 120 points au plus : un match de basket
 * compte plus de 400 jeux.
 */
export function winTimeline(data) {
  const all = (data?.winprobability ?? [])
    .map((x) => Number(x?.homeWinPercentage))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.round(v * 1000) / 10);
  if (all.length <= 120) return all;
  const step = (all.length - 1) / 119;
  return Array.from({ length: 120 }, (_, i) => all[Math.round(i * step)]);
}

// Statut d'ESPN -> québécois.
export const INJURY_FR = [
  [/injured reserve|\bir\b/i, 'Liste des blessés'], [/out/i, 'Absent'], [/day[- ]to[- ]day/i, 'Au jour le jour'],
  [/questionable/i, 'Incertain'], [/doubtful/i, 'Douteux'], [/probable/i, 'Probable'], [/suspen/i, 'Suspendu'],
];

/** Blessés de chaque équipe : [{ teamId, players: [{ name, pos, status, what, back }] }]. */
export function injuriesOf(data) {
  return (data?.injuries ?? []).map((t) => ({
    teamId: String(t?.team?.id ?? ''),
    players: (t?.injuries ?? []).map((x) => {
      const status = String(x?.status ?? x?.type?.description ?? '');
      const d = x?.details ?? {};
      return {
        name: x?.athlete?.displayName ?? '',
        pos: x?.athlete?.position?.abbreviation ?? '',
        photo: athletePhoto(x?.athlete, ''),
        status: INJURY_FR.find(([re]) => re.test(status))?.[1] ?? autoFr(status),
        what: autoFr([d.type, d.location].filter(Boolean).join(' ') || d.detail || ''),
        back: d.returnDate ? new Date(d.returnDate) : null,
      };
    }).filter((x) => x.name),
  })).filter((t) => t.teamId && t.players.length);
}

/**
 * Chaque tir du match avec sa position sur la glace, d'après les jeux
 * d'ESPN : [{ teamId, x, y, kind: 'goal' | 'shot' | 'miss' | 'block', who, period }].
 * x va de -100 à 100 pieds (bandes), y de -42,5 à 42,5.
 */
export function shotMap(data) {
  return (data?.plays ?? [])
    .map((p) => {
      const c = p?.coordinate ?? p?.coordinates;
      const x = Number(c?.x);
      const y = Number(c?.y);
      const type = String(p?.type?.text ?? '');
      if (!Number.isFinite(x) || !Number.isFinite(y) || !p?.team?.id) return null;
      if (Math.abs(x) > 100 || Math.abs(y) > 43 || (x === 0 && y === 0)) return null;
      const kind = isScoring(p) ? 'goal' : /block/i.test(type) ? 'block' : /miss|wide/i.test(type) ? 'miss' : /shot/i.test(type) ? 'shot' : null;
      if (!kind) return null;
      return { teamId: String(p.team.id), x, y, kind, who: scorerName(p), period: Number(p?.period?.number ?? p?.period) || null };
    })
    .filter(Boolean);
}

export const overviewCache = diskCache('player-overview', 3 * 3600 * 1000);
// Colonnes d'ESPN -> abréviations québécoises.
export const STAT_FR = {
  GP: 'PJ', G: 'B', A: 'A', PTS: 'PTS', '+/-': '+/-', PIM: 'PUN', SOG: 'TB', PPG: 'BAN', GWG: 'BG', TOI: 'TG', 'TOI/G': 'TG/M',
  W: 'V', L: 'D', OTL: 'DP', GAA: 'MBA', 'SV%': '%ARR', SO: 'BL', SV: 'ARR', GA: 'BA',
  AVG: 'MOY', HR: 'CC', RBI: 'PP', R: 'P', H: 'CS', OBP: 'MBB', SLG: 'MPU', OPS: 'OPS', SB: 'BV', AB: 'VB',
  ERA: 'MPM', K: 'RB', IP: 'ML', WHIP: 'WHIP', SV_BB: 'SV', BB: 'BB',
  MIN: 'MIN', REB: 'REB', AST: 'PD', STL: 'INT', BLK: 'CT', 'FG%': '%TIRS', '3P%': '%3PTS', 'FT%': '%LF',
  YDS: 'VG', TD: 'TC', INT: 'INT', REC: 'RÉC', CMP: 'RÉU', ATT: 'ESS', CAR: 'PORT', TGTS: 'CIB',
};
export const statFr = (label) => STAT_FR[String(label).toUpperCase()] ?? STAT_FR[label] ?? label;

/**
 * Fiche d'un joueur : { season: [{ label, value }], games: [{ date, opp,
 * result, stats: [{ label, value }] }] } — la saison régulière et ses 5
 * derniers matchs, d'après l'aperçu du joueur chez ESPN.
 */
export async function fetchPlayerOverview(leagueId, athleteId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !athleteId) return null;
  const key = `${leagueId}:${athleteId}`;
  const hit = overviewCache.get(key);
  if (hit) return hit;
  const data = await getWeb(`${league.path}/athletes/${encodeURIComponent(athleteId)}/overview`);

  const st = data?.statistics ?? {};
  const labels = st.labels ?? st.names ?? [];
  const split = (st.splits ?? []).find((x) => /regular|saison/i.test(x?.displayName ?? '')) ?? st.splits?.[0];
  const season = labels.map((l, i) => ({ label: statFr(l), value: String(split?.stats?.[i] ?? '') }))
    .filter((x) => x.value !== '' && x.value !== '-').slice(0, 7);

  const log = data?.gameLog ?? {};
  const events = log.events ?? {};
  const cat = (log.statistics ?? [])[0] ?? {};
  const logLabels = cat.labels ?? cat.names ?? [];
  const games = (cat.events ?? []).slice(0, 5).map((e) => {
    const info = events[e?.eventId] ?? {};
    return {
      date: info.gameDate ? new Date(info.gameDate) : null,
      opp: [info.atVs, info.opponent?.abbreviation].filter(Boolean).join(' '),
      result: [info.gameResult === 'W' ? 'V' : info.gameResult === 'L' ? 'D' : info.gameResult ?? '', info.score].filter(Boolean).join(' '),
      stats: logLabels.map((l, i) => ({ label: statFr(l), value: String(e?.stats?.[i] ?? '') })).slice(0, 6),
    };
  });
  const out = { season, seasonName: split?.displayName ?? '', games };
  if (season.length || games.length) overviewCache.set(key, out);
  return out;
}

/** Faits saillants vidéo d'ESPN : [{ title, thumb, href }], 4 au plus. */
export function highlights(data) {
  return (data?.videos ?? [])
    .map((v) => ({
      title: v?.headline ?? v?.title ?? '',
      thumb: v?.thumbnail ?? v?.images?.[0]?.url ?? '',
      href: v?.links?.web?.href ?? v?.links?.mobile?.href ?? '',
    }))
    .filter((v) => v.title && /^https:\/\/(www\.)?espn\.(com|ca|co\.uk)\//.test(v.href))
    .slice(0, 4);
}

/** « MTL leads series 2-1 » -> « MTL mène la série 2-1 ». */
export function seriesTextFr(raw) {
  const t = String(raw ?? '').trim();
  let m = /^(\S+) leads? (?:the |season )?series (\d+)-(\d+)(?:-(\d+))?/i.exec(t);
  if (m) return `${m[1]} mène la série ${m[2]}-${m[3]}${m[4] ? `-${m[4]}` : ''}`;
  m = /^(\S+) (?:wins?|won) (?:the |season )?series (\d+)-(\d+)(?:-(\d+))?/i.exec(t);
  if (m) return `${m[1]} remporte la série ${m[2]}-${m[3]}${m[4] ? `-${m[4]}` : ''}`;
  m = /^(?:season )?series (?:is )?tied (\d+)-(\d+)(?:-(\d+))?/i.exec(t);
  if (m) return `Série égale ${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
  return autoFr(t);
}

/**
 * Face-à-face de la saison, d'après le résumé d'ESPN : { text, games:
 * [{ id, date, state, home, away, winnerId }] }, du plus ancien au plus
 * récent. La série de saison régulière passe avant celle des séries.
 */
export function headToHead(data, homeId) {
  const all = Array.isArray(data?.seasonseries) ? data.seasonseries : [];
  const s = all.find((x) => !/playoff|post/i.test(`${x?.type ?? ''} ${x?.title ?? ''}`)) ?? all[0];
  if (!s) return null;
  const side = (c) => ({
    id: String(c?.team?.id ?? c?.id ?? ''),
    abbr: c?.team?.abbreviation ?? '',
    logo: c?.team?.logo ?? c?.team?.logos?.[0]?.href ?? '',
    score: String(c?.score?.displayValue ?? c?.score ?? ''),
  });
  const games = (s.events ?? []).map((e) => {
    const cs = e?.competitors ?? [];
    const h = cs.find((c) => c?.homeAway === 'home') ?? cs[0];
    const a = cs.find((c) => c?.homeAway === 'away') ?? cs[1];
    const state = e?.statusType?.state ?? (typeof e?.status === 'string' ? e.status : e?.status?.type?.state) ?? '';
    return {
      id: String(e?.id ?? ''),
      date: e?.date ? new Date(e.date) : null,
      state: ['pre', 'in', 'post'].includes(state) ? state : 'post',
      home: side(h),
      away: side(a),
      winnerId: cs.find((c) => c?.winner === true)?.team?.id != null ? String(cs.find((c) => c?.winner === true).team.id) : null,
    };
  }).filter((g) => g.home.abbr && g.away.abbr)
    .sort((x, y) => (x.date?.getTime() ?? 0) - (y.date?.getTime() ?? 0));
  const text = seriesTextFr(s.summary || s.description || '');
  if (!text && !games.length) return null;
  return { text, games, homeId: String(homeId ?? '') };
}

/** Articles d'ESPN : [{ id, title, text, date, image, link }], 6 au plus. */
export function newsOf(articles) {
  return (Array.isArray(articles) ? articles : [])
    .filter((a) => a?.headline && !/^media$/i.test(a?.type ?? ''))
    .map((a) => ({
      id: String(a?.id ?? a?.headline),
      title: autoFr(a.headline),
      text: autoFr(a?.description ?? ''),
      date: a?.published ? new Date(a.published) : a?.lastModified ? new Date(a.lastModified) : null,
      image: a?.images?.find?.((i) => i?.url)?.url ?? '',
      link: a?.links?.web?.href ?? '',
    }))
    .filter((a) => /^https:\/\/(www\.)?espn\.(com|ca|co\.uk)\//.test(a.link))
    .slice(0, 6);
}

/** Nouvelles d'une équipe (fil d'ESPN), les plus récentes d'abord. */
export async function fetchTeamNews(leagueId, teamId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !teamId) return [];
  const data = await getJson(`${league.path}/news`, `?team=${encodeURIComponent(teamId)}&limit=12`);
  return newsOf(data?.articles)
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
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
export const INFRACTIONS_FR = [
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
 * Tirs de barrage (hockey, saison régulière) : chaque tir, dans l'ordre,
 * d'après les jeux du résumé d'ESPN : [{ id, teamId, who, goal }].
 */
export function shootoutAttempts(data) {
  return (data?.plays ?? [])
    .filter((p) => Number(p?.period?.number ?? p?.period) >= 5 && p?.team?.id)
    // Pas les jeux « Début / Fin de période », arrêts de jeu, mises en jeu…
    .filter((p) => !/period|start|end|stoppage|faceoff|timeout|challenge|penalty/i.test(p?.type?.text ?? ''))
    .map((p, i) => {
      const text = `${p?.type?.text ?? ''} ${p?.text ?? ''}`;
      const missed = /no goal|miss|save|stopp|block|post|crossbar|wide/i.test(text);
      return {
        id: String(p?.id ?? `so-${i}`),
        teamId: String(p.team.id),
        who: scorerName(p),
        goal: !missed && (isScoring(p) || /\bgoal\b|\bscores?\b/i.test(text)),
      };
    });
}

/** Tirs de barrage d'un match (lecture du résumé d'ESPN). */
export async function fetchShootout(leagueId, eventId) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league || !eventId) return [];
  const data = await getJson(`${league.path}/summary`, `?event=${encodeURIComponent(eventId)}`);
  return shootoutAttempts(data);
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
