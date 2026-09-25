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
// Caches de cette version : les autres (anciennes versions) sont effacés.
const KNOWN = new Set();

export function diskCache(name, ttl) {
  KNOWN.add(name);
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

/* ---------- Nettoyage ---------- */

const DAY = 24 * 3600 * 1000;
const PRUNED_KEY = 'sports-counter.pruned';
// Listes d'équipes d'anciennes versions (« …teams.nhl.v2 ») : remplacées.
const OLD_TEAMS = /^sports-counter\.teams\..+\.v[12]$/;

const storageKeys = () => {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
  return keys.filter(Boolean);
};

/**
 * Une fois par jour : efface les caches d'anciennes versions, les entrées de
 * plus de 30 jours, et garde 400 entrées au plus par cache (les plus
 * récentes). Renvoie le nombre de caractères libérés.
 */
export function pruneStorage({ force = false, maxAgeMs = 30 * DAY, maxEntries = 400 } = {}) {
  const today = new Date().toDateString();
  try {
    if (!force && localStorage.getItem(PRUNED_KEY) === today) return 0;
  } catch {
    return 0;
  }
  let freed = 0;
  for (const key of storageKeys()) {
    const raw = localStorage.getItem(key) ?? '';
    const stale = (key.startsWith(PREFIX) && !KNOWN.has(key.slice(PREFIX.length))) || OLD_TEAMS.test(key);
    if (stale) {
      localStorage.removeItem(key);
      freed += raw.length;
      continue;
    }
    if (!key.startsWith(PREFIX)) continue;
    try {
      const entries = JSON.parse(raw);
      const kept = entries
        .filter(([, e]) => e && Date.now() - e.at < maxAgeMs)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, maxEntries);
      if (kept.length !== entries.length) {
        const text = JSON.stringify(kept);
        localStorage.setItem(key, text);
        freed += raw.length - text.length;
      }
    } catch {
      localStorage.removeItem(key); // illisible : on repart de zéro
      freed += raw.length;
    }
  }
  try { localStorage.setItem(PRUNED_KEY, today); } catch { /* plein */ }
  return freed;
}

/** Taille de la mémoire de l'app sur le disque (caractères). */
export function storageSize() {
  return storageKeys().filter((k) => k.startsWith('sports-counter.')).reduce((n, k) => n + k.length + (localStorage.getItem(k)?.length ?? 0), 0);
}

/**
 * Vide toute la mémoire de l'app (scores, équipes, logos, photos…), sauf les
 * réglages et les traductions. Tout se recharge d'ESPN au besoin.
 */
export function clearCaches() {
  for (const key of storageKeys()) {
    if (key.startsWith(PREFIX) || key.startsWith('sports-counter.teams.') || key.startsWith('sports-counter.drivers')) localStorage.removeItem(key);
  }
}
