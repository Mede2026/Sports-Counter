// Fenêtre « Match » : tout le détail d'un match suivi, dans l'app.
// Hockey, basket, football, soccer : pointage par période, statistiques,
// buts, pénalités, classement. F1 : classement complet de la séance, pilote
// favori et programme du week-end.
import { fetchMatchDetail, fetchScoreboard, fetchStandings, fetchTeamForm, demoEvents, sameDriver } from './lib/api.js';
import { LEAGUES_BY_ID, sportOf } from './lib/leagues.js';
import { loadPrefs } from './lib/store.js';
import { crestHtml, bindCrests } from './lib/crest.js';
import { visibleTeamColor } from './lib/color.js';
import { errText, isOffline, OFFLINE_TITLE, OFFLINE_HINT } from './lib/err.js';
import { whenText, untilText, isDate, TIME_FMT } from './lib/time.js';
import { MEDALS, esc, ordinal, rank as rankText, formIcons, formTitle } from './lib/format.js';
import { translated, translateAll } from './lib/translate.js';

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


/* ---------- Morceaux communs ---------- */

function statusHtml(g) {
  if (g.state === 'in') {
    const text = [g.session, g.clock, g.statusText].filter(Boolean).join(' · ');
    return `<div class="status status--live"><span class="dot"></span>${esc(text || 'En direct')}</div>`;
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
      ${t.record ? `<div class="side__rec">${esc(t.record)}</div>` : ''}
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
    </div>${series}</section>`;
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
  const colorA = visibleTeamColor(g.away.color, g.away.alt) ?? '#4aa3ff';
  const colorH = visibleTeamColor(g.home.color, g.home.alt) ?? '#ff7a45';
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

/** Textes libres d'ESPN affichés dans la fenêtre : ceux à traduire. */
function textsOf(g) {
  return [...(g?.goals ?? []), ...(g?.penalties ?? [])].map((p) => p.text)
    .concat((g?.videos ?? []).map((v) => v.title))
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
  if (!p) return '';
  const colorA = visibleTeamColor(g.away.color, g.away.alt) ?? '#4aa3ff';
  const colorH = visibleTeamColor(g.home.color, g.home.alt) ?? '#ff7a45';
  const total = p.away + p.home || 1;
  return `<div class="prob">
    <div class="prob__vals"><b>${esc(g.away.abbr)} ${p.away} %</b><span>${p.live ? 'en direct' : 'avant le match'}</span><b>${p.home} % ${esc(g.home.abbr)}</b></div>
    <div class="stat__bar"><i style="width:${(p.away / total) * 100}%;background:${colorA}"></i><i style="width:${(p.home / total) * 100}%;background:${colorH}"></i></div>
  </div>`;
}

const personFace = (x, cls = 'face') => (x?.photo
  ? `<img class="${cls}" src="${esc(x.photo)}" alt="" data-face />`
  : `<span class="${cls}"></span>`);

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

function matchHtml(g, table) {
  const goalsTitle = ['hockey', 'soccer'].includes(sportOf(g.leagueId)) ? 'Buts' : 'Jeux marquants';
  return heroHtml(g)
    + section('Chances de victoire', winProbHtml(g))
    + section('Faits saillants', videosHtml(g))
    + section('Les 3 étoiles', starsHtml(g))
    + section('Meneurs du match', leadersHtml(g))
    + section(periodsTitle(g), periodsHtml(g))
    + section(goalsTitle, playsHtml(g, g.goals, true))
    + section('Statistiques', statsHtml(g))
    + (g.leagueId === 'nhl' ? section('Pénalités', playsHtml(g, g.penalties, false)) : '')
    + section('Classement', standingsHtml(g, table))
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

  const rows = (g.results ?? []).map((d) => {
    const isFav = favs.some((f) => sameDriver(d, f));
    return `<li class="${isFav ? 'fav' : ''}">
      <span class="pos">${MEDALS[d.pos] ?? d.pos}</span>
      ${d.photo ? `<img class="face" src="${esc(d.photo)}" alt="" loading="lazy" data-face />` : '<span class="face"></span>'}
      <span class="drv"><b>${esc(d.name)}</b>${d.team ? `<small>${esc(d.team)}</small>` : ''}</span>
      ${d.pos > 1 && d.gap ? `<span class="gap">${esc(String(d.gap).startsWith('+') ? d.gap : `+${d.gap}`)}</span>` : ''}
    </li>`;
  }).join('');
  const results = rows ? `<ol class="grid">${rows}</ol>` : '';

  const now = Date.now();
  const sessions = (g.sessions ?? []).map((s) => {
    const cls = s.state === 'in' ? 'live' : s.state === 'post' ? 'done' : '';
    const when = `${DAY_FMT.format(s.startsAt)} · ${TIME_FMT.format(s.startsAt)}`;
    const extra = s.state === 'in' ? '<span class="live">En direct</span>'
      : s.state === 'post' ? '<span>Terminée</span>'
      : s.startsAt.getTime() > now ? `<span class="until" data-start="${s.startsAt.getTime()}">${untilText(s.startsAt)}</span>` : '';
    return `<li class="${cls}"><b>${esc(s.label)}</b><span>${esc(when)}</span>${extra}</li>`;
  }).join('');

  return hero + favCard
    + section(`Classement${g.session ? ` · ${esc(g.session)}` : ''}`, results)
    + section('Programme du week-end', sessions ? `<ul class="sessions">${sessions}</ul>` : '');
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
  if (IS_DEMO) return demoEvents().find((e) => e.leagueId === current.league) ?? demoEvents()[0];
  const games = await fetchScoreboard(current.league);
  return games.find((x) => x.id === current.event) ?? null;
}

async function load() {
  clearTimeout(timer);
  prefs = loadPrefs();
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
      html = ufcHtml(g);
    } else if (league?.kind === 'event') {
      g = await fromScoreboard();
      if (!g) throw new Error('Cette séance n\'est plus au programme.');
      el.title.textContent = g.title;
      html = f1Html(g);
    } else {
      let table = new Map();
      try {
        [g, table] = IS_DEMO
          ? [demoDetail(), new Map([['10', { rank: 3, group: 'Atlantique', points: '27' }]])]
          : await Promise.all([fetchMatchDetail(current.league, current.event), fetchStandings(current.league)]);
      } catch {
        // Résumé illisible : on se contente du tableau des scores.
        const basic = await fromScoreboard();
        if (!basic) throw new Error('Match introuvable.');
        g = { ...basic, stats: [], goals: [], penalties: [] };
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
  // Textes d'ESPN en anglais : traduits en arrière-plan, puis redessinés.
  if (build && prefs.translate !== false) {
    translateAll(textsOf(g)).then((changed) => { if (changed) paint(build()); });
  }

  link = g?.link ?? '';
  el.espn.hidden = !link;
  if (g?.kind !== 'event' && g?.home && !IS_DEMO) loadForms(g);
  timer = setTimeout(load, g?.state === 'in' || !g ? REFRESH_LIVE_MS : REFRESH_IDLE_MS);
}

function paint(html) {
  if (html === lastHtml) return;
  lastHtml = html;
  el.main.innerHTML = html;
  bindCrests(el.main);
  el.main.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true }));
  document.getElementById('btnRetry')?.addEventListener('click', load);
  // Vidéo des faits saillants : ouverte sur ESPN, dans le navigateur.
  el.main.querySelectorAll('.video[data-href]').forEach((b) => b.addEventListener('click', async () => {
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
    winProb: { home: 64, away: 36, live: true },
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

load();
