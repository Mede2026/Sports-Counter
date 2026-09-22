// Préférences persistées dans localStorage (aucune dépendance, aucun fichier à gérer).
const KEY = 'sports-counter.prefs.v1';

const DEFAULTS = {
  // Équipes suivies, sous la forme "<idLigue>:<idÉquipeESPN>" (ex. "nhl:10").
  favorites: [],
  // Ligues suivies en entier, sans filtre d'équipe (ex. "f1").
  leagues: [],
  // Cacher les matchs terminés depuis plus de 6 h.
  hideOldFinals: true,
  // Nombre maximum de cartes affichées dans le widget.
  maxGames: 4,
  // Opacité de la fenêtre, de 0.3 à 1.
  opacity: 1,
  // Mode compact : masque la ligne de statut détaillée.
  compact: false,
};

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs) {
  localStorage.setItem(KEY, JSON.stringify(prefs));
  // Prévient l'autre fenêtre (widget <-> réglages) qu'il faut recharger.
  localStorage.setItem('sports-counter.ping', String(Date.now()));
}

export { DEFAULTS };
