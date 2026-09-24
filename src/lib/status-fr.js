// Traduction immédiate (sans réseau) des petits textes d'ESPN qui reviennent
// sans cesse : statuts de match de chaque sport, termes de l'UFC. Les longues
// descriptions de jeux passent par translate.js.
// Ce qui reste inconnu part à Google Traduction (autoFr).
// Au baseball, « Haut de la 4e » sous-entend « manche », comme à la radio.
import { autoFr } from './translate.js';

const ord = (n) => (Number(n) === 1 ? '1re' : `${n}e`);   // manche, demie, période
const ordM = (n) => (Number(n) === 1 ? '1er' : `${n}e`);  // quart

const INNING_SIDE = { top: 'Haut', bot: 'Bas', bottom: 'Bas', mid: 'Milieu', middle: 'Milieu', end: 'Fin' };

const EXACT = {
  final: 'Final',
  'final/ot': 'Final (prol.)',
  'final/so': 'Final (TB)',
  halftime: 'Mi-temps',
  half: 'Mi-temps',
  ht: 'Mi-temps',
  ft: 'Terminé',
  'full time': 'Terminé',
  aet: 'Terminé (prol.)',
  'ft-pens': 'Terminé (tirs au but)',
  pens: 'Tirs au but',
  et: 'Prolongation',
  ot: 'Prolongation',
  postponed: 'Reporté',
  canceled: 'Annulé',
  cancelled: 'Annulé',
  delayed: 'Retardé',
  'rain delay': 'Retard (pluie)',
  suspended: 'Suspendu',
  abandoned: 'Abandonné',
  scheduled: 'À venir',
  tbd: 'À déterminer',
  'in progress': 'En cours',
  'end of period': 'Fin de période',
};

/**
 * Statut d'un match en français : « Top 4th » → « Haut de la 4e »,
 * « 7:42 - 3rd Qtr » → « 7:42 · 3e quart », « Halftime » → « Mi-temps ».
 * Rendu tel quel quand rien ne correspond.
 */
export function statusFr(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return raw;
  const low = raw.toLowerCase();
  if (EXACT[low]) return EXACT[low];

  let m;
  // Baseball : « Top 4th », « Bot 7th », « Mid 5th », « End 9th ».
  if ((m = /^(top|bot|bottom|mid|middle|end)\s+(?:of\s+(?:the\s+)?)?(\d+)(?:st|nd|rd|th)?$/i.exec(raw))) {
    return `${INNING_SIDE[m[1].toLowerCase()]} de la ${ord(m[2])}`;
  }
  // Baseball, manches supplémentaires : « Final/10 ».
  if ((m = /^final\/(\d+)$/i.exec(raw))) return `Final (${m[1]} manches)`;
  // Prolongations multiples : « Final/2OT ».
  if ((m = /^final\/(\d)ot$/i.exec(raw))) return `Final (${ord(m[1])} prol.)`;
  // Basket, football : « 7:42 - 3rd Qtr », « 7:42 - 3rd Quarter ».
  if ((m = /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d)(?:st|nd|rd|th)(?:\s*(?:qtr|quarter))?$/i.exec(raw))) {
    return `${m[1]} · ${ordM(m[2])} quart`;
  }
  if ((m = /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d)?ot$/i.exec(raw))) return `${m[1]} · ${m[2] ? `${ord(m[2])} ` : ''}prolongation`;
  if ((m = /^end of (\d)(?:st|nd|rd|th)(?:\s*(?:qtr|quarter))?$/i.exec(raw))) return `Fin du ${ordM(m[1])} quart`;
  if ((m = /^(\d)(?:st|nd|rd|th)\s*(?:qtr|quarter)$/i.exec(raw))) return `${ordM(m[1])} quart`;
  // Soccer : « 1st Half », « 2nd Half ».
  if ((m = /^(\d)(?:st|nd|rd|th)\s*half$/i.exec(raw))) return `${ord(m[1])} demie`;
  // Hockey hors LNH, formes génériques : « End of 2nd Period », « 2nd Period ».
  if ((m = /^end of (\d)(?:st|nd|rd|th)\s*period$/i.exec(raw))) return `Fin de la ${ord(m[1])} période`;
  if ((m = /^(\d)(?:st|nd|rd|th)\s*period$/i.exec(raw))) return `${ord(m[1])} période`;
  // F1 : « Lap 23 », « Lap 23 of 57 ».
  if ((m = /^lap\s+(\d+)(?:\s*(?:of|\/)\s*(\d+))?$/i.exec(raw))) return `Tour ${m[1]}${m[2] ? ` / ${m[2]}` : ''}`;
  // UFC : « End of Round 2 », « Round 2 ».
  if ((m = /^end of (?:round|rd) (\d)$/i.exec(raw))) return `Fin du round ${m[1]}`;
  if ((m = /^(?:round|rd|r)\s*(\d)$/i.exec(raw))) return `Round ${m[1]}`;
  return autoFr(raw);
}

/* ---------- UFC ---------- */

const WEIGHTS = [
  [/light heavyweight/i, 'Mi-lourds'],
  [/heavyweight/i, 'Poids lourds'],
  [/middleweight/i, 'Poids moyens'],
  [/welterweight/i, 'Mi-moyens'],
  [/lightweight/i, 'Poids légers'],
  [/featherweight/i, 'Poids plumes'],
  [/bantamweight/i, 'Poids coqs'],
  [/flyweight/i, 'Poids mouches'],
  [/strawweight/i, 'Poids pailles'],
  [/catchweight/i, 'Poids convenu'],
];

/** Catégorie de poids : « Women's Flyweight » → « Poids mouches (femmes) ». */
export function weightFr(text) {
  const raw = String(text ?? '').trim();
  const hit = WEIGHTS.find(([re]) => re.test(raw));
  if (!hit) return autoFr(raw);
  return /women/i.test(raw) ? `${hit[1]} (femmes)` : hit[1];
}

const RESULTS = [
  [/unanimous/i, 'Décision unanime'],
  [/split/i, 'Décision partagée'],
  [/majority/i, 'Décision majoritaire'],
  [/decision/i, 'Décision'],
  [/submission/i, 'Soumission'],
  [/tko|ko|knockout/i, 'KO/TKO'],
  [/no contest/i, 'Sans décision'],
  [/disqualif/i, 'Disqualification'],
  [/draw/i, 'Nul'],
];

/** Méthode de victoire : « Decision - Unanimous » → « Décision unanime ». */
export function resultFr(text) {
  const raw = String(text ?? '').trim();
  return RESULTS.find(([re]) => re.test(raw))?.[1] ?? autoFr(raw);
}

/** Partie de la soirée : « Main Card » → « Carte principale ». */
export function segmentFr(text) {
  const raw = String(text ?? '').trim();
  if (/early prelim/i.test(raw)) return 'Préliminaires hâtifs';
  if (/prelim/i.test(raw)) return 'Préliminaires';
  if (/main/i.test(raw)) return 'Carte principale';
  return autoFr(raw);
}

/* ---------- Tennis ---------- */

const ROUNDS_FR = [
  [/^final$|^finals?$|championship/i, 'Finale'],
  [/semi/i, 'Demi-finale'],
  [/quarter/i, 'Quart de finale'],
  [/round of 16|4th round|fourth round/i, '8e de finale'],
  [/round of 32|3rd round|third round/i, '3e tour'],
  [/round of 64|2nd round|second round/i, '2e tour'],
  [/round of 128|1st round|first round/i, '1er tour'],
  [/qualif/i, 'Qualifications'],
];

/** Tour d'un tournoi : « Quarterfinal » → « Quart de finale ». */
export function roundFr(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  return ROUNDS_FR.find(([re]) => re.test(raw))?.[1] ?? autoFr(raw);
}

/** Tableau : « Men's Singles » → « Simple messieurs ». */
export function drawFr(text) {
  const raw = String(text ?? '').trim();
  const who = /women|ladies/i.test(raw) ? 'dames' : /men|gentlemen/i.test(raw) ? 'messieurs' : '';
  const what = /double/i.test(raw) ? 'Double' : /single/i.test(raw) ? 'Simple' : '';
  return what ? `${what}${who ? ` ${who}` : ''}` : raw;
}
