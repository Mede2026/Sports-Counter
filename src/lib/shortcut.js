// Raccourcis clavier globaux : lecture d'une combinaison tapée, et affichage.
// Format échangé avec Rust : « Ctrl+Alt+KeyS » (noms de touches du navigateur).

export const DEFAULT_SHORTCUTS = { toggle: 'Ctrl+Alt+KeyS', match: 'Ctrl+Alt+KeyM' };

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/**
 * Combinaison tapée, ou null tant qu'il n'y a qu'une touche de modification.
 * Il faut Ctrl ou Alt : une touche seule gênerait la frappe partout ailleurs.
 */
export function comboFromEvent(e) {
  if (MODIFIER_CODES.test(e.code)) return null;
  if (!e.ctrlKey && !e.altKey) return '';
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, e.code].join('+');
}

/** « Ctrl+Alt+KeyS » → « Ctrl + Alt + S ». */
export function shortcutLabel(combo) {
  return String(combo ?? '')
    .split('+')
    .map((t) => t
      .replace(/^Key([A-Z])$/, '$1')
      .replace(/^Digit(\d)$/, '$1')
      .replace(/^Numpad(\d)$/, 'Pavé $1')
      .replace(/^Arrow(Up|Down|Left|Right)$/, (_, d) => ({ Up: '↑', Down: '↓', Left: '←', Right: '→' }[d]))
      .replace(/^Shift$/, 'Maj')
      .replace(/^Space$/, 'Espace'))
    .join(' + ');
}
