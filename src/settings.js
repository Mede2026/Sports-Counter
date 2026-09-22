import { LEAGUES, LEAGUES_BY_ID } from './lib/leagues.js';
import { loadPrefs, savePrefs } from './lib/store.js';
import { fetchTeams } from './lib/api.js';
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
};

let prefs = loadPrefs();
let current = LEAGUES[0].id;
let teams = [];
let query = '';
const cache = new Map(); // idLigue -> équipes

const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"
  stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>`;

/* ---------- Colonne des ligues ---------- */

function countFor(id) {
  if (LEAGUES_BY_ID[id]?.kind === 'event') return prefs.leagues.includes(id) ? 1 : 0;
  return prefs.favorites.filter((f) => f.startsWith(`${id}:`)).length;
}

function renderLeagues() {
  el.leagues.innerHTML = LEAGUES.map((l) => {
    const n = countFor(l.id);
    return `<button class="league${l.id === current ? ' league--on' : ''}" data-id="${l.id}">
      <span class="league__dot" style="background:${l.accent}"></span>
      <span>${l.label}</span>
      ${n ? `<span class="league__count">${n}</span>` : ''}
    </button>`;
  }).join('');

  el.leagues.querySelectorAll('.league').forEach((b) => {
    b.addEventListener('click', () => { current = b.dataset.id; query = ''; el.search.value = ''; selectLeague(); });
  });

  const total = prefs.favorites.length + prefs.leagues.length;
  el.summary.textContent = total ? `${total} sélection${total > 1 ? 's' : ''}` : 'aucune sélection';
}

/* ---------- Liste des équipes ---------- */

function renderTeams() {
  const league = LEAGUES_BY_ID[current];

  // Les ligues « évènement » (F1) se suivent en entier, sans choix d'équipe.
  if (league.kind === 'event') {
    const on = prefs.leagues.includes(current);
    el.teams.innerHTML = `
      <div class="team-row${on ? ' team-row--on' : ''}" data-league="${current}">
        <span class="check">${CHECK}</span>
        <span class="crest-sm" style="background:${league.accent}">F1</span>
        <span class="team-row__name">Suivre toute la ${league.label}</span>
      </div>
      <div class="state">Les courses n'ont pas d'équipes à cocher :<br />le widget affiche la course en cours ou la prochaine.</div>`;
    el.teams.querySelector('.team-row').addEventListener('click', toggleLeague);
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

  if (league.kind === 'event') { renderTeams(); return; }

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

document.getElementById('btnReveal').addEventListener('click', async () => {
  if (inTauri()) await window.__TAURI__.core.invoke('reveal_widget');
});

document.getElementById('btnClose').addEventListener('click', async () => {
  if (inTauri()) await window.__TAURI__.window.getCurrentWindow().close();
  else window.location.href = 'index.html';
});

el.search.addEventListener('input', () => { query = el.search.value; renderTeams(); });

bindOptions();
selectLeague();
