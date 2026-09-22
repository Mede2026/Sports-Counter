// Rend le widget et l'écran de réglages dans Chromium, avec les données de démo,
// et enregistre des captures dans tools/preview/.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'preview');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/__bureau.html') {
        res.writeHead(200, { 'Content-Type': TYPES['.html'] });
        res.end(DESKTOP);
        return;
      }
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
        res.writeHead(404).end('introuvable');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Faux bureau, pour juger l'effet de verre dépoli du widget.
const DESKTOP = `
  <style>
    html,body{margin:0;height:100%;overflow:hidden}
    body{
      background:
        radial-gradient(900px 600px at 18% 12%, #2b4a8a 0%, transparent 60%),
        radial-gradient(800px 700px at 85% 78%, #6c2f6b 0%, transparent 58%),
        linear-gradient(150deg, #10131c 0%, #1a1f30 45%, #0c0e15 100%);
    }
    iframe{position:absolute;border:0;background:transparent;}
    #w{top:40px;left:40px;width:300px;height:600px;}
  </style>
  <iframe id="w" src="/index.html?demo"></iframe>`;

(async () => {
  const { server, port } = await serve();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  // 1. Le widget posé sur un bureau, aux couleurs des Canadiens
  const page = await browser.newPage({ viewport: { width: 380, height: 650 }, deviceScaleFactor: 2 });
  // Réglage de couleur écrit avant tout script, dans le localStorage partagé
  // par le faux bureau et le widget (même origine).
  await page.addInitScript(() => {
    localStorage.setItem('sports-counter.prefs.v1', JSON.stringify({
      theme: 'nhl:10',
      favInfo: { 'nhl:10': { name: 'Canadiens de Montréal', abbr: 'MTL', color: '#c41230', alt: '#013a81' } },
    }));
  });
  await page.goto(`http://127.0.0.1:${port}/__bureau.html`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, 'widget.png') });
  console.log('  tools/preview/widget.png');
  await page.close();

  // 2. La fenêtre de réglages
  const s = await browser.newPage({ viewport: { width: 780, height: 540 }, deviceScaleFactor: 2 });
  await s.goto(`http://127.0.0.1:${port}/settings.html?demo`);
  await s.waitForTimeout(800);
  await s.screenshot({ path: path.join(OUT, 'settings.png') });
  console.log('  tools/preview/settings.png');
  await s.close();

  // 3. Une notification, posée juste au-dessus d'un bout de barre des tâches
  const t = await browser.newPage({ viewport: { width: 340, height: 116 }, deviceScaleFactor: 2 });
  await t.goto(`http://127.0.0.1:${port}/toast.html?demo`);
  await t.addStyleTag({ content: `
    html, body { background: linear-gradient(150deg, #1a1f30, #3a2a4a) !important; }
    body { padding: 20px; }` });
  await t.waitForTimeout(500);
  await t.screenshot({ path: path.join(OUT, 'toast.png') });
  console.log('  tools/preview/toast.png');
  await t.close();

  await browser.close();
  server.close();
})();
