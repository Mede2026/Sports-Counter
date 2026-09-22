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
