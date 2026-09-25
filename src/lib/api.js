// Accès aux données ESPN.
// Deux chemins, essayés dans l'ordre :
//   1. fetch() depuis la page. Dans l'app, la page tourne dans WebView2, qui est
//      Chromium : la requête est celle d'un vrai navigateur, jusqu'à la poignée
//      de main TLS et au protocole HTTP/2. C'est ce que le pare-feu d'ESPN
//      laisse passer.
//   2. Le relais Rust (commande `espn_get`), si le premier chemin échoue.
//      reqwest n'imite pas un navigateur, donc ESPN peut le refuser, mais il
//      contourne un éventuel blocage CORS.
// Quand les deux échouent, l'erreur rapporte le résultat de chacun.
//
// Le code est rangé par thème dans lib/espn/ ; ce fichier les réunit.

export * from './espn/core.js';
export * from './espn/logos.js';
export * from './espn/scoreboard.js';
export * from './espn/detail.js';
export * from './espn/standings.js';
export * from './espn/people.js';
export { fetchTyres, tyresOf, TYRES, TYRE_NAMES, fetchF1Extras, fetchRaceControl, driverNumbers } from './openf1.js';
