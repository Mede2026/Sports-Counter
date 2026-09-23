// Une commande Tauri qui échoue rejette avec une simple chaîne, pas un objet
// Error. Lire `err.message` donnait donc « undefined » à l'écran.
export function errText(err) {
  if (err == null) return 'erreur inconnue';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  if (typeof err.message === 'string' && err.message) return err.message;
  try {
    const s = JSON.stringify(err);
    return s && s !== '{}' ? s : String(err);
  } catch {
    return String(err);
  }
}

/**
 * Vrai quand l'échec vient du réseau de l'ordinateur (pas de Wi-Fi, câble
 * débranché…) plutôt que d'ESPN. Le navigateur dit seulement « Failed to
 * fetch », ce qu'il dit aussi quand ESPN refuse ; c'est le relais Rust qui
 * tranche : « réseau : … » veut dire qu'il n'a même pas joint le serveur.
 */
export function isOffline(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const text = errText(err);
  return /failed to fetch|networkerror|load failed/i.test(text) && /réseau :/i.test(text);
}

export const OFFLINE_TITLE = 'Pas de connexion Internet';
export const OFFLINE_HINT = 'Vérifie ta connexion Internet (Wi-Fi ou câble). Les scores reviendront tout seuls dès qu\'elle sera rétablie.';

/** Message à afficher pour une erreur : clair quand c'est la connexion. */
export function friendlyError(err) {
  return isOffline(err) ? `${OFFLINE_TITLE}. ${OFFLINE_HINT}` : errText(err);
}
