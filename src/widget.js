import { fetchScoreboard, fetchNextGames, fetchScorer, demoEvents, sameDriver, LOOKAHEAD_DAYS } from './lib/api.js';
import { LEAGUES_BY_ID } from './lib/leagues.js';
import { loadPrefs } from './lib/store.js';
import { errText } from './lib/err.js';
import { crestHtml, bindCrests } from './lib/crest.js';
import { visibleTeamColor } from './lib/color.js';
import { detectEvents, remember } from './lib/events.js';
import { whenText, shortWhen, untilText, isDate, TIME_FMT } from './lib/time.js';

const REFRESH_LIVE_MS = 25_000;   // un match est en cours
const REFRESH_IDLE_MS = 300_000;  // aucun match en cours
const TICK_MS = 30_000;           // comptes à rebours et rappels
const DAY_MS = 24 * 3600 * 1000;
const SIZES = { s: 0.85, m: 1, l: 1.2 };
const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

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
let followed = []; // tous les matchs suivis (pas seulement ceux affichés)
let lastHtml = ''; // dernier rendu : on ne touche pas au DOM s'il est identique
const shownIds = new Set(); // cartes déjà affichées : elles n'ont plus d'animation d'entrée

const inTauri = () => !!window.__TAURI__;
const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* ---------- Rendu ---------- */

function teamRow(game, team, dim) {
  const key = `${game.id}:${team.id}`;
  const prev = lastScores.get(key);
  const bumped = prev !== undefined && prev !== team.score && game.state === 'in';
  lastScores.set(key, team.score);
  const record = team.record ? ` <span class="team__rec">${team.record}</span>` : '';
  return `
    <div class="team${dim ? ' team--loser' : ''}">
      ${crestHtml(team)}
      <span class="team__abbr">${team.abbr}</span>
      <span class="team__name">${team.name}${record}</span>
      <span class="team__score${bumped ? ' team__score--bump' : ''}">${team.score}</span>
    </div>`;
}

/** Compte à rebours, tenu à jour par la minuterie sans redemander les scores. */
function untilSpan(date, short = false) {
  const text = untilText(date, Date.now(), short);
  return text ? `<span class="until" data-start="${date.getTime()}"${short ? ' data-short' : ''}>${text}</span>` : '';
}

/** Moins de 24 h avant le départ : on affiche le compte à rebours. */
const soon = (date) => isDate(date) && date.getTime() - Date.now() < DAY_MS;

function statusBlock(game) {
  if (game.state === 'in') {
    const text = [game.session, game.clock, game.statusText].filter(Boolean).join(' · ');
    return `<span class="status status--live"><span class="dot"></span>${text || 'En direct'}</span>`;
  }
  if (game.state === 'pre' && isDate(game.startsAt)) {
    // Bientôt : l'heure seule suffit, le compte à rebours dit le jour.
    const when = soon(game.startsAt) ? TIME_FMT.format(game.startsAt) : whenText(game.startsAt);
    const text = [game.session, when].filter(Boolean).join(' · ');
    const until = soon(game.startsAt) ? ` · ${untilSpan(game.startsAt)}` : '';
    return `<span class="status">${text}${until}</span>`;
  }
  const text = [game.session, game.statusText].filter(Boolean).join(' · ');
  return `<span class="status">${text}</span>`;
}

/** Photo ronde d'un pilote (repli : rien, la place reste vide). */
const photo = (d) => (d?.photo ? `<img class="face" src="${attr(d.photo)}" alt="" data-face />` : '');

/**
 * Top 3 d'une séance, médailles à l'appui. Le pilote favori est mis en
 * évidence ; s'il n'est pas sur le podium, sa position s'ajoute dessous.
 */
function podiumHtml(game) {
  const top3 = game.top3 ?? [];
  if (!top3.length) return '';
  const fav = prefs.favDriver;
  const line = (d, extra = '') => {
    const isFav = sameDriver(d, fav);
    const medal = MEDALS[d.pos] ?? `<span class="podium__pos">${d.pos}</span>`;
    return `<li class="${isFav ? 'podium__fav' : ''}${extra}">
      <span class="podium__medal">${medal}</span>${isFav ? photo(fav) : ''}${d.short || d.name}</li>`;
  };
  let html = top3.map((d) => line(d)).join('');
  const mine = fav && !top3.some((d) => sameDriver(d, fav))
    ? (game.results ?? []).find((d) => sameDriver(d, fav))
    : null;
  if (mine) html += line(mine, ' podium__extra');
  return `<ol class="podium">${html}</ol>`;
}

/** Tirs au but (hockey), quand ESPN les donne dans le tableau des scores. */
function shotsLine(game) {
  if (game.state === 'pre' || !game.away.shots || !game.home.shots) return '';
  return `<div class="shots"><span>Tirs au but</span><b>${game.away.shots}</b><i></i><b>${game.home.shots}</b></div>`;
}

function scoreSpan(game, team) {
  const key = `${game.id}:${team.id}`;
  const prev = lastScores.get(key);
  const bumped = prev !== undefined && prev !== team.score && game.state === 'in';
  lastScores.set(key, team.score);
  return `<span class="row__score${bumped ? ' team__score--bump' : ''}">${team.score}</span>`;
}

/** Attributs d'une carte cliquable : ouvre la fenêtre « Match ». */
function cardAttrs(game, cls, tip) {
  const fresh = shownIds.has(game.id) ? '' : ' game--new';
  return `class="${cls} game game--link${fresh}" data-league="${game.leagueId}" data-event="${attr(game.id)}" title="${attr(tip)}"`;
}

/**
 * Mode compact : une seule ligne par match — logo, pointage | pointage,
 * logo. L'équipe favorite à gauche. Match à venir : l'heure ou le compte à
 * rebours au milieu. En direct, la barre de séparation est rouge.
 */
function compactCard(game) {
  const league = LEAGUES_BY_ID[game.leagueId];
  const status = [game.session, game.clock, game.statusText, game.series?.text].filter(Boolean).join(' · ');
  const tip = `${status} — cliquer pour les détails`;
  const cls = `row${game.state === 'in' ? ' row--live' : ''}`;
  const pre = game.state === 'pre';
  const middleWhen = pre && soon(game.startsAt)
    ? untilSpan(game.startsAt, true) || shortWhen(game.startsAt)
    : shortWhen(game.startsAt) || game.statusText;

  if (game.kind === 'event') {
    const leader = game.state !== 'pre' ? game.top3?.[0] : null;
    const when = pre ? middleWhen : leader ? `🥇 ${leader.short || leader.name}` : game.session || game.statusText;
    return `<div ${cardAttrs(game, cls, tip)}>
      ${crestHtml({ logo: game.logo || league?.logo, abbr: league?.short ?? '?', color: league?.accent })}
      <span class="row__event">${when}</span>
    </div>`;
  }

  const fav = (t) => prefs.favorites.includes(`${game.leagueId}:${t.id}`);
  const [a, b] = fav(game.home) && !fav(game.away) ? [game.home, game.away] : [game.away, game.home];
  const middle = pre
    ? `<span class="row__when">${middleWhen}</span>`
    : `${scoreSpan(game, a)}<span class="row__sep"></span>${scoreSpan(game, b)}`;
  return `<div ${cardAttrs(game, cls, tip)}>
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
  const head = `
    <div class="game__head">
      <span class="chip" style="color:${league?.accent ?? 'inherit'}">${league?.label ?? ''}</span>
      ${statusBlock(game)}
    </div>`;

  if (game.kind === 'event') {
    return `<div ${cardAttrs(game, '', 'Cliquer pour le classement complet')}>${head}
      <div class="event">
        ${crestHtml({ logo: game.logo || league?.logo, abbr: league?.short ?? '?', color: league?.accent })}
        <span class="event__title">${game.title}</span>
      </div>${podiumHtml(game)}</div>`;
  }

  // Après un match terminé, on atténue le perdant.
  const done = game.state === 'post';
  return `<div ${cardAttrs(game, '', 'Cliquer pour les détails du match')}>${head}
    ${teamRow(game, game.away, done && game.home.winner)}
    ${teamRow(game, game.home, done && game.away.winner)}
    ${shotsLine(game)}
    ${seriesLine(game.series)}
  </div>`;
}

function emptyHtml() {
  return `
    <div class="empty">
      Aucune équipe sélectionnée.<br />
      Choisis tes favoris pour les voir ici.
      <br /><button id="btnEmptySettings">Ouvrir les réglages</button>
    </div>`;
}

/**
 * Compare ce relevé au précédent et fait surgir une notification par
 * évènement (but, début, fin…). Le premier relevé sert seulement de référence.
 */
function notifyEvents(games) {
  const opts = { favDriver: prefs.favDriver };
  const events = detectEvents(seen, games, opts);
  seen = remember(seen, games, opts);
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
    team: { abbr: e.team?.abbr ?? '', logo: e.team?.logo ?? '', color, round: !!e.team?.round },
  };
  await window.__TAURI__.core.invoke('notify', { toast }).catch(() => {});
}

/* ---------- Rappels avant le match ---------- */

const REMINDED_KEY = 'sports-counter.reminded';

function loadReminded() {
  try {
    const all = JSON.parse(localStorage.getItem(REMINDED_KEY) ?? '{}');
    // On oublie les rappels de plus de deux jours.
    const cutoff = Date.now() - 2 * DAY_MS;
    return Object.fromEntries(Object.entries(all).filter(([, at]) => at > cutoff));
  } catch {
    return {};
  }
}

/** Notification quelques minutes avant un match ou une séance suivis. */
function checkReminders() {
  const minutes = Number(prefs.reminderMinutes) || 0;
  if (!minutes || prefs.notifications === false || !inTauri()) return;
  const now = Date.now();
  let reminded = null;
  for (const g of followed) {
    if (g.state !== 'pre' || !isDate(g.startsAt)) continue;
    const left = g.startsAt.getTime() - now;
    if (left <= 0 || left > minutes * 60000) continue;
    reminded ??= loadReminded();
    const key = `${g.id}:${g.session ?? ''}`;
    if (reminded[key]) continue;
    reminded[key] = now;

    const until = untilText(g.startsAt, now);
    if (g.kind === 'match') {
      const fav = prefs.favorites.includes(`${g.leagueId}:${g.home.id}`) ? g.home : g.away;
      sendToast({
        title: `Le match commence ${until}`,
        body: `${g.away.abbr} @ ${g.home.abbr} · ${TIME_FMT.format(g.startsAt)}`,
        team: fav,
        link: g.link,
      });
    } else {
      const league = LEAGUES_BY_ID[g.leagueId];
      sendToast({
        title: `${g.session || 'Séance'} ${until}`,
        body: `${g.title} · ${TIME_FMT.format(g.startsAt)}`,
        team: { abbr: league?.short ?? '', logo: g.logo || league?.logo || '', color: '#ff4d6d' },
        link: g.link,
      });
    }
  }
  if (reminded) {
    try { localStorage.setItem(REMINDED_KEY, JSON.stringify(reminded)); } catch { /* plein */ }
  }
}

/**
 * Toutes les 30 s : comptes à rebours et rappels, sans toucher au réseau.
 * Un match dont l'heure est passée déclenche un relevé, pour le voir commencer.
 */
function tick() {
  let started = false;
  el.games.querySelectorAll('[data-start]').forEach((node) => {
    const text = untilText(new Date(Number(node.dataset.start)), Date.now(), 'short' in node.dataset);
    if (!text) started = true;
    if (node.textContent !== text) node.textContent = text || 'maintenant';
  });
  checkReminders();
  if (started) refresh();
}

/* ---------- Clics ---------- */

/** Un clic sur un match ouvre sa fenêtre de détail dans l'app. */
function bindCards() {
  el.games.querySelectorAll('.game[data-event]').forEach((card) => {
    card.addEventListener('click', async () => {
      const { league, event } = card.dataset;
      if (!inTauri()) { window.open(`match.html?league=${league}&event=${encodeURIComponent(event)}`, '_blank'); return; }
      try {
        await window.__TAURI__.core.invoke('open_match', { league, event });
      } catch { /* fenêtre indisponible */ }
    });
  });
  document.getElementById('btnEmptySettings')?.addEventListener('click', openSettings);
  // Photo de pilote introuvable : on la retire plutôt que d'afficher une image cassée.
  el.games.querySelectorAll('img[data-face]').forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
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

/** Apparence : couleur, compact, opacité, taille. */
function applyLook() {
  applyTheme();
  el.widget.classList.toggle('widget--compact', prefs.compact);
  el.widget.style.opacity = String(prefs.opacity ?? 1);
  el.widget.style.zoom = String(SIZES[prefs.widgetSize] ?? 1);
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

/** Remplace le contenu seulement s'il a changé : pas de clignotement ni de travail inutile. */
function paint(html, footHtml) {
  const key = `${html}|${footHtml}|${prefs.compact}|${prefs.widgetSize}|${prefs.opacity}|${prefs.theme}`;
  applyLook();
  if (key === lastHtml) return;
  lastHtml = key;
  el.games.innerHTML = html;
  el.foot.hidden = !footHtml;
  el.foot.innerHTML = footHtml;
  bindCrests(el.games);
  bindCards();
  fitWindow();
}

function renderError(message) {
  el.title.textContent = 'Sports Counter';
  paint(`
    <div class="empty">
      <strong>Scores indisponibles</strong><br />
      <span class="empty__detail">${message}</span>
      <br /><button id="btnRetry">Réessayer</button>
    </div>`, '');
  document.getElementById('btnRetry')?.addEventListener('click', () => refresh(true));
}

function render(games, error) {
  const html = games.length ? games.map(gameCard).join('') : emptyHtml();
  games.forEach((g) => shownIds.add(g.id));

  const live = games.filter((g) => g.state === 'in').length;
  el.title.textContent = live ? `${live} match${live > 1 ? 's' : ''} en direct` : 'Sports Counter';
  paint(html, error ? `<span class="foot__err">Partiel — ${error}</span>` : '');
}

/** Ajuste la taille de la fenêtre au contenu réel (zoom compris). */
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
  if (game.state !== 'pre' || !isDate(game.startsAt)) return false;
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
  const known = new Set(todayGames.map((g) => g.id));
  const out = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const g of r.value) {
      if (!known.has(g.id)) { known.add(g.id); out.push(g); }
    }
  }
  return out;
}

/*
 * Relevé par ligue, gardé entre deux rafraîchissements. Pendant un match, on
 * ne redemande toutes les 25 s que les ligues qui ont un match en cours (ou
 * sur le point de commencer) ; les autres gardent leur relevé jusqu'à 5 min.
 */
const boards = new Map(); // idLigue -> { at, games }
const SOON_MS = 10 * 60 * 1000;

function boardIsHot(games) {
  const now = Date.now();
  return games.some((g) => g.state === 'in'
    || (g.state === 'pre' && isDate(g.startsAt) && g.startsAt.getTime() - now < SOON_MS));
}

async function loadBoard(leagueId, force) {
  const hit = boards.get(leagueId);
  const age = hit ? Date.now() - hit.at : Infinity;
  const fresh = hit && (boardIsHot(hit.games) ? age < REFRESH_LIVE_MS - 2000 : age < REFRESH_IDLE_MS - 5000);
  if (fresh && !force) return hit.games;
  const games = await fetchScoreboard(leagueId);
  boards.set(leagueId, { at: Date.now(), games });
  return games;
}

let refreshing = null;
function refresh(force = false) {
  // Un relevé à la fois : un clic pendant un relevé ne le double pas.
  refreshing ??= doRefresh(force).finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh(force) {
  prefs = loadPrefs();
  const leagues = selectedLeagues();

  if (!leagues.length) {
    followed = [];
    render([], null);
    schedule(false, []);
    return;
  }

  // Hors ligne : inutile d'insister, on reprend au retour du réseau.
  if (navigator.onLine === false && !boards.size) {
    renderError('Pas de connexion Internet.');
    schedule(false, []);
    return;
  }

  const results = await Promise.allSettled(leagues.map((id) => loadBoard(id, force)));
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
    schedule(false, []);
    return;
  }

  const today = games.filter(keepGame).filter((g) => !isStale(g) && !beyondHorizon(g));
  const upcoming = await nextGamesForIdleFavorites(today);

  followed = [...today, ...upcoming.filter((g) => !beyondHorizon(g))].sort(sortGames);
  notifyEvents(followed);
  checkReminders();

  const visible = followed.slice(0, prefs.maxGames);
  render(visible, error);
  const hasLive = visible.some((g) => g.state === 'in');
  applyWidgetMode(hasLive);
  schedule(hasLive, followed);
}

/**
 * Prochain relevé : 25 s pendant un match, sinon 5 min — mais jamais après
 * l'heure de départ d'un match suivi, pour le voir commencer à temps.
 */
function schedule(hasLive, games) {
  clearTimeout(timer);
  let delay = hasLive ? REFRESH_LIVE_MS : REFRESH_IDLE_MS;
  const now = Date.now();
  for (const g of games) {
    if (g.state !== 'pre' || !isDate(g.startsAt)) continue;
    const until = g.startsAt.getTime() - now + 15_000;
    if (until > 0) delay = Math.min(delay, Math.max(until, REFRESH_LIVE_MS));
  }
  timer = setTimeout(refresh, delay);
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

document.getElementById('btnRefresh').addEventListener('click', () => refresh(true));
document.getElementById('btnSettings').addEventListener('click', openSettings);
document.getElementById('btnHide').addEventListener('click', hideWidget);

// Les réglages écrivent dans localStorage : on recharge dès qu'ils changent.
window.addEventListener('storage', (e) => {
  if (!e.key?.startsWith('sports-counter.') || e.key === REMINDED_KEY) return;
  if (e.key.startsWith('sports-counter.teams.') || e.key.startsWith('sports-counter.drivers.')) return;
  prefs = loadPrefs();
  shownByMode = undefined; // réglage peut-être changé : réappliquer
  if ((prefs.widgetMode ?? 'always') !== 'live') applyWidgetMode(false);
  syncFullscreenOption();
  refresh();
});

// Retour du réseau (sortie de veille, Wi-Fi retrouvé) : relevé immédiat.
window.addEventListener('online', () => refresh(true));

syncFullscreenOption();
setInterval(tick, TICK_MS);

if (inTauri()) {
  window.__TAURI__.event.listen('snapped', (e) => flashEdges(e.payload));
  // Le widget démarre caché. « Toujours » : on l'affiche tout de suite.
  // « Pendant un match » : on attend le premier relevé pour savoir.
  if ((prefs.widgetMode ?? 'always') !== 'live') applyWidgetMode(false);
}

// Mode aperçu navigateur : données de démonstration, sans réseau.
if (!inTauri() && new URLSearchParams(location.search).has('demo')) {
  prefs = { ...prefs, maxGames: 5, favorites: [], leagues: ['nhl', 'nba', 'f1'],
    favDriver: { id: 'demo-ant', name: 'Andrea Kimi Antonelli', short: 'K. Antonelli', photo: '' } };
  render(demoEvents(), null);
} else {
  refresh();
}
