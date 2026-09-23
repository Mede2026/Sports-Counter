// Fenêtre de notification : reçoit les évènements du widget (via Rust),
// les affiche l'un après l'autre, puis se cache.
import { crestHtml, bindCrests } from './lib/crest.js';

const DURATION_MS = 6000;
// Une proposition de mise à jour reste plus longtemps ; sans réponse, elle
// compte comme « Plus tard » (l'app redemandera à la prochaine recherche).
const UPDATE_DURATION_MS = 30000;
const UPDATE_COLOR = '#4aa3ff';
const ARROW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"
  stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>`;
const LEAVE_MS = 200;

const el = {
  card: document.getElementById('toast'),
  icon: document.getElementById('icon'),
  title: document.getElementById('title'),
  body: document.getElementById('body'),
  actions: document.getElementById('actions'),
  install: document.getElementById('btnInstall'),
  later: document.getElementById('btnLater'),
};

const inTauri = () => !!window.__TAURI__;
const queue = [];
let busy = false;
let timer = null;
let current = null;

document.documentElement.style.setProperty('--duration', `${DURATION_MS}ms`);

function render(t) {
  current = t;
  const isUpdate = t.kind === 'update';
  el.card.style.setProperty('--team', isUpdate ? UPDATE_COLOR : t.color || '#4aa3ff');
  if (isUpdate) {
    el.icon.innerHTML = `<span class="crest crest--update">${ARROW}</span>`;
    el.title.textContent = `Mise à jour ${t.version} disponible`;
    el.body.hidden = true;
    el.actions.hidden = false;
    el.install.disabled = false;
    el.install.textContent = 'Installer';
    el.later.disabled = false;
    el.card.title = '';
    el.card.style.cursor = 'default';
    return;
  }
  el.icon.innerHTML = crestHtml(t.team ?? { abbr: '•' }, 'crest');
  bindCrests(el.icon);
  el.title.textContent = t.title ?? '';
  el.body.textContent = t.body ?? '';
  el.body.hidden = false;
  el.actions.hidden = true;
  el.card.title = t.link ? 'Ouvrir le match sur ESPN' : '';
  el.card.style.cursor = 'pointer';
}

async function next() {
  const t = queue.shift();
  if (!t) {
    busy = false;
    if (inTauri()) await window.__TAURI__.window.getCurrentWindow().hide();
    return;
  }
  busy = true;
  render(t);
  // Rust l'affiche et la remet devant toutes les fenêtres.
  if (inTauri()) await window.__TAURI__.core.invoke('show_toast').catch(() => {});
  // Relancer les animations : retirer puis remettre la classe.
  el.card.classList.remove('toast--in', 'toast--out');
  void el.card.offsetWidth;
  el.card.classList.add('toast--in');
  clearTimeout(timer);
  const duration = t.kind === 'update' ? UPDATE_DURATION_MS : DURATION_MS;
  el.card.style.setProperty('--duration', `${duration}ms`);
  timer = setTimeout(leave, duration);
}

function leave() {
  clearTimeout(timer);
  el.card.classList.remove('toast--in');
  el.card.classList.add('toast--out');
  setTimeout(next, LEAVE_MS);
}

function enqueue(t) {
  queue.push(t);
  if (!busy) next();
}

// Mise à jour acceptée : Rust installe puis redémarre l'app.
el.install.addEventListener('click', async (e) => {
  e.stopPropagation();
  clearTimeout(timer);
  el.install.disabled = true;
  el.later.disabled = true;
  el.install.textContent = 'Installation…';
  try {
    await window.__TAURI__.core.invoke('install_update');
  } catch {
    el.install.textContent = 'Échec';
    timer = setTimeout(leave, 4000);
  }
});

el.later.addEventListener('click', (e) => {
  e.stopPropagation();
  leave();
});

// Un clic ouvre le match sur ESPN (s'il a une page) et ferme la notification.
el.card.addEventListener('click', async () => {
  if (current?.kind === 'update') return; // seuls ses boutons agissent
  if (current?.link && inTauri()) {
    try { await window.__TAURI__.core.invoke('open_espn', { url: current.link }); } catch { /* refusé */ }
  }
  leave();
});

if (inTauri()) {
  window.__TAURI__.event.listen('toast', (e) => enqueue(e.payload));
} else if (new URLSearchParams(location.search).has('demo')) {
  // Aperçu navigateur : une notification d'exemple, figée à l'écran.
  render({
    title: 'But des Canadiens !',
    body: 'TOR 2 – 4 MTL · 07:42 · 2e période',
    color: '#c41230',
    team: { abbr: 'MTL', color: '#c41230', logo: '' },
  });
  el.card.style.opacity = '1';
  el.card.style.transform = 'none';
}
