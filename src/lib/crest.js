// Pastille d'équipe : logo distant si disponible, sinon monogramme coloré.
// Aucun attribut `onerror` en ligne — la CSP de Tauri les bloquerait.

export function crestHtml(team, cls = 'crest') {
  const color = team.color || '#3b4150';
  const abbr = team.abbr || '?';
  if (team.logo) {
    return `<img class="${cls}" src="${team.logo}" alt=""
      data-abbr="${abbr}" data-color="${color}" data-cls="${cls}" />`;
  }
  return `<span class="${cls}" style="background:${color}">${abbr}</span>`;
}

/** À rappeler après chaque innerHTML : branche le repli sur les logos. */
export function bindCrests(root) {
  root.querySelectorAll('img[data-abbr]').forEach((img) => {
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = img.dataset.cls || 'crest';
      span.style.background = img.dataset.color;
      span.textContent = img.dataset.abbr;
      img.replaceWith(span);
    }, { once: true });
  });
}
