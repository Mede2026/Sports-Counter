// Préférences persistées dans localStorage (aucune dépendance, aucun fichier à gérer).
import { DEFAULT_SHORTCUTS } from './shortcut.js';

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
  // Nom et couleurs de chaque favori, notés au moment où on le coche.
  favInfo: {},
  // Favori dont le widget prend la couleur ("nhl:10"), ou '' pour aucun.
  theme: '',
  // Cacher le widget quand un jeu ou une vidéo passe en plein écran.
  hideFullscreen: true,
  // Notifications de l'app : buts, débuts et fins de match, séances de F1.
  notifications: true,
  // Affichage du widget : 'always' (toujours, devant les fenêtres),
  // 'desktop' (toujours, mais sur le bureau, derrière les fenêtres ; les
  // notifications passent devant), 'live' (pendant un match seulement),
  // 'never' (notifications seulement).
  widgetMode: 'always',
  // Taille du widget : 's' (petit), 'm' (moyen), 'l' (grand).
  widgetSize: 'm',
  // Rappel avant le début d'un match ou d'une séance, en minutes (0 = aucun).
  reminderMinutes: 15,
  // Pilotes de F1 favoris : [{ id, name, short, photo, team }].
  favDrivers: [],
  // Combattants de l'UFC favoris : [{ id, name, short, photo }].
  favFighters: [],
  // Joueurs de tennis favoris : [{ id, name, short, photo, leagueId }].
  favTennis: [],
  // Golfeurs favoris : [{ id, name, short, photo, leagueId }].
  favGolfers: [],
  // Mode Grand Prix : top 5 et écarts pendant une course.
  gpMode: true,
  // Joueurs de hockey favoris : [{ id, name, photo, teamId }].
  favPlayers: [],
  // Thème du widget et des notifications : 'dark', 'light' ou 'auto'.
  widgetTheme: 'dark',
  // Les 5 derniers résultats (✅ ❌) à côté des équipes favorites.
  showForm: true,
  // Traduire en français les descriptions d'ESPN (Google Traduction, sans compte).
  translate: true,
  // Résultats d'hier de tes équipes, en notification le matin.
  morningDigest: true,
  notifyPenalties: true,
  notifyClose: true,
  // Fiche V-D dans le widget : non (elle est dans la fenêtre Match).
  widgetRecords: false,
  // Klaxon de but quand ton équipe marque : son 'auto' (selon le sport),
  // 'horn', 'whistle', 'buzzer', 'organ' ou 'chime' ; volume de 0 à 100.
  goalSound: true,
  goalSoundKind: 'auto',
  goalSoundVolume: 60,
  // Heures silencieuses : aucune notification entre ces heures (un résumé
  // arrive à la fin).
  quietHours: false,
  quietFrom: '23:00',
  quietTo: '07:00',
  // Bandeau défilant : '' (non), 'top' (haut de l'écran) ou 'bottom' (bas).
  ticker: '',
  // Raccourcis clavier globaux (format « Ctrl+Alt+KeyS »).
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const prefs = { ...DEFAULTS, ...JSON.parse(raw) };
    // Avant la 0.5.0, un seul pilote favori (favDriver) : il devient le premier de la liste.
    if (prefs.favDriver && !prefs.favDrivers?.length) prefs.favDrivers = [prefs.favDriver];
    delete prefs.favDriver;
    return prefs;
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
