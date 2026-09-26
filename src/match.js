// Fenêtre « Match » : tout le détail d'un match suivi, dans l'app.
// Hockey, basket, football, soccer : pointage par période, statistiques,
// buts, pénalités, classement ; onglets « Joueurs » (box score) et « Jeux »
// (tous les jeux du match). F1 : classement complet de la séance, pilote
// favori et programme du week-end.
import { fetchMatchDetail, fetchTeamNews, fetchScoreboard, fetchStandings, fetchTeamForm, fetchF1Standings, fetchHockeyLines, demoEvents, sameDriver, qualCuts, intervalText, fetchTyres, tyresOf, TYRES, TYRE_NAMES, fetchF1Extras } from './lib/api.js';
import { LEAGUES_BY_ID, sportOf } from './lib/leagues.js';
import { loadPrefs } from './lib/store.js';
import { crestHtml, bindCrests } from './lib/crest.js';
import { visibleTeamColor, applyTeamAccent, distinctColors } from './lib/color.js';
import { errText, isOffline, OFFLINE_TITLE, OFFLINE_HINT } from './lib/err.js';
import { whenText, untilText, isDate, TIME_FMT, dayText, isDateOnly } from './lib/time.js';
import { MEDALS, esc, ordinal, rank as rankText, formIcons, formTitle } from './lib/format.js';
import { translated, translateAll, autoFr, TRANSLATED_EVENT } from './lib/translate.js';
import { faceHtml, bindFaces } from './lib/face.js';

const REFRESH_LIVE_MS = 20_000;
const REFRESH_IDLE_MS = 300_000;
const DAY_FMT = new Intl.DateTimeFormat('fr-CA', { weekday: 'long' });

const inTauri = () => !!window.__TAURI__;
const params = new URLSearchParams(location.search);
const IS_DEMO = params.has('demo');

const el = {
  main: document.getElementById('main'),
  chip: document.getElementById('chip'),
  title: document.getElementById('headTitle'),
  espn: document.getElementById('btnEspn'),
};

// Match affiché : passé par Rust à l'ouverture (ou dans l'adresse, en aperçu).
let current = window.__MATCH__ ?? { league: params.get('league') ?? 'nhl', event: params.get('event') ?? '' };
let timer = null;
let link = '';
let lastHtml = '';
let prefs = loadPrefs();
const teamForms = new Map(); // idÉquipe -> 5 derniers résultats

// Onglet affiché ('summary', 'box', 'plays'), équipe du box score et nombre
// de jeux montrés : gardés d'un rafraîchissement à l'autre.
const PLAYS_STEP = 40;
let tab = 'summary';
let boxTeam = null;
let playsShown = PLAYS_STEP;
let shown = null; // { g, build } : le match affiché et de quoi le redessiner
let f1Tab = null; // séance de F1 affichée (indice), 'champ' (championnat) ou null (en cours)
let f1Champ = null; // championnat de F1 chargé (ou Error)
const tyreData = new Map(); // séance -> pneus d'OpenF1 (null : rien, 'wait' : en chargement)
const extraData = new Map(); // séance -> le reste d'OpenF1 (arrêts, radio, météo…)
const hockeyLines = new Map(); // idÉquipe -> trios (ou Error), chargés à la demande
const teamNews = new Map(); // idÉquipe -> articles d'ESPN (null : en chargement)


/* ---------- Morceaux communs ---------- */

function statusHtml(g) {
  if (g.state === 'in') {
    const text = [g.session, g.clock, g.statusText].filter(Boolean).join(' · ');
    return `<div class="status status--live"><span class="dot"></span>${esc(text || 'En direct')}</div>`;
  }
  if (g.state === 'pre' && isDate(g.startsAt) && (g.allDay || isDateOnly(g.startsAt))) {
    return `<div class="status">${esc([g.session, dayText(g.startsAt)].filter(Boolean).join(' · '))}</div>`;
  }
  if (g.state === 'pre' && isDate(g.startsAt)) {
    const until = untilText(g.startsAt);
    return `<div class="status">${esc([g.session, whenText(g.startsAt)].filter(Boolean).join(' · '))}</div>
      ${until ? `<div class="countdown" data-start="${g.startsAt.getTime()}">${until}</div>` : ''}`;
  }
  return `<div class="status">${esc([g.session, g.statusText].filter(Boolean).join(' · '))}</div>`;
}

const section = (title, body) => (body ? `<section class="card"><h2>${title}</h2>${body}</section>` : '');

/* ---------- Match entre deux équipes ---------- */

function heroHtml(g) {
  const side = (t, dim) => `
    <div class="side${dim ? ' side--dim' : ''}">
      ${crestHtml(t, 'crest-xl')}
      <div class="side__name">${esc(t.name)}</div>
      ${t.record ? `<div class="side__rec" title="${esc(recordTip(g))}">Fiche ${esc(t.record)}</div>` : ''}
    </div>`;
  const done = g.state === 'post';
  const score = g.state === 'pre'
    ? '<div class="vs">VS</div>'
    : `<div class="score"><span>${esc(g.away.score)}</span><i></i><span>${esc(g.home.score)}</span></div>`;
  const series = g.series
    ? `<div class="series">${esc([g.series.round, g.series.game ? `Match ${g.series.game}` : '', g.series.text].filter(Boolean).join(' · '))}</div>`
    : '';
  return `<section class="hero">
    <div class="hero__row">
      ${side(g.away, done && g.home.winner)}
      <div class="hero__mid">${score}${statusHtml(g)}</div>
      ${side(g.home, done && g.away.winner)}
    </div>${series}${channelsHtml(g)}</section>`;
}

/** Où regarder le match (avant et pendant). */
function channelsHtml(g) {
  if (g.state === 'post' || !g.broadcasts?.length) return '';
  return `<div class="tv" title="Où regarder le match"><span aria-hidden="true">📺</span>${esc(g.broadcasts.join(' · '))}</div>`;
}

const H2H_DAY = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short' });

/** Face-à-face de la saison : bilan, puis chaque rencontre. */
function h2hHtml(g) {
  const h = g.h2h;
  if (!h || (!h.games?.length && !h.text)) return '';
  const rows = (h.games ?? []).map((m) => {
    const cell = (t) => `<b class="${m.winnerId === t.id ? 'h2h__win' : ''}">${esc(t.abbr)} ${m.state === 'pre' ? '' : esc(t.score)}</b>`;
    const now = m.id === String(g.id) ? ' h2h__row--now' : '';
    return `<li class="h2h__row${now}">
      <small>${m.date ? esc(H2H_DAY.format(m.date)) : ''}</small>
      ${cell(m.away)}<span class="h2h__at">@</span>${cell(m.home)}
      <em>${m.state === 'pre' ? 'à venir' : m.id === String(g.id) ? 'ce match' : ''}</em>
    </li>`;
  }).join('');
  return `${h.text ? `<div class="h2h__text">${esc(fr(h.text))}</div>` : ''}${rows ? `<ul class="h2h">${rows}</ul>` : ''}`;
}

/** Articles d'ESPN sur le match, sinon sur ton équipe. */
function newsList(g) {
  if (g.news?.length) return g.news;
  return teamNews.get(String(newsTeam(g)?.id)) ?? [];
}

/** Ton équipe dans ce match, sinon l'équipe locale. */
const newsTeam = (g) => [g.home, g.away].find((t) => t && (prefs.favorites ?? []).includes(`${g.leagueId}:${t.id}`)) ?? g.home;

function newsHtml(g) {
  const list = newsList(g).slice(0, 4);
  if (!list.length) return '';
  return `<ul class="news">${list.map((a) => `
    <li><button class="news__item" type="button" data-href="${esc(a.link)}">
      ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" data-face />` : ''}
      <span><b>${esc(fr(a.title))}</b>${a.text ? `<small>${esc(fr(a.text))}</small>` : ''}
      ${isDate(a.date) ? `<em>${esc(dayText(a.date))}</em>` : ''}</span>
    </button></li>`).join('')}</ul>`;
}

/** Pas d'article sur le match : ceux de l'équipe, chargés une fois. */
async function loadTeamNews(g) {
  if (g.news?.length || IS_DEMO) return;
  const id = String(newsTeam(g)?.id ?? '');
  if (!id || teamNews.has(id)) return;
  teamNews.set(id, null);
  try {
    teamNews.set(id, await fetchTeamNews(g.leagueId, id));
  } catch {
    teamNews.set(id, []);
  }
  if (teamNews.get(id).length && shown?.g === g) repaint();
}

function periodsHtml(g) {
  const n = Math.max(g.away.periods?.length ?? 0, g.home.periods?.length ?? 0);
  if (!n) return '';
  const head = Array.from({ length: n }, (_, i) => {
    if (g.leagueId !== 'nhl' || i < 3) return `<th>${i + 1}</th>`;
    return `<th>${g.playoffs ? `P${i - 2}` : i === 3 ? 'Prol.' : 'TB'}</th>`;
  }).join('');
  const row = (t) => `<tr><td class="t">${crestHtml(t, 'crest-xs')}${esc(t.abbr)}</td>${
    Array.from({ length: n }, (_, i) => `<td>${esc(t.periods?.[i] ?? '')}</td>`).join('')}<td class="tot">${esc(t.score)}</td></tr>`;
  return `<table class="periods"><thead><tr><th></th>${head}<th>T</th></tr></thead>
    <tbody>${row(g.away)}${row(g.home)}</tbody></table>`;
}

/** Barres face à face : la part de chaque équipe pour chaque statistique. */
function statsHtml(g) {
  if (!g.stats?.length) return '';
  const [colorA, colorH] = distinctColors(g.away, g.home);
  return g.stats.map((s) => {
    const a = parseFloat(String(s.away).replace(',', '.')) || 0;
    const h = parseFloat(String(s.home).replace(',', '.')) || 0;
    const share = a + h > 0 ? (a / (a + h)) * 100 : 50;
    return `<div class="stat">
      <div class="stat__vals"><b>${esc(s.away)}</b><span>${esc(s.label)}</span><b>${esc(s.home)}</b></div>
      <div class="stat__bar"><i style="width:${share}%;background:${colorA}"></i><i style="width:${100 - share}%;background:${colorH}"></i></div>
    </div>`;
  }).join('');
}

function periodLabel(g, p) {
  if (!p) return '';
  const sport = sportOf(g.leagueId);
  if (sport === 'baseball') return `${ordinal(p)} manche`;
  if (sport === 'basketball' || sport === 'football') return p <= 4 ? `${rankText(p)} quart` : 'Prol.';
  if (sport === 'soccer') return p <= 2 ? `${ordinal(p)} demie` : 'Prol.';
  if (g.leagueId !== 'nhl' || p <= 3) return `${ordinal(p)} pér.`;
  return g.playoffs ? `${ordinal(p - 3)} prol.` : p === 4 ? 'Prol.' : 'TB';
}

/** « Pointage par manche / quart / demie / période ». */
function periodsTitle(g) {
  return { baseball: 'Pointage par manche', basketball: 'Pointage par quart', football: 'Pointage par quart',
    soccer: 'Pointage par demie' }[sportOf(g.leagueId)] ?? 'Pointage par période';
}

/** Texte d'ESPN en français, si la traduction est activée et déjà faite. */
const fr = (text) => (prefs.translate === false ? text : translated(text));

/** Un même jeu en double chez ESPN (même moment, même texte) : une seule fois. */
function uniquePlays(plays) {
  const seen = new Set();
  return (plays ?? []).filter((p) => {
    const key = `${p.period}|${p.clock}|${p.who}|${p.text}`;
    return seen.has(key) ? false : seen.add(key);
  });
}

/** Un de tes joueurs favoris ? */
const isStar = (name) => !!name && (prefs.favPlayers ?? []).some((f) => sameDriver(f, { name }));

function playsHtml(g, plays, withAssists) {
  const list = uniquePlays(plays);
  if (!list.length) return '';
  const team = (id) => (String(g.home.id) === id ? g.home : g.away);
  // Au baseball, ESPN ne nomme pas de « buteur » : la description du jeu suffit.
  const clockOf = (p) => (sportOf(g.leagueId) === 'baseball' ? '' : p.clock);
  return `<ul class="plays">${list.map((p) => `
    <li>
      ${crestHtml(team(p.teamId), 'crest-xs')}
      <span class="plays__when">${esc([periodLabel(g, p.period), clockOf(p)].filter(Boolean).join(' · '))}</span>
      <span class="plays__who">
        ${p.who ? `<b>${isStar(p.who) ? '⭐ ' : ''}${esc(p.who)}</b>` : `<span class="plays__text">${esc(fr(p.text))}</span>`}
        ${withAssists && p.assists.length ? `<small>Passes : ${esc(p.assists.join(', '))}</small>` : ''}
        ${!withAssists && p.who && p.text ? `<small>${esc(fr(p.text))}</small>` : ''}
      </span>
    </li>`).join('')}</ul>`;
}

/** Jeux visibles dans l'onglet « Jeux » : les plus récents d'abord. */
const visiblePlays = (g) => [...(g?.allPlays ?? [])].reverse().slice(0, playsShown);

/** Textes libres d'ESPN affichés dans la fenêtre : ceux à traduire. */
function textsOf(g) {
  if (tab === 'plays') return visiblePlays(g).map((p) => p.text).filter(Boolean);
  return [...(g?.goals ?? []), ...(g?.penalties ?? [])].map((p) => p.text)
    .concat((g?.videos ?? []).map((v) => v.title))
    .concat(newsList(g ?? {}).flatMap((a) => [a.title, a.text]))
    .concat(g?.h2h?.text ? [g.h2h.text] : [])
    .filter(Boolean);
}

function standingsHtml(g, table) {
  const line = (t) => {
    const s = table.get(String(t.id));
    if (!s && !t.record) return '';
    const parts = [s ? `${rankText(s.rank)} · ${s.group}` : '', s?.points ? `${s.points} pts` : '', t.record].filter(Boolean);
    const form = teamForms.get(String(t.id));
    const formHtml = form?.length
      ? `<small class="form" title="${esc(formTitle(form))}">${formIcons(form)}</small>`
      : '';
    return `<div class="rank">${crestHtml(t, 'crest-xs')}<b>${esc(t.name)}</b>${formHtml}<span>${esc(parts.join(' · '))}</span></div>`;
  };
  return line(g.away) + line(g.home);
}

/** Barre des chances de victoire, aux couleurs des deux équipes. */
function winProbHtml(g) {
  const p = g.winProb;
  const graph = winGraphHtml(g);
  if (!p) return graph;
  const [colorA, colorH] = distinctColors(g.away, g.home);
  const total = p.away + p.home || 1;
  return `<div class="prob">
    <div class="prob__vals"><b>${esc(g.away.abbr)} ${p.away} %</b><span>${p.live ? 'en direct' : 'avant le match'}</span><b>${p.home} % ${esc(g.home.abbr)}</b></div>
    <div class="stat__bar"><i style="width:${(p.away / total) * 100}%;background:${colorA}"></i><i style="width:${(p.home / total) * 100}%;background:${colorH}"></i></div>
  </div>${graph}`;
}

/**
 * Le match en une courbe : au-dessus du milieu, les locaux sont favoris ;
 * en dessous, les visiteurs. Chaque moitié à la couleur de son équipe.
 */
function winGraphHtml(g) {
  const pts = g.winTimeline ?? [];
  if (pts.length < 3) return '';
  const [colorA, colorH] = distinctColors(g.away, g.home);
  const W = 300;
  const H = 90;
  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => H - (v / 100) * H;
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${W} ${H / 2} L0 ${H / 2} Z`;
  const id = `wg${String(g.id ?? '').replace(/\W/g, '')}`;
  return `<div class="wg">
    <div class="wg__labels"><span>${esc(g.home.abbr)}</span><span>${esc(g.away.abbr)}</span></div>
    <svg class="wg__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Chances de victoire pendant le match">
      <defs>
        <clipPath id="${id}t"><rect x="0" y="0" width="${W}" height="${H / 2}" /></clipPath>
        <clipPath id="${id}b"><rect x="0" y="${H / 2}" width="${W}" height="${H / 2}" /></clipPath>
      </defs>
      <path d="${area}" fill="${colorH}" opacity="0.3" clip-path="url(#${id}t)" />
      <path d="${area}" fill="${colorA}" opacity="0.3" clip-path="url(#${id}b)" />
      <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="wg__mid" />
      <path d="${line}" fill="none" stroke="${colorH}" stroke-width="2" clip-path="url(#${id}t)" vector-effect="non-scaling-stroke" />
      <path d="${line}" fill="none" stroke="${colorA}" stroke-width="2" clip-path="url(#${id}b)" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="wg__foot"><span>Début</span><span>${g.state === 'post' ? 'Fin' : 'Maintenant'}</span></div>
  </div>`;
}

const personFace = (x, cls = 'face') => faceHtml(x, cls);

/** Les 3 étoiles du match (hockey). */
function starsHtml(g) {
  if (!g.stars?.length) return '';
  const team = (id) => (String(g.home.id) === id ? g.home : String(g.away.id) === id ? g.away : null);
  return `<div class="stars">${g.stars.map((s) => `
    <div class="star">
      <div class="star__rank">${'⭐'.repeat(4 - s.rank)}</div>
      ${personFace(s, 'face face--lg')}
      <b>${isStar(s.name) ? '⭐ ' : ''}${esc(s.name)}</b>
      <small>${team(s.teamId) ? esc(team(s.teamId).abbr) : ''}${s.line ? ` · ${esc(s.line)}` : ''}</small>
    </div>`).join('')}</div>`;
}

/** Meneurs du match, face à face : le meilleur de chaque équipe par catégorie. */
function leadersHtml(g) {
  if (!g.leaders?.length) return '';
  const side = (x, right) => (x
    ? `<div class="lead__p${right ? ' lead__p--r' : ''}">${right ? '' : personFace(x)}<span><b>${esc(x.name)}</b><small>${esc(x.value)}</small></span>${right ? personFace(x) : ''}</div>`
    : '<div class="lead__p"></div>');
  return g.leaders.map((l) => `<div class="lead">
    ${side(l.away, false)}<span class="lead__label">${esc(l.label)}</span>${side(l.home, true)}
  </div>`).join('');
}

/** Faits saillants vidéo : un clic ouvre la vidéo sur ESPN. */
function videosHtml(g) {
  if (!g.videos?.length) return '';
  return `<div class="videos">${g.videos.map((v) => `
    <button class="video" type="button" data-href="${esc(v.href)}">
      ${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy" data-face />` : '<span class="video__ph"></span>'}
      <span class="video__play">▶</span>
      <span class="video__title">${esc(fr(v.title))}</span>
    </button>`).join('')}</div>`;
}

/* ---------- Onglets : Résumé, Joueurs, Jeux ---------- */

/** Onglet « Alignement » : trios au hockey, ordre des frappeurs au baseball. */
const hasLineup = (g) => (sportOf(g.leagueId) === 'hockey' && g.leagueId === 'nhl')
  || (sportOf(g.leagueId) === 'baseball' && (g.box?.length || Object.keys(g.probables ?? {}).length));

function tabsHtml(g) {
  const tabs = [['summary', 'Résumé'], hasLineup(g) ? ['lineup', 'Alignement'] : null,
    g.box?.length ? ['box', 'Joueurs'] : null, g.allPlays?.length ? ['plays', 'Jeux'] : null]
    .filter(Boolean);
  if (tabs.length < 2) return '';
  return `<nav class="tabs">${tabs.map(([id, label]) => `
    <button type="button" class="tab${tab === id ? ' tab--on' : ''}" data-tab="${id}">${label}</button>`).join('')}</nav>`;
}

/** Choix de l'équipe (ton équipe d'abord, sinon les visiteurs). */
function sideTeam(g, ids) {
  const favs = prefs.favorites ?? [];
  return [g.away, g.home].find((t) => String(t.id) === boxTeam && ids.includes(String(t.id)))
    ?? [g.away, g.home].find((t) => favs.includes(`${g.leagueId}:${t.id}`) && ids.includes(String(t.id)))
    ?? [g.away, g.home].find((t) => ids.includes(String(t.id))) ?? g.away;
}

function teamSwitch(g, pick) {
  return `<div class="teamseg">${[g.away, g.home].map((t) => `
    <button type="button" data-box-team="${esc(t.id)}" class="${String(t.id) === String(pick.id) ? 'teamseg--on' : ''}">${crestHtml(t, 'crest-xs')}${esc(t.name)}</button>`).join('')}</div>`;
}

const personLine = (p, extra = '') => `<li class="lu__p">${faceHtml(p ?? { name: '?' }, 'face')}
  <span class="drv"><b>${isStar(p?.name) ? '⭐ ' : ''}${esc(p?.name ?? '—')}</b>${extra ? `<small>${esc(extra)}</small>` : ''}</span></li>`;

/** Stats d'un lanceur dans le box score : « 6.0 ML · 3 CS · 1 PM · 2 BB · 8 RB · 94 lancers ». */
function pitchingLine(p, cols) {
  const stat = (label) => {
    const i = cols.findIndex((c) => c.label === label);
    return i === -1 ? '' : String(p.stats?.[i] ?? '').trim();
  };
  const pitches = (stat('LAN-PR') || stat('LAN')).split('-')[0];
  return [
    stat('ML') && `${stat('ML')} ML`,
    stat('CS') && `${stat('CS')} CS`,
    stat('PM') && `${stat('PM')} PM`,
    stat('BB') && `${stat('BB')} BB`,
    stat('RB') && `${stat('RB')} RB`,
    pitches && `${pitches} lancers`,
    stat('MPM') && `MPM ${stat('MPM')}`,
  ].filter(Boolean).join(' · ');
}

/** Petit losange des buts occupés (1re, 2e, 3e). */
function basesSvg(bases = []) {
  const cell = (on, x, y) => `<rect x="${x}" y="${y}" width="7" height="7" transform="rotate(45 ${x + 3.5} ${y + 3.5})"${on ? ' class="on"' : ''}/>`;
  return `<svg class="bases" viewBox="0 0 28 20" aria-hidden="true">${cell(bases[1], 10.5, 1)}${cell(bases[2], 3, 9)}${cell(bases[0], 18, 9)}</svg>`;
}

/**
 * Baseball : en direct, le lanceur au monticule et le frappeur (stats du
 * match, compte, retraits, buts occupés) ; avant le match, les partants
 * annoncés et leur fiche de la saison.
 */
function moundHtml(g) {
  if (sportOf(g.leagueId) !== 'baseball') return '';
  const sit = g.situation;
  if (g.state === 'in' && sit && (sit.pitcher || sit.batter)) {
    const team = (p) => [g.away, g.home].find((t) => String(t.id) === String(p?.teamId))?.abbr ?? '';
    const rows = [
      sit.pitcher && personLine(sit.pitcher, ['Lanceur', team(sit.pitcher), sit.pitcher.line].filter(Boolean).join(' · ')),
      sit.batter && personLine(sit.batter, ['Au bâton', team(sit.batter), sit.batter.line].filter(Boolean).join(' · ')),
    ].filter(Boolean).join('');
    const count = `<div class="mound__count"><span>Balles <b>${sit.balls}</b></span><span>Prises <b>${sit.strikes}</b></span>
      <span>Retraits <b>${sit.outs}</b></span>${basesSvg(sit.bases)}</div>`;
    return `<ul class="lu__list">${rows}</ul>${count}`;
  }
  if (g.state === 'pre') {
    const rows = [g.away, g.home]
      .map((t) => {
        const p = g.probables?.[String(t.id)];
        return p ? personLine(p, [t.abbr, p.line].filter(Boolean).join(' · ')) : '';
      })
      .join('');
    return rows ? `<ul class="lu__list">${rows}</ul>` : '';
  }
  return '';
}

/** Ce que veut dire la fiche, selon le sport (infobulle). */
function recordTip(g) {
  const sport = sportOf(g.leagueId);
  if (sport === 'hockey') return 'Victoires – défaites – défaites en prolongation, cette saison';
  if (sport === 'soccer') return 'Victoires – nuls – défaites, cette saison';
  return 'Victoires – défaites, cette saison';
}

/** Blessés des deux équipes : nom, position, statut, blessure, retour prévu. */
function injuriesHtml(g) {
  const list = g.injuries ?? [];
  if (!list.length) return '';
  const DAY = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short' });
  return [g.away, g.home].map((t) => {
    const team = list.find((x) => x.teamId === String(t.id));
    if (!team) return '';
    const rows = team.players.map((p) => personLine(p, [p.pos, p.status, p.what, p.back ? `retour vers le ${DAY.format(p.back)}` : ''].filter(Boolean).join(' · '))).join('');
    return `<div class="inj__team">${crestHtml(t, 'crest-xs')}<b>${esc(t.name)}</b></div><ul class="lu__list">${rows}</ul>`;
  }).join('');
}

/**
 * Hockey : chaque tir sur une patinoire vue de haut. Chaque équipe attaque
 * toujours du même côté (visiteurs à gauche, locaux à droite), même si les
 * équipes changent de côté à chaque période.
 */
function shotMapHtml(g) {
  const shots = g.shots ?? [];
  if (shots.length < 3) return '';
  const [colorA, colorH] = distinctColors(g.away, g.home);
  const home = String(g.home.id);
  const mark = (s) => {
    const isHome = s.teamId === home;
    // Locaux : vers la droite (x > 0). Visiteurs : vers la gauche.
    const x = 100 + (isHome ? Math.abs(s.x) : -Math.abs(s.x));
    const y = 42.5 - s.y * (isHome === s.x > 0 ? 1 : -1);
    const c = isHome ? colorH : colorA;
    const tip = esc([s.who, s.kind === 'goal' ? 'But' : s.kind === 'shot' ? 'Tir au but' : s.kind === 'miss' ? 'Tir raté' : 'Tir bloqué', s.period ? `${s.period}e pér.` : ''].filter(Boolean).join(' · '));
    if (s.kind === 'goal') return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${c}" stroke="#fff" stroke-width="0.8"><title>${tip}</title></circle>`;
    if (s.kind === 'shot') return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.9" fill="none" stroke="${c}" stroke-width="0.9"><title>${tip}</title></circle>`;
    return `<path d="M${(x - 1.4).toFixed(1)} ${(y - 1.4).toFixed(1)}l2.8 2.8m0 -2.8l-2.8 2.8" stroke="${c}" stroke-width="0.7" opacity="0.6"><title>${tip}</title></path>`;
  };
  const count = (id, kinds) => shots.filter((s) => s.teamId === String(id) && kinds.includes(s.kind)).length;
  const rink = `<rect x="0.5" y="0.5" width="199" height="84" rx="28" class="rink__ice" />
    <line x1="100" y1="0" x2="100" y2="85" class="rink__red" /><line x1="75" y1="0" x2="75" y2="85" class="rink__blue" /><line x1="125" y1="0" x2="125" y2="85" class="rink__blue" />
    <line x1="11" y1="4" x2="11" y2="81" class="rink__red" /><line x1="189" y1="4" x2="189" y2="81" class="rink__red" />
    <circle cx="100" cy="42.5" r="15" class="rink__line" />
    <path d="M11 38.5 a4 4 0 0 1 0 8" class="rink__crease" /><path d="M189 38.5 a4 4 0 0 0 0 8" class="rink__crease" />`;
  return `<svg class="rink" viewBox="0 0 200 85" aria-label="Carte des tirs">${rink}${shots.map(mark).join('')}</svg>
    <div class="rink__legend">
      <span><i style="background:${colorA}"></i>${esc(g.away.abbr)} ← ${count(g.away.id, ['goal'])} B · ${count(g.away.id, ['goal', 'shot'])} TB</span>
      <span>${count(g.home.id, ['goal'])} B · ${count(g.home.id, ['goal', 'shot'])} TB → ${esc(g.home.abbr)}<i style="background:${colorH}"></i></span>
    </div>
    <div class="rink__key">● but · ○ tir au but · × raté ou bloqué — B : buts, TB : tirs au but</div>`;
}

/** Tirs de barrage : chaque tireur, dans l'ordre, ✅ ou ❌, et le compte. */
function shootoutHtml(g) {
  const list = g.shootout ?? [];
  if (!list.length) return '';
  const tally = (t) => list.filter((x) => x.teamId === String(t.id) && x.goal).length;
  const rows = list.map((x, i) => {
    const team = x.teamId === String(g.home.id) ? g.home : g.away;
    return `<li class="so__row"><span class="so__n">${Math.floor(i / 2) + 1}</span>${crestHtml(team, 'crest-xs')}
      <span class="so__who">${esc(x.who || team.abbr)}</span><span class="so__res">${x.goal ? '✅ But' : '❌ Arrêté'}</span></li>`;
  }).join('');
  return `<div class="so__tally">${esc(g.away.abbr)} <b>${tally(g.away)}</b> – <b>${tally(g.home)}</b> ${esc(g.home.abbr)}</div><ul class="so__list">${rows}</ul>`;
}

function lineupHtml(g) {
  const pick = sideTeam(g, [String(g.away.id), String(g.home.id)]);
  const id = String(pick.id);
  if (sportOf(g.leagueId) === 'hockey') {
    const lines = hockeyLines.get(id);
    if (!lines) { loadLines(id, g.state !== 'pre' ? g.id : ''); return teamSwitch(g, pick) + '<div class="state">Chargement des trios…</div>'; }
    if (lines instanceof Error || (!lines.forwards.length && !lines.defense.length)) {
      return teamSwitch(g, pick) + '<div class="state">ESPN ne donne pas les trios de cette équipe pour le moment.</div>';
    }
    const block = (title, rows, labels) => rows.map((r, i) => `
      <div class="lu__line"><span class="lu__n">${title(i)}</span>
        ${r.map((p, k) => `<span class="lu__slot"><small>${labels[k] ?? ''}</small>${faceHtml(p ?? { name: '?' }, 'face')}<b>${isStar(p?.name) ? '⭐ ' : ''}${esc(p ? (p.short || p.name) : '—')}</b></span>`).join('')}
      </div>`).join('');
    return teamSwitch(g, pick)
      + section('Trios', block((i) => `${i + 1}${i ? 'e' : 'er'}`, lines.forwards, ['AG', 'C', 'AD']))
      + section('Paires de défense', block((i) => `${i + 1}re`.replace('2re', '2e').replace('3re', '3e'), lines.defense, ['D', 'D']))
      + section('Gardiens', lines.goalies.length ? `<ul class="lu__list">${lines.goalies.map((p, i) => personLine(p, goalieLabel(lines, p, i))).join('')}</ul>` : '')
      + `<p class="hint">${linesSource(lines)}</p>`;
  }
  // Baseball : ordre des frappeurs et lanceurs.
  const team = (g.box ?? []).find((t) => t.teamId === id);
  const batting = team?.groups.find((x) => /frappeur/i.test(x.name));
  const pitching = team?.groups.find((x) => /lanceur/i.test(x.name));
  const prob = g.probables?.[id];
  let html = teamSwitch(g, pick);
  if (prob && !batting) html += section('Lanceur partant probable', `<ul class="lu__list">${personLine(prob, prob.line)}</ul>`);
  if (batting) {
    let n = 0;
    const rows = batting.players.map((p) => {
      if (p.starter !== false || !n) n += 1;
      const sub = p.starter === false && n > 0;
      return `<li class="lu__bat${sub ? ' lu__bat--sub' : ''}"><span class="lu__n">${sub ? '↳' : p.order ?? n}</span>
        <span class="drv"><b>${isStar(p.name) ? '⭐ ' : ''}${esc(p.name)}</b></span><span class="lu__pos">${esc(p.pos)}</span></li>`;
    }).join('');
    html += section('Ordre des frappeurs', `<ol class="lu__list">${rows}</ol>`);
  }
  if (pitching?.players.length) {
    html += section('Lanceurs', `<ul class="lu__list">${pitching.players.map((p, i) => personLine(p, [i ? 'Releveur' : 'Partant', pitchingLine(p, pitching.cols)].filter(Boolean).join(' · '))).join('')}</ul>`);
  }
  return html;
}

/** D'où viennent les trios affichés. */
function linesSource(lines) {
  if (lines.source === 'game' && lines.current) return 'Trios de ce match, d\'après le temps de glace de chaque joueur.';
  if (lines.source === 'game') {
    const when = lines.date ? new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long' }).format(new Date(lines.date)) : '';
    return `Trios estimés d'après le temps de glace du dernier match${when ? ` (${when}${lines.opp ? ` contre ${esc(lines.opp)}` : ''})` : ''}. L'entraîneur peut les changer.`;
  }
  return 'Selon la grille de profondeur d\'ESPN, vérifiée avec l\'effectif actuel. L\'entraîneur peut changer ses trios pendant le match.';
}

function goalieLabel(lines, p, i) {
  if (lines.source === 'game') return p.played ? (lines.current ? 'Devant le filet ce match' : 'A joué le dernier match') : 'Auxiliaire';
  return i ? 'Auxiliaire' : 'Partant probable';
}

async function loadLines(teamId, eventId = '') {
  if (hockeyLines.has(teamId)) return;
  hockeyLines.set(teamId, null);
  // Appelée pendant un dessin : on laisse d'abord ce dessin se terminer.
  await Promise.resolve();
  try {
    hockeyLines.set(teamId, IS_DEMO ? demoLines() : await fetchHockeyLines(teamId, { eventId }));
  } catch (err) {
    hockeyLines.set(teamId, err instanceof Error ? err : new Error(String(err)));
  }
  repaint();
}

function demoLines() {
  const P = (name) => ({ name, short: name.replace(/^(\w)\w+ /, '$1. '), photo: '' });
  return {
    forwards: [['Juraj Slafkovsky', 'Nick Suzuki', 'Cole Caufield'], ['Ivan Demidov', 'Kirby Dach', 'Patrik Laine'],
      ['Alex Newhook', 'Jake Evans', 'Josh Anderson'], ['Brendan Gallagher', 'Christian Dvorak', 'Joel Armia']].map((l) => l.map(P)),
    defense: [['Lane Hutson', 'Mike Matheson'], ['Kaiden Guhle', 'Noah Dobson'], ['Arber Xhekaj', 'Alexandre Carrier']].map((l) => l.map(P)),
    goalies: [P('Samuel Montembeault'), P('Jakub Dobes')],
  };
}

/** Box score : les stats de chaque joueur d'une équipe, groupe par groupe. */
function boxHtml(g) {
  const teams = g.box ?? [];
  // Ton équipe d'abord, sinon l'équipe visiteuse.
  const pick = teams.find((t) => t.teamId === boxTeam)
    ?? teams.find((t) => (prefs.favorites ?? []).includes(`${g.leagueId}:${t.teamId}`))
    ?? teams.find((t) => t.teamId === String(g.away.id)) ?? teams[0];
  const sides = [g.away, g.home].filter((t) => teams.some((x) => x.teamId === String(t.id)));
  const switcher = `<div class="teamseg">${sides.map((t) => `
    <button type="button" data-box-team="${esc(t.id)}" class="${String(t.id) === pick.teamId ? 'teamseg--on' : ''}">${crestHtml(t, 'crest-xs')}${esc(t.name)}</button>`).join('')}</div>`;
  const groups = pick.groups.map((grp) => `<section class="card">
    ${grp.name ? `<h2>${esc(grp.name)}</h2>` : ''}
    <div class="box__scroll"><table class="box">
      <thead><tr><th class="box__name">Joueur</th>${grp.cols.map((c) => `<th title="${esc(autoFr(c.tip))}">${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${grp.players.map((p) => {
        const star = isStar(p.name);
        return `<tr class="${star ? 'box--fav' : ''}">
          <td class="box__name">${p.jersey ? `<small>${esc(p.jersey)}</small>` : ''}<b>${star ? '⭐ ' : ''}${esc(p.short || p.name)}</b>${p.pos ? `<i>${esc(p.pos)}</i>` : ''}</td>
          ${p.stats.map((v) => `<td>${esc(v)}</td>`).join('')}
        </tr>`;
      }).join('')}</tbody>
    </table></div></section>`).join('');
  return `${switcher}${groups}<p class="hint">Survole une colonne pour voir ce qu'elle veut dire.</p>`;
}

/** Nom complet d'une période, pour les intertitres de l'onglet « Jeux ». */
function periodName(g, p) {
  if (!p.period) return '';
  const sport = sportOf(g.leagueId);
  if (sport === 'baseball') {
    const half = /top/i.test(p.half) ? 'Haut' : /bot/i.test(p.half) ? 'Bas' : '';
    return half ? `${half} de la ${ordinal(p.period)} manche` : `${ordinal(p.period)} manche`;
  }
  if (sport === 'hockey' && (g.leagueId !== 'nhl' || p.period <= 3)) return `${ordinal(p.period)} période`;
  if (sport === 'basketball' || sport === 'football') return p.period <= 4 ? `${rankText(p.period)} quart` : 'Prolongation';
  if (sport === 'soccer') return p.period <= 2 ? `${ordinal(p.period)} demie` : 'Prolongation';
  return periodLabel(g, p.period);
}

/** Tous les jeux du match, les plus récents en haut, par période. */
function allPlaysHtml(g) {
  const total = g.allPlays?.length ?? 0;
  const team = (id) => (String(g.home.id) === id ? g.home : String(g.away.id) === id ? g.away : null);
  let section = null;
  const rows = visiblePlays(g).map((p) => {
    const key = `${p.period}|${p.half ?? ''}`;
    const head = p.period && key !== section ? `<li class="pl__period">${esc(periodName(g, p))}</li>` : '';
    section = key;
    const t = team(p.teamId);
    const score = p.scoring && p.away != null && p.home != null
      ? `<span class="pl__score">${esc(g.away.abbr)} ${esc(p.away)} – ${esc(p.home)} ${esc(g.home.abbr)}</span>` : '';
    return `${head}<li class="pl${p.scoring ? ' pl--score' : ''}">
      <span class="pl__clock">${esc(p.clock)}</span>
      ${t ? crestHtml(t, 'crest-xs') : '<span class="pl__nocrest"></span>'}
      <span class="pl__text">${esc(fr(p.text))}${score}</span>
    </li>`;
  }).join('');
  const left = total - Math.min(total, playsShown);
  const more = left > 0
    ? `<button class="ghost pl__more" type="button" data-more-plays>Voir ${Math.min(PLAYS_STEP, left)} jeux de plus</button>` : '';
  return section === null ? '' : `<section class="card"><h2>Tous les jeux · ${total}</h2><ul class="pl-list">${rows}</ul>${more}</section>`;
}

function matchHtml(g, table) {
  if (tab === 'box' && !g.box?.length) tab = 'summary';
  if (tab === 'lineup' && !hasLineup(g)) tab = 'summary';
  if (tab === 'plays' && !g.allPlays?.length) tab = 'summary';
  const head = heroHtml(g) + tabsHtml(g);
  if (tab === 'box') return head + boxHtml(g);
  if (tab === 'lineup') return head + lineupHtml(g);
  if (tab === 'plays') return head + allPlaysHtml(g);
  const goalsTitle = ['hockey', 'soccer'].includes(sportOf(g.leagueId)) ? 'Buts' : 'Jeux marquants';
  return head
    + section(g.state === 'pre' ? 'Lanceurs partants' : 'Au monticule', moundHtml(g))
    + section('Chances de victoire', winProbHtml(g))
    + section('Faits saillants', videosHtml(g))
    + section('Les 3 étoiles', starsHtml(g))
    + section('Meneurs du match', leadersHtml(g))
    + section(periodsTitle(g), periodsHtml(g))
    + section(goalsTitle, playsHtml(g, g.goals, true))
    + section('Tirs de barrage', shootoutHtml(g))
    + section('Carte des tirs', shotMapHtml(g))
    + section('Statistiques', statsHtml(g))
    + (g.leagueId === 'nhl' ? section('Pénalités', playsHtml(g, g.penalties, false)) : '')
    + section('Blessés', injuriesHtml(g))
    + section('Face-à-face cette saison', h2hHtml(g))
    + section('Classement', standingsHtml(g, table))
    + section('Nouvelles', newsHtml(g))
    + (g.venue ? `<div class="venue">${esc(g.venue)}</div>` : '');
}

/* ---------- F1 ---------- */

function f1Html(g) {
  const favs = prefs.favDrivers ?? [];
  const league = LEAGUES_BY_ID.f1;

  const hero = `<section class="hero hero--f1">
    <img class="f1logo" src="${league.logo}" alt="F1" />
    <div class="hero__title">${esc(g.title)}</div>
    ${statusHtml(g)}
  </section>`;

  // Une carte par pilote favori, dans l'ordre de la séance.
  const cards = favs
    .map((fav) => ({ fav, mine: (g.results ?? []).find((d) => sameDriver(d, fav)) ?? null }))
    .sort((x, y) => (x.mine?.pos ?? 99) - (y.mine?.pos ?? 99))
    .map(({ fav, mine }) => `<section class="card favdriver">
      ${fav.photo ? `<img class="face face--xl" src="${esc(fav.photo)}" alt="" data-face />` : ''}
      <div class="favdriver__txt">
        <small>${favs.length > 1 ? 'Un de tes pilotes' : 'Ton pilote'}</small>
        <b>${esc(fav.name)}</b>
        <span>${mine ? `${MEDALS[mine.pos] ?? ''} ${rankText(mine.pos)} · ${esc(g.session)}` : g.state === 'pre' ? 'La séance n\'a pas commencé' : 'Pas encore classé'}</span>
      </div>
    </section>`);
  const favCard = cards.join('');

  // Séance choisie : celle d'un bouton, sinon la séance en cours (ou la prochaine).
  const sessions = g.sessions ?? [];
  const current = sessions.findIndex((x) => x.label === g.session);
  const pick = f1Tab === 'champ' ? null : sessions[f1Tab ?? current] ?? null;
  const results = pick ? (pick.label === g.session && g.results?.length ? g.results : pick.results ?? []) : [];
  const tabs = sessions.length ? `<nav class="tabs tabs--wrap">${sessions.map((x, i) => `
    <button type="button" class="tab${f1Tab !== 'champ' && (f1Tab ?? current) === i ? ' tab--on' : ''}" data-f1="${i}">${esc(x.label)}${x.state === 'in' ? ' <span class="dot"></span>' : ''}</button>`).join('')}
    <button type="button" class="tab${f1Tab === 'champ' ? ' tab--on' : ''}" data-f1="champ">Championnat</button></nav>` : '';
  if (f1Tab === 'champ') return hero + favCard + tabs + f1ChampHtml();

  // Qualifications : qui est éliminé (ou menacé) en Q1 et en Q2.
  const phase = pick?.qual ? (pick.label === g.session ? g.phase : pick.phase) ?? (pick.state === 'post' ? 3 : 1) : null;
  const cuts = qualCuts(results.length);
  const qualTag = (d) => {
    if (!pick?.qual) return '';
    const done = pick.state === 'post';
    if (d.pos > cuts.q2 && (done || phase >= 2)) return '<span class="qtag qtag--out">Éliminé en Q1</span>';
    if (d.pos > cuts.q3 && d.pos <= cuts.q2 && (done || phase >= 3)) return '<span class="qtag qtag--out">Éliminé en Q2</span>';
    if (!done && ((phase === 1 && d.pos > cuts.q2) || (phase === 2 && d.pos > cuts.q3))) return '<span class="qtag qtag--risk">Zone d\'élimination</span>';
    return '';
  };
  // Pneus (OpenF1) : chargés à part, la liste se redessine à leur arrivée.
  const tyres = pick && pick.state !== 'pre' ? tyreData.get(pick.label) : null;
  if (pick && pick.state !== 'pre' && !tyreData.has(pick.label)) loadTyres(pick);
  const tyreHtml = (d) => {
    const stints = tyres && tyres !== 'wait' ? tyresOf(tyres, d) : [];
    if (!stints.length) return '';
    const now = stints[stints.length - 1];
    const tip = stints.map((x) => `${TYRE_NAMES[x.compound]}${x.from ? ` (tours ${x.from}–${x.to ?? '…'})` : ''}`).join(' → ');
    return `<span class="tyre tyre--${now.compound.toLowerCase()}" title="${esc(tip)}">${TYRES[now.compound]}</span>`;
  };
  const rows = results.map((d, i) => {
    const isFav = favs.some((f) => sameDriver(d, f));
    const q = pick?.qual && d.q?.length ? d.q.map((t, k) => (t ? `Q${k + 1} ${t}` : '')).filter(Boolean).join(' · ') : '';
    // Course et essais : écart avec le premier, et avec le pilote juste devant.
    const gap = d.pos > 1 && d.gap ? esc(String(d.gap).startsWith('+') ? d.gap : `+${d.gap}`) : '';
    const interval = !pick?.qual && i > 1 ? intervalText(results, i) : '';
    const gaps = gap ? `<span class="gap">${gap}${interval ? `<small title="Écart avec le pilote devant">devant ${esc(interval)}</small>` : ''}</span>` : tyreHtml(d) ? '<span class="gap"></span>' : '';
    return `<li class="${isFav ? 'fav' : ''}${qualTag(d).includes('--out') ? ' out' : ''}">
      <span class="pos">${MEDALS[d.pos] ?? d.pos}</span>
      ${faceHtml(d, 'face')}
      <span class="drv"><b>${esc(d.name)}</b>${d.team || q ? `<small>${esc([d.team, q].filter(Boolean).join(' · '))}</small>` : ''}${qualTag(d)}</span>
      ${tyreHtml(d)}${gaps}
    </li>`;
  }).join('');
  const board = rows ? `<ol class="grid">${rows}</ol>` : '';

  const now = Date.now();
  const program = sessions.map((s) => {
    const cls = s.state === 'in' ? 'live' : s.state === 'post' ? 'done' : '';
    const when = `${DAY_FMT.format(s.startsAt)} · ${TIME_FMT.format(s.startsAt)}`;
    const extra = s.state === 'in' ? '<span class="live">En direct</span>'
      : s.state === 'post' ? '<span>Terminée</span>'
      : s.startsAt.getTime() > now ? `<span class="until" data-start="${s.startsAt.getTime()}">${untilText(s.startsAt)}</span>` : '';
    return `<li class="${cls}"><b>${esc(s.label)}</b><span>${esc(when)}</span>${extra}</li>`;
  }).join('');

  const empty = pick && pick.state === 'pre'
    ? `<div class="state">${esc(pick.label)} n'a pas encore eu lieu${isDate(pick.startsAt) ? ` : ${esc(whenText(pick.startsAt))}` : ''}.</div>`
    : '<div class="state">ESPN ne donne pas encore le classement de cette séance.</div>';
  // Le reste d'OpenF1 : chargé à part, comme les pneus.
  const extra = pick && pick.state !== 'pre' ? extraData.get(pick.label) : null;
  if (pick && pick.state !== 'pre' && !extraData.has(pick.label)) loadExtras(pick);
  const x = extra && extra !== 'wait' ? extra : null;
  return hero + favCard + tabs
    + section('Télémétrie', x?.telemetry ? telemetryHtml(x.telemetry) : '')
    + section('Carte du circuit', x?.track ? trackHtml(x.track) : '')
    + section(`Classement${pick ? ` · ${esc(pick.label)}${pick.qual && pick.state === 'in' && phase ? ` · Q${phase}` : ''}` : ''}`, board || empty)
    + section('Météo', x?.weather ? weatherHtml(x.weather) : '')
    + section('Direction de course', x?.control ? controlHtml(x.control) : '')
    + section('Meilleurs tours', x?.best ? bestLapsHtml(x.best) : '')
    + section('Arrêts aux stands', x?.pits ? pitsHtml(x.pits) : '')
    + section('Radio des équipes', x?.radio ? radioHtml(x.radio) : '')
    + section('Programme du week-end', program ? `<ul class="sessions">${program}</ul>` : '');
}

/** Championnat de F1 : pilotes (tes favoris en évidence), puis constructeurs. */
function f1ChampHtml() {
  if (!f1Champ) return '<div class="state">Chargement du championnat…</div>';
  if (f1Champ instanceof Error) return `<div class="state state--err">Championnat indisponible.<br /><code>${esc(errText(f1Champ))}</code></div>`;
  const favs = prefs.favDrivers ?? [];
  const drivers = (f1Champ.drivers ?? []).map((d) => `
    <li class="${favs.some((f) => sameDriver(d, f)) ? 'fav' : ''}">
      <span class="pos">${MEDALS[d.rank] ?? d.rank}</span>${faceHtml(d, 'face')}
      <span class="drv"><b>${esc(d.name)}</b>${d.team ? `<small>${esc(d.team)}</small>` : ''}</span>
      <span class="gap">${esc(d.points)} pts</span></li>`).join('');
  const teams = (f1Champ.teams ?? []).map((t) => `
    <li><span class="pos">${MEDALS[t.rank] ?? t.rank}</span><span class="drv"><b>${esc(t.name)}</b></span><span class="gap">${esc(t.points)} pts</span></li>`).join('');
  return section('Championnat des pilotes', drivers ? `<ol class="grid">${drivers}</ol>` : '')
    + section('Championnat des constructeurs', teams ? `<ol class="grid">${teams}</ol>` : '');
}

/** Le reste d'une séance (OpenF1) : arrêts, radio, météo, tours, carte, télémétrie. */
async function loadExtras(session) {
  extraData.set(session.label, 'wait');
  await Promise.resolve();
  const favs = (prefs.favDrivers ?? []).map((d) => String(d.name ?? '').trim().split(/\s+/).pop().normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase());
  let data = null;
  try {
    data = IS_DEMO ? demoExtras() : await fetchF1Extras(session, favs);
  } catch { data = null; }
  extraData.set(session.label, data);
  // Séance en cours : on relit tout dans 30 s (carte et télémétrie bougent).
  if (session.state === 'in') {
    setTimeout(function again() {
      // Réduite : on attend qu'elle revienne avant de relire.
      if (document.hidden) { setTimeout(again, 30 * 1000); return; }
      extraData.delete(session.label);
      repaint();
    }, 30 * 1000);
  }
  repaint();
}

const oneDecimal = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 10) / 10).replace('.', ',') : '');
const CLOCK = new Intl.DateTimeFormat('fr-CA', { hour: 'numeric', minute: '2-digit' });

function weatherHtml(w) {
  const parts = [
    Number.isFinite(w.air) && `🌡️ Air ${oneDecimal(w.air)} °C`,
    Number.isFinite(w.track) && `🛣️ Piste ${oneDecimal(w.track)} °C`,
    Number.isFinite(w.humidity) && `💧 Humidité ${Math.round(w.humidity)} %`,
    Number.isFinite(w.wind) && `💨 Vent ${oneDecimal(w.wind * 3.6)} km/h`,
    w.rain ? '🌧️ Pluie' : '☀️ Sec',
  ].filter(Boolean);
  return `<div class="f1x__chips">${parts.map((p) => `<span>${esc(p)}</span>`).join('')}</div>`;
}

function controlHtml(list) {
  return `<ul class="f1x__list">${list.slice(0, 12).map((m) => `<li${/penalt|investigation|pénalité|enquête/i.test(m.raw + m.text) ? ' class="warn"' : ''}>
    <small>${m.lap ? `Tour ${m.lap}` : m.date ? CLOCK.format(m.date) : ''}</small><span>${esc(m.text)}</span></li>`).join('')}</ul>`;
}

function bestLapsHtml(best) {
  const [first] = best.ranking;
  const rows = best.ranking.map((d, i) => `<li><span class="pos">${i + 1}</span><i class="f1x__team" style="background:${esc(d.color)}"></i>
    <span class="drv"><b>${esc(d.name)}</b><small>Tour ${d.lap ?? '?'}${d.speed ? ` · ${d.speed} km/h au radar` : ''}</small></span>
    <span class="gap">${esc(d.time)}${i ? `<small>+${(d.seconds - first.seconds).toFixed(3)}</small>` : ''}</span></li>`).join('');
  return `<div class="f1x__note">${best.laps ? `${best.laps} tours · ` : ''}Meilleur tour : <b>${esc(first.name)}</b> en ${esc(first.time)}</div><ol class="grid">${rows}</ol>`;
}

function pitsHtml(list) {
  const fastest = list.filter((p) => Number.isFinite(p.stop)).sort((a, b) => a.stop - b.stop)[0];
  const rows = list.slice(-20).reverse().map((p) => `<li><small>Tour ${p.lap ?? '?'}</small><i class="f1x__team" style="background:${esc(p.color)}"></i>
    <span><b>${esc(p.acronym || p.name)}</b></span><span class="f1x__val">${Number.isFinite(p.stop) ? `${oneDecimal(p.stop)} s à l'arrêt` : ''}${Number.isFinite(p.lane) ? ` · ${oneDecimal(p.lane)} s dans les stands` : ''}</span></li>`).join('');
  return `${fastest ? `<div class="f1x__note">Arrêt le plus rapide : <b>${esc(fastest.name)}</b> en ${oneDecimal(fastest.stop)} s</div>` : ''}<ul class="f1x__list">${rows}</ul>`;
}

function radioHtml(list) {
  return `<ul class="f1x__list f1x__radio">${list.map((r) => `<li><i class="f1x__team" style="background:${esc(r.color)}"></i>
    <span><b>${esc(r.acronym || r.name)}</b><small>${r.date ? CLOCK.format(r.date) : ''}</small></span>
    <audio controls preload="none" src="${esc(r.url)}"></audio></li>`).join('')}</ul>`;
}

/** Tracé du circuit (le meilleur tour) et, en direct, la position de chaque voiture. */
function trackHtml(track) {
  const pts = track.outline;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 300;
  const k = W / Math.max(1, maxX - minX, (maxY - minY) * 1.2);
  const H = Math.round((maxY - minY) * k) + 20;
  const px = (x) => ((x - minX) * k + 10).toFixed(1);
  const py = (y) => ((maxY - y) * k + 10).toFixed(1); // l'axe y d'OpenF1 monte
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p[0])} ${py(p[1])}`).join(' ') + 'Z';
  const cars = track.cars.map((c) => `<g><circle cx="${px(c.x)}" cy="${py(c.y)}" r="${c.fav ? 5 : 3.6}" fill="${esc(c.color)}" stroke="#fff" stroke-width="${c.fav ? 1.5 : 0.6}" />
    ${c.fav ? `<text x="${px(c.x)}" y="${(Number(py(c.y)) - 8).toFixed(1)}" class="f1x__car">${esc(c.acronym)}</text>` : ''}<title>${esc(c.name)}</title></g>`).join('');
  return `<svg class="f1x__track" viewBox="0 0 ${W + 20} ${H}"><path d="${path}" class="f1x__line" />${cars}</svg>
    ${track.cars.length ? '' : '<div class="f1x__note">Position des voitures : en direct seulement (OpenF1 la réserve à ses abonnés).</div>'}`;
}

/** Télémétrie de tes pilotes : vitesse, rapport, accélérateur, frein, DRS (ou vitesse de pointe). */
function telemetryHtml(list) {
  return list.map((t) => {
    if (!t.live) return `<div class="f1x__tel"><i class="f1x__team" style="background:${esc(t.color)}"></i><b>${esc(t.name)}</b><span>Vitesse de pointe : <b>${t.top} km/h</b></span></div>`;
    const bar = (label, v, color) => `<div class="f1x__bar"><small>${label}</small><span><i style="width:${Math.max(0, Math.min(100, v))}%;background:${color}"></i></span></div>`;
    return `<div class="f1x__tel"><i class="f1x__team" style="background:${esc(t.color)}"></i><b>${esc(t.name)}</b>
      <span class="f1x__speed"><b>${t.speed}</b> km/h · rapport <b>${t.gear}</b>${t.drs ? ' · <b class="f1x__drs">DRS</b>' : ''}</span></div>
      ${bar('Accélérateur', t.throttle, '#3ecf8e')}${bar('Frein', t.brake ? 100 : 0, '#ff6b6b')}`;
  }).join('');
}

function demoExtras() {
  const d = (name, acronym, color) => ({ name, acronym, color, number: 0 });
  const circle = Array.from({ length: 80 }, (_, i) => [Math.cos((i / 80) * 6.283) * (900 + 300 * Math.sin((i / 80) * 12.56)), Math.sin((i / 80) * 6.283) * 600]);
  return {
    weather: { air: 24.3, track: 38.1, humidity: 55, rain: false, wind: 1.8 },
    control: [{ lap: 34, text: 'Voiture 1 (VER) : pénalité de temps de 5 s pour avoir causé une collision', raw: 'PENALTY' }, { lap: 30, text: 'DRS autorisé', raw: '' }],
    best: { laps: 34, ranking: [{ ...d('Andrea Kimi Antonelli', 'ANT', '#27f4d2'), time: '1:14.321', seconds: 74.321, lap: 28, speed: 318 }, { ...d('George Russell', 'RUS', '#27f4d2'), time: '1:14.502', seconds: 74.502, lap: 30 }] },
    pits: [{ ...d('Lando Norris', 'NOR', '#ff8000'), lap: 15, stop: 2.4, lane: 21.9 }, { ...d('Andrea Kimi Antonelli', 'ANT', '#27f4d2'), lap: 22, stop: 2.1, lane: 21.3 }],
    radio: [{ ...d('Andrea Kimi Antonelli', 'ANT', '#27f4d2'), date: new Date(), url: 'https://livetiming.formula1.com/static/demo.mp3' }],
    track: { outline: circle, cars: [{ ...d('Andrea Kimi Antonelli', 'ANT', '#27f4d2'), x: circle[10][0], y: circle[10][1], fav: true }, { ...d('George Russell', 'RUS', '#27f4d2'), x: circle[14][0], y: circle[14][1] }] },
    telemetry: [{ ...d('Andrea Kimi Antonelli', 'ANT', '#27f4d2'), live: true, speed: 312, gear: 8, throttle: 100, brake: 0, drs: true }],
  };
}

/** Pneus d'une séance (OpenF1), puis on redessine. */
async function loadTyres(session) {
  tyreData.set(session.label, 'wait');
  await Promise.resolve(); // pas pendant le dessin en cours
  tyreData.set(session.label, IS_DEMO ? demoTyres() : await fetchTyres(session));
  // Séance en cours : on relira les pneus dans une minute.
  if (session.state === 'in') setTimeout(() => tyreData.delete(session.label), 60 * 1000);
  repaint();
}

function demoTyres() {
  return { antonelli: [{ compound: 'MEDIUM', from: 1, to: 22 }, { compound: 'HARD', from: 23, to: null }],
    russell: [{ compound: 'MEDIUM', from: 1, to: 20 }, { compound: 'HARD', from: 21, to: null }],
    verstappen: [{ compound: 'HARD', from: 1, to: null }], norris: [{ compound: 'SOFT', from: 1, to: 15 }, { compound: 'MEDIUM', from: 16, to: null }] };
}

async function loadF1Champ() {
  if (f1Champ && !(f1Champ instanceof Error)) return;
  try {
    f1Champ = IS_DEMO
      ? { drivers: [['Lando Norris', 'McLaren', '390'], ['Oscar Piastri', 'McLaren', '366'], ['Max Verstappen', 'Red Bull', '341']]
        .map(([name, team, points], i) => ({ rank: i + 1, name, team, points, photo: '' })),
      teams: [['McLaren', '756'], ['Mercedes', '426'], ['Red Bull', '380']].map(([name, points], i) => ({ rank: i + 1, name, points })) }
      : await fetchF1Standings();
  } catch (err) {
    f1Champ = err instanceof Error ? err : new Error(String(err));
  }
  repaint();
}

/* ---------- Golf ---------- */

function golfHtml(g) {
  const league = LEAGUES_BY_ID[g.leagueId];
  const hero = `<section class="hero hero--f1">
    <div class="hero__title">${esc(g.title)}</div>
    ${statusHtml(g)}
  </section>`;
  if (g.state === 'pre' || !g.players?.length) {
    return hero + `<div class="state">Le tableau des meneurs apparaîtra au début du tournoi.</div>`;
  }
  if (g.teamEvent) {
    const rows = g.players.map((t) => `<li><span class="pos">${t.winner ? '🏆' : ''}</span>${faceHtml(t, 'face')}
      <span class="drv"><b>${esc(t.name)}</b></span><span class="gap golf__score">${esc(String(t.score).replace('.', ','))} pts</span></li>`).join('');
    return hero + section('Pointage des équipes', `<ol class="grid">${rows}</ol>`);
  }
  const thru = (p) => (g.state !== 'in' || !p.thru ? '' : /^\d+$/.test(p.thru) ? `${p.thru} trous` : p.thru === 'F' ? 'Ronde finie' : p.thru);
  const rows = g.players.map((p) => `<li>
    <span class="pos">${g.state === 'post' && p.pos <= 3 ? MEDALS[p.pos] : esc(p.posText)}</span>
    ${faceHtml(p, 'face')}
    <span class="drv"><b>${esc(p.name)}</b>${thru(p) ? `<small>${esc(thru(p))}</small>` : ''}</span>
    <span class="gap golf__score">${esc(p.score)}</span>
  </li>`).join('');
  return hero + section(`Tableau des meneurs${g.session ? ` · ${esc(g.session)}` : ''} <small>${esc(league?.label ?? '')}</small>`, `<ol class="grid">${rows}</ol>`);
}

/* ---------- Tennis ---------- */

const lastWord = (name) => String(name ?? '').trim().split(/\s+/).pop();

function tennisHtml(m) {
  const favs = prefs.favTennis ?? [];
  const n = Math.max(m.a.sets.length, m.b.sets.length);
  const head = Array.from({ length: n }, (_, i) => `<th>${i + 1}</th>`).join('');
  const row = (p, o) => `<tr class="${p.winner ? 'win' : ''}">
    <td class="t">${faceHtml(p, 'face')}<span><b>${favs.some((f) => sameDriver(f, p)) ? '⭐ ' : ''}${esc(p.name)}</b>${p.seed ? ` <small>(${p.seed})</small>` : ''}</span></td>
    ${Array.from({ length: n }, (_, i) => `<td class="${(p.sets[i] ?? 0) > (o.sets[i] ?? 0) ? 'set--won' : ''}">${p.sets[i] ?? ''}</td>`).join('')}
    <td class="tot">${p.winner ? '✅' : ''}</td></tr>`;
  const hero = `<section class="hero hero--f1">
    <div class="hero__title">${esc([m.round, m.draw].filter(Boolean).join(' · ') || m.title)}</div>
    <div class="series">${esc(m.title)}</div>
    ${statusHtml(m)}
  </section>`;
  const board = n
    ? `<table class="periods tennis"><thead><tr><th></th>${head}<th></th></tr></thead><tbody>${row(m.a, m.b)}${row(m.b, m.a)}</tbody></table>`
    : `<table class="periods tennis"><tbody>${row(m.a, m.b)}${row(m.b, m.a)}</tbody></table>`;
  return hero + section('Pointage par manche', board);
}

/* ---------- UFC ---------- */

function fighterBlock(f, big) {
  const face = f.photo
    ? `<img class="face${big ? ' face--xl face--ufc' : ''}" src="${esc(f.photo)}" alt="" data-face />`
    : `<span class="face${big ? ' face--xl face--ufc' : ''}"></span>`;
  return `<div class="fighter${f.winner ? ' fighter--win' : ''}">
    ${face}
    <b>${f.winner ? '✅ ' : ''}${esc(f.name)}</b>
    ${f.record ? `<small>${esc(f.record)}</small>` : ''}
  </div>`;
}

function fightStatus(f) {
  if (f.state === 'in') return `<span class="live"><span class="dot"></span>Round ${f.round ?? 1}${f.clock ? ` · ${esc(f.clock)}` : ''}</span>`;
  if (f.state === 'post') return esc(f.result || 'Terminé');
  return isDate(f.startsAt) ? esc(TIME_FMT.format(f.startsAt)) : '';
}

/** Gala de l'UFC : combat principal en grand, puis toute la carte. */
/** Une carte par combattant favori : photo, fiche, adversaire, état du combat. */
function favFightersHtml(g) {
  const favs = prefs.favFighters ?? [];
  const cards = [];
  for (const f of g.fights ?? []) {
    const me = [f.a, f.b].find((x) => favs.some((fav) => sameDriver(x, fav)));
    if (!me) continue;
    const opp = me === f.a ? f.b : f.a;
    const outcome = f.state === 'post'
      ? (me.winner ? `🏆 Victoire${f.result ? ` · ${esc(f.result)}` : ''}` : opp.winner ? `Défaite${f.result ? ` · ${esc(f.result)}` : ''}` : esc(f.result || 'Terminé'))
      : fightStatus(f);
    cards.push(`<section class="card favdriver favfighter">
      ${me.photo ? `<img class="face face--xl face--ufc" src="${esc(me.photo)}" alt="" data-face />` : ''}
      <div class="favdriver__txt">
        <small>${favs.length > 1 ? 'Un de tes combattants' : 'Ton combattant'}</small>
        <b>${esc(me.name)}${me.record ? ` <span class="st-rec">${esc(me.record)}</span>` : ''}</b>
        <span>contre ${esc(opp.name)}${f.weight ? ` · ${esc(f.weight)}` : ''}</span>
        <span>${outcome}</span>
      </div>
    </section>`);
  }
  return cards.join('');
}

function ufcHtml(g) {
  const m = g.main;
  const isFav = (x) => (prefs.favFighters ?? []).some((fav) => sameDriver(x, fav));
  const hero = `<section class="hero hero--f1">
    <div class="hero__title">${esc(g.title)}</div>
    ${statusHtml(g)}
    ${m ? `<div class="mainbout">${fighterBlock(m.a, true)}<span class="vs">VS</span>${fighterBlock(m.b, true)}</div>
      <div class="status">${[esc(m.weight), fightStatus(m)].filter(Boolean).join(' · ')}</div>` : ''}
  </section>`;
  let segment = '';
  const rows = (g.fights ?? []).filter((f) => f !== m && f.id !== m?.id).map((f) => {
    const head = f.segment && f.segment !== segment ? `<li class="seg">${esc(f.segment)}</li>` : '';
    segment = f.segment || segment;
    const name = (x) => `<span class="${x.winner ? 'win' : ''}">${isFav(x) ? '⭐ ' : ''}${x.winner ? '✅ ' : ''}${esc(x.name)}</span>`;
    const fav = isFav(f.a) || isFav(f.b);
    return `${head}<li class="fight${f.state === 'in' ? ' fight--live' : ''}${fav ? ' fight--fav' : ''}">
      <div class="fight__names">${name(f.a)}<i>vs</i>${name(f.b)}</div>
      <div class="fight__meta">${[esc(f.weight), fightStatus(f)].filter(Boolean).join(' · ')}</div>
    </li>`;
  }).join('');
  return hero + favFightersHtml(g) + section('Carte complète', rows ? `<ul class="card-list">${rows}</ul>` : '');
}

/* ---------- Chargement ---------- */

/** Match tel que le tableau des scores le décrit (repli, et F1). */
async function fromScoreboard() {
  if (IS_DEMO) return demoEvents(true).find((e) => e.leagueId === current.league) ?? demoEvents()[0];
  const games = await fetchScoreboard(current.league);
  return games.find((x) => x.id === current.event) ?? null;
}

// Fenêtre réduite : on ne relit rien ; tout reprend dès qu'elle revient.
let waitingVisible = false;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && waitingVisible) {
    waitingVisible = false;
    load();
  }
});

async function load() {
  clearTimeout(timer);
  if (document.hidden && shown) {
    waitingVisible = true;
    return;
  }
  prefs = loadPrefs();
  applyTeamAccent(prefs);
  const league = LEAGUES_BY_ID[current.league];
  el.chip.textContent = league?.label ?? '';
  el.chip.style.color = league?.accent ?? '';
  let g = null;
  let html = '';
  let build = null; // refait le HTML (après traduction) sans redemander les données

  try {
    if (league?.kind === 'card') {
      g = await fromScoreboard();
      if (!g) throw new Error("Ce gala n'est plus au programme.");
      el.title.textContent = g.title;
      const card = g;
      build = () => ufcHtml(card);
      html = build();
    } else if (league?.kind === 'event') {
      g = await fromScoreboard();
      if (!g) throw new Error('Cette séance n\'est plus au programme.');
      el.title.textContent = g.title;
      const gp = g;
      build = () => f1Html(gp);
      html = build();
    } else if (league?.kind === 'golf') {
      g = await fromScoreboard();
      if (!g) throw new Error("Ce tournoi n'est plus au programme.");
      el.title.textContent = g.title;
      const t = g;
      build = () => golfHtml(t);
      html = build();
    } else if (league?.kind === 'tennis') {
      g = await fromScoreboard();
      if (!g) throw new Error("Ce match n'est plus au programme.");
      el.title.textContent = `${lastWord(g.a.name)} – ${lastWord(g.b.name)}`;
      const m = g;
      build = () => tennisHtml(m);
      html = build();
    } else {
      let table = new Map();
      try {
        [g, table] = IS_DEMO
          ? [demoDetail(), new Map([['10', { rank: 3, group: 'Atlantique', points: '27' }]])]
          : await Promise.all([fetchMatchDetail(current.league, current.event), fetchStandings(current.league)]);
      } catch (detailErr) {
        // Résumé illisible : on se contente du tableau des scores.
        const basic = await fromScoreboard();
        if (!basic) throw new Error(`Match introuvable.\n${errText(detailErr)}`);
        g = { ...basic, stats: [], goals: [], penalties: [] };
      }
      // Baseball en direct : lanceur et frappeur, du tableau des scores si le
      // résumé ne les donne pas.
      if (sportOf(current.league) === 'baseball' && g.state === 'in' && !g.situation) {
        const basic = await fromScoreboard().catch(() => null);
        if (basic?.situation) g = { ...g, situation: basic.situation };
      }
      el.title.textContent = `${g.away.abbr} @ ${g.home.abbr}`;
      const match = g;
      build = () => matchHtml(match, table);
      html = build();
    }
  } catch (err) {
    html = isOffline(err)
      ? `<div class="state"><div class="state__icon">📡</div><b>${OFFLINE_TITLE}</b><br />${OFFLINE_HINT}<br />
        <button class="ghost" id="btnRetry">Réessayer</button></div>`
      : `<div class="state state--err"><b>Détails indisponibles</b><br /><code>${esc(errText(err))}</code><br />
        <button class="ghost" id="btnRetry">Réessayer</button></div>`;
  }

  paint(html);
  shown = build ? { g, build } : null;
  translateShown();

  link = g?.link ?? '';
  el.espn.hidden = !link;
  if (g?.kind !== 'event' && g?.home && !IS_DEMO) loadForms(g);
  if (g?.kind === 'match' && g?.home && tab === 'summary') loadTeamNews(g);
  timer = setTimeout(load, g?.state === 'in' || !g ? REFRESH_LIVE_MS : REFRESH_IDLE_MS);
}

/** Textes d'ESPN en anglais : traduits en arrière-plan, puis redessinés. */
function translateShown() {
  if (!shown || prefs.translate === false) return;
  const { g, build } = shown;
  translateAll(textsOf(g)).then((changed) => { if (changed && shown?.g === g) paint(build()); });
}

/** Redessine le match affiché sans redemander les données (onglet changé…). */
function repaint() {
  if (!shown) return;
  paint(shown.build());
  translateShown();
}

// Onglets, équipe du box score, « Voir plus de jeux ».
el.main.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) { tab = t.dataset.tab; repaint(); el.main.scrollTop = 0; return; }
  const b = e.target.closest('[data-box-team]');
  if (b) { boxTeam = b.dataset.boxTeam; repaint(); return; }
  if (e.target.closest('[data-more-plays]')) { playsShown += PLAYS_STEP; repaint(); }
  const f = e.target.closest('[data-f1]');
  if (f) {
    f1Tab = f.dataset.f1 === 'champ' ? 'champ' : Number(f.dataset.f1);
    repaint();
    if (f1Tab === 'champ') loadF1Champ();
  }
});

function paint(html) {
  if (html === lastHtml) return;
  lastHtml = html;
  el.main.innerHTML = html;
  bindCrests(el.main);
  bindFaces(el.main);
  document.getElementById('btnRetry')?.addEventListener('click', load);
  // Vidéo des faits saillants : ouverte sur ESPN, dans le navigateur.
  el.main.querySelectorAll('.video[data-href], .news__item[data-href]').forEach((b) => b.addEventListener('click', async () => {
    const url = b.dataset.href;
    if (!inTauri()) { window.open(url, '_blank', 'noopener'); return; }
    try { await window.__TAURI__.core.invoke('open_espn', { url }); } catch { /* refusé */ }
  }));
}

/** Derniers résultats des deux équipes, chargés après coup (ils peuvent être lents). */
async function loadForms(g) {
  const missing = [g.away, g.home].filter((t) => !teamForms.has(String(t.id)));
  if (!missing.length) return;
  for (const t of missing) {
    try {
      teamForms.set(String(t.id), await fetchTeamForm(g.leagueId, t.id));
    } catch {
      teamForms.set(String(t.id), []);
    }
  }
  lastHtml = '';
  load();
}

/** Aperçu navigateur : un match de démonstration complet. */
function demoDetail() {
  const g = demoEvents()[0];
  return {
    ...g,
    home: { ...g.home, periods: ['1', '2', '0'] },
    away: { ...g.away, periods: ['0', '1', '1'] },
    goals: [
      { teamId: '10', period: 1, clock: '04:12', who: 'Cole Caufield', assists: ['Nick Suzuki', 'Lane Hutson'] },
      { teamId: '21', period: 2, clock: '02:30', who: 'Auston Matthews', assists: ['Mitch Marner'] },
      { teamId: '10', period: 2, clock: '11:48', who: 'Juraj Slafkovsky', assists: ['Ivan Demidov'] },
      { teamId: '10', period: 2, clock: '17:05', who: 'Nick Suzuki', assists: [] },
      { teamId: '21', period: 3, clock: '06:20', who: 'William Nylander', assists: ['John Tavares', 'Morgan Rielly'] },
    ],
    penalties: [{ teamId: '21', period: 2, clock: '09:14', who: 'Morgan Rielly', text: '2 minutes pour accrochage' }],
    stats: [
      { label: 'Tirs au but', away: '19', home: '27' },
      { label: 'Mises en jeu (%)', away: '47.2', home: '52.8' },
      { label: 'Mises en échec', away: '22', home: '18' },
      { label: 'Tirs bloqués', away: '9', home: '14' },
    ],
    venue: 'Centre Bell, Montréal',
    broadcasts: ['RDS', 'Sportsnet'],
    h2h: {
      text: 'MTL mène la série 2-1',
      games: [
        { id: 'a', date: new Date(Date.now() - 40 * 864e5), state: 'post', home: { id: '10', abbr: 'MTL', score: '4' }, away: { id: '21', abbr: 'TOR', score: '2' }, winnerId: '10' },
        { id: 'b', date: new Date(Date.now() - 20 * 864e5), state: 'post', home: { id: '21', abbr: 'TOR', score: '5' }, away: { id: '10', abbr: 'MTL', score: '3' }, winnerId: '21' },
        { id: 'c', date: new Date(Date.now() - 6 * 864e5), state: 'post', home: { id: '10', abbr: 'MTL', score: '3' }, away: { id: '21', abbr: 'TOR', score: '2' }, winnerId: '10' },
        { id: 'd', date: new Date(Date.now() + 30 * 864e5), state: 'pre', home: { id: '21', abbr: 'TOR', score: '' }, away: { id: '10', abbr: 'MTL', score: '' }, winnerId: null },
      ],
    },
    news: [
      { id: '1', title: 'Le Canadien rappelle un attaquant de Laval', text: 'Le club-école envoie du renfort avant le match contre Toronto.', date: new Date(Date.now() - 3600e3), image: '', link: 'https://www.espn.com/nhl/story/_/id/1' },
      { id: '2', title: 'Caufield vise une 3e saison de 40 buts', text: '', date: new Date(Date.now() - 2 * 864e5), image: '', link: 'https://www.espn.com/nhl/story/_/id/2' },
    ],
    winProb: { home: 64, away: 36, live: true },
    winTimeline: [50, 52, 48, 41, 38, 45, 55, 61, 58, 49, 44, 52, 60, 66, 63, 58, 62, 64],
    shots: [[70, 5, 'goal', '10'], [80, -8, 'shot', '10'], [-75, 12, 'shot', '10'], [60, 20, 'miss', '10'], [85, 2, 'goal', '10'], [-82, -4, 'shot', '21'],
      [-70, 10, 'goal', '21'], [65, -15, 'shot', '21'], [-60, 25, 'block', '21'], [-88, 1, 'goal', '21'], [75, -3, 'shot', '10']]
      .map(([x, y, kind, teamId]) => ({ x, y, kind, teamId, who: '', period: 2 })),
    injuries: [{ teamId: '10', players: [{ name: 'Kirby Dach', pos: 'C', status: 'Absent', what: 'Genou', back: null, photo: '' }] }],
    stars: [
      { rank: 1, name: 'Cole Caufield', photo: '', teamId: '10', line: '2 buts' },
      { rank: 2, name: 'Nick Suzuki', photo: '', teamId: '10', line: '1 but, 2 passes' },
      { rank: 3, name: 'Auston Matthews', photo: '', teamId: '21', line: '1 but' },
    ],
    leaders: [
      { label: 'Points', away: { name: 'Auston Matthews', photo: '', value: '1 B, 1 A' }, home: { name: 'Nick Suzuki', photo: '', value: '1 B, 2 A' } },
      { label: 'Arrêts', away: { name: 'Anthony Stolarz', photo: '', value: '24 arrêts' }, home: { name: 'Sam Montembeault', photo: '', value: '17 arrêts' } },
    ],
    videos: [
      { title: 'Caufield scores on the power play', thumb: '', href: 'https://www.espn.com/video/clip?id=1' },
      { title: 'Suzuki buries the go-ahead goal', thumb: '', href: 'https://www.espn.com/video/clip?id=2' },
    ],
    box: [['10', [
      ['14', 'N. Suzuki', 'C', ['1', '2', '3', '+2', '4', '19:42', '1', '0', '0', '11', '7', '61.1']],
      ['13', 'C. Caufield', 'RW', ['2', '0', '2', '+1', '6', '17:10', '0', '1', '0', '0', '0', '0.0']],
      ['20', 'J. Slafkovsky', 'LW', ['1', '0', '1', '+1', '3', '16:55', '4', '0', '2', '0', '0', '0.0']],
      ['48', 'L. Hutson', 'D', ['0', '1', '1', '+2', '2', '23:31', '0', '2', '0', '0', '0', '0.0']],
    ]], ['21', [
      ['34', 'A. Matthews', 'C', ['1', '0', '1', '-1', '5', '20:14', '2', '1', '0', '9', '10', '47.4']],
      ['88', 'W. Nylander', 'RW', ['1', '0', '1', '0', '4', '18:40', '0', '0', '0', '0', '0', '0.0']],
    ]]].map(([teamId, rows]) => ({
      teamId,
      groups: [{
        name: 'Attaquants',
        cols: ['B', 'A', 'PTS', '+/-', 'TB', 'TG', 'MÉ', 'TBL', 'PUN', 'MJG', 'MJP', '%MJ'].map((label) => ({ label, tip: '' })),
        players: rows.map(([jersey, short, pos, stats]) => ({ name: short, short, jersey, pos, stats })),
      }],
    })),
    allPlays: [
      { period: 1, clock: '0:00', teamId: '', text: 'Start of 1st Period' },
      { period: 1, clock: '4:12', teamId: '10', text: 'Cole Caufield Goal (1) Wrist Shot, assists: Nick Suzuki (1), Lane Hutson (1)', scoring: true, away: '0', home: '1' },
      { period: 1, clock: '9:30', teamId: '21', text: 'Auston Matthews Shot on Goal saved by Sam Montembeault' },
      { period: 2, clock: '2:30', teamId: '21', text: 'Auston Matthews Goal (1) Snap Shot, assists: Mitch Marner (1)', scoring: true, away: '1', home: '1' },
      { period: 2, clock: '9:14', teamId: '21', text: 'Morgan Rielly Hooking against Nick Suzuki' },
      { period: 2, clock: '11:48', teamId: '10', text: 'Juraj Slafkovsky Goal (1) Tip-In, assists: Ivan Demidov (1)', scoring: true, away: '1', home: '2' },
    ],
  };
}

// Compte à rebours tenu à jour sans redemander les données.
setInterval(() => {
  document.querySelectorAll('[data-start]').forEach((n) => {
    const t = untilText(new Date(Number(n.dataset.start)));
    if (n.textContent !== t) n.textContent = t;
  });
}, 30_000);

el.espn.addEventListener('click', async () => {
  if (!link) return;
  if (!inTauri()) { window.open(link, '_blank', 'noopener'); return; }
  try { await window.__TAURI__.core.invoke('open_espn', { url: link }); } catch { /* refusé */ }
});

document.getElementById('btnClose').addEventListener('click', async () => {
  if (inTauri()) await window.__TAURI__.window.getCurrentWindow().close();
  else window.close();
});

// Un autre match cliqué dans le widget : la fenêtre déjà ouverte s'y met.
if (inTauri()) {
  window.__TAURI__.event.listen('match-open', (e) => {
    current = e.payload;
    lastHtml = '';
    tab = 'summary';
    boxTeam = null;
    playsShown = PLAYS_STEP;
    f1Tab = null;
    hockeyLines.clear(); // trios « de ce match » : pas ceux du match d'avant
    el.main.innerHTML = '<div class="state">Chargement…</div>';
    load();
  });
}

// Pilote favori changé dans les réglages : on redessine.
window.addEventListener('storage', (e) => {
  if (e.key === 'sports-counter.ping') { lastHtml = ''; load(); }
});

// Retour du réseau : on recharge tout de suite.
window.addEventListener('online', () => { lastHtml = ''; load(); });
window.addEventListener(TRANSLATED_EVENT, () => load());

load();
