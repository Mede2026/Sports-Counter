// Fiches par-dessus la fenêtre des réglages : une équipe (forme, prochains
// matchs, nouvelles, alignement) ou un joueur (bio, saison, derniers matchs).
// Ouvertes d'un clic dans les classements ou la liste des équipes.
import { fetchTeamGames, fetchRoster, fetchStandingsTable, fetchTeamNews, fetchPlayerBio, fetchPlayerOverview, STANDING_COLS } from './lib/api.js';
import { LEAGUES_BY_ID, sportOf } from './lib/leagues.js';
import { crestHtml, bindCrests } from './lib/crest.js';
import { faceHtml, bindFaces } from './lib/face.js';
import { esc } from './lib/format.js';
import { TIME_FMT } from './lib/time.js';
import { autoFr, translated } from './lib/translate.js';
import { errText } from './lib/err.js';

// Même crochet que dans la liste des équipes : suivre = cocher.
const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"
  stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>`;
const followBtn = (on, attr, yes, no) => `<button class="ghost ghost--small sh__follow${on ? ' sh__follow--on' : ''}" type="button" ${attr}>
  <span class="check">${CHECK}</span>${on ? yes : no}</button>`;

const DAY = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short' });
const WEEKDAY = new Intl.DateTimeFormat('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' });

const el = {
  root: document.getElementById('sheet'),
  body: document.getElementById('sheetBody'),
  back: document.getElementById('sheetBack'),
};

let hooks = null; // fonctions des réglages : favoris, ouverture d'un match…
let stack = []; // fiches ouvertes, pour « Retour » (équipe -> joueur)
let token = 0; // la fiche affichée ; une réponse d'une autre fiche est ignorée

/**
 * `h` : { prefs(), toggleTeam(leagueId, team), togglePlayer(p), isFavPlayer(p),
 * openMatch(leagueId, eventId), openLink(url), demo }.
 */
export function initSheet(h) {
  hooks = h;
  el.root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
  el.back.addEventListener('click', () => { stack.pop(); show(stack.at(-1), false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.root.hidden) closeSheet(); });
}

export function closeSheet() {
  el.root.hidden = true;
  stack = [];
  token += 1;
}

export const openTeamSheet = (leagueId, team) => show({ kind: 'team', leagueId, team }, true);
export const openPlayerSheet = (leagueId, player) => show({ kind: 'player', leagueId, player }, true);

function show(entry, push) {
  if (!entry) { closeSheet(); return; }
  if (push) stack.push(entry);
  el.back.hidden = stack.length < 2;
  el.root.hidden = false;
  el.body.scrollTop = 0;
  const t = ++token;
  if (entry.kind === 'team') loadTeam(entry, t);
  else loadPlayer(entry, t);
}

const fresh = (t) => t === token && !el.root.hidden;
const fr = (text) => (hooks.prefs().translate === false ? text : translated(text));
const section = (title, body) => (body ? `<section class="sh__sec"><h3>${title}</h3>${body}</section>` : '');
const loading = (what) => `<div class="sh__wait">Chargement ${what}…</div>`;

function paint(html) {
  el.body.innerHTML = html;
  bindCrests(el.body);
  bindFaces(el.body);
}

/* ---------- Équipe ---------- */

/** Rang et fiche tirés du classement : « 3e · Atlantique », « 12-5-3 · 27 pts ». */
function standingOf(leagueId, id, groups) {
  for (const g of groups ?? []) {
    const r = g.rows.find((x) => String(x.id) === String(id));
    if (!r) continue;
    const s = r.stats ?? {};
    const sport = sportOf(leagueId);
    const record = sport === 'hockey' ? [s.wins, s.losses, s.otLosses]
      : sport === 'soccer' ? [s.wins, s.ties, s.losses] : [s.wins, s.losses];
    const cols = STANDING_COLS[sport] ?? [];
    const pts = cols.some(([k]) => k === 'points') && s.points != null ? `${s.points} pts` : '';
    return {
      rank: g.preseason ? '' : `${r.rank}${Number(r.rank) === 1 ? 'er' : 'e'} · ${autoFr(g.name)}`,
      record: [record.every((x) => x != null && x !== '') ? record.join('-') : '', pts].filter(Boolean).join(' · '),
    };
  }
  return null;
}

function gameLine(leagueId, teamId, g) {
  const me = g.home.id === String(teamId) ? g.home : g.away;
  const opp = me === g.home ? g.away : g.home;
  const at = me === g.away ? '@' : 'vs';
  let right;
  if (g.state === 'post') {
    const res = me.winner ? 'V' : opp.winner ? 'D' : 'N';
    right = `<b class="sh__res sh__res--${res}">${res}</b> ${esc(me.score)}-${esc(opp.score)}`;
  } else if (g.state === 'in') {
    right = `<b class="sh__live">● ${esc(me.score)}-${esc(opp.score)}</b>`;
  } else {
    right = g.startsAt ? esc(TIME_FMT.format(g.startsAt)) : '';
  }
  const date = g.startsAt ? (g.state === 'pre' ? WEEKDAY : DAY).format(g.startsAt) : '';
  return `<li class="sh__game" data-event="${esc(g.id)}" title="Voir le match">
    <small>${esc(date)}</small><span class="sh__opp">${at} ${crestHtml(opp, 'crest-sm')}<b>${esc(opp.abbr)}</b></span><span>${right}</span></li>`;
}

async function loadTeam({ leagueId, team }, t) {
  const league = LEAGUES_BY_ID[leagueId];
  const head = (standing) => {
    const on = hooks.prefs().favorites.includes(`${leagueId}:${team.id}`);
    return `<div class="sh__head">
      ${crestHtml(team, 'crest-sm sh__crest')}
      <div class="sh__title"><b>${esc(team.name)}</b>
        <small>${esc([league?.label, standing?.rank].filter(Boolean).join(' · '))}</small>
        ${standing?.record ? `<small>${esc(standing.record)}</small>` : ''}</div>
      ${followBtn(on, 'data-fav-team', 'Suivie', 'Suivre')}
    </div>`;
  };
  const state = { standing: null, games: null, roster: null, news: null };
  const draw = () => {
    if (!fresh(t)) return;
    const games = state.games instanceof Error ? [] : state.games ?? [];
    const past = games.filter((g) => g.state !== 'pre').slice(-5).reverse();
    const next = games.filter((g) => g.state === 'pre').slice(0, 3);
    const list = (arr) => (arr.length ? `<ul class="sh__games">${arr.map((g) => gameLine(leagueId, team.id, g)).join('')}</ul>` : '');
    const roster = state.roster instanceof Error ? [] : state.roster ?? [];
    const news = state.news instanceof Error ? [] : (state.news ?? []).slice(0, 3);
    paint(head(state.standing)
      + (state.games === null ? loading('des matchs') : section('Derniers matchs', list(past)) + section('Prochains matchs', list(next)))
      + section('Nouvelles', news.length ? `<ul class="sh__news">${news.map((a) => `
          <li><button type="button" data-link="${esc(a.link)}"><b>${esc(fr(a.title))}</b>${a.date ? `<small>${esc(DAY.format(a.date))}</small>` : ''}</button></li>`).join('')}</ul>` : '')
      + (state.roster === null ? loading("de l'alignement") : section(`Alignement · ${roster.length}`, roster.length ? `<ul class="sh__roster">${roster.map((p) => `
          <li><button type="button" data-player="${esc(p.id)}">${faceHtml(p, 'face-sm')}<span><b>${esc(p.name)}</b><small>${esc([p.jersey ? `#${p.jersey}` : '', p.pos].filter(Boolean).join(' · '))}</small></span></button></li>`).join('')}</ul>` : '')));
    bindTeam(leagueId, team, roster);
  };
  draw();
  const demo = hooks.demo;
  const jobs = [
    [() => (demo ? demo.standings() : fetchStandingsTable(leagueId)), (v) => { state.standing = Array.isArray(v) ? standingOf(leagueId, team.id, v) : null; }],
    [() => (demo ? demo.games(team) : fetchTeamGames(leagueId, team.id, { back: 30, ahead: 30 })), (v) => { state.games = v; }],
    [() => (demo ? demo.roster(team.id) : fetchRoster(leagueId, team.id)), (v) => { state.roster = v; }],
    [() => (demo ? demo.news() : fetchTeamNews(leagueId, team.id)), (v) => { state.news = v; }],
  ];
  await Promise.all(jobs.map(async ([get, put]) => {
    try { put(await get()); } catch (err) { put(err instanceof Error ? err : new Error(errText(err))); }
    draw();
  }));
}

function bindTeam(leagueId, team, roster) {
  el.body.querySelector('[data-fav-team]')?.addEventListener('click', () => {
    hooks.toggleTeam(leagueId, team);
    show(stack.at(-1), false);
  });
  el.body.querySelectorAll('.sh__game[data-event]').forEach((li) => li.addEventListener('click', () => hooks.openMatch(leagueId, li.dataset.event)));
  el.body.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => hooks.openLink(b.dataset.link)));
  el.body.querySelectorAll('[data-player]').forEach((b) => b.addEventListener('click', () => {
    const p = roster.find((x) => x.id === b.dataset.player);
    if (p) openPlayerSheet(leagueId, { ...p, teamId: String(team.id), team });
  }));
}

/* ---------- Joueur ---------- */

async function loadPlayer({ leagueId, player }, t) {
  const state = { bio: null, overview: null };
  const draw = () => {
    if (!fresh(t)) return;
    const bio = state.bio instanceof Error ? null : state.bio;
    const p = { ...player, ...(bio ?? {}), photo: bio?.photo || player.photo };
    const team = bio?.team ?? player.team ?? null;
    const fav = hooks.isFavPlayer(p);
    const sub = [p.jersey ? `#${p.jersey}` : '', bio?.pos || p.pos, team?.abbr].filter(Boolean).join(' · ');
    const facts = bio ? [
      ['Âge', bio.age ? `${bio.age} ans` : ''], ['Naissance', [bio.born, bio.place].filter(Boolean).join(' · ')],
      ['Taille', bio.height], ['Poids', bio.weight],
      [sportOf(leagueId) === 'hockey' ? 'Tire' : 'Main', bio.hand],
      ['Repêchage', bio.draft], ['Expérience', bio.experience],
    ].filter(([, v]) => v) : [];
    const o = state.overview instanceof Error ? null : state.overview;
    const season = o?.season?.length
      ? `<div class="pcard__season">${o.season.map((x) => `<span><b>${esc(x.value)}</b><small>${esc(x.label)}</small></span>`).join('')}</div>` : '';
    const games = o?.games?.length ? `<table class="st__table pcard__games"><tbody>${o.games.map((gm) => `<tr>
        <td class="st__muted">${gm.date ? DAY.format(gm.date) : ''}</td><td>${esc(gm.opp)}</td>
        <td class="${/^V/.test(gm.result) ? 'win' : /^D/.test(gm.result) ? 'loss' : ''}">${esc(gm.result)}</td>
        <td class="pcard__line">${gm.stats.map((x) => `${esc(x.value)} ${esc(x.label)}`).join(' · ')}</td></tr>`).join('')}</tbody></table>` : '';
    const seasonName = o ? (/regular/i.test(o.seasonName) ? 'Saison régulière' : /post/i.test(o.seasonName) ? 'Séries' : autoFr(o.seasonName) || 'Saison') : 'Saison';
    paint(`<div class="sh__head">
        ${faceHtml(p, 'face sh__face')}
        <div class="sh__title"><b>${esc(p.name)}${bio?.injured ? ' <span title="Blessé">🩹</span>' : ''}</b>
          <small>${team ? `${crestHtml(team, 'crest-sm sh__mini')} ` : ''}${esc(sub)}</small></div>
        ${followBtn(fav, 'data-fav-player', 'Joueur favori', 'Joueur favori')}
      </div>`
      + (state.bio === null ? loading('de la fiche') : facts.length ? `<dl class="sh__facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '')
      + (state.overview === null ? loading('des stats')
        : section(seasonName, season) + section('Derniers matchs', games)
          + (!season && !games ? '<div class="sh__wait">Pas encore de stats cette saison.</div>' : '')));
    el.body.querySelector('[data-fav-player]')?.addEventListener('click', () => {
      hooks.togglePlayer({ id: p.id, name: p.name, photo: p.photo, teamId: team?.id ?? player.teamId ?? '', leagueId });
      draw();
    });
  };
  draw();
  const demo = hooks.demo;
  await Promise.all([
    (async () => { try { state.bio = demo ? demo.bio(player) : await fetchPlayerBio(leagueId, player.id); } catch (err) { state.bio = err; } draw(); })(),
    (async () => { try { state.overview = demo ? demo.overview() : await fetchPlayerOverview(leagueId, player.id); } catch (err) { state.overview = err; } draw(); })(),
  ]);
}

