import { fetchScoreboard, fetchNextGames, fetchScorer, demoEvents, LOOKAHEAD_DAYS } from './lib/api.js';
import { LEAGUES_BY_ID } from './lib/leagues.js';
import { loadPrefs } from './lib/store.js';
import { errText } from './lib/err.js';
import { crestHtml, bindCrests } from './lib/crest.js';
import { visibleTeamColor } from './lib/color.js';
import { detectEvents, remember } from './lib/events.js';

const REFRESH_LIVE_MS = 25_000;   // un match est en cours
const REFRESH_IDLE_MS = 300_000;  // aucun match en cours

const el = {
  widget: document.getElementById('widget'),
  games: document.getElementById('games'),
  foot: document.getElementById('foot'),
  title: document.getElementById('barTitle'),
};

let prefs = loadPrefs();
let timer = null;
const lastScores = new Map(); // "idMatch:idÉquipe" -> score précédent
let seen = null; // relevé précédent, pour les notifications (null = premier)

const inTauri = () => !!window.__TAURI__;

/* ---------- Rendu ---------- */

function teamRow(game, team, dim) {
  const key = `${game.id}:${team.id}`;
  const prev = lastScores.get(key);
  const bumped = prev !== undefined && prev !== team.score && game.state === 'in';
  lastScores.set(key, team.score);
  return `
    <div class="team${dim ? ' team--loser' : ''}">
      ${crestHtml(team)}
      <span class="team__abbr">${team.abbr}</span>
      <span class="team__name">${team.name}</span>
      <span class="team__score${bumped ? ' team__score--bump' : ''}">${team.score}</span>
    </div>`;
}

// ESPN rédige ses statuts en anglais américain (« 9/24 - 4:30 AM EDT ») :
// pour un match à venir, on reformule l'heure de départ à la québécoise.
const DAY_FMT = new Intl.DateTimeFormat('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' });
const TIME_FMT = new Intl.DateTimeFormat('fr-CA', { hour: 'numeric', minute: '2-digit' });

function whenText(date) {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const day =
    date.toDateString() === today.toDateString() ? "Aujourd'hui"
    : date.toDateString() === tomorrow.toDateString() ? 'Demain'
    : DAY_FMT.format(date);
  return `${day} · ${TIME_FMT.format(date)}`;
}

function statusBlock(game) {
  if (game.state === 'in') {
    const text = [game.session, game.clock, game.statusText].filter(Boolean).join(' · ');
    return `<span class="status status--live"><span class="dot"></span>${text || 'En direct'}</span>`;
  }
  if (game.state === 'pre' && game.startsAt instanceof Date && !isNaN(game.startsAt)) {
    const text = [game.session, whenText(game.startsAt)].filter(Boolean).join(' · ');
    return `<span class="status">${text}</span>`;
  }
  const text = [game.session, game.statusText].filter(Boolean).join(' · ');
  return `<span class="status">${text}</span>`;
}

function podiumHtml(top3) {
  if (!top3?.length) return '';
  return `<ol class="podium">${top3
    .map((d) => `<li><span class="podium__pos podium__pos--${d.pos}">${d.pos}</span>${d.name}</li>`)
    .join('')}</ol>`;
}

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const SHORT_DAY = new Intl.DateTimeFormat('fr-CA', { weekday: 'short' });

/** Heure de départ courte pour le mode compact : « 19 h 00 », « sam. 19 h 00 ». */
function shortWhen(date) {
  if (!(date instanceof Date) || isNaN(date)) return '';
  const time = TIME_FMT.format(date);
  return date.toDateString() === new Date().toDateString() ? time : `${SHORT_DAY.format(date)} ${time}`;
}

function scoreSpan(game, team) {
  const key = `${game.id}:${team.id}`;
  const prev = lastScores.get(key);
  const bumped = prev !== undefined && prev !== team.score && game.state === 'in';
  lastScores.set(key, team.score);
  return `<span class="row__score${bumped ? ' team__score--bump' : ''}">${team.score}</span>`;
}

/**
 * Mode compact : une seule ligne par match — logo, pointage | pointage,
 * logo. L'équipe favorite à gauche. Match à venir : l'heure au milieu.
 * En direct, la barre de séparation est rouge. Le détail est en infobulle.
 */
function compactCard(game) {
  const league = LEAGUES_BY_ID[game.leagueId];
  const status = [game.session, game.clock, game.statusText, game.series?.text].filter(Boolean).join(' · ');
  const tip = game.link ? `${status} — cliquer pour ouvrir sur ESPN` : status;
  const link = game.link ? ` data-link="${attr(game.link)}"` : '';
  const cls = `row${game.link ? ' game--link' : ''}${game.state === 'in' ? ' row--live' : ''}`;

  if (game.kind === 'event') {
    const when = game.state === 'pre'
      ? shortWhen(game.startsAt) || game.statusText
      : game.session || game.statusText;
    return `<div class="${cls} game" title="${attr(tip)}"${link}>
      ${crestHtml({ logo: game.logo || league?.logo, abbr: league?.short ?? '?', color: league?.accent })}
      <span class="row__event">${when}</span>
    </div>`;
  }

  const fav = (t) => prefs.favorites.includes(`${game.leagueId}:${t.id}`);
  const [a, b] = fav(game.home) && !fav(game.away) ? [game.home, game.away] : [game.away, game.home];
  const middle = game.state === 'pre'
    ? `<span class="row__when">${shortWhen(game.startsAt) || game.statusText}</span>`
    : `${scoreSpan(game, a)}<span class="row__sep"></span>${scoreSpan(game, b)}`;
  return `<div class="${cls} game" title="${attr(tip)}"${link}>
    ${crestHtml(a)}${middle}${crestHtml(b)}
  </div>`;
}

/** Séries éliminatoires : « 1re ronde · Match 5 · MTL mène la série 3-2 ». */
function seriesLine(series) {
  if (!series) return '';
  const parts = [series.round, series.game ? `Match ${series.game}` : '', series.text].filter(Boolean);
  return `<div class="series">${parts.join(' · ')}</div>`;
}

function gameCard(game) {
  if (prefs.compact) return compactCard(game);
  const league = LEAGUES_BY_ID[game.leagueId];
  const open = game.link ? ` game--link" data-link="${attr(game.link)}" title="Ouvrir sur ESPN` : '';
  const head = `
    <div class="game__head">
      <span class="chip" style="color:${league?.accent ?? 'inherit'}">${league?.label ?? ''}</span>
      ${statusBlock(game)}
    </div>`;

  if (game.kind === 'event') {
    return `<div class="game${open}">${head}
      <div class="event">
        ${crestHtml({ logo: game.logo || league?.logo, abbr: league?.short ?? '?', color: league?.accent })}
        <span class="event__title">${game.title}</span>
      </div>${podiumHtml(game.top3)}</div>`;
  }

  // Après un match terminé, on atténue le perdant.
  const done = game.state === 'post';
  return `<div class="game${open}">${head}
    ${teamRow(game, game.away, done && game.home.winner)}
    ${teamRow(game, game.home, done && game.away.winner)}
    ${seriesLine(game.series)}
  </div>`;
}

function renderEmpty() {
  el.games.innerHTML = `
    <div class="empty">
      Aucune équipe sélectionnée.<br />
      Choisis tes favoris pour les voir ici.
      <br /><button id="btnEmptySettings">Ouvrir les réglages</button>
    </div>`;
  document.getElementById('btnEmptySettings')?.addEventListener('click', openSettings);
}

/**
 * Compare ce relevé au précédent et fait surgir une notification par
 * évènement (but, début, fin…). Le premier relevé sert seulement de référence.
 */
function notifyEvents(games) {
  const events = detectEvents(seen, games);
  seen = remember(seen, games);
  if (!events.length || prefs.notifications === false || !inTauri()) return;

  // L'une après l'autre, dans l'ordre : un but qui attend le nom de son
  // buteur ne doit pas se faire doubler par un évènement survenu après lui.
  (async () => { for (const e of events) await sendToast(e); })();
}

/** Temps maximal accordé à la recherche du buteur avant d'afficher quand même. */
const SCORER_TIMEOUT_MS = 3000;

async function sendToast(e) {
  // But sans buteur connu : on le cherche dans le résumé du match, sans
  // jamais retarder la notification de plus de 3 s.
  if (e.goal) {
    const name = await Promise.race([
      fetchScorer(e.goal.leagueId, e.goal.eventId, e.goal.teamId),
      new Promise((r) => setTimeout(() => r(''), SCORER_TIMEOUT_MS)),
    ]);
    if (name) e = { ...e, title: `But de ${name} !` };
  }
  const color = visibleTeamColor(e.team?.color, e.team?.alt) ?? '#4aa3ff';
  const toast = {
    title: e.title,
    body: e.body,
    link: e.link,
    color,
    team: { abbr: e.team?.abbr ?? '', logo: e.team?.logo ?? '', color },
  };
  await window.__TAURI__.core.invoke('notify', { toast }).catch(() => {});
}

/** Un clic sur un match ouvre sa page ESPN dans le navigateur. */
function bindLinks() {
  el.games.querySelectorAll('.game[data-link]').forEach((card) => {
    card.addEventListener('click', async () => {
      const url = card.dataset.link;
      if (!inTauri()) { window.open(url, '_blank', 'noopener'); return; }
      try {
        await window.__TAURI__.core.invoke('open_espn', { url });
      } catch { /* adresse refusée par Rust : rien à ouvrir */ }
    });
  });
}

/** Liseré et bordure aux couleurs de l'équipe choisie dans les réglages. */
function applyTheme() {
  const info = prefs.favInfo?.[prefs.theme];
  const color = info ? visibleTeamColor(info.color, info.alt) : null;
  el.widget.classList.toggle('widget--team', !!color);
  if (color) el.widget.style.setProperty('--team', color);
  else el.widget.style.removeProperty('--team');
}

/**
 * Réglage « Widget » : Toujours devant, Sur le bureau (toujours affiché,
 * derrière les fenêtres), Pendant un match (en direct), Jamais (notifications
 * seulement). On n'agit qu'aux changements : si tu montres ou
 * caches le widget à la main, il le reste jusqu'au prochain début ou fin de
 * match. Le relevé des scores continue quand il est caché.
 */
let shownByMode;
function applyWidgetMode(hasLive) {
  const mode = prefs.widgetMode ?? 'always';
  const want = mode === 'never' ? false : mode === 'live' ? !!hasLive : true;
  if (want === shownByMode || !inTauri()) return;
  shownByMode = want;
  window.__TAURI__.core.invoke('set_widget_visible', { visible: want }).catch(() => {});
}

/** L'aimant vient de coller le widget à un bord : un éclat le long de ce bord. */
function flashEdges(edges) {
  for (const side of ['left', 'right', 'top', 'bottom']) {
    if (!edges?.[side]) continue;
    const glow = document.createElement('div');
    glow.className = `snapedge snapedge--${side}`;
    el.widget.appendChild(glow);
    setTimeout(() => glow.remove(), 900);
  }
}

/** Transmet à Rust les options qu'il applique lui-même : plein écran, premier plan. */
async function syncFullscreenOption() {
  if (!inTauri()) return;
  try {
    await window.__TAURI__.core.invoke('set_hide_fullscreen', { enabled: prefs.hideFullscreen !== false });
    // Premier plan ou bureau : réglé avant que le widget ne s'affiche.
    await window.__TAURI__.core.invoke('set_widget_on_top', { onTop: prefs.widgetMode !== 'desktop' });
  } catch { /* version sans cette commande : sans conséquence */ }
}

function renderError(message) {
  applyTheme();
  el.widget.classList.toggle('widget--compact', prefs.compact);
  el.widget.style.opacity = String(prefs.opacity ?? 1);
  el.title.textContent = 'Sports Counter';
  el.games.innerHTML = `
    <div class="empty">
      <strong>Scores indisponibles</strong><br />
      <span class="empty__detail">${message}</span>
      <br /><button id="btnRetry">Réessayer</button>
    </div>`;
  document.getElementById('btnRetry')?.addEventListener('click', refresh);
  el.foot.hidden = true;
  fitWindow();
}

function render(games, error) {
  applyTheme();
  el.widget.classList.toggle('widget--compact', prefs.compact);
  el.widget.style.opacity = String(prefs.opacity ?? 1);

  if (!games.length) {
    renderEmpty();
  } else {
    el.games.innerHTML = games.map(gameCard).join('');
  }

  bindCrests(el.games);
  bindLinks();

  const live = games.filter((g) => g.state === 'in').length;
  el.title.textContent = live ? `${live} match${live > 1 ? 's' : ''} en direct` : 'Sports Counter';

  if (error) {
    el.foot.hidden = false;
    el.foot.innerHTML = `<span class="foot__err">Partiel — ${error}</span>`;
  } else {
    el.foot.hidden = true;
  }

  fitWindow();
}

/** Ajuste la hauteur de la fenêtre au contenu réel. */
async function fitWindow() {
  if (!inTauri()) return;
  const box = el.widget.getBoundingClientRect();
  const height = Math.ceil(box.height);
  const width = Math.ceil(box.width);
  try {
    // Côté Rust : un widget collé en bas (ou à droite) grandit par le haut
    // (ou par la gauche), pour rester collé à son bord.
    await window.__TAURI__.core.invoke('fit_widget', { height, width });
  } catch { /* la fenêtre peut être en cours de fermeture */ }
}

/* ---------- Données ---------- */

function selectedLeagues() {
  const fromFavs = prefs.favorites.map((f) => f.split(':')[0]);
  return [...new Set([...fromFavs, ...prefs.leagues])];
}

function keepGame(game) {
  const league = LEAGUES_BY_ID[game.leagueId];
  // Une ligue suivie en entier passe sans filtre.
  if (prefs.leagues.includes(game.leagueId)) return true;
  if (league?.kind === 'event') return false;
  const favIds = prefs.favorites
    .filter((f) => f.startsWith(`${game.leagueId}:`))
    .map((f) => f.split(':')[1]);
  return favIds.includes(game.home?.id) || favIds.includes(game.away?.id);
}

function sortGames(a, b) {
  // En direct d'abord, puis à venir, puis terminés.
  const rank = { in: 0, pre: 1, post: 2 };
  const d = rank[a.state] - rank[b.state];
  if (d !== 0) return d;
  return (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0);
}

/**
 * Vrai pour un match à venir au-delà des 4 prochains jours (aujourd'hui
 * compris, jusqu'à minuit du 4e jour). ESPN renvoie parfois plus loin : la
 * semaine entière pour la NFL, le prochain Grand Prix pour la F1.
 */
function beyondHorizon(game) {
  if (game.state !== 'pre' || !(game.startsAt instanceof Date) || isNaN(game.startsAt)) return false;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() + LOOKAHEAD_DAYS + 1);
  return game.startsAt >= cutoff;
}

function isStale(game) {
  if (!prefs.hideOldFinals || game.state !== 'post' || !game.startsAt) return false;
  return Date.now() - game.startsAt.getTime() > 6 * 3600 * 1000;
}

/**
 * Pour chaque équipe favorite absente des matchs du jour, son prochain match.
 * Sans ça, une équipe au repos aujourd'hui disparaissait complètement du widget.
 */
async function nextGamesForIdleFavorites(todayGames) {
  const playing = new Set();
  for (const g of todayGames) {
    if (g.kind !== 'match') continue;
    playing.add(`${g.leagueId}:${g.home.id}`);
    playing.add(`${g.leagueId}:${g.away.id}`);
  }

  const idleByLeague = new Map();
  for (const fav of prefs.favorites) {
    if (playing.has(fav)) continue;
    const [leagueId, teamId] = fav.split(':');
    if (LEAGUES_BY_ID[leagueId]?.kind !== 'team') continue;
    if (!idleByLeague.has(leagueId)) idleByLeague.set(leagueId, []);
    idleByLeague.get(leagueId).push(teamId);
  }

  const results = await Promise.allSettled(
    [...idleByLeague].map(([leagueId, ids]) => fetchNextGames(leagueId, ids)),
  );
  const seen = new Set(todayGames.map((g) => g.id));
  const out = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const g of r.value) {
      if (!seen.has(g.id)) { seen.add(g.id); out.push(g); }
    }
  }
  return out;
}

async function refresh() {
  prefs = loadPrefs();
  const leagues = selectedLeagues();

  if (!leagues.length) {
    render([], null);
    schedule(false);
    return;
  }

  const results = await Promise.allSettled(leagues.map(fetchScoreboard));
  const games = [];
  let error = null;

  for (const r of results) {
    if (r.status === 'fulfilled') games.push(...r.value);
    else error = errText(r.reason);
  }

  // Tout a échoué : on le dit. Afficher des données de démonstration ferait
  // passer de faux scores pour de vrais.
  if (!games.length && error) {
    renderError(error);
    schedule(false);
    return;
  }

  const today = games.filter(keepGame).filter((g) => !isStale(g) && !beyondHorizon(g));
  const upcoming = await nextGamesForIdleFavorites(today);

  const all = [...today, ...upcoming.filter((g) => !beyondHorizon(g))];
  notifyEvents(all);

  const visible = all.sort(sortGames).slice(0, prefs.maxGames);

  render(visible, error);
  const hasLive = visible.some((g) => g.state === 'in');
  applyWidgetMode(hasLive);
  schedule(hasLive);
}

function schedule(hasLive) {
  clearTimeout(timer);
  timer = setTimeout(refresh, hasLive ? REFRESH_LIVE_MS : REFRESH_IDLE_MS);
}

/* ---------- Actions ---------- */

async function openSettings() {
  if (!inTauri()) { window.location.href = 'settings.html'; return; }
  await window.__TAURI__.core.invoke('open_settings');
}

async function hideWidget() {
  if (!inTauri()) return;
  await window.__TAURI__.window.getCurrentWindow().hide();
}

document.getElementById('btnRefresh').addEventListener('click', refresh);
document.getElementById('btnSettings').addEventListener('click', openSettings);
document.getElementById('btnHide').addEventListener('click', hideWidget);

// Les réglages écrivent dans localStorage : on recharge dès qu'ils changent.
window.addEventListener('storage', (e) => {
  if (!e.key?.startsWith('sports-counter.')) return;
  prefs = loadPrefs();
  shownByMode = undefined; // réglage peut-être changé : réappliquer
  if ((prefs.widgetMode ?? 'always') !== 'live') applyWidgetMode(false);
  syncFullscreenOption();
  refresh();
});

syncFullscreenOption();

if (inTauri()) {
  window.__TAURI__.event.listen('snapped', (e) => flashEdges(e.payload));
  // Le widget démarre caché. « Toujours » : on l'affiche tout de suite.
  // « Pendant un match » : on attend le premier relevé pour savoir.
  if ((prefs.widgetMode ?? 'always') !== 'live') applyWidgetMode(false);
}

// Mode aperçu navigateur : données de démonstration, sans réseau.
if (!inTauri() && new URLSearchParams(location.search).has('demo')) {
  prefs = { ...prefs, maxGames: 4, favorites: [], leagues: ['nhl', 'nba', 'f1'] };
  render(demoEvents(), null);
} else {
  refresh();
}
