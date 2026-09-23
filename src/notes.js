// Écran « Notes de mise à jour » : ouvert une fois après une mise à jour,
// ou à la demande depuis les réglages (clic sur le numéro de version).
import { notesSince, CHANGELOG, compareVersions } from './lib/changelog.js';

const inTauri = () => !!window.__TAURI__;
const params = new URLSearchParams(location.search);
// Passé par Rust à l'ouverture (ou dans l'adresse, en aperçu).
const opts = window.__NOTES__ ?? { since: params.get('since') ?? '', current: params.get('current') ?? '' };

const latest = () => Object.keys(CHANGELOG).sort((a, b) => compareVersions(b, a))[0];

async function render() {
  let current = opts.current;
  if (!current && inTauri()) {
    try { current = await window.__TAURI__.core.invoke('app_version'); } catch { /* ancienne version */ }
  }
  current ||= latest();
  const list = notesSince(opts.since, current);
  const shown = list.length ? list : notesSince('', current);
  document.getElementById('main').innerHTML = shown.map((n, i) => `
    <section class="rel${i ? ' rel--old' : ''}">
      <h1>Notes de mise à jour <span class="ver">(${n.version})</span></h1>
      <ul>${n.points.map((p) => `<li>${p}</li>`).join('')}</ul>
    </section>`).join('') || '<p class="empty">Aucune note pour cette version.</p>';
}

async function close() {
  if (inTauri()) await window.__TAURI__.window.getCurrentWindow().close();
  else window.close();
}

document.getElementById('btnOk').addEventListener('click', close);
document.getElementById('btnClose').addEventListener('click', close);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); });

render();
