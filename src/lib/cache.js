// Mémoire gardée sur le disque (localStorage), avec une durée de vie : elle
// survit au redémarrage de l'app et de Windows. Au lancement, l'app reprend
// ce qu'elle savait déjà au lieu de tout redemander à ESPN.

const PREFIX = 'sports-counter.cache.';

// Les dates redeviennent des objets Date à la relecture.
const DATE_KEYS = new Set(['startsAt', 'mainAt', 'date']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const revive = (key, value) => (DATE_KEYS.has(key) && typeof value === 'string' && ISO.test(value) ? new Date(value) : value);

/**
 * Cache nommé : get(clé) rend la valeur si elle a moins de `ttl` ms, sinon
 * undefined ; set(clé, valeur) l'écrit aussitôt sur le disque.
 */
export function diskCache(name, ttl) {
  const storageKey = PREFIX + name;
  let map = null;

  function load() {
    if (map) return map;
    map = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? '[]', revive);
      const now = Date.now();
      for (const [k, entry] of raw) if (now - entry.at < ttl) map.set(k, entry);
    } catch { /* cache illisible : on repart de zéro */ }
    return map;
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...map]));
    } catch {
      // Stockage plein : on vide ce cache plutôt que de bloquer l'app.
      try { localStorage.removeItem(storageKey); } catch { /* rien à faire */ }
    }
  }

  return {
    get(key) {
      const entry = load().get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.at >= ttl) { map.delete(key); return undefined; }
      return entry.value;
    },
    /** Âge de l'entrée en ms (Infinity si absente). */
    age(key) {
      const entry = load().get(key);
      return entry ? Date.now() - entry.at : Infinity;
    },
    set(key, value) {
      load().set(key, { at: Date.now(), value });
      save();
    },
  };
}
