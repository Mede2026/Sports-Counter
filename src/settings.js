import { LEAGUES, LEAGUES_BY_ID } from './lib/leagues.js';
import { loadPrefs, savePrefs } from './lib/store.js';
import { fetchTeams, fetchDrivers, demoEvents, sameDriver } from './lib/api.js';
import { DEMO_TEAMS } from './lib/demo.js';
import { crestHtml, bindCrests } from './lib/crest.js';
import { errText } from './lib/err.js';
import { visibleTeamColor } from './lib/color.js';
import { NHL_TEAMS } from './lib/teams-nhl.js';

const IS_DEMO = new URLSearchParams(location.search).has('demo');
const inTauri = () => !!window.__TAURI__;

const el = {
  leagues: document.getElementById('leagues'),
  teams: document.getElementById('teams'),
  search: document.getElementById('search'),
  summary: document.getElementById('summary'),
  teamsView: document.getElementById('teamsView'),
  prefsView: document.getElementById('prefsView'),
  navPrefs: document.getElementById('navPrefs'),
};

let prefs = loadPrefs();
let current = LEAGUES[0].id;
let view = 'teams'; // 'teams' (une ligue) ou 'prefs' (section Réglages)
let teams = [];
let query = '';
const cache = new Map(); // idLigue -> équipes
let drivers = null; // pilotes de F1 : null = pas encore chargés
let driversErr = null;

const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"
  stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>`;

/* ---------- Colonne des ligues ---------- */

function countFor(id) {
  if (LEAGUES_BY_ID[id]?.kind === 'event') return prefs.leagues.includes(id) ? 1 : 0;
  return prefs.favorites.filter((f) => f.startsWith(`${id}:`)).length;
}

function renderLeagues() {
  el.navPrefs.classList.toggle('league--on', view === 'prefs');
  el.leagues.innerHTML = LEAGUES.map((l) => {
    const n = countFor(l.id);
    return `<button class="league${view === 'teams' && l.id === current ? ' league--on' : ''}" data-id="${l.id}">
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

/* ---------- F1 : suivre la saison, choisir son pilote ---------- */

function renderF1(league) {
  const on = prefs.leagues.includes(current);
  const q = query.trim().toLowerCase();
  const fav = prefs.favDriver;
  let list = '';
  if (driversErr) {
    list = `<div class="state state--err">Impossible de charger les pilotes.<br />
      <code class="state__code">${errText(driversErr)}</code><br />
      <button class="ghost" id="btnRetryDrivers">Réessayer</button></div>`;
  } else if (!drivers) {
    list = '<div class="state">Chargement des pilotes…</div>';
  } else {
    const shown = q ? drivers.filter((d) => `${d.name} ${d.team}`.toLowerCase().includes(q)) : drivers;
    list = shown.map((d) => {
      const mine = sameDriver(d, fav);
      return `<div class="team-row driver-row${mine ? ' team-row--on' : ''}" data-driver="${d.id}">
        <span class="check check--round">${CHECK}</span>
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
    <div class="subhead">Ton pilote favori <small>mis en évidence dans le widget, avec des notifications s'il prend la tête ou monte sur le podium</small></div>
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

/** Un seul pilote favori : cliquer sur le sien le retire. */
function pickDriver(id) {
  const d = drivers?.find((x) => x.id === id);
  if (!d) return;
  prefs.favDriver = sameDriver(d, prefs.favDriver) ? null
    : { id: d.id, name: d.name, short: d.short, photo: d.photo, team: d.team ?? '' };
  // Choisir un pilote, c'est aussi suivre la F1.
  if (prefs.favDriver && !prefs.leagues.includes('f1')) prefs.leagues.push('f1');
  savePrefs(prefs);
  renderLeagues();
  renderTeams();
  renderFavDriver();
}

function renderFavDriver() {
  const fav = prefs.favDriver;
  document.getElementById('favDriverTxt').innerHTML = fav
    ? `<b>Pilote favori</b><small class="favline">${fav.photo ? `<img class="face-xs" src="${fav.photo}" alt="" />` : ''}${fav.name}</small>`
    : '<b>Pilote favori</b><small>Aucun</small>';
}

/* ---------- Navigation ---------- */

function showLeague(id) {
  view = 'teams';
  current = id;
  query = '';
  el.search.value = '';
  el.teamsView.hidden = false;
  el.prefsView.hidden = true;
  el.search.placeholder = LEAGUES_BY_ID[id]?.kind === 'event' ? 'Rechercher un pilote…' : 'Rechercher une équipe…';
  selectLeague();
}

function showPrefs() {
  view = 'prefs';
  el.teamsView.hidden = true;
  el.prefsView.hidden = false;
  renderLeagues();
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
    el.teams.innerHTML = `<div class="state state--err">
      <strong>Impossible de charger les équipes.</strong><br />
      <code class="state__code">${errText(err)}</code><br />
      <button class="ghost" id="btnRetryTeams">Réessayer</button></div>`;
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

  const notify = document.getElementById('optNotify');
  notify.checked = prefs.notifications !== false;
  notify.addEventListener('change', () => { prefs.notifications = notify.checked; savePrefs(prefs); });
  document.getElementById('btnTryToast').addEventListener('click', tryToast);

  bindAutostart();
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

bindOptions();
if (new URLSearchParams(location.search).get('view') === 'prefs') showPrefs();
else if (new URLSearchParams(location.search).get('league')) showLeague(new URLSearchParams(location.search).get('league'));
else selectLeague();
