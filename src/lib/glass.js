// Effet de verre des fenêtres (translucide) : le fond d'écran de Windows,
// flou, se voit derrière l'app, comme dans l'Explorateur de fichiers.
//
// Les effets de Windows ne conviennent pas (flou noir sur Windows 11 récent,
// acrylique gris quand la fenêtre n'a pas le focus, boutons de Windows
// redessinés) : l'app dessine elle-même le fond d'écran flou, placé selon la
// position de la fenêtre sur l'écran. Chaque page importe ce module.
const KEY = 'sports-counter.prefs.v1';
export const GLASS_MODES = ['blur', 'off'];

/** « blur » (verre, par défaut) ou « off ». Les anciens choix (acrylique, mica) deviennent le verre. */
export const glassMode = (prefs) => (prefs?.glass === 'off' ? 'off' : 'blur');

const root = typeof document !== 'undefined' ? document.documentElement : null;
const tauri = () => (typeof window !== 'undefined' ? window.__TAURI__ : null);

let wanted = 'off';
let wall = null; // { url, w, h, style, tile, modified }
let lastPlace = '';
let timers = [];

/**
 * Taille et position du fond d'écran par rapport à la fenêtre, selon la façon
 * dont Windows l'affiche : remplir (10, par défaut), ajuster (6), étirer (2),
 * centrer ou mosaïque (0), étendre sur plusieurs écrans (22).
 */
export function wallpaperPlacement(w, h, style, tile, screenBox, win, ratio = 1) {
  const sw = screenBox.width;
  const sh = screenBox.height;
  let dw;
  let dh;
  if (style === '2') { dw = sw; dh = sh; }
  else if (style === '0') { dw = w / ratio; dh = h / ratio; }
  else {
    const k = style === '6' ? Math.min(sw / w, sh / h) : Math.max(sw / w, sh / h);
    dw = w * k;
    dh = h * k;
  }
  const x = style === '0' && tile === '1' ? 0 : (sw - dw) / 2;
  const y = style === '0' && tile === '1' ? 0 : (sh - dh) / 2;
  return {
    size: `${Math.round(dw)}px ${Math.round(dh)}px`,
    pos: `${Math.round(x - (win.x - screenBox.left))}px ${Math.round(y - (win.y - screenBox.top))}px`,
    repeat: style === '0' && tile === '1' ? 'repeat' : 'no-repeat',
  };
}

/** Recale le fond d'écran quand la fenêtre bouge (ou change d'écran). */
function place() {
  if (!wall) return;
  const p = wallpaperPlacement(wall.w, wall.h, wall.style, wall.tile,
    { width: screen.width, height: screen.height, left: screen.availLeft ?? 0, top: screen.availTop ?? 0 },
    { x: window.screenX, y: window.screenY }, window.devicePixelRatio || 1);
  const key = `${p.size}|${p.pos}|${p.repeat}`;
  if (key === lastPlace) return;
  lastPlace = key;
  root.style.setProperty('--glass-size', p.size);
  root.style.setProperty('--glass-pos', p.pos);
  root.style.setProperty('--glass-repeat', p.repeat);
}

/**
 * Lit le fond d'écran (seulement s'il a changé) et en fait une petite image
 * déjà floue : légère à afficher, et le flou n'est calculé qu'une fois.
 */
async function loadWallpaper() {
  const t = tauri();
  const info = await t.core.invoke('glass_wallpaper_info');
  if (!info?.found) throw new Error('aucun fond d’écran');
  if (wall && wall.modified === info.modified && wall.style === info.style && wall.tile === info.tile) return;
  const bytes = await t.core.invoke('glass_wallpaper_bytes');
  const bmp = await createImageBitmap(new Blob([bytes]));
  const w = 360;
  const h = Math.max(1, Math.round((w * bmp.height) / bmp.width));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'blur(5px) saturate(1.15)';
  // Un peu plus grand que la toile : les bords restent nets de transparence.
  ctx.drawImage(bmp, -12, -12, w + 24, h + 24);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (wall?.url) URL.revokeObjectURL(wall.url);
  wall = { url: URL.createObjectURL(blob), w: bmp.width, h: bmp.height, style: info.style, tile: info.tile, modified: info.modified };
  root.style.setProperty('--glass-img', `url("${wall.url}")`);
  lastPlace = '';
  place();
}

/** Applique le réglage à la fenêtre de la page. Sans fond d'écran lisible, les fonds restent pleins. */
export async function applyGlass(mode) {
  wanted = mode;
  timers.forEach(clearInterval);
  timers = [];
  if (!tauri() || mode === 'off') { root.classList.remove('glass'); return; }
  try {
    await loadWallpaper();
    if (wanted !== mode) return;
    root.classList.add('glass');
    timers.push(setInterval(place, 400));
    timers.push(setInterval(() => { loadWallpaper().catch(() => {}); }, 60 * 1000));
  } catch {
    root.classList.remove('glass');
  }
}

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
};

if (root && typeof window !== 'undefined') {
  applyGlass(glassMode(read()));
  window.addEventListener('storage', (e) => {
    if (e.key === KEY && glassMode(read()) !== wanted) applyGlass(glassMode(read()));
  });
}
