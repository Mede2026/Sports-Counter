// Écran « Notes de mise à jour » : ouvert une fois après une mise à jour,
// ou à la demande depuis les réglages (clic sur le numéro de version).
// Une version à la fois ; « ← » revient aux versions précédentes.
import { notesSince, CHANGELOG, compareVersions } from './lib/changelog.js';
import { esc } from './lib/format.js';

const inTauri = () => !!window.__TAURI__;
const params = new URLSearchParams(location.search);
// Passé par Rust à l'ouverture (ou dans l'adresse, en aperçu).
const opts = window.__NOTES__ ?? { since: params.get('since') ?? '', current: params.get('current') ?? '' };

const el = {
  main: document.getElementById('main'),
  prev: document.getElementById('btnPrev'),
  next: document.getElementById('btnNext'),
};

let versions = []; // de la plus récente à la plus ancienne, jusqu'à la version installée
let fresh = new Set(); // versions arrivées avec cette mise à jour
let index = 0;

function show(i) {
  index = Math.max(0, Math.min(versions.length - 1, i));
  const v = versions[index];
  if (!v) {
    el.main.innerHTML = '<p class="empty">Aucune note pour cette version.</p>';
    return;
  }
  el.main.innerHTML = `
    <section class="rel">
      <h1>Notes de mise à jour <span class="ver">(${esc(v)})</span>${fresh.has(v) ? '<span class="new">Nouveau</span>' : ''}</h1>
      <ul>${CHANGELOG[v].map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    </section>`;
  // « ← » : version plus ancienne ; « → » : plus récente.
  const older = versions[index + 1];
  const newer = versions[index - 1];
  el.prev.hidden = !older;
  el.next.hidden = !newer;
  if (older) el.prev.textContent = `← ${older}`;
  if (newer) el.next.textContent = `${newer} →`;
}

async function start() {
  let current = opts.current;
  if (!current && inTauri()) {
    try { current = await window.__TAURI__.core.invoke('app_version'); } catch { /* ancienne version */ }
  }
  current ||= Object.keys(CHANGELOG).sort((a, b) => compareVersions(b, a))[0];
  versions = Object.keys(CHANGELOG)
    .filter((v) => compareVersions(v, current) <= 0)
    .sort((a, b) => compareVersions(b, a));
  fresh = new Set(notesSince(opts.since, current).map((n) => n.version));
  show(0);
}

async function close() {
  if (inTauri()) await window.__TAURI__.window.getCurrentWindow().close();
  else window.close();
}

el.prev.addEventListener('click', () => show(index + 1));
el.next.addEventListener('click', () => show(index - 1));
document.getElementById('btnOk').addEventListener('click', close);
document.getElementById('btnClose').addEventListener('click', close);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Enter') close();
  else if (e.key === 'ArrowLeft') show(index + 1);
  else if (e.key === 'ArrowRight') show(index - 1);
});

start();
