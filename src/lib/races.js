// Sports qu'ESPN n'a pas : ski et snowboard (site de la FIS), biathlon (API
// de l'IBU) et grands marathons (articles de Wikipédia). Chaque course devient
// un « évènement » comme une séance de F1 : un titre (le lieu), une séance
// (« Slalom géant · Femmes ») et un classement. Le widget, le calendrier, la
// fenêtre Match et le fond d'écran les affichent donc sans code à part.
import { LEAGUES_BY_ID } from './leagues.js';
import { diskCache } from './cache.js';
import { fetchWithTimeout, inTauri } from './espn/core.js';

const DAY = 24 * 3600 * 1000;
const MIN = 60 * 1000;

/* ---------- Requêtes ---------- */

// Adresse réelle de chaque source ; dans l'app, le relais Rust les connaît
// sous un préfixe (« fis/ », « ibu/ », « wiki/ ») et refuse tout autre site.
const ROUTES = {
  fis: 'https://www.fis-ski.com/DB/',
  ibu: 'https://biathlonresults.com/modules/sportapi/api/',
  wiki: 'https://en.wikipedia.org/w/api.php',
  vis: 'https://www.fivb.org/Vis2009/XmlRequest.asmx?Request=',
};

// L'IBU et Wikipédia refusent les rafales (erreur 429) : au moins 0,7 s
// entre deux requêtes vers le même site.
const GAP_MS = { ibu: 700, wiki: 700 };
const nextSlot = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(route, rest) {
  if (inTauri()) return window.__TAURI__.core.invoke('espn_get', { path: `${route}/${rest}` });
  const res = await fetchWithTimeout(ROUTES[route] + rest);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Texte brut d'une page ou d'une API (HTML de la FIS, JSON de l'IBU…). */
export async function getText(route, rest) {
  const gap = GAP_MS[route] ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    if (gap) {
      const now = Date.now();
      const at = Math.max(now, nextSlot[route] ?? 0);
      nextSlot[route] = at + gap;
      if (at > now) await sleep(at - now);
    }
    try {
      return await fetchText(route, rest);
    } catch (err) {
      // Trop de requêtes : un seul nouvel essai, un peu plus tard.
      if (attempt === 0 && /\b429\b/.test(String(err?.message ?? err))) { await sleep(2500); continue; }
      throw err;
    }
  }
}

// Réponses gardées sur le disque. Chaque appel dit lui-même combien de temps
// une réponse reste bonne (une course finie : un jour ; en direct : 20 s).
const store = diskCache('races', 3 * DAY);
const pending = new Map();

/** `load()` au plus une fois par `ttl` pour cette clé ; deux appels simultanés partagent la requête. */
async function cached(key, ttl, load) {
  if (store.age(key) < ttl) return store.get(key);
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    try {
      const value = await load();
      store.set(key, value);
      return value;
    } catch (err) {
      // Source muette : la dernière réponse connue plutôt que rien.
      const old = store.get(key);
      if (old !== undefined) return old;
      throw err;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

/* ---------- Petits outils ---------- */

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Jour local à minuit, décalé de `offset` jours. */
const dayStart = (now, offset = 0) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
};

const decode = (s) => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

const cap = (w) => w.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

/**
 * « HROBAT Miha » → { name: « Miha Hrobat », short: « M. Hrobat » }. Les
 * fédérations écrivent le nom de famille en majuscules : on s'en sert pour
 * séparer nom et prénom. Une équipe (« AUSTRIA ») garde son nom, adouci.
 */
export function personName(raw) {
  const words = decode(raw).split(' ').filter(Boolean);
  const isFamily = (w) => /\p{Lu}/u.test(w) && w === w.toUpperCase() && /\p{L}{2}/u.test(w);
  const family = words.filter(isFamily);
  const given = words.filter((w) => !isFamily(w));
  if (!family.length || !given.length) {
    const name = cap(words.join(' '));
    return { name, short: name };
  }
  const last = cap(family.join(' '));
  return { name: `${given.join(' ')} ${last}`, short: `${given[0][0]}. ${last}` };
}

// Mots anglais des noms de courses, en français. L'ordre compte : les
// expressions longues d'abord.
const WORDS = [
  [/\bWomen'?s?\b/gi, ''], [/\bMen'?s?\b/gi, ''], [/\bLadies'?\b/gi, ''],
  [/\bAlpine Combined\b/gi, 'Combiné'], [/\bTeam Combined\b/gi, 'Combiné par équipe'],
  [/\bParallel Giant Slalom\b/gi, 'Slalom géant parallèle'], [/\bParallel Slalom\b/gi, 'Slalom parallèle'],
  [/\bGiant Slalom\b/gi, 'Slalom géant'], [/\bSuper G\b/gi, 'Super-G'], [/\bDownhill\b/gi, 'Descente'],
  [/\bTeam Parallel\b/gi, 'Parallèle par équipe'], [/\bParallel\b/gi, 'Parallèle'],
  [/\bSnowboard Cross\b/gi, 'Snowboardcross'], [/\bSki Cross\b/gi, 'Skicross'], [/\bDual Moguls\b/gi, 'Bosses en parallèle'],
  [/\bMoguls\b/gi, 'Bosses'], [/\bAerials\b/gi, 'Sauts'], [/\bHalfpipe\b/gi, 'Demi-lune'],
  [/\bLarge Hill\b/gi, 'Grand tremplin'], [/\bNormal Hill\b/gi, 'Petit tremplin'], [/\bFlying Hill\b/gi, 'Tremplin de vol'],
  [/\bSuper Team\b/gi, 'Super équipe'], [/\bTeam Sprint\b/gi, 'Sprint par équipe'],
  [/\bSingle Mixed Relay\b/gi, 'Relais mixte simple'], [/\bMixed Relay\b/gi, 'Relais mixte'], [/\bRelay\b/gi, 'Relais'],
  [/\bShort Individual\b/gi, 'Individuel court'], [/\bIndividual\b/gi, 'Individuel'],
  [/\bInterval Start\b/gi, 'départ par intervalles'], [/\bMass Start\b/gi, 'Départ groupé'], [/\bPursuit\b/gi, 'Poursuite'],
  [/\bClassic\b/gi, 'classique'], [/\bFree\b/gi, 'libre'], [/\bTeam\b/gi, 'par équipe'], [/\bTraining\b/gi, 'entraînement'],
  [/\bMixed\b/gi, 'mixte'], [/\bQualification\b/gi, 'qualifications'], [/\bFinals?\b/gi, 'finale'], [/(\d)\.(\d)\s?km\b/g, '$1,$2 km'], [/(\d)\s?km\b/g, '$1 km'],
];

/** « Men's 10km Interval Start Classic » → « 10 km départ par intervalles classique ». */
export function raceLabel(raw) {
  let s = decode(raw);
  for (const [re, fr] of WORDS) s = s.replace(re, fr);
  s = s.replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Hommes, Femmes ou Mixte, d'après le nom anglais de la course ou une lettre (M, W, L, A, X). */
export function genderOf(text = '', letter = '') {
  if (/\bmixed\b/i.test(text) || /^[AX]$/.test(letter)) return 'Mixte';
  if (/\b(women|ladies)/i.test(text) || /^[WL]$/.test(letter)) return 'Femmes';
  if (/\bmen/i.test(text) || letter === 'M') return 'Hommes';
  return '';
}

const sessionOf = (label, gender) => [label, gender].filter(Boolean).join(' · ');

/** Un résultat de course, prêt pour le podium du widget. */
const finisher = (pos, raw, extra = {}) => ({ id: '', pos, ...personName(raw), photo: '', flag: '', team: '', gap: '', ...extra });

/**
 * État d'une course : pas commencée, en cours, finie. Sans résultats
 * officiels, une course partie depuis plus de `maxHours` est dite finie.
 */
function stateOf(startsAt, done, now, maxHours = 4) {
  const t = startsAt?.getTime?.() ?? NaN;
  if (done) return 'post';
  if (!Number.isFinite(t) || t > now.getTime()) return 'pre';
  return now.getTime() - t < maxHours * 3600e3 ? 'in' : 'post';
}

const STATUS = { pre: 'Prévue', in: 'En cours', post: 'Terminée' };

/* ---------- FIS : ski alpin, ski de fond, saut, combiné, snowboard, freestyle ---------- */

/** Saison de la FIS : celle de 2026-2027 s'appelle « 2027 ». */
export const fisSeason = (d) => (d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear());

/** Dates d'une ligne du calendrier : « 24-25 Oct 2026 », « 29 Nov-01 Dec 2025 », « 31 Dec 2025-01 Jan 2026 ». */
export function fisDates(text) {
  const m = /^(\d{1,2})(?:\s+([A-Z][a-z]{2}))?(?:\s+(\d{4}))?(?:\s*-\s*(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4}))?$/.exec(decode(text));
  if (!m) return null;
  const [, d1, m1, y1, d2, m2, y2] = m;
  const endMonth = MONTHS[m2 ?? m1];
  const endYear = Number(y2 ?? y1);
  if (endMonth == null || !endYear) return null;
  const startMonth = MONTHS[m1 ?? m2];
  const startYear = Number(y1 ?? (startMonth > endMonth ? endYear - 1 : endYear));
  const start = new Date(startYear, startMonth, Number(d1));
  const end = d2 ? new Date(endYear, endMonth, Number(d2)) : new Date(start);
  return { start, end };
}

/** Lignes du calendrier de la FIS : une par étape (« Soelden, 2xGS, AUT »). */
export function parseFisCalendar(html) {
  const out = [];
  for (const chunk of String(html).split('<div class="table-row reset-padding"').slice(1)) {
    const id = (/^[^>]*\bid="(\d+)"/.exec(chunk) ?? [])[1];
    const dateText = (/>([^<>]*\d{4})\s*<\/a>/.exec(chunk) ?? [])[1];
    const dates = dateText && fisDates(dateText);
    if (!id || !dates) continue;
    const grays = [...chunk.matchAll(/<span class="gray clip">([^<]*)<\/span>/g)].map((x) => decode(x[1]));
    out.push({
      id,
      ...dates,
      place: decode((/<span class="bold clip-xs">([^<]*)<\/span>/.exec(chunk) ?? [])[1]),
      nation: decode((/country__name-short">([^<]*)</.exec(chunk) ?? [])[1]),
      cat: grays[0] ?? '',
      disciplines: grays[1] ?? '',
      cancelled: /title="Cancelled"/.test(chunk),
    });
  }
  return out;
}

/** Courses d'une étape (page « event-details ») : date et heure, discipline, sexe, état. */
export function parseFisEvent(html) {
  const out = [];
  for (const chunk of String(html).split('<div class="table-row reset-padding').slice(1)) {
    const id = (/raceid=(\d+)/.exec(chunk) ?? [])[1];
    if (!id || out.some((r) => r.id === id)) continue;
    const iso = (/data-iso-date="([^"]+)"/.exec(chunk) ?? [])[1];
    const discipline = decode((/<div class="clip">([^<]*)<\/div>/.exec(chunk) ?? [])[1]);
    const letter = decode((/gender__item[^"]*">([^<]*)</.exec(chunk) ?? [])[1]);
    // Texte d'une case (« > Official results < »), pas l'infobulle « Not cancelled ».
    const status = decode((/>\s*(Official results|Unofficial results|Cancelled|Postponed|Rescheduled|Interrupted|Live)\s*</.exec(chunk) ?? [])[1]);
    out.push({
      id,
      startsAt: iso ? new Date(iso) : null,
      discipline,
      gender: genderOf(discipline, letter),
      status,
      cancelled: /title="Cancelled"/.test(chunk) || /cancel|postpone/i.test(status),
    });
  }
  return out;
}

/** Résultats d'une course de la FIS : rang, nom, pays, temps (ou points), écart. */
export function parseFisResults(html) {
  const page = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const results = [];
  for (const chunk of page.split('<a class="table-row"').slice(1)) {
    if (!/athlete-biography/.test(chunk.slice(0, 300))) continue;
    const row = chunk.slice(0, chunk.indexOf('</a>') > 0 ? chunk.indexOf('</a>') : undefined);
    const cells = [...row.matchAll(/<div class="[^"]*">([^<]*)<\/div>/g)].map((x) => decode(x[1])).filter(Boolean);
    const nat = decode((/country__name-short">([^<]*)</.exec(row) ?? [])[1]);
    const pos = Number.parseInt(cells[0], 10);
    const nameAt = cells.findIndex((c, i) => i > 0 && /\p{L}{2}/u.test(c) && !/^\d/.test(c));
    if (!Number.isFinite(pos) || nameAt < 0) continue;
    const after = cells.slice(nameAt + 1).filter((c) => !/^(19|20)\d\d$/.test(c));
    const time = after.find((c) => /^\d[\d:.,]*$/.test(c)) ?? '';
    const gap = after.find((c) => /^\+/.test(c)) ?? '';
    const id = (/competitorid=(\d+)/.exec(row) ?? [])[1] ?? '';
    results.push(finisher(pos, cells[nameAt], { id, nat, time, gap: pos === 1 ? '' : gap }));
  }
  return {
    kind: decode((/event-header__kind">([^<]*)</.exec(page) ?? [])[1]),
    place: decode((/<h1[^>]*>([^<]*)<\/h1>/.exec(page) ?? [])[1]),
    official: /event-status_finished/.test(page) || (/Official results/.test(page) && !/Unofficial results/.test(page)),
    results: results.sort((a, b) => a.pos - b.pos),
  };
}

// Catégories suivies : Coupe du monde, championnats du monde, Jeux olympiques.
const FIS_CATS = ['WC', 'WSC', 'OWG'];

async function fisCalendar(sector, season) {
  const lists = await Promise.all(FIS_CATS.map((cat) => cached(`fis:cal:${sector}:${season}:${cat}`, cat === 'WC' ? 6 * 3600e3 : DAY,
    async () => parseFisCalendar(await getText('fis', `general/calendar-results.html?sectorcode=${sector}&seasoncode=${season}&categorycode=${cat}`)))
    .catch(() => [])));
  return lists.flat();
}

// Codes des disciplines au calendrier de la FIS (« 2xGS »), en français.
const FIS_CODES = {
  DH: 'Descente', SG: 'Super-G', GS: 'Slalom géant', SL: 'Slalom', AC: 'Combiné', TC: 'Combiné par équipe', PAR: 'Parallèle',
  PGS: 'Slalom géant parallèle', PSL: 'Slalom parallèle', SBX: 'Snowboardcross', SX: 'Skicross', HP: 'Demi-lune',
  SS: 'Slopestyle', BA: 'Big Air', MO: 'Bosses', DM: 'Bosses en parallèle', AE: 'Sauts', AET: 'Sauts par équipe',
  TCS: 'Tournée des quatre tremplins', HS: 'Tremplin', SP: 'Sprint', TS: 'Sprint par équipe', MS: 'Départ groupé',
  PU: 'Poursuite', RL: 'Relais', IND: 'Individuel', SA: 'Skiathlon', TE: 'Par équipe',
};

/** « 2xGS • 2xSL » → « 2 × Slalom géant, 2 × Slalom ». Code inconnu : laissé tel quel. */
export function fisDisciplines(text) {
  return String(text ?? '').split(/[•,/]/).map((part) => {
    const m = /^\s*(?:(\d+)\s*x\s*)?([A-Z]+)\b/.exec(part);
    if (!m) return part.trim();
    const name = FIS_CODES[m[2]] ?? m[2];
    return m[1] && m[1] !== '1' ? `${m[1]} × ${name}` : name;
  }).filter(Boolean).join(', ');
}

// Étapes dont on détaille les courses (une page de plus chacune) : celles de
// ces jours-ci. Plus loin (calendrier), une ligne par étape suffit.
const NEAR_BEFORE = 3 * DAY;
const NEAR_AFTER = 5 * DAY;

async function fisRaces(league, from, to, now) {
  const sector = league.fis;
  const seasons = [...new Set([fisSeason(from), fisSeason(to)])];
  const events = (await Promise.all(seasons.map((s) => fisCalendar(sector, s)))).flat()
    .filter((e) => e.end.getTime() + DAY >= from.getTime() && e.start.getTime() <= to.getTime());
  const isNear = (e) => e.end.getTime() + DAY >= now.getTime() - NEAR_BEFORE && e.start.getTime() <= now.getTime() + NEAR_AFTER;
  const out = [];
  // Étapes lointaines : une seule ligne, le jour où elles commencent.
  for (const ev of events.filter((e) => !isNear(e))) {
    if (ev.start < from) continue;
    const state = ev.end.getTime() + DAY < now.getTime() ? 'post' : ev.start > now ? 'pre' : 'in';
    out.push(raceGame(league, {
      id: `fis-ev-${ev.id}`,
      title: ev.place || 'Étape',
      nation: ev.nation,
      session: fisDisciplines(ev.disciplines) || league.label,
      startsAt: ev.start,
      allDay: true,
      state,
      statusText: ev.cancelled ? 'Annulée' : STATUS[state],
      results: [],
      link: `https://www.fis-ski.com/DB/general/event-details.html?sectorcode=${sector}&eventid=${ev.id}&seasoncode=${fisSeason(ev.start)}`,
    }));
  }
  // Étapes de ces jours-ci : chaque course, avec son heure et son classement.
  const games = [];
  await Promise.all(events.filter(isNear).slice(0, 8).map(async (ev) => {
    let races;
    try {
      races = await cached(`fis:ev:${ev.id}`, 30 * MIN,
        async () => parseFisEvent(await getText('fis', `general/event-details.html?sectorcode=${sector}&eventid=${ev.id}&seasoncode=${fisSeason(ev.start)}`)));
    } catch { return; }
    for (const r of races) {
      // Entraînements et qualifications : pas des courses à suivre.
      if (!r.startsAt || r.startsAt < from || r.startsAt > to || /training|qualif/i.test(r.discipline)) continue;
      games.push({ ev, r });
    }
  }));
  // Résultats des courses déjà parties (les plus récentes d'abord, 16 au plus).
  const started = games.filter(({ r }) => r.startsAt <= now && !r.cancelled)
    .sort((a, b) => b.r.startsAt - a.r.startsAt).slice(0, 16);
  const results = new Map();
  await Promise.all(started.map(async ({ r }) => {
    const fresh = now.getTime() - r.startsAt.getTime() < DAY;
    const official = /^official/i.test(r.status);
    try {
      results.set(r.id, await cached(`fis:res:${r.id}`, official && !fresh ? 7 * DAY : official ? 3600e3 : 2 * MIN,
        async () => parseFisResults(await getText('fis', `general/results.html?sectorcode=${sector}&raceid=${r.id}`))));
    } catch { /* résultats pas encore publiés */ }
  }));
  for (const { ev, r } of games) {
    const res = results.get(r.id);
    const list = res?.results ?? [];
    const done = r.cancelled || /^official/i.test(r.status) || res?.official || (list.length > 0 && now - r.startsAt > 2 * 3600e3);
    const state = r.cancelled ? 'post' : stateOf(r.startsAt, done, now, 5);
    out.push(raceGame(league, {
      id: `fis-${r.id}`,
      title: ev.place || res?.place || 'Course',
      nation: ev.nation,
      session: sessionOf(raceLabel(res?.kind || r.discipline), r.gender || genderOf(res?.kind)),
      startsAt: r.startsAt,
      state,
      statusText: r.cancelled ? 'Annulée' : state === 'in' && list.length ? 'Résultats provisoires' : STATUS[state],
      results: state === 'pre' ? [] : list,
      link: `https://www.fis-ski.com/DB/general/results.html?sectorcode=${sector}&raceid=${r.id}`,
    }));
  }
  return out;
}

/* ---------- IBU : biathlon ---------- */

/** Saison de l'IBU : celle de 2026-2027 s'appelle « 2627 ». */
export const ibuSeason = (d) => {
  const y = d.getFullYear() % 100;
  const a = d.getMonth() >= 6 ? y : y - 1;
  return `${String(a).padStart(2, '0')}${String(a + 1).padStart(2, '0')}`;
};

/** Classement d'une course de l'IBU (les relayeurs sont cachés, l'équipe reste). */
export function ibuResults(data) {
  const rows = (data?.Results ?? []).filter((x) => x && (x.IsTeam || !x.Leg));
  return rows
    .map((x) => {
      const pos = Number.parseInt(x.Rank ?? x.ResultOrder, 10);
      const gap = String(x.Behind ?? '').trim();
      return finisher(pos, x.IsTeam ? x.Name : (x.Name ?? x.ShortName), {
        id: String(x.IBUId ?? ''),
        nat: x.Nat ?? '',
        time: x.TotalTime ?? x.Result ?? '',
        gap: pos === 1 || !gap || gap === '0.0' ? '' : (gap.startsWith('+') ? gap : `+${gap}`),
        shooting: x.ShootingTotal ?? '',
      });
    })
    .filter((d) => Number.isFinite(d.pos) && d.pos > 0)
    .sort((a, b) => a.pos - b.pos);
}

async function ibuRaces(league, from, to, now) {
  const seasons = [...new Set([ibuSeason(from), ibuSeason(to)])];
  const events = (await Promise.all(seasons.map((s) => cached(`ibu:ev:${s}`, 6 * 3600e3,
    async () => JSON.parse(await getText('ibu', `Events?SeasonId=${s}&Level=1`))).catch(() => [])))).flat()
    .filter((e) => new Date(e.EndDate).getTime() + DAY >= from.getTime() && new Date(e.StartDate).getTime() <= to.getTime());
  const games = [];
  for (const ev of events.slice(0, 12)) {
    const near = Math.abs(new Date(ev.StartDate).getTime() - now.getTime()) < 8 * DAY;
    let comps;
    try {
      comps = await cached(`ibu:comp:${ev.EventId}`, near ? 10 * MIN : 12 * 3600e3,
        async () => JSON.parse(await getText('ibu', `Competitions?EventId=${ev.EventId}`)));
    } catch { continue; }
    for (const c of comps ?? []) {
      const startsAt = new Date(c.StartTime);
      if (!(startsAt >= from && startsAt <= to)) continue;
      games.push({ ev, c, startsAt });
    }
  }
  // Une requête à la fois : l'IBU refuse les rafales (erreur 429).
  const results = new Map();
  for (const { c, startsAt } of games.filter((g) => g.startsAt <= now).sort((a, b) => b.startsAt - a.startsAt).slice(0, 16)) {
    const final = /final|official/i.test(`${c.StatusText} ${c.ResultStatus}`) || c.ScheduleStatus === 'FINISHED';
    const live = c.IsLive || now - startsAt < 3 * 3600e3;
    try {
      results.set(c.RaceId, await cached(`ibu:res:${c.RaceId}`, final && !live ? 7 * DAY : final ? 10 * MIN : 20 * 1000,
        async () => ibuResults(JSON.parse(await getText('ibu', `Results?RaceId=${c.RaceId}`)))));
    } catch { /* pas encore de résultats */ }
  }
  return games.map(({ ev, c, startsAt }) => {
    const list = results.get(c.RaceId) ?? [];
    const cancelled = /cancel/i.test(`${c.StatusText} ${c.ScheduleStatus}`);
    const final = /final|official/i.test(`${c.StatusText} ${c.ResultStatus}`) || c.ScheduleStatus === 'FINISHED';
    const state = cancelled ? 'post' : c.IsLive ? 'in' : stateOf(startsAt, final, now, 3);
    return raceGame(league, {
      id: `ibu-${c.RaceId}`,
      title: ev.ShortDescription || ev.Organizer || 'Biathlon',
      nation: ev.Nat ?? '',
      session: sessionOf(raceLabel(c.ShortDescription || c.Description), genderOf(c.Description)),
      startsAt,
      state,
      statusText: cancelled ? 'Annulée' : c.IsLive ? 'En direct' : STATUS[state],
      results: state === 'pre' ? [] : list,
      link: 'https://biathlonresults.com/',
    });
  });
}

/* ---------- Marathons : les sept « majeurs » ---------- */

// Heure de départ des élites, à l'heure locale (avec le décalage horaire de
// la saison de la course). Wikipédia ne donne que le jour.
export const MARATHONS = [
  { key: 'Tokyo', fr: 'Tokyo', start: '09:10:00+09:00' },
  { key: 'Boston', fr: 'Boston', start: '09:37:00-04:00' },
  { key: 'London', fr: 'Londres', start: '09:35:00+01:00' },
  { key: 'Sydney', fr: 'Sydney', start: '07:10:00+10:00' },
  { key: 'Berlin', fr: 'Berlin', start: '09:15:00+02:00' },
  { key: 'Chicago', fr: 'Chicago', start: '07:30:00-05:00' },
  { key: 'New York City', fr: 'New York', start: '08:40:00-05:00' },
];

const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Jour de la course et vainqueurs, tirés de l'infobox de l'article Wikipédia. */
export function parseMarathon(wikitext) {
  const w = String(wikitext ?? '');
  let date = null;
  const t = /start date(?: and age)?\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i.exec(w);
  if (t) date = [Number(t[1]), Number(t[2]), Number(t[3])];
  else {
    const months = EN_MONTHS.join('|');
    const a = new RegExp(`\\|\\s*dates?\\s*=[^\\n]*?(\\d{1,2})\\s+(${months})\\s+(\\d{4})`, 'i').exec(w);
    const b = new RegExp(`\\|\\s*dates?\\s*=[^\\n]*?(${months})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i').exec(w);
    if (a) date = [Number(a[3]), EN_MONTHS.indexOf(a[2].toLowerCase()) + 1, Number(a[1])];
    else if (b) date = [Number(b[3]), EN_MONTHS.indexOf(b[1].toLowerCase()) + 1, Number(b[2])];
  }
  // Liens et gras retirés : « [[John Korir (runner)|John Korir]] » → « John Korir ».
  const plain = w.replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '');
  const field = (name) => decode((new RegExp(`\\|\\s*${name}\\s*=\\s*([^|\\n}]*)`).exec(plain) ?? [])[1]);
  const time = (v) => (/\d:\d{2}:\d{2}/.exec(v) ?? [''])[0];
  return {
    date,
    men: field('men'), menTime: time(field('men_win_value')),
    women: field('women'), womenTime: time(field('women_win_value')),
  };
}

async function marathonRaces(league, from, to, now) {
  const years = [...new Set([from.getFullYear(), to.getFullYear()])];
  const titles = years.flatMap((y) => MARATHONS.map((m) => `${y} ${m.key} Marathon`));
  const raceDay = (d) => Math.abs(d.getTime() - now.getTime()) < 2 * DAY;
  // Une seule requête pour tous les articles : Wikipédia freine les rafales.
  const key = `wiki:marathons:${years.join(',')}`;
  const soon = store.get(key)?.some((p) => p.date && raceDay(new Date(Date.UTC(p.date[0], p.date[1] - 1, p.date[2]))));
  const pages = await cached(key, soon ? 15 * MIN : 12 * 3600e3, async () => {
    const q = `?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles=${titles.map((x) => x.replace(/ /g, '_')).join('|')}`;
    const data = JSON.parse(await getText('wiki', q));
    return (data?.query?.pages ?? []).filter((p) => !p.missing).map((p) => ({
      title: p.title, ...parseMarathon(p.revisions?.[0]?.slots?.main?.content ?? p.revisions?.[0]?.content),
    }));
  });
  const games = [];
  for (const p of pages ?? []) {
    const m = MARATHONS.find((x) => p.title.endsWith(`${x.key} Marathon`));
    if (!m || !p.date) continue;
    const [y, mo, d] = p.date;
    const startsAt = new Date(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${m.start}`);
    if (!(startsAt >= from && startsAt <= to)) continue;
    const results = [
      p.men && finisher(1, '', { name: p.men, short: `${p.men.split(' ').pop()} (H)`, time: p.menTime, gap: p.menTime }),
      p.women && finisher(1, '', { name: p.women, short: `${p.women.split(' ').pop()} (F)`, time: p.womenTime, gap: p.womenTime }),
    ].filter(Boolean);
    const state = stateOf(startsAt, false, now, 3);
    games.push(raceGame(league, {
      id: `mar-${y}-${m.key.replace(/\W/g, '')}`,
      title: `Marathon de ${m.fr}`,
      nation: '',
      session: 'Marathon · Hommes et femmes',
      startsAt,
      state,
      statusText: state === 'post' && !results.length ? 'Terminé · résultats à venir' : STATUS[state],
      results: state === 'pre' ? [] : results,
      link: `https://en.wikipedia.org/wiki/${p.title.replace(/ /g, '_')}`,
    }));
  }
  return games;
}

/* ---------- Commun ---------- */

/** Une course, sous la forme d'un évènement du widget (comme une séance de F1). */
function raceGame(league, x) {
  return {
    leagueId: league.id,
    kind: 'event',
    race: true,
    clock: '',
    period: null,
    playoffs: false,
    logo: league.logo ?? '',
    sessions: [],
    laps: '',
    qual: false,
    phase: null,
    flag: '',
    ...x,
    top3: (x.results ?? []).slice(0, 3),
  };
}

/* ---------- FIVB : volleyball international (VNL, championnats du monde) ---------- */

/** Une demande au service de données de la FIVB (VIS) ; il répond en JSON. */
async function vis(xml) {
  const data = JSON.parse(await getText('vis', encodeURIComponent(xml)));
  return data?.data ?? [];
}

const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Tours d'un tournoi (« Pool 3 - Preliminary Phase », « Final 1-2 »), en français.
const ROUNDS = [
  [/final\s*1\s*-\s*2|^final$|gold/i, 'Finale'], [/final\s*3\s*-\s*4|bronze/i, 'Match pour la 3e place'],
  [/semi/i, 'Demi-finale'], [/quarter/i, 'Quart de finale'], [/round of 16|eighth/i, 'Huitième de finale'],
  [/final\s*(\d+)\s*-\s*(\d+)/i, 'Match de classement'],
];

/** « Pool 3 - Preliminary Phase » → « Poule 3 · Phase préliminaire ». */
export function roundFr(pool = '') {
  const p = String(pool ?? '').trim();
  for (const [re, fr] of ROUNDS) if (re.test(p)) return fr;
  return p.replace(/\bPool\b/gi, 'Poule').replace(/\bPreliminary Phase\b/gi, 'phase préliminaire')
    .replace(/\bWeek\b/gi, 'Semaine').replace(/\s+-\s+/g, ' · ');
}

// Pays : drapeau d'ESPN, à partir du code à trois lettres. Un club (« NEC
// Red Rockets Kawasaki (JPN) ») garde son sigle.
const flagOf = (code, name) => (/^[A-Z]{3}$/.test(code ?? '') && !/\(/.test(name ?? '')
  ? `https://a.espncdn.com/i/teamlogos/countries/500/${code.toLowerCase()}.png` : '');

/** Points de chaque set, sous les deux noms de champs que la FIVB a utilisés. */
function setScores(m) {
  const out = [];
  for (let i = 1; i <= 5; i += 1) {
    const a = m[`pointsTeamASet${i}`] ?? m[`set${i}PointsA`];
    const b = m[`pointsTeamBSet${i}`] ?? m[`set${i}PointsB`];
    if (a == null || b == null || (a === 0 && b === 0)) break;
    out.push([Number(a), Number(b)]);
  }
  return out;
}

/** Un match de la FIVB, sous la forme d'un match du widget (pointage = sets gagnés). */
export function fivbGame(league, m, now = new Date(), gender = '') {
  const startsAt = new Date(m.dateTimeUtc);
  const a = Number(m.matchPointsA);
  const b = Number(m.matchPointsB);
  const scored = m.matchPointsA != null && m.matchPointsB != null;
  // État : 1 = au programme, 25 = terminé ; entre les deux, le match se joue.
  const st = Number(m.status);
  const state = st >= 25 ? 'post' : st > 1 ? 'in' : 'pre';
  const sets = setScores(m);
  const side = (code, name, score, won) => ({
    id: String(code ?? name ?? ''), abbr: code || String(name ?? '').slice(0, 3).toUpperCase(), name: name ?? 'À déterminer',
    short: name ?? '', logo: flagOf(code, name), color: '', score: state === 'pre' || !scored ? '–' : String(score),
    winner: state === 'post' && won, record: '',
  });
  const round = roundFr(m.poolName ?? m.roundName ?? '');
  return {
    id: `fivb-${m.no}`,
    leagueId: league.id,
    kind: 'match',
    fivb: true,
    state,
    statusText: state === 'post' ? (round && /finale|place/i.test(round) ? `Final · ${round}` : 'Final') : state === 'in' ? 'En cours' : '',
    clock: state === 'in' && scored ? `${a + b + 1}e set` : '',
    period: state === 'in' && scored ? a + b + 1 : null,
    playoffs: /finale|place|quart|huiti/i.test(round),
    startsAt,
    session: [round, gender].filter(Boolean).join(' · '),
    venue: [m.city, m.countryName].filter(Boolean).join(', '),
    home: side(m.teamBCode, m.teamBName, b, b > a),
    away: side(m.teamACode, m.teamAName, a, a > b),
    sets,
    link: 'https://en.volleyballworld.com/',
  };
}

const VIS_FIELDS = 'No DateTimeUtc TeamAName TeamBName TeamACode TeamBCode MatchPointsA MatchPointsB Status PoolName City CountryName '
  + [1, 2, 3, 4, 5].map((i) => `PointsTeamASet${i} PointsTeamBSet${i}`).join(' ');

async function fivbMatches(league, from, to, now) {
  // Tournois de la FIVB (VNL, Mondiaux…) qui touchent la période demandée.
  const year = now.getFullYear();
  const list = await cached(`vis:tournois:${year}`, 12 * 3600e3, () => vis(
    `<Request Type="GetVolleyTournamentList" Fields="No Code Name StartDate EndDate Gender"><Filter FirstDate="${year - 1}-01-01" LastDate="${year + 1}-12-31" /></Request>`));
  const codes = new RegExp(`^(${league.fivb.join('|')})\\d{4}$`);
  const tournaments = list.filter((t) => codes.test(t.code ?? '')
    && new Date(`${t.endDate}T23:59:59Z`).getTime() + DAY >= from.getTime() && new Date(`${t.startDate}T00:00:00Z`) <= to);
  const games = [];
  for (const t of tournaments) {
    const live = new Date(`${t.startDate}T00:00:00Z`) <= now && now.getTime() <= new Date(`${t.endDate}T23:59:59Z`).getTime() + DAY;
    let matches;
    try {
      matches = await cached(`vis:matchs:${t.no}:${ymdOf(from)}:${ymdOf(to)}`, live ? 30 * 1000 : 6 * 3600e3, () => vis(
        `<Request Type="GetVolleyMatchList" Fields="${VIS_FIELDS}"><Filter NoTournament="${t.no}" FirstDate="${ymdOf(from)}" LastDate="${ymdOf(to)}" /></Request>`));
    } catch { continue; }
    const gender = league.fivb.length > 1 ? (Number(t.gender) === 1 ? 'Femmes' : 'Hommes') : '';
    for (const m of matches) {
      const g = fivbGame(league, m, now, gender);
      if (g.startsAt >= from && g.startsAt <= to) games.push(g);
    }
  }
  return games;
}

const SOURCES = { fis: fisRaces, ibu: ibuRaces, marathon: marathonRaces, fivb: fivbMatches };

/** Courses de `fromOffset` à `toOffset` jours d'aujourd'hui, dans l'ordre. */
export async function fetchRaceRange(leagueId, fromOffset, toOffset, now = new Date()) {
  const league = LEAGUES_BY_ID[leagueId];
  const source = SOURCES[league?.source];
  if (!source) return [];
  const from = dayStart(now, fromOffset);
  const to = new Date(dayStart(now, toOffset + 1).getTime() - 1);
  const games = await source(league, from, to, now);
  return games.sort((a, b) => a.startsAt - b.startsAt);
}

/** Courses autour d'aujourd'hui, pour le widget : d'avant-hier à dans 4 jours. */
export const fetchRaceBoard = (leagueId, now = new Date()) => fetchRaceRange(leagueId, -2, 4, now);
