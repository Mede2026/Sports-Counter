// Logos et photos de secours : TheSportsDB et Wikipédia, quand ESPN n'en a pas.
// (Découpé de api.js : les autres fichiers importent toujours depuis api.js.)
import { LEAGUES_BY_ID } from '../leagues.js';
import { errText } from '../err.js';
import { diskCache } from '../cache.js';
import { DAY, TEAMS_TTL, inTauri, squash, viaPage, viaRust } from './core.js';

// ESPN n'a pas de logo pour certaines ligues (la LCF) : on les prend chez
// TheSportsDB, une base sportive gratuite, une fois par semaine.
export const SPORTSDB = 'https://www.thesportsdb.com/api/v1/json';
// Clés publiques gratuites de TheSportsDB : « 123 » depuis 2025, « 3 » avant.
export const SPORTSDB_KEYS = ['123', '3'];
export const logoCache = diskCache('logos.sportsdb.v3', TEAMS_TTL);
export const logoLoads = new Map();
// idLigue -> raison du dernier échec, affichée par le Diagnostic.
export const logoErrors = new Map();
// Espaces en « _ » et rien d'autre que des lettres : le relais Rust n'accepte
// que des adresses simples, et TheSportsDB comprend les « _ ».
export const tsdbName = (text) => String(text ?? '').normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '_');

export async function getSportsDb(query) {
  let lastErr = null;
  for (const key of SPORTSDB_KEYS) {
    try {
      let data;
      try {
        data = await viaPage(`${SPORTSDB}/${key}/${query}`);
      } catch (err) {
        if (!inTauri()) throw err;
        data = await viaRust(`tsdb/${key}/${query}`);
      }
      if (data && typeof data === 'object') return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('réponse vide');
}

export const tsdbTeams = (data) => (data?.teams ?? [])
  .map((t) => ({ name: squash(t?.strTeam), alt: squash(t?.strTeamAlternate), league: squash(t?.strLeague), logo: t?.strBadge ?? t?.strTeamBadge ?? t?.strLogo ?? '' }))
  .filter((t) => t.name && /^https:\/\//.test(t.logo));

/** Logos de la ligue chez TheSportsDB : [{ name, alt, logo }] (noms tassés). */
export function sportsDbLogos(league) {
  if (!league?.sportsDb) return Promise.resolve([]);
  const hit = logoCache.get(league.id);
  if (hit) return Promise.resolve(hit);
  if (!logoLoads.has(league.id)) {
    const load = (async () => {
      const errors = [];
      // Toute la ligue d'un coup : par son nom, puis par son numéro.
      const queries = [`search_all_teams.php?l=${tsdbName(league.sportsDb)}`];
      if (league.sportsDbId) queries.push(`lookup_all_teams.php?id=${league.sportsDbId}`);
      for (const q of queries) {
        try {
          const list = tsdbTeams(await getSportsDb(q));
          if (list.length) {
            logoCache.set(league.id, list);
            logoErrors.delete(league.id);
            return list;
          }
          errors.push(`${q.split('.')[0]} : aucune équipe`);
        } catch (err) {
          errors.push(`${q.split('.')[0]} : ${errText(err).split('\n')[0]}`);
        }
      }
      logoErrors.set(league.id, errors.join(' · '));
      return [];
    })().finally(() => logoLoads.delete(league.id));
    logoLoads.set(league.id, load);
  }
  return logoLoads.get(league.id);
}

/* Logos par Wikipédia : l'image principale de l'article de chaque équipe
   est son logo. Une seule requête pour toutes les équipes manquantes. */
export const WIKI_API = 'https://en.wikipedia.org/w/api.php';
export const WIKI_QUERY = 'action=query&format=json&prop=pageimages&piprop=thumbnail&pithumbsize=256&pilicense=any&redirects=1';
export const wikiTitle = (text) => String(text ?? '').normalize('NFD').replace(/[^A-Za-z0-9 .'-]/g, '').trim().replace(/\s+/g, '_');

export async function getWiki(titles) {
  try {
    return await viaPage(`${WIKI_API}?${WIKI_QUERY}&origin=*&titles=${encodeURIComponent(titles.join('|'))}`);
  } catch (err) {
    if (!inTauri()) throw err;
    // Le relais n'accepte que des adresses simples : une équipe à la fois.
    const parts = await Promise.all(titles.map((t) => viaRust(`wiki/?${WIKI_QUERY}&titles=${t}`).catch(() => null)));
    const pages = {};
    const redirects = [];
    const normalized = [];
    for (const d of parts.filter(Boolean)) {
      Object.assign(pages, d?.query?.pages ?? {});
      redirects.push(...(d?.query?.redirects ?? []));
      normalized.push(...(d?.query?.normalized ?? []));
    }
    return { query: { pages, redirects, normalized } };
  }
}

/** Logos des équipes chez Wikipédia : [{ name, alt, logo }] pour celles trouvées. */
export async function wikiLogos(teams) {
  const titles = [...new Set(teams.map((t) => wikiTitle(t.full || t.name)).filter((t) => t.length > 3))].slice(0, 40);
  if (!titles.length) return [];
  const data = await getWiki(titles);
  const q = data?.query ?? {};
  const follow = (title) => {
    let t = String(title).replace(/_/g, ' ');
    t = (q.normalized ?? []).find((n) => n.from === t)?.to ?? t;
    return (q.redirects ?? []).find((r) => r.from === t)?.to ?? t;
  };
  const pages = Object.values(q.pages ?? {});
  const out = [];
  for (const t of teams) {
    const want = follow(wikiTitle(t.full || t.name));
    const page = pages.find((p) => p?.title === want);
    const logo = page?.thumbnail?.source;
    if (typeof logo === 'string' && logo.startsWith('https://')) out.push({ name: squash(t.full || t.name), alt: squash(page.title), logo });
  }
  return out;
}

/** Dernier recours : chercher une équipe par son nom chez TheSportsDB. */
export async function sportsDbTeamLogo(league, team) {
  const names = [team.full, team.name].filter((n) => n && n.length > 3);
  for (const name of names) {
    try {
      // Seulement les équipes de cette ligue : « Edmonton » ne doit pas donner les Oilers.
      const list = tsdbTeams(await getSportsDb(`searchteams.php?t=${tsdbName(name)}`))
        .filter((t) => !t.league || t.league === squash(league.sportsDb));
      const logo = matchLogo(list, team.full, team.name, team.short) || (list.length === 1 ? list[0].logo : '');
      if (logo) return { name: squash(name), alt: '', logo };
    } catch (err) {
      if (!logoErrors.has(league.id)) logoErrors.set(league.id, `searchteams : ${errText(err).split('\n')[0]}`);
    }
  }
  return null;
}

// Photos de joueurs de secours (TheSportsDB), quand ESPN n'a pas de portrait
// (joueurs des équipes nationales, par exemple). Gardées 30 jours, même
// quand rien n'est trouvé : on ne redemande pas sans cesse le même nom.
export const playerPhotoCache = diskCache('photos.sportsdb', 30 * DAY);
export const playerPhotoLoads = new Map();

/** Photo d'un joueur chez TheSportsDB, d'après son nom ; '' si introuvable. */
export function sportsDbPlayerPhoto(name) {
  const key = squash(name);
  if (key.length < 5) return Promise.resolve('');
  const hit = playerPhotoCache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (!playerPhotoLoads.has(key)) {
    const load = getSportsDb(`searchplayers.php?p=${tsdbName(name)}`)
      .then((data) => {
        const players = (data?.player ?? data?.players ?? []).filter((p) => p && typeof p === 'object');
        const same = players.filter((p) => squash(p.strPlayer) === key);
        const pick = same.length === 1 ? same[0] : players.length === 1 ? players[0] : null;
        const photo = [pick?.strCutout, pick?.strThumb, pick?.strRender].find((u) => typeof u === 'string' && u.startsWith('https://')) ?? '';
        playerPhotoCache.set(key, photo);
        return photo;
      })
      .catch(() => '') // réseau : on réessaiera à la prochaine ouverture
      .finally(() => playerPhotoLoads.delete(key));
    playerPhotoLoads.set(key, load);
  }
  return playerPhotoLoads.get(key);
}

/** Pourquoi les logos de secours manquent, pour le Diagnostic ('' si tout va bien). */
export const logoError = (leagueId) => logoErrors.get(leagueId) ?? '';

/** Le logo d'une équipe d'après son nom complet, puis son surnom (« Alouettes »). */
export function matchLogo(list, ...names) {
  for (const raw of names) {
    const q = squash(raw);
    if (q.length < 3) continue;
    const exact = list.find((t) => t.name === q || t.alt === q);
    if (exact) return exact.logo;
    if (q.length < 4) continue;
    const near = list.filter((t) => t.name.endsWith(q) || t.name.startsWith(q));
    if (near.length === 1) return near[0].logo;
  }
  return '';
}

// Après un échec, TheSportsDB n'est pas réinterrogé avant 30 min : le widget
// rafraîchit toutes les 25 s pendant un match.
export const LOGO_RETRY_MS = 30 * 60 * 1000;
export const logoFailedAt = new Map();

/** Complète, sur place, les logos manquants d'une liste d'équipes. */
export async function fillLogos(leagueId, teams) {
  const league = LEAGUES_BY_ID[leagueId];
  const missing = teams.filter((t) => t && !t.logo);
  if (!league?.sportsDb || !missing.length) return teams;
  // Puis le surnom seul (« Lions » pour « British Columbia Lions »), et en
  // dernier la ville : une équipe renommée (Eskimos → Elks) garde sa ville.
  const words = (t) => String(t.full || t.name || '').trim().split(/\s+/);
  const apply = (list) => missing.forEach((t) => {
    if (!t.logo) t.logo = matchLogo(list, t.full, t.name, t.short, words(t).slice(-1)[0], words(t)[0]);
  });

  // 1. Ce qu'on sait déjà (gardé une semaine) : aucune requête.
  apply(logoCache.get(leagueId) ?? []);
  if (missing.every((t) => t.logo)) return teams;
  if (Date.now() - (logoFailedAt.get(leagueId) ?? 0) < LOGO_RETRY_MS) return teams;

  // 2. Wikipédia (LCF) : le logo de l'article de chaque équipe.
  if (league.wikiLogos) {
    try {
      const found = await wikiLogos(missing.filter((t) => !t.logo));
      if (found.length) {
        logoCache.set(leagueId, [...(logoCache.get(leagueId) ?? []), ...found]);
        apply(found);
      }
    } catch (err) {
      logoErrors.set(leagueId, `Wikipédia : ${errText(err).split('\n')[0]}`);
    }
    if (missing.every((t) => t.logo)) {
      logoFailedAt.delete(leagueId);
      return teams;
    }
  }

  // 3. TheSportsDB : toute la ligue d'un coup.
  const list = await sportsDbLogos(league);
  apply(list);

  // 4. Une recherche par équipe restante (au plus 12), gardée avec les autres.
  const still = missing.filter((t) => !t.logo).slice(0, 12);
  if (still.length) {
    const found = (await Promise.all(still.map((t) => sportsDbTeamLogo(league, t)))).filter(Boolean);
    if (found.length) {
      const merged = [...(logoCache.get(leagueId) ?? list), ...found];
      logoCache.set(leagueId, merged);
      apply(merged);
    }
  }
  if (missing.some((t) => !t.logo)) logoFailedAt.set(leagueId, Date.now());
  else logoFailedAt.delete(leagueId);
  return teams;
}

/** Même chose pour les deux équipes de chaque match. */
export async function fillGameLogos(leagueId, games) {
  await fillLogos(leagueId, games.flatMap((g) => [g?.home, g?.away]).filter(Boolean));
  return games;
}
