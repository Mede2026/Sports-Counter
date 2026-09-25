// Pastille d'équipe : logo ESPN pour fond sombre, sinon logo normal, sinon
// monogramme coloré. Aucun attribut `onerror` en ligne — la CSP de Tauri les
// bloquerait.

/**
 * Version « fond sombre » d'un logo ESPN, quand elle existe.
 * ESPN range ses logos sous …/500/… et leurs variantes sombres sous
 * …/500-dark/… (vu dans la réponse réelle de …/nhl/teams).
 */
export function darkLogo(url) {
  if (!url || !url.includes('a.espncdn.com/') || !url.includes('/500/')) return '';
  return url.replace('/500/', '/500-dark/');
}

import { F1_LOGO } from './f1-logo.js';

// Thème clair : les logos normaux d'ESPN sont faits pour un fond clair.
let lightCrests = false;
export function setLightCrests(on) { lightCrests = !!on; }

export function crestHtml(team, cls = 'crest') {
  const color = team.color || '#3b4150';
  const abbr = team.abbr || '?';
  if (!team.logo) return `<span class="${cls}" style="background:${color}">${abbr}</span>`;

  // Logo de la F1, intégré à l'app : en longueur, donc plus large qu'une
  // pastille carrée. Lisible sur fond clair comme sombre.
  if (team.logo === F1_LOGO) return `<img decoding="async" class="${cls} ${cls}--wide" src="${team.logo}" alt="" />`;
  // Autres logos intégrés (aperçu) : rien à essayer d'autre.
  if (team.logo.startsWith('data:')) return `<img decoding="async" class="${cls}" src="${team.logo}" alt="" />`;
  // Drapeau (équipe nationale, pays d'un joueur) : tel quel, sans variante
  // sombre ni halo, rectangle aux coins arrondis.
  if (/\/countries\/|\/flags?\//i.test(team.logo)) {
    return `<img decoding="async" class="${cls}" src="${team.logo}" alt="" data-flag data-abbr="${abbr}" data-color="${color}" data-cls="${cls}" />`;
  }

  if (lightCrests) {
    return `<img decoding="async" class="${cls}" src="${team.logo}" alt="" data-abbr="${abbr}" data-color="${color}" data-cls="${cls}" />`;
  }

  const dark = darkLogo(team.logo);
  // Premier essai : logo sombre. En repli : logo normal, marqué --light pour
  // recevoir le halo qui le garde lisible sur le fond sombre du widget.
  return dark
    ? `<img decoding="async" class="${cls}" src="${dark}" alt="" data-next="${team.logo}"
        data-abbr="${abbr}" data-color="${color}" data-cls="${cls}" />`
    : `<img decoding="async" class="${cls} ${cls}--light" src="${team.logo}" alt=""
        data-abbr="${abbr}" data-color="${color}" data-cls="${cls}" />`;
}

/** À rappeler après chaque innerHTML : branche les replis successifs. */
export function bindCrests(root) {
  root.querySelectorAll('img[data-abbr]').forEach((img) => {
    img.addEventListener('error', function fallback() {
      const next = img.dataset.next;
      if (next) {
        delete img.dataset.next;
        img.classList.add(`${img.dataset.cls || 'crest'}--light`);
        img.src = next;
        return; // l'écouteur reste branché pour l'étape suivante
      }
      img.removeEventListener('error', fallback);
      const span = document.createElement('span');
      span.className = img.dataset.cls || 'crest';
      span.style.background = img.dataset.color;
      span.textContent = img.dataset.abbr;
      img.replaceWith(span);
    });
  });
}
