// Visage d'une personne (joueur, pilote, combattant) : sa photo, ou ses
// initiales quand ESPN n'en a pas (joueurs retraités, recrues…). Un cercle
// vide laissait croire à un bogue.

import { esc } from './format.js';

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
  return person?.photo
    ? `<img class="${cls}" src="${esc(person.photo)}" alt="" loading="lazy" data-face data-initials="${ini}" />`
    : `<span class="${cls} face--ini" aria-hidden="true">${ini}</span>`;
}

/** Photo introuvable : remplacée par les initiales. */
export function bindFaces(root) {
  root.querySelectorAll('img[data-face]').forEach((img) => img.addEventListener('error', () => {
    const span = document.createElement('span');
    span.className = `${img.className} face--ini`;
    span.setAttribute('aria-hidden', 'true');
    span.textContent = img.dataset.initials ?? '';
    img.replaceWith(span);
  }, { once: true }));
}
