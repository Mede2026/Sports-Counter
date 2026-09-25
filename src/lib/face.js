// Visage d'une personne (joueur, pilote, combattant) : sa photo, ou ses
// initiales quand ESPN n'en a pas (joueurs retraités, recrues…). Un cercle
// vide laissait croire à un bogue.

import { esc } from './format.js';
import { sportsDbPlayerPhoto } from './api.js';

/** « Wayne Gretzky » → « WG ». */
export function initials(name) {
  const parts = String(name ?? '').replace(/[^\p{L}\s'-]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** Photo, ou pastille aux initiales. `cls` : classes CSS du cercle. */
export function faceHtml(person, cls = 'face') {
  const ini = esc(initials(person?.name ?? person?.short));
  const name = esc(person?.name ?? '');
  return person?.photo
    ? `<img class="${cls}" src="${esc(person.photo)}" alt="" loading="lazy" decoding="async" data-face data-initials="${ini}" data-name="${name}" />`
    : `<span class="${cls} face--ini" aria-hidden="true" data-name="${name}">${ini}</span>`;
}

// Recherches de secours limitées par fenêtre : une longue liste de joueurs
// sans photo ne doit pas lancer des centaines de requêtes.
const MAX_LOOKUPS = 40;
let lookups = 0;

/** Pastille aux initiales, remplacée par une photo de secours si on en trouve une. */
function upgrade(span) {
  const name = span.dataset.name;
  if (!name || span.dataset.tried || lookups >= MAX_LOOKUPS) return;
  span.dataset.tried = '1';
  lookups += 1;
  sportsDbPlayerPhoto(name).then((photo) => {
    if (!photo || !span.isConnected) return;
    const img = document.createElement('img');
    img.className = span.className.replace(/\s*face--ini\b/, '');
    img.alt = '';
    img.src = photo;
    img.addEventListener('load', () => span.replaceWith(img), { once: true });
  });
}

/** Photo introuvable : remplacée par les initiales, puis par une photo de secours. */
export function bindFaces(root) {
  root.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => {
    const span = document.createElement('span');
    span.className = `${img.className} face--ini`;
    span.setAttribute('aria-hidden', 'true');
    span.textContent = img.dataset.initials ?? '';
    span.dataset.name = img.dataset.name ?? '';
    img.replaceWith(span);
    upgrade(span);
  }, { once: true }));
  root.querySelectorAll('span.face--ini[data-name]').forEach(upgrade);
}
