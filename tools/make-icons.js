// Génère les icônes de l'app à partir de tools/icon.svg, avec Chromium.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src-tauri', 'icons');
const SIZES = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 };

// Tailles de l'ICO Windows : zone de notification (16-24), barre des tâches et
// menu Démarrer (24-48 selon la mise à l'échelle), Explorateur (64-256).
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// En dessous de cette taille, l'icône complète devient floue (traits de 2 px,
// grande marge) : on dessine une version simplifiée, calée sur les pixels.
const SMALL_MAX = 48;

/**
 * Icône simplifiée pour les petites tailles : pleine case, deux rangées de
 * pointage et les deux points, sans reflet ni trait du bas. Dessinée sur une
 * grille de 16 et arrondie au pixel près pour chaque taille.
 */
function smallSvg(size) {
  // Petite marge dès 24 px, comme les autres icônes de Windows.
  const m = size <= 20 ? 0 : Math.round(size * 0.05);
  const k = (size - 2 * m) / 16;
  const r = (v) => m + Math.round(v * k);
  const bar = (x, y, w, h, extra = '') => `<rect x="${r(x)}" y="${r(y)}" width="${r(x + w) - r(x)}" height="${r(y + h) - r(y)}" rx="${Math.max(1, r(h) / 2)}" ${extra}/>`;
  // Deux rangées de pointage (longue barre, point, longue barre, puis plus
  // courtes) ; dès 24 px, le trait du bas de la grande icône.
  const tiny = size <= 20;
  const [y1, y2] = tiny ? [5, 9] : [4, 7.5];
  const rows = [
    bar(1.5, y1, 4.5, 2),
    bar(7, y1, 2, 2),
    bar(10, y1, 4.5, 2),
    bar(1.5, y2, 3, 2, 'opacity="0.8"'),
    bar(7, y2, 2, 2),
    bar(10, y2, 3, 2, 'opacity="0.8"'),
    tiny ? '' : bar(1.5, 11.5, 13, 1.5, 'opacity="0.4"'),
  ].map((x) => `    ${x}`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="${size <= 20 ? 'crispEdges' : 'auto'}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4fa6ff"/>
      <stop offset="0.55" stop-color="#3f6ffa"/>
      <stop offset="1" stop-color="#6d4dfa"/>
    </linearGradient>
  </defs>
  <rect x="${m}" y="${m}" width="${size - 2 * m}" height="${size - 2 * m}" rx="${Math.round((size - 2 * m) * 0.24)}" fill="url(#g)" shape-rendering="auto"/>
  <g fill="#ffffff">
${rows}
  </g>
  </g>
</svg>`;
}

/** Rendu PNG d'une taille : version simplifiée ou complète. */
async function render(browser, svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const art = size <= SMALL_MAX ? smallSvg(size) : svg;
  await page.setContent(`<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;line-height:0">${art}</div></body>`);
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return buf;
}

/** Assemble un .ico contenant des PNG (format accepté par Windows Vista+). */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type : icône
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 signifie 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const made = {};

  for (const [name, size] of Object.entries(SIZES)) {
    const buf = await render(browser, svg, size);
    fs.writeFileSync(path.join(OUT, name), buf);
    made[size] = buf;
    console.log(`  ${name.padEnd(16)} ${size}x${size}  ${(buf.length / 1024).toFixed(1)} Ko`);
  }

  // L'ICO Windows regroupe toutes les tailles : Windows prend la plus proche
  // au lieu de réduire une grande image (ce qui la rendait floue).
  const pngs = [];
  for (const s of ICO_SIZES) pngs.push({ size: s, data: made[s] ?? await render(browser, svg, s) });
  const ico = buildIco(pngs);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
  console.log(`  icon.ico         ${ICO_SIZES.join('/')}  ${(ico.length / 1024).toFixed(1)} Ko`);

  // Planche de contrôle : toutes les tailles côte à côte, fond clair et sombre.
  if (process.env.ICON_SHEET) {
    const cells = [];
    for (const { size: s, data } of pngs) cells.push(`<img src="data:image/png;base64,${data.toString('base64')}" width="${s}" height="${s}">`);
    const page = await browser.newPage({ viewport: { width: 760, height: 360 }, deviceScaleFactor: 2 });
    const row = (bg) => `<div style="background:${bg};display:flex;gap:18px;align-items:end;padding:20px;image-rendering:pixelated">${cells.join('')}</div>`;
    await page.setContent(`<body style="margin:0">${row('#f3f3f3')}${row('#202020')}</body>`);
    await page.screenshot({ path: process.env.ICON_SHEET, fullPage: true });
    await page.close();
  }

  await browser.close();
})();
