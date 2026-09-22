// Génère les icônes de l'app à partir de tools/icon.svg, avec Chromium.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src-tauri', 'icons');
const SIZES = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 };

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
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<body style="margin:0;background:transparent">
         <div style="width:${size}px;height:${size}px">${svg}</div>
       </body>`
    );
    const buf = await page.screenshot({ omitBackground: true });
    fs.writeFileSync(path.join(OUT, name), buf);
    made[size] = buf;
    await page.close();
    console.log(`  ${name.padEnd(16)} ${size}x${size}  ${(buf.length / 1024).toFixed(1)} Ko`);
  }

  // L'ICO Windows regroupe plusieurs tailles dans un seul fichier.
  const icoSizes = [32, 128, 256];
  const pngs = [];
  for (const s of icoSizes) {
    if (made[s]) { pngs.push({ size: s, data: made[s] }); continue; }
    const page = await browser.newPage({ viewport: { width: s, height: s } });
    await page.setContent(`<body style="margin:0"><div style="width:${s}px;height:${s}px">${svg}</div></body>`);
    pngs.push({ size: s, data: await page.screenshot({ omitBackground: true }) });
    await page.close();
  }
  const ico = buildIco(pngs);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
  console.log(`  icon.ico         ${icoSizes.join('/')}     ${(ico.length / 1024).toFixed(1)} Ko`);

  await browser.close();
})();
