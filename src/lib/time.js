// Heures et comptes à rebours, à la québécoise.

const DAY_FMT = new Intl.DateTimeFormat('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' });
const SHORT_DAY = new Intl.DateTimeFormat('fr-CA', { weekday: 'short' });
export const TIME_FMT = new Intl.DateTimeFormat('fr-CA', { hour: 'numeric', minute: '2-digit' });

export const isDate = (d) => d instanceof Date && !isNaN(d);

/** « Aujourd'hui · 19 h 00 », « Demain · 13 h 30 », « sam. 27 sept. · 19 h 00 ». */
export function whenText(date, now = new Date()) {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const day =
    date.toDateString() === now.toDateString() ? "Aujourd'hui"
    : date.toDateString() === tomorrow.toDateString() ? 'Demain'
    : DAY_FMT.format(date);
  return `${day} · ${TIME_FMT.format(date)}`;
}

/** Heure de départ courte : « 19 h 00 », ou « sam. 19 h 00 » un autre jour. */
export function shortWhen(date, now = new Date()) {
  if (!isDate(date)) return '';
  const time = TIME_FMT.format(date);
  return date.toDateString() === now.toDateString() ? time : `${SHORT_DAY.format(date)} ${time}`;
}

/**
 * Temps avant le départ : « dans 42 min », « dans 2 h 15 », « dans 3 j ».
 * `short` retire le « dans » (mode compact). Vide une fois l'heure passée.
 */
export function untilText(date, now = Date.now(), short = false) {
  if (!isDate(date)) return '';
  const min = Math.ceil((date.getTime() - now) / 60000);
  if (min <= 0) return '';
  const pre = short ? '' : 'dans ';
  if (min < 60) return `${pre}${min} min`;
  if (min < 24 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${pre}${h} h ${String(m).padStart(2, '0')}` : `${pre}${h} h`;
  }
  return `${pre}${Math.round(min / (24 * 60))} j`;
}

const LONG_DAY = new Intl.DateTimeFormat('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' });

/** En-tête de jour : « Aujourd'hui », « Demain », « Hier », « Samedi 27 septembre ». */
export function dayName(date, now = new Date()) {
  const shift = (d) => { const x = new Date(now); x.setDate(now.getDate() + d); return x.toDateString(); };
  const key = date.toDateString();
  if (key === shift(0)) return "Aujourd'hui";
  if (key === shift(1)) return 'Demain';
  if (key === shift(-1)) return 'Hier';
  const s = LONG_DAY.format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Jour seul, pour ce qui commence « dans la journée » sans heure précise
 * (tournoi de golf : ESPN donne minuit) : « Aujourd'hui », « Demain »,
 * « jeudi 24 sept. ».
 */
export function dayText(date, now = new Date()) {
  if (!isDate(date)) return '';
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === now.toDateString()) return "Aujourd'hui";
  if (date.toDateString() === tomorrow.toDateString()) return 'Demain';
  return date.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'short' });
}

/** Minuit pile : ESPN n'a donné que la date, pas l'heure. */
export const isDateOnly = (date) => isDate(date) && date.getHours() === 0 && date.getMinutes() === 0;
