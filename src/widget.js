import { fetchScoreboard, fetchNextGames, demoEvents } from './lib/api.js';
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

function gameCard(game) {
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
        ${crestHtml({ logo: game.logo, abbr: league?.short ?? '?', color: league?.accent })}
        <span class="event__title">${game.title}</span>
      </div>${podiumHtml(game.top3)}</div>`;
  }

  // Après un match terminé, on atténue le perdant.
  const done = game.state === 'post';
  return `<div class="game${open}">${head}
    ${teamRow(game, game.away, done && game.home.winner)}
    ${teamRow(game, game.home, done && game.away.winner)}
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

  for (const e of events) {
    const color = visibleTeamColor(e.team?.color, e.team?.alt) ?? '#4aa3ff';
    const toast = {
      title: e.title,
      body: e.body,
      link: e.link,
      color,
      team: { abbr: e.team?.abbr ?? '', logo: e.team?.logo ?? '', color },
    };
    window.__TAURI__.core.invoke('notify', { toast }).catch(() => {});
  }
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

/** Rust surveille le plein écran ; il faut lui dire si l'option est active. */
async function syncFullscreenOption() {
  if (!inTauri()) return;
  try {
    await window.__TAURI__.core.invoke('set_hide_fullscreen', { enabled: prefs.hideFullscreen !== false });
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
  const height = Math.ceil(el.widget.getBoundingClientRect().height);
  try {
    // Côté Rust : un widget posé en bas grandit par le haut, pour rester
    // collé à la barre des tâches.
    await window.__TAURI__.core.invoke('fit_widget', { height });
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

  const today = games.filter(keepGame).filter((g) => !isStale(g));
  const upcoming = await nextGamesForIdleFavorites(today);

  const all = [...today, ...upcoming];
  notifyEvents(all);

  const visible = all.sort(sortGames).slice(0, prefs.maxGames);

  render(visible, error);
  schedule(visible.some((g) => g.state === 'in'));
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
  syncFullscreenOption();
  refresh();
});

syncFullscreenOption();

// Mode aperçu navigateur : données de démonstration, sans réseau.
if (!inTauri() && new URLSearchParams(location.search).has('demo')) {
  prefs = { ...prefs, maxGames: 4, favorites: [], leagues: ['nhl', 'nba', 'f1'] };
  render(demoEvents(), null);
} else {
  refresh();
}
