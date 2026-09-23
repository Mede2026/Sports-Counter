// Notes de mise à jour : quelques points d'une phrase par version.
// À compléter à chaque nouvelle version (la plus récente en haut).
export const CHANGELOG = {
  '0.5.1': [
    '🇫🇷 Les descriptions des jeux d’ESPN sont traduites en français avec Google Traduction, sans compte.',
    '⚾ Les statuts sont en français dans tous les sports : « Haut de la 4e », « 3e quart », « Mi-temps »…',
    '🏎️ En mode compact, la F1 indique la séance (Essais 1, Qualifications, Course) au-dessus de l’heure.',
    '🧹 Les jeux en double d’ESPN ne s’affichent plus qu’une fois dans la fenêtre Match.',
  ],
  '0.5.0': [
    '⚽ La Liga, la Serie A, la Bundesliga, la Ligue 1 et la Ligue Europa sont maintenant disponibles.',
    '🥊 Tu peux suivre les galas de l’UFC : combat principal avec photos, combat en cours et vainqueur.',
    '🏎️ Tu peux choisir plusieurs pilotes favoris en F1.',
    '📅 Quand une équipe a plusieurs matchs à venir, le widget montre seulement le prochain.',
    '🎨 Le dégradé aux couleurs de ton équipe est plus visible en haut du widget.',
    '🗂️ Les ligues sont rangées par sport dans les réglages.',
  ],
  '0.4.4': [
    '◀️ Dans cet écran, les flèches permettent de revoir les notes des versions précédentes.',
    '🔋 En mode « Jamais (notifications) », le widget ne dessine plus rien pour rien : l’app travaille moins.',
    '🧹 Le code de l’app a été rangé pour que les prochaines nouveautés arrivent plus vite et avec moins de bugs.',
  ],
  '0.4.3': [
    '📝 Après chaque mise à jour, cet écran résume les nouveautés en quelques points.',
    '🔎 Tu peux le rouvrir quand tu veux en cliquant sur le numéro de version dans les réglages.',
  ],
  '0.4.2': [
    "📅 Le calendrier commence maintenant aujourd'hui au lieu du début du mois.",
    '📡 Sans Internet, le widget te demande de vérifier ta connexion et garde les derniers scores.',
  ],
  '0.4.1': [
    '⌨️ Tu peux choisir tes propres raccourcis clavier dans les réglages.',
    '🏎️ La liste des pilotes ne montre plus que les titulaires de la dernière course.',
    "🎨 La couleur de ton équipe est plus discrète : un fin liseré en haut au lieu d'un cadre.",
  ],
  '0.4.0': [
    '🏁 Le mode Grand Prix affiche le top 5 et les écarts pendant les courses.',
    '📅 Un nouvel onglet Calendrier montre les matchs de tes équipes et les Grands Prix.',
    '✅ Les 5 derniers résultats de tes équipes s’affichent à côté de leur nom.',
    '🚨 Tes joueurs favoris au hockey ont une notification spéciale quand ils marquent.',
    '☀️ Un thème clair est disponible pour le widget et les notifications.',
    '⌨️ Ctrl + Alt + M ouvre la fenêtre du match en cours.',
  ],
};

/** Compare deux numéros de version (« 0.4.2 » < « 0.4.10 »). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Versions à présenter, de la plus récente à la plus ancienne : toutes celles
 * installées depuis `since` (exclue) jusqu'à `current` (incluse). Sans
 * `since`, seulement la version actuelle.
 */
export function notesSince(since, current) {
  return Object.keys(CHANGELOG)
    .filter((v) => compareVersions(v, current) <= 0 && (since ? compareVersions(v, since) > 0 : v === current))
    .sort((a, b) => compareVersions(b, a))
    .map((v) => ({ version: v, points: CHANGELOG[v] }));
}
