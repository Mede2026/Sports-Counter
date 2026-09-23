import { LEAGUES, LEAGUES_BY_ID, isWholeLeague, sportOf } from './lib/leagues.js';
import { loadPrefs, savePrefs } from './lib/store.js';
import { fetchTeams, fetchDrivers, fetchFighters, fetchRoster, fetchTeamGames, fetchLeagueCalendar, fetchStandingsTable, fetchF1Standings, fetchLeagueLeaders, fetchAthlete, STANDING_COLS, demoEvents, sameDriver } from './lib/api.js';
import { untilText, isDate, dayName, TIME_FMT } from './lib/time.js';
import { DEFAULT_SHORTCUTS, comboFromEvent, shortcutLabel } from './lib/shortcut.js';
import { DEMO_TEAMS } from './lib/demo.js';
import { crestHtml, bindCrests } from './lib/crest.js';
import { errText, isOffline, OFFLINE_TITLE, OFFLINE_HINT } from './lib/err.js';
import { visibleTeamColor } from './lib/color.js';
import { NHL_TEAMS } from './lib/teams-nhl.js';
import { autoFr, TRANSLATED_EVENT } from './lib/translate.js';

const IS_DEMO = new URLSearchParams(location.search).has('demo');
const inTauri = () => !!window.__TAURI__;

const el = {
  leagues: document.getElementById('leagues'),
  teams: document.getElementById('teams'),
  search: document.getElementById('search'),
  summary: document.getElementById('summary'),
  teamsView: document.getElementById('teamsView'),
  prefsView: document.getElementById('prefsView'),
  calendarView: document.getElementById('calendarView'),
  standingsView: document.getElementById('standingsView'),
  standings: document.getElementById('standings'),
  navStandings: document.getElementById('navStandings'),
  playersView: document.getElementById('playersView'),
  navPrefs: document.getElementById('navPrefs'),
  navCalendar: document.getElementById('navCalendar'),
  calendar: document.getElementById('calendar'),
  players: document.getElementById('players'),
};

let prefs = loadPrefs();
let current = LEAGUES[0].id;
// Textes d'ESPN traduits entre-temps : on redessine le classement affiché.
window.addEventListener(TRANSLATED_EVENT, () => { if (view === 'standings') loadStandings(); });

let view = 'teams'; // 'teams' (une ligue), 'prefs' (Réglages), 'calendar', 'players'
let teams = [];
let query = '';
const cache = new Map(); // idLigue -> équipes
let drivers = null; // pilotes de F1 : null = pas encore chargés
let driversErr = null;

const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"
  stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>`;

/* ---------- Colonne des ligues ---------- */

function countFor(id) {
  if (isWholeLeague(id)) return prefs.leagues.includes(id) ? 1 : 0;
  return prefs.favorites.filter((f) => f.startsWith(`${id}:`)).length;
}

function renderLeagues() {
  el.navPrefs.classList.toggle('league--on', view === 'prefs' || view === 'players');
  el.navCalendar.classList.toggle('league--on', view === 'calendar');
  el.navStandings.classList.toggle('league--on', view === 'standings');
  // Rangées par sport : un petit titre au début de chaque groupe.
  el.leagues.innerHTML = LEAGUES.map((l, i) => {
    const n = countFor(l.id);
    const title = l.group !== LEAGUES[i - 1]?.group ? `<div class="league-group">${l.group}</div>` : '';
    return `${title}<button class="league${view === 'teams' && l.id === current ? ' league--on' : ''}" data-id="${l.id}">
      <span class="league__dot" style="background:${l.accent}"></span>
      <span>${l.label}</span>
      ${n ? `<span class="league__count">${n}</span>` : ''}
    </button>`;
  }).join('');

  el.leagues.querySelectorAll('.league').forEach((b) => {
    b.addEventListener('click', () => showLeague(b.dataset.id));
  });

  const total = prefs.favorites.length + prefs.leagues.length;
  el.summary.textContent = total ? `${total} sélection${total > 1 ? 's' : ''}` : 'aucune sélection';
}

/* ---------- Liste des équipes ---------- */

function renderTeams() {
  const league = LEAGUES_BY_ID[current];

  // Les ligues « évènement » (F1) se suivent en entier ; on y choisit son pilote.
  if (league.kind === 'event') {
    renderF1(league);
    return;
  }
  // UFC : on suit tous les galas.
  if (league.kind === 'card') {
    renderWhole(league);
    return;
  }

  const q = query.trim().toLowerCase();
  const list = q ? teams.filter((t) => `${t.name} ${t.abbr}`.toLowerCase().includes(q)) : teams;

  if (!list.length) {
    el.teams.innerHTML = `<div class="state">Aucune équipe ne correspond à « ${query} ».</div>`;
    return;
  }

  el.teams.innerHTML = list.map((t) => {
    const on = prefs.favorites.includes(`${current}:${t.id}`);
    const crest = crestHtml(t, 'crest-sm');
    return `<div class="team-row${on ? ' team-row--on' : ''}" data-id="${t.id}">
      <span class="check">${CHECK}</span>
      ${crest}
      <span class="team-row__name">${t.name}</span>
      <span class="team-row__abbr">${t.abbr}</span>
    </div>`;
  }).join('');

  bindCrests(el.teams);
  el.teams.querySelectorAll('.team-row').forEach((row) => {
    row.addEventListener('click', () => toggleTeam(row.dataset.id));
  });
}

/** Bloc d'erreur : message clair quand c'est la connexion Internet. */
function errorBlock(title, err, extra = '') {
  if (isOffline(err)) {
    return `<div class="state"><div class="state__icon">📡</div><strong>${OFFLINE_TITLE}</strong><br />${OFFLINE_HINT}${extra}</div>`;
  }
  return `<div class="state state--err"><strong>${title}</strong><br />
    <code class="state__code">${errText(err)}</code>${extra}</div>`;
}

/* ---------- UFC : suivre les galas, choisir ses combattants ---------- */

let fighters = null; // null = pas encore chargés
let fightersErr = null;

function renderWhole(league) {
  const on = prefs.leagues.includes(league.id);
  const q = query.trim().toLowerCase();
  const favs = prefs.favFighters ?? [];
  let list = '';
  if (fightersErr) {
    list = errorBlock('Impossible de charger les combattants.', fightersErr,
      '<br /><button class="ghost" id="btnRetryFighters">Réessayer</button>');
  } else if (!fighters) {
    list = '<div class="state">Chargement des combattants…</div>';
  } else {
    // Tes favoris d'abord, puis tous les autres (filtrés par la recherche).
    const shown = (q ? fighters.filter((f) => `${f.name} ${f.weight}`.toLowerCase().includes(q)) : fighters)
      .map((f) => ({ f, mine: favs.some((x) => sameDriver(f, x)) }))
      .sort((a, b) => Number(b.mine) - Number(a.mine));
    list = shown.map(({ f, mine }) => `
      <div class="team-row driver-row${mine ? ' team-row--on' : ''}" data-fighter="${f.id}">
        <span class="check">${CHECK}</span>
        ${f.photo ? `<img class="face-sm" src="${f.photo}" alt="" data-face />` : '<span class="face-sm"></span>'}
        <span class="team-row__name">${f.name}${f.record ? ` <small class="st__muted">${f.record}</small>` : ''}</span>
        <span class="team-row__abbr">${autoFr(f.weight)}</span>
      </div>`).join('') || `<div class="state">Aucun combattant ne correspond à « ${query} ».</div>`;
  }

  el.teams.innerHTML = `
    <div class="team-row${on ? ' team-row--on' : ''}" id="rowFollowWhole">
      <span class="check">${CHECK}</span>
      <span class="crest-sm" style="background:${league.accent}">${league.short}</span>
      <span class="team-row__name">Suivre tous les galas de l'${league.label}</span>
    </div>
    <div class="subhead">Tes combattants favoris <small>coche-en autant que tu veux : leur combat est mis en évidence, avec un rappel avant et une notification quand ils gagnent ou perdent</small></div>
    ${list}`;
  el.teams.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true }));
  document.getElementById('rowFollowWhole').addEventListener('click', toggleLeague);
  document.getElementById('btnRetryFighters')?.addEventListener('click', () => { fightersErr = null; loadFighters(); });
  el.teams.querySelectorAll('[data-fighter]').forEach((row) => row.addEventListener('click', () => pickFighter(row.dataset.fighter)));
}

async function loadFighters() {
  if (fighters) return;
  renderTeams();
  try {
    fighters = IS_DEMO ? demoFighters() : await fetchFighters();
  } catch (err) {
    fightersErr = err;
  }
  if (current === 'ufc' && view === 'teams') renderTeams();
}

/** Coche ou décoche un combattant favori ; en choisir un, c'est suivre l'UFC. */
function pickFighter(id) {
  const f = fighters?.find((x) => x.id === id);
  if (!f) return;
  prefs.favFighters ??= [];
  const i = prefs.favFighters.findIndex((x) => sameDriver(f, x));
  if (i === -1) prefs.favFighters.push({ id: f.id, name: f.name, short: f.short, photo: f.photo });
  else prefs.favFighters.splice(i, 1);
  if (prefs.favFighters.length && !prefs.leagues.includes('ufc')) prefs.leagues.push('ufc');
  savePrefs(prefs);
  renderLeagues();
  renderTeams();
  renderFavFighters();
}

function renderFavFighters() {
  const favs = prefs.favFighters ?? [];
  const box = document.getElementById('favFightersTxt');
  if (!box) return;
  box.innerHTML = favs.length
    ? `<b>Combattants favoris</b><span class="chips">${favs.map((f) => `<span class="chip-player">${f.photo ? `<img class="face-xs" src="${f.photo}" alt="" />` : ''}${f.name}</span>`).join('')}</span>`
    : '<b>Combattants favoris</b><small>Aucun</small>';
}

function demoFighters() {
  return [['Alex Pereira', '12-2-0', 'Mi-lourds'], ['Magomed Ankalaev', '20-1-1', 'Mi-lourds'], ['Islam Makhachev', '27-1-0', 'Poids légers'],
    ['Merab Dvalishvili', '19-4-0', 'Poids coqs'], ['Jiri Prochazka', '31-5-1', 'Mi-lourds']]
    .map(([name, record, weight], i) => ({ id: `f${i}`, name, short: name, record, weight, photo: '' }));
}

/* ---------- F1 : suivre la saison, choisir son pilote ---------- */

function renderF1(league) {
  const on = prefs.leagues.includes(current);
  const q = query.trim().toLowerCase();
  const favs = prefs.favDrivers ?? [];
  let list = '';
  if (driversErr) {
    list = errorBlock('Impossible de charger les pilotes.', driversErr,
      '<br /><button class="ghost" id="btnRetryDrivers">Réessayer</button>');
  } else if (!drivers) {
    list = '<div class="state">Chargement des pilotes…</div>';
  } else {
    const shown = q ? drivers.filter((d) => `${d.name} ${d.team}`.toLowerCase().includes(q)) : drivers;
    list = shown.map((d) => {
      const mine = favs.some((f) => sameDriver(d, f));
      return `<div class="team-row driver-row${mine ? ' team-row--on' : ''}" data-driver="${d.id}">
        <span class="check">${CHECK}</span>
        ${d.photo ? `<img class="face-sm" src="${d.photo}" alt="" data-face />` : '<span class="face-sm"></span>'}
        <span class="team-row__name">${d.name}</span>
        <span class="team-row__abbr">${d.team ?? ''}</span>
      </div>`;
    }).join('') || `<div class="state">Aucun pilote ne correspond à « ${query} ».</div>`;
  }

  el.teams.innerHTML = `
    <div class="team-row${on ? ' team-row--on' : ''}" id="rowFollowF1">
      <span class="check">${CHECK}</span>
      ${crestHtml({ logo: league.logo, abbr: league.short, color: league.accent }, 'crest-sm')}
      <span class="team-row__name">Suivre toute la ${league.label}</span>
    </div>
    <div class="subhead">Tes pilotes favoris <small>coche-en autant que tu veux : mis en évidence dans le widget, avec des notifications s'ils prennent la tête ou montent sur le podium</small></div>
    ${list}`;
  bindCrests(el.teams);
  el.teams.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true }));
  document.getElementById('rowFollowF1').addEventListener('click', toggleLeague);
  document.getElementById('btnRetryDrivers')?.addEventListener('click', () => { driversErr = null; loadDrivers(); });
  el.teams.querySelectorAll('.driver-row').forEach((row) => {
    row.addEventListener('click', () => pickDriver(row.dataset.driver));
  });
}

async function loadDrivers() {
  if (drivers) return;
  renderTeams();
  try {
    drivers = IS_DEMO
      ? demoEvents().find((e) => e.leagueId === 'f1').results
      : await fetchDrivers();
  } catch (err) {
    driversErr = err;
  }
  if (current === 'f1' && view === 'teams') renderTeams();
}

/** Coche ou décoche un pilote favori (autant qu'on veut). */
function pickDriver(id) {
  const d = drivers?.find((x) => x.id === id);
  if (!d) return;
  prefs.favDrivers ??= [];
  const i = prefs.favDrivers.findIndex((f) => sameDriver(d, f));
  if (i === -1) prefs.favDrivers.push({ id: d.id, name: d.name, short: d.short, photo: d.photo, team: d.team ?? '' });
  else prefs.favDrivers.splice(i, 1);
  // Choisir un pilote, c'est aussi suivre la F1.
  if (prefs.favDrivers.length && !prefs.leagues.includes('f1')) prefs.leagues.push('f1');
  savePrefs(prefs);
  renderLeagues();
  renderTeams();
  renderFavDriver();
}

function renderFavDriver() {
  const favs = prefs.favDrivers ?? [];
  const title = `<b>Pilote${favs.length > 1 ? 's' : ''} favori${favs.length > 1 ? 's' : ''}</b>`;
  document.getElementById('favDriverTxt').innerHTML = favs.length
    ? `${title}<span class="chips">${favs.map((f) => `<span class="chip-player">${f.photo ? `<img class="face-xs" src="${f.photo}" alt="" />` : ''}${f.name}</span>`).join('')}</span>`
    : `${title}<small>Aucun</small>`;
}

/* ---------- Navigation ---------- */

/** Affiche un seul des panneaux de droite. */
function setView(name) {
  view = name;
  el.teamsView.hidden = name !== 'teams';
  el.prefsView.hidden = name !== 'prefs';
  el.calendarView.hidden = name !== 'calendar';
  el.standingsView.hidden = name !== 'standings';
  el.playersView.hidden = name !== 'players';
  renderLeagues();
}

function showLeague(id) {
  current = id;
  query = '';
  el.search.value = '';
  const kind = LEAGUES_BY_ID[id]?.kind;
  el.search.placeholder = kind === 'event' ? 'Rechercher un pilote…' : kind === 'card' ? 'Rechercher un combattant…' : 'Rechercher une équipe…';
  setView('teams');
  selectLeague();
}

function showPrefs() {
  setView('prefs');
}

function forgetFavorite(key) {
  delete prefs.favInfo[key];
  if (prefs.theme === key) prefs.theme = '';
}

function toggleTeam(id) {
  const key = `${current}:${id}`;
  const i = prefs.favorites.indexOf(key);
  if (i === -1) {
    prefs.favorites.push(key);
    // Nom et couleurs gardés maintenant : le widget en a besoin pour se
    // colorer, sans redemander la liste des équipes à ESPN.
    const t = teams.find((x) => x.id === id);
    if (t) prefs.favInfo[key] = { name: t.name, abbr: t.abbr, color: t.color, alt: t.alt ?? null };
  } else {
    prefs.favorites.splice(i, 1);
    forgetFavorite(key);
  }
  savePrefs(prefs);
  renderLeagues();
  renderTeams();
  renderThemeOptions();
}

/**
 * Favoris cochés avant l'arrivée des couleurs d'équipe : on complète leur
 * nom et leurs couleurs dès que la liste de leur ligue est chargée.
 */
function backfillFavInfo(leagueId, list) {
  let changed = false;
  for (const key of prefs.favorites) {
    if (!key.startsWith(`${leagueId}:`) || prefs.favInfo[key]) continue;
    const t = list.find((x) => `${leagueId}:${x.id}` === key);
    if (!t) continue;
    prefs.favInfo[key] = { name: t.name, abbr: t.abbr, color: t.color, alt: t.alt ?? null };
    changed = true;
  }
  if (changed) { savePrefs(prefs); renderThemeOptions(); }
}

function renderThemeOptions() {
  const select = document.getElementById('optTheme');
  const favs = prefs.favorites.filter((k) => prefs.favInfo[k]?.color);
  select.innerHTML = [
    `<option value="">Aucune (neutre)</option>`,
    ...favs.map((k) => `<option value="${k}">${prefs.favInfo[k].name}</option>`),
  ].join('');
  select.value = favs.includes(prefs.theme) ? prefs.theme : '';
  select.disabled = !favs.length;
}

function toggleLeague() {
  const i = prefs.leagues.indexOf(current);
  if (i === -1) prefs.leagues.push(current);
  else prefs.leagues.splice(i, 1);
  savePrefs(prefs);
  renderLeagues();
  renderTeams();
}

async function selectLeague() {
  renderLeagues();
  const league = LEAGUES_BY_ID[current];

  if (league.kind === 'event') { renderTeams(); loadDrivers(); return; }
  if (league.kind === 'card') { renderTeams(); loadFighters(); return; }

  if (cache.has(current)) { teams = cache.get(current); renderTeams(); return; }

  if (IS_DEMO) { teams = DEMO_TEAMS; cache.set(current, teams); renderTeams(); return; }

  el.teams.innerHTML = `<div class="state">Chargement des équipes…</div>`;
  try {
    teams = await fetchTeams(current);
    cache.set(current, teams);
    backfillFavInfo(current, teams);
    renderTeams();
  } catch (err) {
    teams = [];
    el.teams.innerHTML = errorBlock('Impossible de charger les équipes.', err,
      '<br /><button class="ghost" id="btnRetryTeams">Réessayer</button>');
    document.getElementById('btnRetryTeams')?.addEventListener('click', () => {
      cache.delete(current);
      selectLeague();
    });
  }
}

/* ---------- Options ---------- */

function bindOptions() {
  const compact = document.getElementById('optCompact');
  const hideOld = document.getElementById('optHideOld');
  const max = document.getElementById('optMax');
  const opacity = document.getElementById('optOpacity');

  compact.checked = prefs.compact;
  hideOld.checked = prefs.hideOldFinals;
  max.value = prefs.maxGames;
  opacity.value = Math.round((prefs.opacity ?? 1) * 100);

  compact.addEventListener('change', () => { prefs.compact = compact.checked; savePrefs(prefs); });
  hideOld.addEventListener('change', () => { prefs.hideOldFinals = hideOld.checked; savePrefs(prefs); });
  max.addEventListener('change', () => {
    prefs.maxGames = Math.min(10, Math.max(1, Number(max.value) || 4));
    max.value = prefs.maxGames;
    savePrefs(prefs);
  });
  opacity.addEventListener('input', () => { prefs.opacity = Number(opacity.value) / 100; savePrefs(prefs); });

  const theme = document.getElementById('optTheme');
  renderThemeOptions();
  theme.addEventListener('change', () => { prefs.theme = theme.value; savePrefs(prefs); });

  const fullscreen = document.getElementById('optHideFullscreen');
  fullscreen.checked = prefs.hideFullscreen !== false;
  fullscreen.addEventListener('change', () => { prefs.hideFullscreen = fullscreen.checked; savePrefs(prefs); });

  const mode = document.getElementById('optWidgetMode');
  mode.value = prefs.widgetMode ?? 'always';
  mode.addEventListener('change', () => {
    prefs.widgetMode = mode.value;
    // Sans widget ni notifications, l'app ne montrerait plus rien.
    if (mode.value === 'never' && prefs.notifications === false) {
      prefs.notifications = true;
      document.getElementById('optNotify').checked = true;
    }
    savePrefs(prefs);
  });

  const size = document.getElementById('optSize');
  const paintSize = () => size.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('seg--on', b.dataset.size === (prefs.widgetSize ?? 'm'));
  });
  paintSize();
  size.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-size]');
    if (!b) return;
    prefs.widgetSize = b.dataset.size;
    savePrefs(prefs);
    paintSize();
  });

  const reminder = document.getElementById('optReminder');
  reminder.value = String(prefs.reminderMinutes ?? 15);
  reminder.addEventListener('change', () => { prefs.reminderMinutes = Number(reminder.value); savePrefs(prefs); });

  renderFavDriver();
  document.getElementById('btnPickDriver').addEventListener('click', () => showLeague('f1'));
  renderFavFighters();
  document.getElementById('btnPickFighters').addEventListener('click', () => showLeague('ufc'));

  const look = document.getElementById('optWidgetTheme');
  look.value = prefs.widgetTheme ?? 'dark';
  look.addEventListener('change', () => { prefs.widgetTheme = look.value; savePrefs(prefs); });

  bindSwitch('optShowForm', 'showForm');
  bindSwitch('optTranslate', 'translate');
  bindSwitch('optGpMode', 'gpMode');

  renderPlayerChips();
  document.getElementById('btnPickPlayers').addEventListener('click', showPlayers);

  bindShortcuts();

  const notify = document.getElementById('optNotify');
  notify.checked = prefs.notifications !== false;
  notify.addEventListener('change', () => { prefs.notifications = notify.checked; savePrefs(prefs); });
  document.getElementById('btnTryToast').addEventListener('click', tryToast);

  bindAutostart();
}

/* ---------- Raccourcis clavier ---------- */

const KEY_IDS = { toggle: ['kbdToggle', 'msgToggle', ''], match: ['kbdMatch', 'msgMatch', 'Sinon le prochain match suivi.'] };
let recording = null; // 'toggle' | 'match' | null

const currentKeys = () => ({ ...DEFAULT_SHORTCUTS, ...prefs.shortcuts });

function renderKeys() {
  const keys = currentKeys();
  for (const [which, [kbdId]] of Object.entries(KEY_IDS)) {
    const kbd = document.getElementById(kbdId);
    kbd.textContent = recording === which ? 'Tape ta combinaison…' : shortcutLabel(keys[which]);
    kbd.classList.toggle('kbd--rec', recording === which);
  }
}

function keyMessage(which, text, isErr) {
  const msg = document.getElementById(KEY_IDS[which][1]);
  msg.textContent = text;
  msg.classList.toggle('kbd-msg--err', !!isErr);
}

/** Enregistre de nouveaux raccourcis : Rust d'abord, qui peut refuser. */
async function applyKeys(next, which) {
  if (inTauri()) {
    try {
      await window.__TAURI__.core.invoke('set_shortcuts', { toggle: next.toggle, matchKey: next.match });
    } catch (err) {
      keyMessage(which, errText(err), true);
      renderKeys();
      return;
    }
  }
  prefs.shortcuts = next;
  savePrefs(prefs);
  keyMessage(which, `Enregistré : ${shortcutLabel(next[which])}`, false);
  renderKeys();
}

function bindShortcuts() {
  renderKeys();
  document.querySelectorAll('[data-record]').forEach((b) => b.addEventListener('click', () => {
    recording = recording === b.dataset.record ? null : b.dataset.record;
    keyMessage(b.dataset.record, KEY_IDS[b.dataset.record][2], false);
    renderKeys();
  }));
  document.getElementById('btnKeysReset').addEventListener('click', () => {
    recording = null;
    applyKeys({ ...DEFAULT_SHORTCUTS }, 'toggle');
  });
  window.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    const which = recording;
    if (e.code === 'Escape') { recording = null; renderKeys(); return; }
    const combo = comboFromEvent(e);
    if (combo === null) return; // seulement Ctrl, Alt ou Maj pour l'instant
    if (combo === '') { keyMessage(which, 'Ajoute Ctrl ou Alt à la touche.', true); return; }
    const next = { ...currentKeys(), [which]: combo };
    const other = which === 'toggle' ? 'match' : 'toggle';
    if (next[other] === combo) { keyMessage(which, "C'est déjà l'autre raccourci.", true); return; }
    recording = null;
    applyKeys(next, which);
  }, true);
}

/** Interrupteur lié à une préférence vraie par défaut. */
function bindSwitch(id, key) {
  const box = document.getElementById(id);
  box.checked = prefs[key] !== false;
  box.addEventListener('change', () => { prefs[key] = box.checked; savePrefs(prefs); });
}

/* ---------- Joueurs favoris (hockey) ---------- */

const rosters = new Map(); // idÉquipe -> joueurs | Error
let playerTeam = null;
let playerQuery = '';

const isFavPlayer = (p) => (prefs.favPlayers ?? []).some((f) => (f.id && f.id === p.id) || sameDriver(f, p));

function renderPlayerChips() {
  const box = document.getElementById('favPlayersChips');
  const list = prefs.favPlayers ?? [];
  box.innerHTML = list.length
    ? list.map((p, i) => `<span class="chip-player">${p.photo ? `<img class="face-xs" src="${p.photo}" alt="" data-face />` : ''}${p.name}
        <button type="button" data-i="${i}" title="Retirer">×</button></span>`).join('')
    : '<small>Aucun</small>';
  box.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true }));
  box.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    prefs.favPlayers.splice(Number(b.dataset.i), 1);
    savePrefs(prefs);
    renderPlayerChips();
  }));
}

function showPlayers() {
  setView('players');
  const select = document.getElementById('playerTeam');
  if (!select.options.length) {
    // Tes équipes de la LNH d'abord, puis toute la ligue.
    const mine = prefs.favorites.filter((k) => k.startsWith('nhl:')).map((k) => k.slice(4));
    const byId = new Map(NHL_TEAMS.map((t) => [t.id, t]));
    const sorted = [...NHL_TEAMS].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    select.innerHTML = [
      ...mine.filter((id) => byId.has(id)).map((id) => `<option value="${id}">★ ${byId.get(id).name}</option>`),
      ...sorted.filter((t) => !mine.includes(t.id)).map((t) => `<option value="${t.id}">${t.name}</option>`),
    ].join('');
    // Sans équipe favorite de la LNH : les Canadiens.
    playerTeam = mine.find((id) => byId.has(id)) ?? NHL_TEAMS.find((t) => t.abbr === 'MTL')?.id;
    select.value = playerTeam;
  }
  loadRoster(playerTeam);
}

async function loadRoster(teamId) {
  playerTeam = teamId;
  if (!rosters.has(teamId)) {
    el.players.innerHTML = '<div class="state">Chargement des joueurs…</div>';
    try {
      rosters.set(teamId, IS_DEMO ? demoRoster(teamId) : await fetchRoster('nhl', teamId));
    } catch (err) {
      rosters.set(teamId, err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (playerTeam === teamId && view === 'players') renderPlayers();
}

function renderPlayers() {
  const roster = rosters.get(playerTeam);
  if (roster instanceof Error) {
    const offline = isOffline(roster);
    el.players.innerHTML = offline
      ? errorBlock('', roster)
      : errorBlock("ESPN ne donne pas l'alignement de cette équipe à l'app.", roster,
        '<br />Ajoute ton joueur par son nom, juste au-dessus.');
    // Sans réseau, on retentera à la prochaine ouverture.
    if (offline) rosters.delete(playerTeam);
    return;
  }
  const q = playerQuery.trim().toLowerCase();
  const list = (roster ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  el.players.innerHTML = list.map((p) => `
    <div class="team-row${isFavPlayer(p) ? ' team-row--on' : ''}" data-player="${p.id}">
      <span class="check">${CHECK}</span>
      <img class="face-sm" src="${p.photo}" alt="" data-face />
      <span class="team-row__name">${p.name}</span>
      <span class="team-row__abbr">${[p.jersey ? `#${p.jersey}` : '', p.pos].filter(Boolean).join(' · ')}</span>
    </div>`).join('') || `<div class="state">Aucun joueur ne correspond à « ${playerQuery} ».</div>`;
  el.players.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true }));
  el.players.querySelectorAll('.team-row').forEach((row) => row.addEventListener('click', () => {
    const p = roster.find((x) => x.id === row.dataset.player);
    togglePlayer({ id: p.id, name: p.name, photo: p.photo, teamId: p.teamId });
  }));
}

function togglePlayer(p) {
  prefs.favPlayers ??= [];
  const i = prefs.favPlayers.findIndex((f) => (f.id && f.id === p.id) || sameDriver(f, p));
  if (i === -1) prefs.favPlayers.push(p);
  else prefs.favPlayers.splice(i, 1);
  savePrefs(prefs);
  renderPlayerChips();
  if (view === 'players') renderPlayers();
}

function demoRoster(teamId) {
  return [['1', 'Cole Caufield', '22', 'AD'], ['2', 'Nick Suzuki', '14', 'C'], ['3', 'Lane Hutson', '48', 'D'], ['4', 'Ivan Demidov', '93', 'AD']]
    .map(([id, name, jersey, pos]) => ({ id, name, jersey, pos, photo: '', teamId }));
}

/* ---------- Classements ---------- */

let standingsLeague = null;
let standingsMode = 'teams'; // 'teams' ou 'players'
let leaderCat = null; // catégorie choisie dans le classement des joueurs

function showStandings() {
  setView('standings');
  const select = document.getElementById('standingsLeague');
  if (!select.options.length) {
    // Les ligues de tes équipes d'abord (★), puis les autres ; F1 comprise.
    const mine = new Set(prefs.favorites.map((k) => k.split(':')[0]));
    if (prefs.leagues.includes('f1') || prefs.favDrivers?.length) mine.add('f1');
    const list = LEAGUES.filter((l) => l.kind === 'team' || l.id === 'f1');
    const sorted = [...list.filter((l) => mine.has(l.id)), ...list.filter((l) => !mine.has(l.id))];
    select.innerHTML = sorted.map((l) => `<option value="${l.id}">${mine.has(l.id) ? '★ ' : ''}${l.label}</option>`).join('');
    standingsLeague = sorted[0]?.id ?? 'nhl';
    select.value = standingsLeague;
  }
  loadStandings(false);
}

async function loadStandings() {
  const leagueId = standingsLeague;
  // La F1 n'a qu'un classement (pilotes, constructeurs) : pas de choix Équipes/Joueurs.
  document.getElementById('standingsMode').hidden = leagueId === 'f1';
  document.querySelectorAll('#standingsMode button').forEach((b) => b.classList.toggle('seg--on', b.dataset.mode === standingsMode));
  if (standingsMode === 'players' && leagueId !== 'f1') { loadPlayerLeaders(leagueId); return; }
  el.standings.innerHTML = '<div class="state">Chargement du classement…</div>';
  try {
    const html = leagueId === 'f1'
      ? f1StandingsHtml(IS_DEMO ? demoF1Standings() : await fetchF1Standings())
      : teamStandingsHtml(leagueId, IS_DEMO ? demoStandings() : await fetchStandingsTable(leagueId));
    if (standingsLeague !== leagueId) return; // autre ligue choisie entre-temps
    el.standings.innerHTML = html || '<div class="state">ESPN ne donne pas encore de classement pour cette ligue.</div>';
    bindCrests(el.standings);
    el.standings.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true }));
    el.standings.querySelector('.st__row--fav')?.scrollIntoView({ block: 'center' });
  } catch (err) {
    if (standingsLeague === leagueId) el.standings.innerHTML = errorBlock('Classement indisponible.', err);
  }
}

/* ---------- Classement des joueurs (meneurs de la ligue) ---------- */

let leadersData = null; // { leagueId, cats, teams: Map id -> { abbr, logo } }

async function loadPlayerLeaders(leagueId) {
  el.standings.innerHTML = '<div class="state">Chargement des meneurs…</div>';
  try {
    const cats = IS_DEMO ? demoLeaders() : await fetchLeagueLeaders(leagueId);
    // Logos et sigles des équipes, repris du classement (souvent déjà en mémoire).
    let teams = new Map();
    try {
      const groups = IS_DEMO ? demoStandings() : await fetchStandingsTable(leagueId);
      teams = new Map(groups.flatMap((g) => g.rows).map((r) => [r.id, { abbr: r.abbr, logo: r.logo }]));
    } catch { /* sans logos */ }
    if (standingsLeague !== leagueId || standingsMode !== 'players') return;
    if (!cats.length) {
      el.standings.innerHTML = "<div class=\"state\">ESPN ne donne pas encore de meneurs pour cette ligue.</div>";
      return;
    }
    leadersData = { leagueId, cats, teams };
    if (!cats.some((c) => c.name === leaderCat)) leaderCat = cats[0].name;
    renderLeaders();
  } catch (err) {
    if (standingsLeague === leagueId) el.standings.innerHTML = errorBlock('Meneurs indisponibles.', err);
  }
}

/** Une catégorie : ses 10 meneurs, avec photo et équipe (chargés au besoin). */
async function renderLeaders() {
  const { leagueId, cats, teams } = leadersData;
  const cat = cats.find((c) => c.name === leaderCat) ?? cats[0];
  const chips = `<div class="cat-chips">${cats.map((c) => `
    <button type="button" class="cat-chip${c.name === cat.name ? ' cat-chip--on' : ''}" data-cat="${c.name}">${autoFr(c.label)}</button>`).join('')}</div>`;
  const draw = (players) => {
    el.standings.innerHTML = chips + `<table class="st__table st__table--players">
      <thead><tr><th class="st__rank">#</th><th class="st__team">Joueur</th><th>Équipe</th><th>${autoFr(cat.label)}</th></tr></thead>
      <tbody>${cat.leaders.map((l, i) => {
        const p = players[i];
        const t = teams.get(l.teamId);
        const fav = prefs.favorites.includes(`${leagueId}:${l.teamId}`) || (p?.name && isFavPlayer(p));
        return `<tr class="${fav ? 'st__row--fav' : ''}">
          <td class="st__rank">${({ 1: '🥇', 2: '🥈', 3: '🥉' })[l.rank] ?? l.rank}</td>
          <td class="st__team"><span class="st__cell">${p?.photo ? `<img class="face-sm" src="${p.photo}" alt="" data-face />` : '<span class="face-sm"></span>'}
            <span>${p?.name ?? '…'}${p?.pos ? ` <small class="st__muted">${p.pos}</small>` : ''}</span></span></td>
          <td>${t ? `<span class="st__cell st__cell--c">${crestHtml({ logo: t.logo, abbr: t.abbr }, 'crest-sm')}${t.abbr}</span>` : ''}</td>
          <td><b>${l.value}</b></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    bindCrests(el.standings);
    el.standings.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true }));
    el.standings.querySelectorAll('.cat-chip').forEach((b) => b.addEventListener('click', () => { leaderCat = b.dataset.cat; renderLeaders(); }));
  };
  // D'abord les valeurs, puis les noms et photos dès qu'ils arrivent.
  draw([]);
  const players = IS_DEMO
    ? cat.leaders.map((l) => l.demo)
    : (await Promise.allSettled(cat.leaders.map((l) => fetchAthlete(l.ref)))).map((r) => (r.status === 'fulfilled' ? r.value : null));
  if (leadersData?.leagueId === leagueId && leaderCat === cat.name && standingsMode === 'players') draw(players);
}

function demoLeaders() {
  const p = (name, pos, teamId, value, i) => ({ rank: i + 1, value, ref: `demo${i}`, teamId, demo: { name, pos, photo: '' } });
  return [
    { name: 'points', label: 'Points', leaders: [['Nikita Kucherov', 'AD', '17', '21'], ['Nick Suzuki', 'C', '10', '18'], ['Auston Matthews', 'C', '21', '16'], ['Cole Caufield', 'AD', '10', '15']].map(([n, pos, t, v], i) => p(n, pos, t, v, i)) },
    { name: 'goals', label: 'Buts', leaders: [['Cole Caufield', 'AD', '10', '11'], ['Auston Matthews', 'C', '21', '9']].map(([n, pos, t, v], i) => p(n, pos, t, v, i)) },
    { name: 'wins', label: 'Victoires', leaders: [['Sam Montembeault', 'G', '10', '7']].map(([n, pos, t, v], i) => p(n, pos, t, v, i)) },
  ];
}

/** Tableau par groupe (association, division…), tes équipes en évidence. */
function teamStandingsHtml(leagueId, groups) {
  const cols = STANDING_COLS[sportOf(leagueId)] ?? [['wins', 'V'], ['losses', 'D']];
  const fav = (id) => prefs.favorites.includes(`${leagueId}:${id}`);
  return groups.map((g) => `
    <div class="st">
      <div class="st__group">${autoFr(g.name)}</div>
      <table class="st__table">
        <thead><tr><th class="st__rank">#</th><th class="st__team">Équipe</th>${cols.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${g.rows.map((r) => `
          <tr class="${fav(r.id) ? 'st__row--fav' : ''}">
            <td class="st__rank">${r.rank}</td>
            <td class="st__team"><span class="st__cell">${crestHtml({ logo: r.logo, abbr: r.abbr }, 'crest-sm')}<span>${r.short || r.name}</span></span></td>
            ${cols.map(([k]) => `<td>${r.stats[k] ?? '–'}</td>`).join('')}
          </tr>`).join('')}</tbody>
      </table>
    </div>`).join('');
}

/** Championnat de F1 : pilotes (tes favoris en évidence) et constructeurs. */
function f1StandingsHtml({ drivers, teams }) {
  if (!drivers?.length && !teams?.length) return '';
  const favs = prefs.favDrivers ?? [];
  const medal = (n) => ({ 1: '🥇', 2: '🥈', 3: '🥉' }[n] ?? n);
  const driverRows = drivers.map((d) => `
    <tr class="${favs.some((f) => sameDriver(d, f)) ? 'st__row--fav' : ''}">
      <td class="st__rank">${medal(d.rank)}</td>
      <td class="st__team"><span class="st__cell">${d.photo ? `<img class="face-sm" src="${d.photo}" alt="" data-face />` : '<span class="face-sm"></span>'}<span>${d.name}</span></span></td>
      <td class="st__muted">${d.team}</td>
      <td><b>${d.points}</b></td>
    </tr>`).join('');
  const teamRows = teams.map((t) => `
    <tr><td class="st__rank">${medal(t.rank)}</td><td class="st__team"><span>${t.name}</span></td><td><b>${t.points}</b></td></tr>`).join('');
  return `
    ${driverRows ? `<div class="st"><div class="st__group">Pilotes</div>
      <table class="st__table"><thead><tr><th class="st__rank">#</th><th class="st__team">Pilote</th><th>Écurie</th><th>PTS</th></tr></thead>
      <tbody>${driverRows}</tbody></table></div>` : ''}
    ${teamRows ? `<div class="st"><div class="st__group">Constructeurs</div>
      <table class="st__table"><thead><tr><th class="st__rank">#</th><th class="st__team">Écurie</th><th>PTS</th></tr></thead>
      <tbody>${teamRows}</tbody></table></div>` : ''}`;
}

function demoStandings() {
  const row = (rank, id, abbr, short, stats) => ({ id, rank, abbr, short, name: short, logo: '', stats });
  return [{ name: 'Atlantique', rows: [
    row(1, '17', 'TBL', 'Lightning', { gamesPlayed: '10', wins: '8', losses: '1', otLosses: '1', points: '17' }),
    row(2, '10', 'MTL', 'Canadiens', { gamesPlayed: '10', wins: '7', losses: '2', otLosses: '1', points: '15' }),
    row(3, '21', 'TOR', 'Maple Leafs', { gamesPlayed: '10', wins: '6', losses: '3', otLosses: '1', points: '13' }),
  ] }];
}

function demoF1Standings() {
  return {
    drivers: [['Lando Norris', 'McLaren', '390'], ['Oscar Piastri', 'McLaren', '366'], ['Max Verstappen', 'Red Bull', '341'],
      ['George Russell', 'Mercedes', '276'], ['Andrea Kimi Antonelli', 'Mercedes', '150']]
      .map(([name, team, points], i) => ({ rank: i + 1, id: '', name, team, points, photo: '' })),
    teams: [['McLaren', '756'], ['Mercedes', '426'], ['Ferrari', '378']].map(([name, points], i) => ({ rank: i + 1, name, points })),
  };
}

/* ---------- Calendrier ---------- */

const DAY_MS = 24 * 3600 * 1000;
const CAL_AHEAD = 30;
let calLoading = false;

function showCalendar() {
  setView('calendar');
  loadCalendar(false);
}

/** Matchs des équipes favorites et Grands Prix, d'aujourd'hui à dans 30 jours. */
async function loadCalendar(force) {
  if (calLoading) return;
  calLoading = true;
  // Depuis ce matin : les matchs d'aujourd'hui déjà joués restent visibles.
  const first = new Date(); first.setHours(0, 0, 0, 0);
  const back = 1;
  const end = Date.now() + CAL_AHEAD * DAY_MS;
  document.getElementById('calRange').textContent = `du ${first.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' })} au ${new Date(end).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' })}`;
  if (force || !el.calendar.innerHTML) el.calendar.innerHTML = '<div class="state">Chargement du calendrier…</div>';

  const teamKeys = prefs.favorites.filter((k) => LEAGUES_BY_ID[k.split(':')[0]]?.kind === 'team');
  const wantF1 = prefs.leagues.includes('f1') || !!prefs.favDrivers?.length;
  const wantUfc = prefs.leagues.includes('ufc') || !!prefs.favFighters?.length;
  if (!IS_DEMO && !teamKeys.length && !wantF1 && !wantUfc) {
    el.calendar.innerHTML = '<div class="state">Choisis des équipes (ou la F1) pour remplir ton calendrier.</div>';
    calLoading = false;
    return;
  }

  let games = [];
  const errors = [];
  let lastErr = null;
  if (IS_DEMO) {
    games = demoCalendar();
  } else {
    const jobs = teamKeys.map((k) => {
      const [leagueId, teamId] = k.split(':');
      return fetchTeamGames(leagueId, teamId, { back, ahead: CAL_AHEAD });
    });
    if (wantF1) jobs.push(fetchLeagueCalendar('f1', -back, CAL_AHEAD));
    if (wantUfc) jobs.push(fetchLeagueCalendar('ufc', -back, CAL_AHEAD));
    for (const r of await Promise.allSettled(jobs)) {
      if (r.status === 'fulfilled') games.push(...r.value);
      else { errors.push(errText(r.reason)); lastErr = r.reason; }
    }
  }

  const seen = new Set();
  games = games
    .filter((g) => isDate(g.startsAt) && g.startsAt >= first && g.startsAt.getTime() <= end)
    .filter((g) => (seen.has(g.id) ? false : seen.add(g.id)))
    .sort((a, b) => a.startsAt - b.startsAt);
  if (!games.length && lastErr && isOffline(lastErr)) {
    el.calendar.innerHTML = errorBlock('', lastErr);
  } else {
    renderCalendar(games, errors);
  }
  calLoading = false;
}

function calRow(g) {
  const league = LEAGUES_BY_ID[g.leagueId];
  const chip = `<span class="cal__chip" style="color:${league?.accent ?? 'inherit'}">${league?.short ?? ''}</span>`;
  const state = g.kind === 'match' ? g.state : g.raceState ?? g.state;
  let when = TIME_FMT.format(g.startsAt);
  if (state === 'in') when = '<span class="cal__live">En direct</span>';
  else if (state === 'post') when = '<span class="cal__done">Final</span>';

  let body;
  if (g.kind === 'card') {
    const m = g.main;
    const w = state === 'post' && m ? (m.a.winner ? m.a : m.b.winner ? m.b : null) : null;
    // Tes combattants à l'affiche de ce gala.
    const mine = (g.fights ?? []).flatMap((f) => [f.a, f.b])
      .filter((x) => (prefs.favFighters ?? []).some((fav) => sameDriver(x, fav)));
    body = `${crestHtml({ logo: g.logo, abbr: 'UFC', color: league.accent }, 'crest-sm')}
      <span class="cal__title">${g.title}</span>
      ${mine.length ? `<span class="cal__fav">⭐ ${mine.map((x) => x.name).join(', ')}</span>` : ''}
      ${w ? `<span class="cal__res">🏆 ${w.name}</span>` : ''}`;
  } else if (g.kind === 'event') {
    const winner = state === 'post' ? g.top3?.[0] : null;
    body = `${crestHtml({ logo: league.logo, abbr: 'F1', color: league.accent }, 'crest-sm')}
      <span class="cal__title">${g.title}</span>
      ${winner ? `<span class="cal__res">🥇 ${winner.short || winner.name}</span>` : ''}`;
  } else {
    const fav = (t) => prefs.favorites.includes(`${g.leagueId}:${t.id}`);
    const me = fav(g.home) ? g.home : fav(g.away) ? g.away : null;
    const opp = me === g.home ? g.away : g.home;
    let res = '';
    if (state === 'post' && me) {
      const r = me.winner ? 'V' : opp.winner ? 'D' : 'N';
      res = `<span class="cal__badge cal__badge--${r}">${r}</span>`;
    }
    const score = state === 'pre' ? '' : `<span class="cal__score">${g.away.score} – ${g.home.score}</span>`;
    body = `${crestHtml(g.away, 'crest-sm')}<span class="cal__abbr">${g.away.abbr}</span>
      <span class="cal__at">@</span>
      ${crestHtml(g.home, 'crest-sm')}<span class="cal__abbr">${g.home.abbr}</span>
      ${score}${res}`;
  }
  const until = state === 'pre' && g.startsAt.getTime() - Date.now() < 2 * DAY_MS ? untilText(g.startsAt) : '';
  return `<div class="cal__row${state === 'post' ? ' cal__row--past' : ''}" data-league="${g.leagueId}" data-event="${g.id}">
    <span class="cal__when">${when}</span>${chip}${body}
    ${until ? `<span class="cal__until">${until}</span>` : ''}
  </div>`;
}

function renderCalendar(games, errors) {
  if (!games.length) {
    el.calendar.innerHTML = `<div class="state">Aucun match trouvé pour cette période.${
      errors.length ? `<br /><code class="state__code">${errors[0]}</code>` : ''}</div>`;
    return;
  }
  let html = '';
  let day = '';
  const todayKey = new Date().toDateString();
  for (const g of games) {
    const key = g.startsAt.toDateString();
    if (key !== day) {
      day = key;
      html += `<div class="cal__day${key === todayKey ? ' cal__day--today' : ''}">${dayName(g.startsAt)}</div>`;
    }
    html += calRow(g);
  }
  if (errors.length) html += `<div class="state state--err">Certaines équipes n'ont pas pu être chargées.<br /><code class="state__code">${errors[0]}</code></div>`;
  el.calendar.innerHTML = html;
  bindCrests(el.calendar);
  el.calendar.querySelectorAll('.cal__row').forEach((row) => row.addEventListener('click', async () => {
    const { league, event } = row.dataset;
    if (!inTauri()) { window.open(`match.html?league=${league}&event=${encodeURIComponent(event)}`, '_blank'); return; }
    try { await window.__TAURI__.core.invoke('open_match', { league, event }); } catch { /* indisponible */ }
  }));
}

/** Aperçu navigateur : un mois factice autour d'aujourd'hui. */
function demoCalendar() {
  const [live, done, next, f1] = demoEvents();
  const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
  const past = (g, days, hs, as, homeWin) => ({ ...g, id: `${g.id}-p${days}`, state: 'post', startsAt: at(days, 19),
    home: { ...g.home, score: hs, winner: homeWin }, away: { ...g.away, score: as, winner: !homeWin } });
  return [
    past(live, -6, '4', '1', true), past(live, -3, '2', '3', false), { ...live, startsAt: at(0, 19) },
    { ...next, id: 'demo-n2', state: 'pre', startsAt: at(2, 20) },
    { ...live, id: 'demo-l3', state: 'pre', startsAt: at(4, 19), home: { ...live.home, score: '–' }, away: { ...live.away, score: '–' } },
    { ...f1, id: 'demo-f1-cal', state: 'pre', raceState: 'pre', startsAt: at(9, 14), title: 'GP du Mexique' },
    { ...done, id: 'demo-d2', startsAt: at(-1, 19) },
  ];
}

/**
 * Notification d'exemple, pour voir le rendu sans attendre un vrai but. Elle
 * prend l'équipe choisie pour la couleur du widget, sinon les Canadiens.
 */
async function tryToast() {
  if (!inTauri()) return;
  const info = prefs.favInfo[prefs.theme];
  const mtl = NHL_TEAMS.find((t) => t.abbr === 'MTL');
  const team = info
    ? { abbr: info.abbr, name: info.name, color: info.color, alt: info.alt, logo: teamLogo(prefs.theme) }
    : { abbr: mtl.abbr, name: 'Canadiens', color: mtl.color, alt: mtl.alt, logo: mtl.logo };
  const color = visibleTeamColor(team.color, team.alt) ?? '#4aa3ff';
  await window.__TAURI__.core.invoke('notify', {
    toast: {
      title: `But des ${team.name} !`,
      body: 'Exemple de notification',
      link: '',
      color,
      team: { abbr: team.abbr, logo: team.logo, color },
    },
  });
}

/** Logo d'un favori s'il est connu (liste LNH intégrée, ou liste chargée). */
function teamLogo(key) {
  const [leagueId, id] = key.split(':');
  const list = leagueId === 'nhl' ? NHL_TEAMS : cache.get(leagueId) ?? [];
  return list.find((t) => t.id === id)?.logo ?? '';
}

/** L'état du démarrage automatique vit dans Windows, pas dans nos préférences. */
async function bindAutostart() {
  const box = document.getElementById('optAutostart');
  if (!inTauri()) { box.disabled = true; return; }
  const { invoke } = window.__TAURI__.core;
  try {
    box.checked = await invoke('get_autostart');
  } catch {
    box.disabled = true;
    return;
  }
  box.addEventListener('change', async () => {
    try {
      await invoke('set_autostart', { enabled: box.checked });
    } catch {
      box.checked = !box.checked; // Windows a refusé : on remet l'état réel
    }
  });
}

document.getElementById('btnClear').addEventListener('click', () => {
  prefs.favorites.filter((f) => f.startsWith(`${current}:`)).forEach(forgetFavorite);
  prefs.favorites = prefs.favorites.filter((f) => !f.startsWith(`${current}:`));
  prefs.leagues = prefs.leagues.filter((l) => l !== current);
  savePrefs(prefs);
  renderLeagues();
  renderTeams();
  renderThemeOptions();
});

/* ---------- Mises à jour ---------- */

async function showVersion() {
  if (!inTauri()) return;
  try {
    const v = await window.__TAURI__.core.invoke('app_version');
    document.getElementById('appVersion').textContent = `v${v}`;
  } catch { /* version antérieure sans cette commande */ }
}

const UPDATE_LABEL = 'Rechercher une mise à jour';
let pendingVersion = null; // version trouvée, en attente de « Installer »

function setUpdateButton(text, state = '', title = '') {
  const btn = document.getElementById('btnUpdate');
  btn.textContent = text;
  btn.title = title;
  btn.classList.remove('ghost--ok', 'ghost--busy', 'ghost--err');
  if (state) btn.classList.add(`ghost--${state}`);
}

function resetUpdateButton(delay = 0) {
  setTimeout(() => {
    pendingVersion = null;
    document.getElementById('btnUpdateLater').hidden = true;
    const btn = document.getElementById('btnUpdate');
    btn.disabled = false;
    setUpdateButton(UPDATE_LABEL);
  }, delay);
}

/** Premier clic : chercher. S'il y a une version, second clic : l'installer. */
async function onUpdateClick() {
  const btn = document.getElementById('btnUpdate');
  if (!inTauri() || btn.disabled) return;
  const { invoke } = window.__TAURI__.core;

  if (pendingVersion) {
    btn.disabled = true;
    document.getElementById('btnUpdateLater').hidden = true;
    setUpdateButton(`Installation de la v${pendingVersion}…`, 'busy', "L'app va redémarrer toute seule.");
    try {
      await invoke('install_update');
    } catch (err) {
      setUpdateButton('Installation impossible', 'err', errText(err));
      resetUpdateButton(4000);
    }
    return;
  }

  btn.disabled = true;
  setUpdateButton('Recherche…', 'busy');
  try {
    const r = await invoke('check_update');
    if (r.available) {
      // Rien n'est installé sans accord : on propose.
      pendingVersion = r.available;
      btn.disabled = false;
      setUpdateButton(`Installer la v${r.available}`, 'ok');
      document.getElementById('btnUpdateLater').hidden = false;
      return;
    }
    setUpdateButton(`À jour (v${r.current}) ✓`, 'ok');
  } catch (err) {
    setUpdateButton('Recherche impossible', 'err', errText(err));
  }
  resetUpdateButton(4000);
}

document.getElementById('btnUpdate').addEventListener('click', onUpdateClick);
// Clic sur le numéro de version : les notes de mise à jour de cette version.
document.getElementById('appVersion').addEventListener('click', async () => {
  if (!inTauri()) { window.open('notes.html', '_blank'); return; }
  try { await window.__TAURI__.core.invoke('open_notes', { since: '' }); } catch { /* ancienne version */ }
});
document.getElementById('btnUpdateLater').addEventListener('click', () => resetUpdateButton());
showVersion();

document.getElementById('btnReveal').addEventListener('click', async () => {
  if (inTauri()) await window.__TAURI__.core.invoke('reveal_widget');
});

document.getElementById('btnClose').addEventListener('click', async () => {
  if (inTauri()) await window.__TAURI__.window.getCurrentWindow().close();
  else window.location.href = 'index.html';
});

el.search.addEventListener('input', () => { query = el.search.value; renderTeams(); });
el.navPrefs.addEventListener('click', showPrefs);
el.navCalendar.addEventListener('click', showCalendar);
el.navStandings.addEventListener('click', showStandings);
document.getElementById('standingsLeague').addEventListener('change', (e) => { standingsLeague = e.target.value; loadStandings(); });
document.getElementById('btnStandingsRefresh').addEventListener('click', () => loadStandings());
document.getElementById('standingsMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === standingsMode) return;
  standingsMode = b.dataset.mode;
  loadStandings();
});
document.getElementById('btnCalRefresh').addEventListener('click', () => loadCalendar(true));
document.getElementById('playerTeam').addEventListener('change', (e) => loadRoster(e.target.value));
document.getElementById('playerSearch').addEventListener('input', (e) => { playerQuery = e.target.value; renderPlayers(); });
document.getElementById('playerAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('playerFree');
  const name = input.value.trim().replace(/\s+/g, ' ');
  if (name.length < 3) return;
  if (!isFavPlayer({ name })) togglePlayer({ id: '', name, photo: '', teamId: '' });
  input.value = '';
});

bindOptions();
const startView = new URLSearchParams(location.search).get('view');
if (startView === 'prefs') showPrefs();
else if (startView === 'calendar') showCalendar();
else if (startView === 'standings') showStandings();
else if (startView === 'players') showPlayers();
else if (new URLSearchParams(location.search).get('league')) showLeague(new URLSearchParams(location.search).get('league'));
else selectLeague();
