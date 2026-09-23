// Logo actuel de la Formule 1, retracé en SVG et intégré à l'app : il
// s'affiche toujours, même quand ESPN n'envoie pas le sien (réglages, hors
// week-end de course). Tracé calqué sur le logo officiel, en rouge F1.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="24 318 1952 488"><g fill="#ff2000">'
  + '<path d="M24 806L380 452C470 365 540 322 745 318H1632L1447 500H790C640 500 590 525 530 583L300 806Z"/>'
  + '<path d="M350 806L548 606C610 545 660 531 765 531H1417L1247 701H785C720 701 695 715 675 735L605 806Z"/>'
  + '<path d="M1183 806L1669 318H1976L1488 806Z"/>'
  + '</g></svg>';

export const F1_LOGO = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
