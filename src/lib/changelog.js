// Notes de mise à jour : quelques points d'une phrase par version.
// À compléter à chaque nouvelle version (la plus récente en haut).
export const CHANGELOG = {
  '0.9.9': [
    '🖼️ Nouvelle icône du tray, nette à toutes les échelles d’écran (100 % à 300 %).',
    '⚡ Plus léger : la fenêtre Match ne relit plus rien quand elle est réduite, les logos se décodent en arrière-plan, et le widget oublie les vieux matchs.',
    '🩹 Fenêtre Match : les blessés de chaque équipe ; au hockey, la carte des tirs sur la patinoire.',
    '📋 Réglages : la fiche de tes joueurs favoris (stats de la saison et 5 derniers matchs).',
    '🏁 F1 (OpenF1) : carte du circuit, arrêts aux stands, direction de course (et notification si ton pilote est pénalisé), radio des équipes, météo, meilleurs tours, télémétrie de ton pilote.',
    '⭕ Widget : des coins arrondis nets (plus de petit carré aux coins).',
    '⏱️ Alerte « fin de match serrée » quand un match de tes équipes se joue à 1 but (ou quelques points) dans les dernières minutes.',
    '🔥 Séries de victoires (🔥) et de défaites (❄️) à côté de tes équipes, et dans la notification de fin de match.',
    '📈 Fenêtre Match : la courbe des chances de victoire pendant tout le match.',
    '🏎️ F1 : Q1, Q2, Q3 en qualifications (temps, éliminés, zone d’élimination, notification si ton pilote passe ou tombe), l’écart avec le pilote devant, et les pneus (OpenF1).',
    '⚡ Démarrage plus rapide et moins de requêtes à ESPN (réponses partagées entre les fenêtres).',
    '🧹 La mémoire de l’app se nettoie seule ; bouton « Vider » dans Diagnostic.',
    '🖼️ Fond d’écran : la fiche ne passe plus sous les pastilles de forme.',
  ],
  '0.9.8': [
    '📐 Forme du widget : tire le coin en bas à droite pour choisir sa taille ; coins arrondis, très arrondis, légers ou carrés (Réglages → Widget). Le bouton ⤡ du widget remet la forme de base.',
    '🏈 LCF : les logos viennent maintenant de Wikipédia (Hamilton et Ottawa compris).',
    '🥅 Tirs de barrage au hockey en direct : chaque tir ✅ ou ❌ dans le widget, une notification par tir, et la liste des tireurs dans la fenêtre Match.',
    '📊 La fiche des équipes (victoires-défaites) est maintenant dans la fenêtre Match, quand tu cliques sur un match. Pour la remettre dans le widget : Réglages → Widget → Fiche des équipes dans le widget.',
  ],
  '0.9.7': [
    '⚾ Baseball : le lanceur au monticule et ses stats du match (manches, retraits au bâton, lancers) dans le widget, avec le compte et les buts occupés.',
    '⚾ Fenêtre Match : « Au monticule » (lanceur et frappeur), les partants annoncés avant le match, et les stats de chaque lanceur dans l’Alignement.',
    '📊 Fiche des équipes (victoires-défaites) aussi en mode compact, sous chaque logo.',
    '🏈 LCF : les joueurs apparaissent (nouvelle adresse d’ESPN).',
    '⏱️ Compte à rebours écrit « dans 4 h 19 » : on ne le confond plus avec une heure.',
  ],
  '0.9.6': [
    '🖼️ Fond d’écran : « Remettre mon fond d’écran » (Réglages → Fond d’écran) remet vraiment le tien. L’app en garde maintenant une copie.',
    '🖼️ Si tu choisis un autre fond d’écran dans Windows, l’app ne l’écrase plus : le mode s’arrête et le widget revient.',
    '🖼️ Quitter l’app remet ton fond d’écran (tes infos seraient devenues périmées).',
    '🏈 LCF : les derniers logos manquants (équipes renommées, comme Eskimos → Elks).',
  ],
  '0.9.5': [
    '🖼️ Nouveau mode Fond d’écran : tes matchs, résultats, la forme et le classement de tes équipes deviennent ton fond d’écran. Clique sur un match pour l’ouvrir.',
    '🎨 Fond d’écran personnalisable : couleur, photo, côté du panneau, sections affichées (Réglages → Fond d’écran).',
    '🪟 Mode « Widget + fond d’écran » : le widget se cache quand tu vas sur le bureau.',
    '🌈 Couleur « Équipe qui joue » : la couleur de ton équipe en match ; deux équipes : elles alternent toutes les 5 min, en fondu.',
    '⛔ Notifications de pénalités au hockey : qui, pour quoi, combien de minutes, avantage numérique.',
    '🧭 Calendrier, Classements, Réglages et Diagnostic en haut de la colonne.',
    '🏈 Logos LCF : nouvelle méthode, et le Diagnostic dit pourquoi s’il en manque. Photos de secours pour les joueurs sans portrait ESPN.',
    '🎾 Icônes ATP, WTA, golf et UFC partout dans le widget ; barres de statistiques de couleurs différentes ; nouvelle icône de l’app.',
  ],
  '0.9.4': [
    '🏈 LCF : les vrais logos des équipes (pris chez TheSportsDB quand ESPN n’en a pas), partout dans l’app.',
    '📊 Classement en pré-saison : les matchs préparatoires ne comptent plus. Tout le monde part de zéro.',
    '🎯 Plus de faux « 0 » : les statistiques qu’ESPN ne donne pas pour un match (tirs, possession…) sont masquées.',
    '🧩 Listes d’équipes : si une source d’ESPN en oublie, les autres complètent la liste.',
    '🩺 Diagnostic : le nombre d’équipes trouvées sur le nombre attendu, et celles sans logo.',
  ],
  '0.9.3': [
    '⬇️ Nouveau bouton dans le widget (à gauche de ↻) : cherche une mise à jour en un clic.',
    '⛳ Golfeurs favoris : choisis-les dans Réglages → PGA/LPGA. Leur rang dans le widget ⭐, et une notification quand ils prennent la tête, entrent dans le top 10 ou terminent.',
    '🎾 Tennis : une notification à chaque manche gagnée ou perdue par tes joueurs.',
    '🔔 Widget « Sur le bureau » : les notifications passent quand même devant toutes les fenêtres.',
    '🖥️ Cliquer sur le bureau de Windows n’est plus pris pour un jeu en plein écran (les notifications ne sont plus bloquées).',
  ],
  '0.9.2': [
    '🏈 LCF, Coupe du monde, NCAA… : les équipes se chargent par une autre adresse d’ESPN, celle qui n’est pas bloquée.',
    '🩺 Nouveau : Réglages → Diagnostic teste chaque ligue depuis ton ordi. Envoie une capture si une ligue ne marche pas.',
    '🛡️ Fenêtre Match : une partie illisible n’empêche plus d’afficher le reste, et l’erreur exacte s’affiche.',
    '🎾 Icônes pour l’ATP, la WTA, le golf et les compétitions internationales ; drapeaux corrigés.',
    '⛳ Les tournois de golf affichent leur jour (plus de « 0 h 00 ») ; la Coupe des Présidents montre le pointage des équipes.',
  ],
  '0.9.1': [
    '⭐ Joueurs favoris dans tous les sports : Réglages → Joueurs favoris, choisis la ligue puis cherche dans toute la ligue.',
    '🏈 Notification quand ton joueur marque un touché, ⚾ frappe un circuit ou fait marquer.',
    '📋 À la fin du match, la fiche de tes joueurs : « 32 points, 8 rebonds », « 1 but, 2 passes », « 2 en 4, 1 circuit »…',
  ],
  '0.9.0': [
    '🌍 Compétitions internationales : Coupe du monde, Euro, Copa América, Gold Cup… Suis ton pays ou toute la compétition.',
    '⛳ Golf (PGA, LPGA) : le tableau des meneurs en direct, et une notification quand le meneur change.',
    '🎾 Tennis (ATP, WTA) : choisis tes joueurs ; leurs matchs, manche par manche, et le résultat en notification.',
    '🏈 Nouvelles ligues : LCF et football universitaire (NCAA).',
    '🏎️ F1 : le classement de chaque séance (essais, qualifs, sprint, course) et le championnat, dans la fenêtre Match.',
    '🏒 Alignement : les trios et paires de défense au hockey, l’ordre des frappeurs et les lanceurs au baseball.',
    '🔎 Recherche parmi tous les joueurs de la LNH ; tes joueurs favoris te préviennent même si leur équipe n’est pas suivie.',
    '🎨 La couleur de ton équipe est bien plus présente, dans le widget et dans toutes les fenêtres.',
    '🐛 Chances de victoire toujours à 100 % au total ; logo de ton équipe dans les notifications ; « But pour CF Montréal ».',
  ],
  '0.8.3': [
    '✅ « Tout décocher » décoche aussi tes pilotes (F1) et tes combattants (UFC).',
  ],
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
