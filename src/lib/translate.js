// Traduction anglais → français des textes libres d'ESPN (descriptions des
// jeux, pénalités…). Deux moyens, sans rien installer ni créer de compte :
//   1. Google Traduction, par le relais Rust (commande translate_text) ;
//   2. à défaut, le traducteur intégré au moteur du navigateur (Edge /
//      WebView2), qui travaille sur l'ordinateur, quand Windows le fournit.
// Chaque phrase n'est traduite qu'une fois : le résultat est gardé.
// Les petits textes qu'aucun dictionnaire ne connaît (statut rare, méthode de
// victoire…) passent par autoFr : traduits en arrière-plan, puis l'évènement
// « sports-counter:translated » demande à la fenêtre de se redessiner.

const CACHE_KEY = 'sports-counter.translations.v1';
const CACHE_MAX = 600;

let cache = null; // Map anglais -> français

function loadCache() {
  if (cache) return cache;
  try {
    cache = new Map(JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]'));
  } catch {
    cache = new Map();
  }
  return cache;
}

function saveCache() {
  try {
    // Les plus récentes seulement : le cache ne grossit pas sans fin.
    const entries = [...cache].slice(-CACHE_MAX);
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch { /* stockage plein : on s'en passe */ }
}

/** Traduction déjà connue, sinon le texte d'origine. */
export function translated(text) {
  return loadCache().get(text) ?? text;
}

/** Traduction automatique activée dans les réglages (oui par défaut). */
function enabled() {
  try {
    return JSON.parse(localStorage.getItem('sports-counter.prefs.v1') ?? '{}')?.translate !== false;
  } catch {
    return true;
  }
}

export const TRANSLATED_EVENT = 'sports-counter:translated';

const queue = new Set();
let queueTimer = null;

/**
 * Texte en français : la traduction connue, sinon le texte tel quel ; un texte
 * anglais inconnu est mis en file pour être traduit tout de suite après.
 */
export function autoFr(text) {
  const raw = String(text ?? '').trim();
  if (!raw || !/[a-z]{2}/i.test(raw) || !enabled()) return raw;
  // Dates et heures (« 9/24 - 7:00 PM EDT ») : affichées autrement ailleurs.
  if (/\d+\/\d+|\d:\d\d\s*[ap]m\b/i.test(raw)) return raw;
  const hit = loadCache().get(raw);
  if (hit) return hit;
  queue.add(raw);
  if (!queueTimer && typeof window !== 'undefined') {
    queueTimer = setTimeout(async () => {
      queueTimer = null;
      const list = [...queue];
      queue.clear();
      if (await translateAll(list)) window.dispatchEvent(new Event(TRANSLATED_EVENT));
    }, 400);
  }
  return raw;
}

let onDevice; // traducteur intégré (créé une fois), null s'il n'existe pas

async function deviceTranslator() {
  if (onDevice !== undefined) return onDevice;
  onDevice = null;
  try {
    const T = globalThis.Translator;
    if (!T) return null;
    const opts = { sourceLanguage: 'en', targetLanguage: 'fr' };
    if ((await T.availability(opts)) === 'unavailable') return null;
    onDevice = await T.create(opts);
  } catch {
    onDevice = null; // modèle absent ou refusé : on passe à Google
  }
  return onDevice;
}

/**
 * Traduit les textes pas encore connus. Renvoie vrai si au moins un nouveau
 * texte a été traduit (l'appelant redessine alors).
 */
export async function translateAll(texts) {
  const known = loadCache();
  const todo = [...new Set(texts.filter((t) => t && /[a-z]/i.test(t) && !known.has(t)))];
  if (!todo.length) return false;

  let results = null;
  if (globalThis.window?.__TAURI__) {
    try {
      results = await window.__TAURI__.core.invoke('translate_text', { texts: todo });
    } catch {
      results = null; // Google injoignable : on essaie le traducteur intégré
    }
  }
  if (!results) {
    const device = await deviceTranslator();
    if (device) {
      try {
        results = [];
        for (const t of todo) results.push(await device.translate(t));
      } catch {
        results = null;
      }
    }
  }
  // Rien n'a marché (pas de réseau…) : on garde l'anglais.
  if (!results || results.length !== todo.length) return false;

  let changed = false;
  todo.forEach((t, i) => {
    const fr = String(results[i] ?? '').trim();
    if (fr) { known.set(t, fr); changed = true; }
  });
  if (changed) saveCache();
  return changed;
}
