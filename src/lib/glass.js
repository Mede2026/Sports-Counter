// Effet de verre des fenêtres (translucide) : « acrylique » (flou, le bureau
// se devine derrière), « mica » (teinte du fond d'écran, Windows 11) ou
// aucun. Chaque page importe ce module : il applique le réglage à sa propre
// fenêtre, et le réapplique quand les réglages changent.
const KEY = 'sports-counter.prefs.v1';
export const GLASS_MODES = ['acrylic', 'mica', 'off'];

/** Effet choisi ; l'acrylique par défaut. */
export const glassMode = (prefs) => (GLASS_MODES.includes(prefs?.glass) ? prefs.glass : 'acrylic');

let applied = null;

/**
 * Pose l'effet sur la fenêtre de la page. Les fonds deviennent translucides
 * (classe « glass ») seulement si Windows a accepté l'effet : sinon, ils
 * restent opaques et lisibles.
 */
export async function applyGlass(mode) {
  const root = document.documentElement;
  const tauri = typeof window !== 'undefined' ? window.__TAURI__ : null;
  // Aperçu dans un navigateur : rien derrière la page, on garde les fonds pleins.
  if (!tauri) { root.classList.remove('glass', 'glass--round'); return; }
  if (mode === applied) return;
  applied = mode;
  try {
    const round = await tauri.core.invoke('set_glass', { mode });
    root.classList.toggle('glass', mode !== 'off');
    root.classList.toggle('glass--round', mode !== 'off' && round === true);
  } catch {
    root.classList.remove('glass', 'glass--round');
  }
}

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
};

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  applyGlass(glassMode(read()));
  window.addEventListener('storage', (e) => { if (e.key === KEY) applyGlass(glassMode(read())); });
}
