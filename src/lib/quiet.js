// Heures silencieuses : les notifications attendent, puis un seul résumé
// arrive quand elles se terminent.

const KEY = 'sports-counter.quiet.v1';
const MAX_HELD = 30;

const minutes = (hhmm) => {
  const [h, m] = String(hhmm ?? '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
};

/** Vrai pendant les heures silencieuses (la plage peut passer minuit). */
export function inQuietHours(prefs, now = new Date()) {
  if (!prefs?.quietHours) return false;
  const from = minutes(prefs.quietFrom);
  const to = minutes(prefs.quietTo);
  if (from === null || to === null || from === to) return false;
  const n = now.getHours() * 60 + now.getMinutes();
  return from < to ? n >= from && n < to : n >= from || n < to;
}

/** Notifications retenues (gardées si l'app redémarre pendant la nuit). */
export function heldToasts() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function holdToast(toast) {
  const list = heldToasts();
  list.push({ title: toast.title ?? '', body: toast.body ?? '', team: toast.team ?? null, color: toast.color ?? '', theme: toast.theme });
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_HELD))); } catch { /* plein */ }
}

export function clearHeld() {
  try { localStorage.removeItem(KEY); } catch { /* rien */ }
}

/** Le résumé des notifications retenues, en une seule notification. */
export function quietSummary(list) {
  if (!list?.length) return null;
  const titles = [...new Set(list.map((t) => t.title).filter(Boolean))];
  const shown = titles.slice(0, 3).join(' · ');
  const more = titles.length > 3 ? ` · et ${titles.length - 3} autre${titles.length - 3 > 1 ? 's' : ''}` : '';
  const last = list.at(-1);
  return {
    title: `🌙 Pendant tes heures silencieuses (${list.length})`,
    body: shown + more,
    link: '',
    color: last.color || '#4aa3ff',
    big: true,
    multi: true,
    theme: last.theme,
    team: last.team ?? { abbr: '🌙', logo: '', color: '#4aa3ff' },
  };
}
