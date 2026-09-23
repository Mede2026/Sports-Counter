// Logo de la Formule 1, dessiné en SVG et intégré à l'app : il s'affiche
// toujours, même quand ESPN n'envoie pas le sien (écran de réglages, hors
// week-end de course). Tracé en rouge, lisible sur le fond sombre.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 26"><g fill="#e10600">'
  + '<path d="M26 0H80L71 9H30C26 9 23.5 10.3 21.5 13L12 26H0L13 8C17 2.5 20.5 0 26 0Z"/>'
  + '<path d="M26 14H56L49 21H21Z"/>'
  + '<path d="M86 0H100L81 26H67Z"/>'
  + '</g></svg>';

export const F1_LOGO = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
