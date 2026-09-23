// Petits morceaux d'affichage partagés par le widget, la fenêtre Match,
// les réglages et les notifications.

export const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** Texte sûr dans du HTML (contenu ou attribut). */
export const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Période, prolongation : « 1re », « 2e ». */
export const ordinal = (n) => (n === 1 ? '1re' : `${n}e`);

/** Rang, place : « 1er », « 2e ». */
export const rank = (n) => (n === 1 ? '1er' : `${n}e`);

/* ---------- Derniers résultats : ✅ ❌ ➖ ---------- */

const FORM_ICONS = { V: '✅', D: '❌', N: '➖' };
const FORM_WORDS = { V: 'Victoire', D: 'Défaite', N: 'Nul' };

/** « ✅❌✅✅❌ » */
export const formIcons = (list) => list.map((f) => FORM_ICONS[f.res] ?? '').join('');

/** Infobulle : une ligne par match (« Victoire 4-2 c. TOR »). */
export const formTitle = (list) => list.map((f) => `${FORM_WORDS[f.res] ?? ''} ${f.score} c. ${f.opp}`).join('\n');
