// Mode « Fond d'écran » : une image aux dimensions de l'écran, avec le
// prochain match en grand, puis ce qui se passe aujourd'hui, les matchs à
// venir, les derniers résultats et le classement des équipes suivies.
// Dessinée dans un canevas, puis posée comme fond d'écran par Rust.

import { LEAGUES_BY_ID } from './leagues.js';
import { TIME_FMT, dayText, isDate, isDateOnly } from './time.js';
import { brightAccent, visibleTeamColor, alternating, playingColors, LIVE_THEME } from './color.js';

const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const DAY_FMT = new Intl.DateTimeFormat('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' });

const INK = '#f2f4f8';
const MUTED = 'rgba(242, 244, 248, 0.58)';
const FAINT = 'rgba(242, 244, 248, 0.34)';
const LIVE = '#ff5a5f';
const WIN = '#3ecf8e';
const LOSS = '#ff6b6b';

const leagueShort = (id) => LEAGUES_BY_ID[id]?.short ?? LEAGUES_BY_ID[id]?.label ?? '';
const leagueLogo = (id) => LEAGUES_BY_ID[id]?.logo ?? '';

/** « Ce soir · 19 h 00 », « Samedi · 13 h 00 », « Samedi » (jour seulement). */
export function whenLine(date, now = new Date()) {
  if (!isDate(date)) return '';
  const raw = dayText(date, now);
  const day = raw.charAt(0).toUpperCase() + raw.slice(1);
  return isDateOnly(date) ? day : `${day} · ${TIME_FMT.format(date)}`;
}

/** Compte à rebours grossier : l'image n'est refaite que toutes les 15 min. */
export function untilCoarse(date, now = new Date()) {
  if (!isDate(date)) return '';
  const h = (date.getTime() - now.getTime()) / 3600e3;
  if (h <= 0) return '';
  if (h < 1) return 'dans moins d’une heure';
  if (h < 24) return `dans ${Math.floor(h)} h`;
  const d = Math.round(h / 24);
  return `dans ${d} jour${d > 1 ? 's' : ''}`;
}

/* ---------- Modèle : ce que l'image montre ---------- */

/** Un match ou un évènement, réduit à ce que l'image affiche. */
export function rowOf(g, now = new Date()) {
  const base = { id: g.id, leagueId: g.leagueId, league: leagueShort(g.leagueId), leagueLogo: leagueLogo(g.leagueId), state: g.state };
  if (g.kind === 'match' && g.home && g.away) {
    const side = (t) => ({ id: String(t.id ?? ''), abbr: t.abbr ?? '', name: t.name ?? '', logo: t.logo ?? '', score: t.score ?? '', winner: !!t.winner, record: t.record ?? '' });
    return {
      ...base,
      kind: 'match',
      away: side(g.away),
      home: side(g.home),
      when: g.state === 'pre' ? whenLine(g.startsAt, now)
        : g.state === 'post' && isDate(g.startsAt) ? `${g.statusText || 'Final'} · ${dayText(g.startsAt, now)}`
          : [g.clock, g.statusText].filter(Boolean).join(' · '),
    };
  }
  return {
    ...base,
    kind: 'event',
    title: g.title ?? g.name ?? '',
    logo: g.logo || leagueLogo(g.leagueId),
    when: g.state === 'pre' ? whenLine(g.mainAt ?? g.startsAt, now) : [g.session, g.statusText].filter(Boolean).join(' · '),
  };
}

/**
 * Tout ce que l'image montre, à partir des matchs déjà connus du widget.
 * - `today` : matchs suivis d'aujourd'hui (en direct d'abord) ;
 * - `teamGames` : [{ key, games }] calendrier de chaque équipe favorite ;
 * - `standings` : Map « ligue:équipe » -> { rank, group, points }.
 */
export function buildModel({ today = [], teamGames = [], standings = new Map(), favInfo = {}, division = null, f1 = null, now = new Date() }) {
  const t = now.getTime();
  const byId = new Map();
  const add = (g) => { if (g?.id && !byId.has(g.id)) byId.set(g.id, g); };
  today.forEach(add);
  teamGames.forEach(({ games }) => games.forEach(add));
  const all = [...byId.values()];
  const time = (g) => (isDate(g.startsAt) ? g.startsAt.getTime() : 0);
  const sameDay = (g) => isDate(g.startsAt) && g.startsAt.toDateString() === now.toDateString();

  const live = all.filter((g) => g.state === 'in');
  const todayRows = [...live, ...all.filter((g) => g.state !== 'in' && sameDay(g)).sort((a, b) => time(a) - time(b))];
  const upcoming = all.filter((g) => g.state === 'pre' && !sameDay(g) && time(g) > t).sort((a, b) => time(a) - time(b));
  // Derniers résultats : le dernier match terminé de chaque équipe (10 jours).
  const results = [];
  for (const { key, games } of teamGames) {
    const last = games.filter((g) => g.state === 'post' && t - time(g) < 10 * 864e5).sort((a, b) => time(b) - time(a))[0];
    if (!last || sameDay(last) || results.some((x) => x.game === last)) continue;
    const teamId = String(key ?? '').split(':')[1];
    const mine = last.home?.id === teamId ? last.home : last.away?.id === teamId ? last.away : null;
    results.push({ game: last, won: mine ? !!mine.winner : null });
  }
  results.sort((a, b) => time(b.game) - time(a.game));

  const table = [];
  for (const [key, s] of standings) {
    const info = favInfo[key] ?? {};
    table.push({
      name: info.name ?? '', abbr: info.abbr ?? '', logo: info.logo ?? '',
      line: [`${s.rank}${s.rank === 1 ? 'er' : 'e'}`, s.group, s.points ? `${s.points} pts` : ''].filter(Boolean).join(' · '),
    });
  }

  // Forme : les 5 derniers résultats de chaque équipe favorite.
  const form = [];
  for (const { key, games } of teamGames) {
    const teamId = String(key ?? '').split(':')[1];
    const mine = (g) => (g.home?.id === teamId ? g.home : g.away?.id === teamId ? g.away : null);
    const played = games.filter((g) => g.state === 'post' && mine(g)).sort((a, b) => time(a) - time(b)).slice(-5);
    const results = played.map((g) => {
      const me = mine(g);
      const opp = me === g.home ? g.away : g.home;
      return me.winner ? 'V' : opp?.winner ? 'D' : 'N';
    });
    const info = favInfo[key] ?? {};
    const latest = [...games].sort((a, b) => time(b) - time(a)).map(mine).find((x) => x?.record);
    if (results.length || latest) {
      form.push({ teamId, name: info.name ?? '', abbr: info.abbr ?? '', logo: info.logo ?? '', results, record: latest?.record ?? '' });
    }
  }

  const heroGame = live[0] ?? todayRows.find((g) => g.state === 'pre') ?? upcoming[0] ?? null;
  const hero = heroGame ? rowOf(heroGame, now) : null;
  if (hero?.kind === 'match') {
    for (const side of [hero.away, hero.home]) side.form = form.find((f) => f.teamId === side.id)?.results ?? [];
  }
  if (hero && heroGame.state === 'pre') hero.until = untilCoarse(heroGame.startsAt, now);
  return {
    now,
    hero,
    form: form.slice(0, 5),
    division,
    f1: f1?.slice(0, 5) ?? null,
    today: todayRows.filter((g) => g !== heroGame).slice(0, 4).map((g) => rowOf(g, now)),
    upcoming: upcoming.filter((g) => g !== heroGame).slice(0, 6).map((g) => rowOf(g, now)),
    results: results.slice(0, 4).map(({ game, won }) => ({ ...rowOf(game, now), won })),
    standings: table.slice(0, 4),
  };
}

/** Adresses des images à charger avant de dessiner. */
export function imageUrls(model) {
  const urls = new Set();
  const rows = [model.hero, ...model.today, ...model.upcoming, ...model.results].filter(Boolean);
  for (const r of rows) {
    if (r.kind === 'match') { urls.add(r.away.logo); urls.add(r.home.logo); } else urls.add(r.logo);
    urls.add(r.leagueLogo);
  }
  model.standings.forEach((s) => urls.add(s.logo));
  (model.form ?? []).forEach((f) => urls.add(f.logo));
  (model.division?.rows ?? []).forEach((r) => urls.add(r.logo));
  urls.delete('');
  urls.delete(undefined);
  return [...urls];
}

/** Signature du contenu : on ne redessine le fond d'écran que s'il change. */
export function modelKey(model) {
  const strip = (r) => r && (r.kind === 'match'
    ? `${r.id}|${r.away.score}-${r.home.score}|${r.when}`
    : `${r.id}|${r.when}`);
  return JSON.stringify([
    model.now.toDateString(), strip(model.hero), model.today.map(strip), model.upcoming.map(strip),
    model.results.map(strip), model.standings.map((s) => s.name + s.line),
    (model.form ?? []).map((f) => f.results.join('') + f.record), model.division, model.f1, model.hero?.until,
  ]);
}

/* ---------- Dessin ---------- */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Texte coupé avec « … » s'il dépasse la largeur donnée. */
function fitText(ctx, text, max) {
  let s = String(text ?? '');
  if (ctx.measureText(s).width <= max) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Logo contenu dans un carré, ou son sigle dans un rond s'il manque. */
function drawLogo(ctx, img, abbr, x, y, size) {
  if (img) {
    const w = img.width || size;
    const h = img.height || size;
    const k = Math.min(size / w, size / h);
    ctx.drawImage(img, x + (size - w * k) / 2, y + (size - h * k) / 2, w * k, h * k);
    return;
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.font = `700 ${Math.round(size * 0.3)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(abbr ?? '').slice(0, 4), x + size / 2, y + size / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** Options par défaut du fond d'écran (réglables dans les réglages). */
export const WALLPAPER_DEFAULTS = {
  bg: 'team', // 'team' (couleur de l'équipe), 'photo' (une image), 'dark' (noir)
  color: '', // '' : couleur de l'équipe du thème ; sinon une couleur choisie
  side: 'right', // côté du panneau des listes
  dim: 0.55, // assombrissement de la photo, pour lire le texte
  hero: true, today: true, upcoming: true, results: true, standings: true,
  form: true, division: true, f1: true,
};

/** Image en « couverture » : remplit tout, recadrée au centre. */
function drawCover(ctx, image, W, H) {
  const w = image.width || W;
  const h = image.height || H;
  const k = Math.max(W / w, H / h);
  ctx.drawImage(image, (W - w * k) / 2, (H - h * k) / 2, w * k, h * k);
}

/**
 * Dessine l'image entière. `images` : Map adresse -> image déjà chargée.
 * `opts` : WALLPAPER_DEFAULTS + `accent` (couleur de l'équipe) et `photo`
 * (image d'arrière-plan déjà chargée, pour bg: 'photo').
 */
export function drawWallpaper(canvas, model, images, opts = {}) {
  const o = { ...WALLPAPER_DEFAULTS, ...opts };
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  // Zones cliquables : chaque match dessiné, pour ouvrir sa fenêtre Match.
  const spots = [];
  ctx.spot = (r, x, y, w, h) => {
    if (r?.id && r.leagueId) spots.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), league: r.leagueId, event: String(r.id) });
  };
  const u = H / 1080; // tout est pensé pour un écran 1080p, puis mis à l'échelle
  const img = (url) => (url ? images.get(url) ?? null : null);
  const color = brightAccent(o.color || o.accent || '#4aa3ff', 0.18) ?? '#4aa3ff';
  // Deux équipes favorites en match : la seconde colore l'autre lueur.
  const color2 = (o.accent2 && brightAccent(o.accent2, 0.18)) || color;
  const glow = (x, y, r, alpha, c = color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `${c}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`);
    g.addColorStop(1, `${c}00`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };

  // Arrière-plan : photo assombrie, noir, ou nuit bleutée à la couleur de l'équipe.
  if (o.bg === 'photo' && o.photo) {
    drawCover(ctx, o.photo, W, H);
    ctx.fillStyle = `rgba(6, 9, 15, ${Math.min(0.9, Math.max(0, Number(o.dim) || 0))})`;
    ctx.fillRect(0, 0, W, H);
  } else if (o.bg === 'dark') {
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, W, H);
  } else {
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0a0e17');
    bg.addColorStop(1, '#131b2c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    glow(W * (o.side === 'left' ? 0.72 : 0.28), H * 0.42, H * 0.75, 0.22);
    glow(W * (o.side === 'left' ? 0.05 : 0.95), H * 1.05, H * 0.6, o.accent2 ? 0.26 : 0.12, color2);
  }

  // Panneau des listes, à droite par défaut : la gauche reste libre pour les icônes.
  const margin = 56 * u;
  const panelW = Math.min(640 * u, W * 0.42);
  const px = o.side === 'left' ? margin : W - panelW - margin;
  const top = 64 * u;
  const bottom = H - 96 * u; // au-dessus de la barre des tâches
  ctx.fillStyle = 'rgba(10, 14, 23, 0.62)';
  roundRect(ctx, px, top, panelW, bottom - top, 28 * u);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = Math.max(1, u);
  ctx.stroke();

  // Zone libre à côté du panneau : le grand match, puis des cartes en bas.
  const zoneX = o.side === 'left' ? px + panelW + margin : margin * 2.2;
  const zoneW = o.side === 'left' ? W - zoneX - margin * 2.2 : px - margin * 3.2;
  const hasCards = (o.form && model.form?.length) || (o.division && model.division?.rows?.length) || (o.f1 && model.f1?.length);
  const cardsH = Math.min(380 * u, (bottom - top) * 0.42);
  if (o.hero) {
    drawHero(ctx, model, img, { x: zoneX, y: top, w: zoneW, h: bottom - top - (hasCards ? cardsH : 0), u, color, compact: hasCards });
  }
  if (hasCards) {
    drawCards(ctx, model, img, o, { x: zoneX, y: bottom - cardsH, w: zoneW, h: cardsH, u, color });
  }

  let y = top + 44 * u;
  const inner = { x: px + 32 * u, w: panelW - 64 * u };
  const room = (rows) => y + (40 + rows * 62) * u < bottom - 24 * u;
  const section = (title, rows, draw) => {
    if (!rows.length || !room(1)) return;
    ctx.fillStyle = color;
    ctx.font = `700 ${Math.round(15 * u)}px ${FONT}`;
    ctx.fillText(title.toUpperCase(), inner.x, y);
    y += 22 * u;
    for (const r of rows) {
      if (!room(1)) break;
      draw(r, y);
      y += 62 * u;
    }
    y += 26 * u;
  };

  // Sans le grand « prochain match », il rejoint la liste d'aujourd'hui ou à venir.
  const heroRows = !o.hero && model.hero ? [model.hero] : [];
  const heroToday = heroRows.filter((r) => r.state !== 'pre' || /^Aujourd/.test(r.when));
  const heroLater = heroRows.filter((r) => !heroToday.includes(r));
  if (o.today) section('Aujourd’hui', [...heroToday, ...model.today], (r, ry) => drawRow(ctx, r, img, inner, ry, u));
  if (o.upcoming) section('À venir', [...heroLater, ...model.upcoming], (r, ry) => drawRow(ctx, r, img, inner, ry, u));
  if (o.results) section('Derniers résultats', model.results, (r, ry) => drawRow(ctx, r, img, inner, ry, u));
  if (o.standings) section('Classement', model.standings, (s, ry) => {
    drawLogo(ctx, img(s.logo), s.abbr, inner.x, ry + 10 * u, 38 * u);
    ctx.fillStyle = INK;
    ctx.font = `600 ${Math.round(21 * u)}px ${FONT}`;
    ctx.fillText(fitText(ctx, s.name, inner.w - 60 * u), inner.x + 54 * u, ry + 30 * u);
    ctx.fillStyle = MUTED;
    ctx.font = `500 ${Math.round(16 * u)}px ${FONT}`;
    ctx.fillText(fitText(ctx, s.line, inner.w - 60 * u), inner.x + 54 * u, ry + 52 * u);
  });

  if (!model.hero && !model.today.length && !model.upcoming.length && !model.results.length) {
    ctx.fillStyle = MUTED;
    ctx.font = `500 ${Math.round(20 * u)}px ${FONT}`;
    ctx.fillText('Aucun match suivi pour l’instant.', inner.x, y + 10 * u);
    ctx.fillText('Choisis tes équipes dans les réglages.', inner.x, y + 40 * u);
  }

  // Pied : l'heure de la mise à jour, pour savoir si c'est frais.
  ctx.fillStyle = FAINT;
  ctx.font = `500 ${Math.round(14 * u)}px ${FONT}`;
  ctx.fillText(`Sports Counter · mis à jour à ${TIME_FMT.format(model.now)}`, inner.x, bottom - 22 * u);
  delete ctx.spot;
  return spots;
}

/** Petites pastilles V / D / N des derniers matchs, centrées sur x. */
function drawForm(ctx, results, x, y, u, align = 'center') {
  const r = 11 * u;
  const step = 27 * u;
  const width = results.length * step - (step - r * 2);
  let cx = align === 'center' ? x - width / 2 + r : x + r;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const res of results) {
    ctx.fillStyle = res === 'V' ? WIN : res === 'D' ? LOSS : 'rgba(242, 244, 248, 0.4)';
    ctx.beginPath();
    ctx.arc(cx, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0a0e17';
    ctx.font = `800 ${Math.round(12 * u)}px ${FONT}`;
    ctx.fillText(res, cx, y + u);
    cx += step;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/**
 * Le prochain match (ou celui en cours), en grand. `compact` : des cartes
 * suivent en dessous, le bloc se tasse en haut au lieu d'être centré.
 */
function drawHero(ctx, model, img, { x, y, w, h, u, color, compact }) {
  const cx = x + w / 2;
  const block = 520 * u;
  const oy = compact ? y : y + Math.max(0, (h - block) / 2 - 30 * u);
  ctx.textAlign = 'center';
  // Date du jour, en tête : le fond d'écran sert aussi de calendrier.
  const day = DAY_FMT.format(model.now);
  ctx.fillStyle = MUTED;
  ctx.font = `500 ${Math.round(26 * u)}px ${FONT}`;
  ctx.fillText(day.charAt(0).toUpperCase() + day.slice(1), cx, y + 60 * u);

  const r = model.hero;
  if (!r) {
    ctx.textAlign = 'left';
    return;
  }
  const live = r.state === 'in';
  const center = oy + 240 * u; // centre des logos
  ctx.spot?.(r, x, oy + 90 * u, w, 440 * u);
  ctx.fillStyle = live ? LIVE : color;
  ctx.font = `800 ${Math.round(20 * u)}px ${FONT}`;
  ctx.fillText(live ? '● EN DIRECT' : r.state === 'post' ? 'TERMINÉ' : 'PROCHAIN MATCH', cx, oy + 118 * u);

  let below = center + 100 * u;
  if (r.kind === 'match') {
    const size = Math.min(150 * u, w * 0.2);
    const gap = Math.min(310 * u, w * 0.36);
    // Un disque clair derrière chaque logo : les logos foncés restent lisibles.
    for (const dx of [-gap, gap]) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
      ctx.beginPath();
      ctx.arc(cx + dx, center, size * 0.68, 0, Math.PI * 2);
      ctx.fill();
    }
    drawLogo(ctx, img(r.away.logo), r.away.abbr, cx - gap - size / 2, center - size / 2, size);
    drawLogo(ctx, img(r.home.logo), r.home.abbr, cx + gap - size / 2, center - size / 2, size);
    const nameY = center + size * 0.68 + 36 * u;
    for (const [side, dx] of [[r.away, -gap], [r.home, gap]]) {
      ctx.textAlign = 'center';
      ctx.fillStyle = INK;
      ctx.font = `600 ${Math.round(26 * u)}px ${FONT}`;
      ctx.fillText(fitText(ctx, side.name, gap * 0.9), cx + dx, nameY);
      if (side.record) {
        ctx.fillStyle = MUTED;
        ctx.font = `500 ${Math.round(18 * u)}px ${FONT}`;
        ctx.fillText(side.record, cx + dx, nameY + 28 * u);
      }
      if (side.form?.length) drawForm(ctx, side.form, cx + dx, nameY + 56 * u, u);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = INK;
    ctx.font = `800 ${Math.round((live || r.state === 'post' ? 84 : 54) * u)}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(live || r.state === 'post' ? `${r.away.score}  –  ${r.home.score}` : '@', cx, center);
    ctx.textBaseline = 'alphabetic';
    below = nameY + (r.away.form?.length || r.home.form?.length ? 110 : r.away.record ? 80 : 50) * u;
  } else {
    const size = Math.min(150 * u, w * 0.24);
    drawLogo(ctx, img(r.logo), r.league, cx - size / 2, center - size / 2, size);
    ctx.fillStyle = INK;
    ctx.font = `700 ${Math.round(40 * u)}px ${FONT}`;
    ctx.fillText(fitText(ctx, r.title, w * 0.9), cx, center + size / 2 + 56 * u);
    below = center + size / 2 + 110 * u;
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = live ? LIVE : INK;
  ctx.font = `600 ${Math.round(32 * u)}px ${FONT}`;
  ctx.fillText(fitText(ctx, r.when, w * 0.9), cx, below);
  const extra = [r.until, r.league].filter(Boolean).join(' · ');
  ctx.fillStyle = r.until ? color : FAINT;
  ctx.font = `700 ${Math.round(18 * u)}px ${FONT}`;
  ctx.fillText(extra, cx, below + 38 * u);
  ctx.textAlign = 'left';
}

/** Carte à titre, pour la bande du bas (forme, division, championnat F1). */
function drawCard(ctx, title, { x, y, w, h, u, color }, body) {
  ctx.fillStyle = 'rgba(10, 14, 23, 0.55)';
  roundRect(ctx, x, y, w, h, 22 * u);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = Math.max(1, u);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = `700 ${Math.round(15 * u)}px ${FONT}`;
  ctx.fillText(fitText(ctx, title.toUpperCase(), w - 48 * u), x + 24 * u, y + 38 * u);
  body({ x: x + 24 * u, y: y + 58 * u, w: w - 48 * u, h: h - 76 * u });
}

/** Bande du bas, sous le grand match : forme, division, championnat F1. */
function drawCards(ctx, model, img, o, { x, y, w, h, u, color }) {
  const cards = [];
  if (o.form && model.form?.length) {
    cards.push(['Forme · 5 derniers', (b) => {
      const rowH = Math.min(46 * u, b.h / model.form.length);
      model.form.forEach((f, i) => {
        const ry = b.y + i * rowH;
        drawLogo(ctx, img(f.logo), f.abbr, b.x, ry, 30 * u);
        ctx.fillStyle = INK;
        ctx.font = `600 ${Math.round(17 * u)}px ${FONT}`;
        ctx.fillText(fitText(ctx, f.abbr || f.name, 70 * u), b.x + 40 * u, ry + 21 * u);
        if (f.record) {
          ctx.fillStyle = MUTED;
          ctx.font = `500 ${Math.round(14 * u)}px ${FONT}`;
          ctx.fillText(f.record, b.x + 100 * u, ry + 21 * u);
        }
        drawForm(ctx, f.results, b.x + b.w - f.results.length * 27 * u + 5 * u, ry + 15 * u, u, 'left');
      });
    }]);
  }
  if (o.division && model.division?.rows?.length) {
    const d = model.division;
    cards.push([d.title, (b) => {
      const rows = d.rows.slice(0, Math.max(1, Math.floor(b.h / (34 * u))));
      const rowH = 34 * u;
      rows.forEach((r, i) => {
        const ry = b.y + i * rowH;
        if (r.fav) {
          ctx.fillStyle = `${color}33`;
          roundRect(ctx, b.x - 10 * u, ry - 4 * u, b.w + 20 * u, rowH - 2 * u, 8 * u);
          ctx.fill();
        }
        ctx.fillStyle = MUTED;
        ctx.font = `600 ${Math.round(15 * u)}px ${FONT}`;
        ctx.fillText(String(r.rank), b.x, ry + 19 * u);
        drawLogo(ctx, img(r.logo), r.abbr, b.x + 28 * u, ry + 1 * u, 24 * u);
        ctx.fillStyle = INK;
        ctx.font = `${r.fav ? 800 : 600} ${Math.round(16 * u)}px ${FONT}`;
        ctx.fillText(fitText(ctx, r.abbr, b.w - 170 * u), b.x + 62 * u, ry + 19 * u);
        ctx.textAlign = 'right';
        ctx.fillStyle = MUTED;
        ctx.font = `500 ${Math.round(14 * u)}px ${FONT}`;
        if (r.gp) ctx.fillText(`${r.gp} PJ`, b.x + b.w - 60 * u, ry + 19 * u);
        ctx.fillStyle = INK;
        ctx.font = `700 ${Math.round(16 * u)}px ${FONT}`;
        ctx.fillText(r.points, b.x + b.w, ry + 19 * u);
        ctx.textAlign = 'left';
      });
    }]);
  }
  if (o.f1 && model.f1?.length) {
    cards.push(['Championnat F1', (b) => {
      const rowH = Math.min(46 * u, b.h / model.f1.length);
      model.f1.forEach((d, i) => {
        const ry = b.y + i * rowH;
        ctx.fillStyle = i < 3 ? color : MUTED;
        ctx.font = `800 ${Math.round(17 * u)}px ${FONT}`;
        ctx.fillText(String(d.rank ?? i + 1), b.x, ry + 21 * u);
        ctx.fillStyle = INK;
        ctx.font = `600 ${Math.round(17 * u)}px ${FONT}`;
        ctx.fillText(fitText(ctx, d.name, b.w - 110 * u), b.x + 34 * u, ry + 21 * u);
        ctx.textAlign = 'right';
        ctx.fillStyle = MUTED;
        ctx.font = `700 ${Math.round(16 * u)}px ${FONT}`;
        ctx.fillText(`${d.points} pts`, b.x + b.w, ry + 21 * u);
        ctx.textAlign = 'left';
      });
    }]);
  }
  if (!cards.length) return;
  const gap = 24 * u;
  const cw = (w - gap * (cards.length - 1)) / cards.length;
  cards.forEach(([title, body], i) => drawCard(ctx, title, { x: x + i * (cw + gap), y, w: cw, h, u, color }, body));
}

/** Une ligne de liste : ligue, logos, sigles, pointage ou date. */
function drawRow(ctx, r, img, box, y, u) {
  const size = 34 * u;
  const cy = y + 30 * u;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
  roundRect(ctx, box.x - 12 * u, y, box.w + 24 * u, 54 * u, 14 * u);
  ctx.fill();
  ctx.spot?.(r, box.x - 12 * u, y, box.w + 24 * u, 54 * u);

  ctx.fillStyle = FAINT;
  ctx.font = `700 ${Math.round(13 * u)}px ${FONT}`;
  ctx.fillText(fitText(ctx, r.league, 52 * u), box.x, cy + 5 * u);
  let x = box.x + 60 * u;
  const right = box.x + box.w;
  const live = r.state === 'in';

  if (r.kind === 'match') {
    const team = (t, lost) => {
      drawLogo(ctx, img(t.logo), t.abbr, x, cy - size / 2, size);
      x += size + 8 * u;
      ctx.fillStyle = lost ? MUTED : INK;
      ctx.font = `700 ${Math.round(19 * u)}px ${FONT}`;
      ctx.fillText(t.abbr, x, cy + 7 * u);
      x += ctx.measureText(t.abbr).width + 12 * u;
    };
    const done = r.state === 'post';
    team(r.away, done && r.home.winner);
    if (r.state !== 'pre') {
      ctx.fillStyle = live ? LIVE : INK;
      ctx.font = `800 ${Math.round(20 * u)}px ${FONT}`;
      const score = `${r.away.score} – ${r.home.score}`;
      ctx.fillText(score, x, cy + 7 * u);
      x += ctx.measureText(score).width + 12 * u;
    } else {
      ctx.fillStyle = FAINT;
      ctx.font = `600 ${Math.round(17 * u)}px ${FONT}`;
      ctx.fillText('@', x, cy + 6 * u);
      x += 26 * u;
    }
    team(r.home, done && r.away.winner);
  } else {
    drawLogo(ctx, img(r.logo), r.league, x, cy - size / 2, size);
    x += size + 10 * u;
    ctx.fillStyle = INK;
    ctx.font = `600 ${Math.round(18 * u)}px ${FONT}`;
    ctx.fillText(fitText(ctx, r.title, Math.max(40 * u, right - x - 170 * u)), x, cy + 6 * u);
  }

  // À droite : l'heure, ou l'état du match.
  ctx.textAlign = 'right';
  ctx.fillStyle = live ? LIVE : r.state === 'post' ? (r.won === false ? LOSS : r.won ? WIN : MUTED) : MUTED;
  ctx.font = `600 ${Math.round(15 * u)}px ${FONT}`;
  const room = Math.max(60 * u, right - x - 8 * u);
  ctx.fillText(fitText(ctx, r.when, room), right, cy + 5 * u);
  ctx.textAlign = 'left';
}

/* ---------- Images, options, rendu complet ---------- */

const inTauri = () => !!globalThis.window?.__TAURI__;
const imageCache = new Map(); // adresse -> image chargée (ou null)

/**
 * Charge une image pour le canevas. Dans l'app, les octets passent par Rust :
 * une image d'un autre site « salirait » le canevas, qu'on ne pourrait plus
 * enregistrer comme fond d'écran.
 */
export async function loadImage(url) {
  if (!url) return null;
  if (imageCache.has(url)) return imageCache.get(url);
  let image = null;
  try {
    if (url.startsWith('data:') || !inTauri()) {
      image = await new Promise((resolve, reject) => {
        const i = new Image();
        if (!url.startsWith('data:')) i.crossOrigin = 'anonymous';
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
    } else {
      const bytes = await window.__TAURI__.core.invoke('image_bytes', { url });
      image = await createImageBitmap(new Blob([bytes]));
    }
  } catch { image = null; } // logo introuvable : on dessine son sigle
  imageCache.set(url, image);
  return image;
}

let photoCache = { ver: null, image: null };

/** Photo d'arrière-plan (choisie, ou le fond d'écran d'origine), relue si `ver` change. */
export async function loadPhoto(ver = 0) {
  if (photoCache.ver === ver) return photoCache.image;
  let image = null;
  if (inTauri()) {
    try {
      const bytes = await window.__TAURI__.core.invoke('wallpaper_photo');
      image = await createImageBitmap(new Blob([bytes]));
    } catch { image = null; } // pas de photo : l'arrière-plan d'équipe prend le relais
  }
  photoCache = { ver, image };
  return image;
}

/** Options du fond d'écran, réglages de l'utilisateur par-dessus les défauts. */
export const wallpaperOptions = (prefs) => ({ ...WALLPAPER_DEFAULTS, ...(prefs?.wallpaper ?? {}) });

/** Couleur de l'équipe du thème, sinon de la 1re favorite, sinon le bleu de l'app. */
export function teamAccent(prefs) {
  const info = (prefs?.theme !== LIVE_THEME && prefs?.favInfo?.[prefs.theme]) || prefs?.favInfo?.[prefs?.favorites?.[0]];
  return visibleTeamColor(info?.color, info?.alt) ?? '#4aa3ff';
}

/** Charge tout ce qu'il faut, puis dessine l'image dans le canevas. */
/**
 * Couleurs de l'image : [principale, seconde ou null]. « Équipe qui joue »
 * (choisie ici, ou suivie du widget) : celles des favorites en match, qui
 * alternent toutes les 5 min.
 */
export function wallpaperColors(prefs, games = [], now = Date.now()) {
  const o = wallpaperOptions(prefs);
  const live = o.color === LIVE_THEME || (!o.color && prefs?.theme === LIVE_THEME);
  if (live) {
    const [a, b] = alternating(playingColors(prefs, games), now);
    return [a ?? teamAccent(prefs), b];
  }
  return [o.color || teamAccent(prefs), null];
}

/** Charge tout ce qu'il faut, dessine l'image et renvoie ses zones cliquables. */
export async function renderWallpaper(canvas, model, prefs, games = []) {
  const o = wallpaperOptions(prefs);
  const images = new Map();
  await Promise.all(imageUrls(model).map(async (url) => images.set(url, await loadImage(url))));
  const photo = o.bg === 'photo' ? await loadPhoto(o.photoVer ?? 0) : null;
  const [accent, accent2] = wallpaperColors(prefs, games, model.now?.getTime?.() ?? Date.now());
  return drawWallpaper(canvas, model, images, { ...o, color: accent, accent2, photo });
}

// Dernier contenu dessiné par le widget : l'aperçu des réglages le reprend.
export const MODEL_KEY = 'sports-counter.wallpaper.model';

export function saveModel(model) {
  try { localStorage.setItem(MODEL_KEY, JSON.stringify(model)); } catch { /* aperçu seulement */ }
}

export function readModel() {
  try {
    const m = JSON.parse(localStorage.getItem(MODEL_KEY) ?? 'null');
    if (m) m.now = new Date(m.now);
    return m;
  } catch {
    return null;
  }
}
