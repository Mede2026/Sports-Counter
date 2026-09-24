// Notes de mise à jour : quelques points d'une phrase par version.
// À compléter à chaque nouvelle version (la plus récente en haut).
export const CHANGELOG = {
  '0.8.2': [
    '📅 Le calendrier s’ouvre toujours sur aujourd’hui ; remonte pour voir les résultats des 14 derniers jours.',
    '⬆️ Le bouton « Voir 14 jours plus tôt » charge des résultats plus anciens, sans perdre ta place.',
  ],
  '0.8.1': [
    '📍 Le widget reste collé à ses bords (par exemple en bas à gauche, sur la barre des tâches) : il ne remonte plus après une mise à jour.',
    '🏆 Classement des joueurs : la saison régulière en cours (ou la dernière), plus les records de tous les temps.',
    '🇫🇷 Catégories bien traduites (« Buts », « Matchs joués »…) et une seule sélectionnée à la fois.',
    '👤 Photos retrouvées pour bien plus de joueurs ; sinon, leurs initiales au lieu d’un cercle vide.',
    '🏎️ F1 dans Classements : boutons Pilotes et Constructeurs.',
    '✨ Icône nette à toutes les tailles (zone de notification, barre des tâches, menu Démarrer).',
  ],
  '0.8.0': [
    '🎩 Notification quand un joueur réussit un tour du chapeau (3 buts dans le match).',
    '🥅 Filet désert : tu sais quand une équipe retire son gardien en fin de match.',
    '⏱️ Prolongation, tirs de barrage, tirs au but et manches supplémentaires sont annoncés.',
    '🏆 Séries : match 7, série gagnée, élimination de ton équipe et championnat.',
    '🏎️ F1 : drapeau rouge, voiture de sécurité et arrêts aux puits de tes pilotes.',
    '☀️ Le matin, un résumé des résultats d’hier de tes équipes (désactivable dans Réglages).',
  ],
  '0.7.2': [
    '🏒 Au hockey, le statut ne s’affiche plus en anglais (« 20:00 - 3rd ») : il devient « Début de la 3e période ».',
    '⏱️ L’horloge ne s’affiche plus deux fois de suite, au hockey comme au basket et au football.',
  ],
  '0.7.1': [
    '🅰️ Notification quand un de tes joueurs favoris fait une passe sur un but.',
    '⬆️ En course, notification quand un de tes pilotes favoris dépasse quelqu’un.',
    '📄 L’app a maintenant une licence : tu peux la télécharger et l’utiliser, mais pas copier son code.',
  ],
  '0.7.0': [
    '📊 Fenêtre Match → onglet Joueurs : les stats de chaque joueur (buts, passes, tirs, temps de jeu, arrêts…).',
    '📜 Onglet Jeux : tous les jeux du match, les plus récents en haut, traduits en français.',
    '🏆 Classements → Séries : le tableau des séries éliminatoires (LNH, NBA, WNBA, MLB, NFL).',
    '⭐ Ton équipe et tes joueurs favoris sont mis en évidence partout.',
  ],
  '0.6.4': [
    '🇫🇷 La traduction passe par un nouveau service de Google, plus fiable : l’ancien reste en secours.',
    '🔤 Les textes anglais qui restaient (statuts rares, résultats UFC, catégories, séances F1…) sont maintenant traduits aussi.',
    '🏎️ En F1, « Lap 23 of 57 » devient « Tour 23 / 57 ».',
  ],
  '0.6.3': [
    '🥊 Tu peux choisir tes combattants favoris à l’UFC, avec leur photo, comme tes pilotes en F1.',
    '⭐ Leur combat est mis en évidence dans le widget, la fenêtre Match et le calendrier.',
    '🔔 Un rappel avant leur combat, puis une notification quand il commence et quand ils gagnent ou perdent.',
    '🐛 Deux personnes avec le même nom de famille ne sont plus confondues.',
  ],
  '0.6.2': [
    '🌙 Les barres de défilement sont maintenant sombres et fines, au lieu de blanches.',
  ],
  '0.6.1': [
    '👤 Le classement des joueurs est arrivé : Classements → Joueurs, avec les 10 meilleurs de chaque catégorie.',
    '🏒 Au hockey : points, buts, passes, +/- et gardiens (victoires, % d’arrêts, moyenne, blanchissages).',
    '⭐ Les joueurs de tes équipes et tes joueurs favoris sont mis en évidence.',
  ],
  '0.6.0': [
    '🏆 Un nouvel onglet Classements montre la LNH, les autres ligues et le championnat de F1 (pilotes et constructeurs).',
    '⭐ La fenêtre Match affiche les 3 étoiles et les meneurs du match avec leur photo.',
    '📊 Une barre montre les chances de victoire de chaque équipe, avant et pendant le match.',
    '🎬 Les faits saillants vidéo s’ouvrent d’un clic depuis la fenêtre Match.',
    '⚡ Au démarrage, le widget affiche tout de suite les derniers scores connus.',
    '💾 L’app garde calendriers, classements et résultats en mémoire : elle démarre plus vite et utilise moins Internet.',
  ],
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
