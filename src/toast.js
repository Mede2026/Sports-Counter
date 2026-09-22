// Fenêtre de notification : reçoit les évènements du widget (via Rust),
// les affiche l'un après l'autre, puis se cache.
import { crestHtml, bindCrests } from './lib/crest.js';

const DURATION_MS = 6000;
const LEAVE_MS = 200;

const el = {
  card: document.getElementById('toast'),
  icon: document.getElementById('icon'),
  title: document.getElementById('title'),
  body: document.getElementById('body'),
};

const inTauri = () => !!window.__TAURI__;
const queue = [];
let busy = false;
let timer = null;
let current = null;

document.documentElement.style.setProperty('--duration', `${DURATION_MS}ms`);

function render(t) {
  current = t;
  el.card.style.setProperty('--team', t.color || '#4aa3ff');
  el.icon.innerHTML = crestHtml(t.team ?? { abbr: '•' }, 'crest');
  bindCrests(el.icon);
  el.title.textContent = t.title ?? '';
  el.body.textContent = t.body ?? '';
  el.card.title = t.link ? 'Ouvrir le match sur ESPN' : '';
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
  if (inTauri()) await window.__TAURI__.window.getCurrentWindow().show();
  // Relancer les animations : retirer puis remettre la classe.
  el.card.classList.remove('toast--in', 'toast--out');
  void el.card.offsetWidth;
  el.card.classList.add('toast--in');
  clearTimeout(timer);
  timer = setTimeout(leave, DURATION_MS);
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

// Un clic ouvre le match sur ESPN (s'il a une page) et ferme la notification.
el.card.addEventListener('click', async () => {
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
