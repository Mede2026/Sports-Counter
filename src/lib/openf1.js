// OpenF1 : base gratuite de données de F1, pour ce qu'ESPN ne donne pas —
// pneus, arrêts aux stands, direction de course, radio des équipes, météo,
// tours, télémétrie et position des voitures sur le circuit. Gratuit après
// chaque séance ; en direct, réservé à ses abonnés (les données arrivent
// alors seulement si OpenF1 les sert).

const OPENF1 = 'https://api.openf1.org/v1';
const MEMO_MS = 60 * 1000;
const memo = new Map(); // requête -> { at, promise }

const inTauri = () => !!globalThis.window?.__TAURI__;
const squash = (text) => String(text ?? '').normalize('NFD').replace(/[^a-z0-9]/gi, '').toLowerCase();

async function viaPage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Une requête à OpenF1, gardée 60 s ; par le relais Rust si la page est refusée. */
function get(query) {
  const hit = memo.get(query);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.promise;
  const promise = (async () => {
    try {
      return await viaPage(`${OPENF1}/${query}`);
    } catch (err) {
      if (!inTauri()) throw err;
      return JSON.parse(await window.__TAURI__.core.invoke('espn_get', { path: `openf1/${query}` }));
    }
  })();
  memo.set(query, { at: Date.now(), promise });
  promise.catch(() => memo.delete(query));
  return promise;
}

const list = (x) => (Array.isArray(x) ? x : []);

const SESSION_NAMES = {
  'Practice 1': 'Essais 1', 'Practice 2': 'Essais 2', 'Practice 3': 'Essais 3',
  Qualifying: 'Qualifications', 'Sprint Qualifying': 'Qualifs sprint', 'Sprint Shootout': 'Qualifs sprint',
  Sprint: 'Sprint', Race: 'Course',
};

/** La séance d'OpenF1 qui correspond à une séance d'ESPN ({ label, startsAt }), ou null. */
async function sessionOf(session) {
  if (!session?.label) return null;
  const start = new Date(session.startsAt).getTime();
  const all = list(await get('sessions?meeting_key=latest'));
  return all.find((x) => SESSION_NAMES[x?.session_name] === session.label
    && (!Number.isFinite(start) || Math.abs(new Date(x.date_start).getTime() - start) < 6 * 3600e3)) ?? null;
}

/** Pilotes de la séance : numéro -> { number, name, last, acronym, team, color }. */
async function driversOf(key) {
  const out = new Map();
  for (const d of list(await get(`drivers?session_key=${key}`))) {
    out.set(d.driver_number, {
      number: d.driver_number,
      name: d.full_name ? d.full_name.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase()) : d.broadcast_name ?? '',
      last: squash(d.last_name ?? String(d.full_name ?? '').split(' ').pop()),
      acronym: d.name_acronym ?? '',
      team: d.team_name ?? '',
      color: d.team_colour ? `#${d.team_colour}` : '#888',
    });
  }
  return out;
}

/* ---------- Pneus ---------- */

export const TYRES = { SOFT: 'T', MEDIUM: 'M', HARD: 'D', INTERMEDIATE: 'I', WET: 'P' };
export const TYRE_NAMES = { SOFT: 'Tendres', MEDIUM: 'Médiums', HARD: 'Durs', INTERMEDIATE: 'Intermédiaires', WET: 'Pluie' };

/** Relais de pneus de chaque pilote : { nomTassé: [{ compound, from, to }] }, ou null. */
export async function fetchTyres(session) {
  try {
    const info = await sessionOf(session);
    if (!info) return null;
    const [stints, drivers] = await Promise.all([get(`stints?session_key=${info.session_key}`), driversOf(info.session_key)]);
    const out = {};
    for (const st of [...list(stints)].sort((a, b) => (a.stint_number ?? 0) - (b.stint_number ?? 0))) {
      const d = drivers.get(st.driver_number);
      if (!d?.last || !TYRES[st.compound]) continue;
      (out[d.last] ??= []).push({ compound: st.compound, from: st.lap_start ?? null, to: st.lap_end ?? null });
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Relais de pneus d'un pilote d'ESPN (par son nom de famille), ou []. */
export const tyresOf = (tyres, driver) => tyres?.[squash(String(driver?.name ?? '').trim().split(/\s+/).pop())] ?? [];

/* ---------- Direction de course ---------- */

// Messages de la direction de course -> français (le reste passe par la traduction).
const RC_FR = [
  [/^GREEN LIGHT - PIT EXIT OPEN$/i, 'Feu vert : sortie des stands ouverte'],
  [/^PIT EXIT CLOSED$/i, 'Sortie des stands fermée'],
  [/^DRS ENABLED$/i, 'DRS autorisé'], [/^DRS DISABLED$/i, 'DRS interdit'],
  [/^SAFETY CAR DEPLOYED$/i, 'Voiture de sécurité en piste'], [/^SAFETY CAR IN THIS LAP$/i, 'La voiture de sécurité rentre à la fin du tour'],
  [/^VIRTUAL SAFETY CAR DEPLOYED$/i, 'Voiture de sécurité virtuelle'], [/^VIRTUAL SAFETY CAR ENDING$/i, 'Fin de la voiture de sécurité virtuelle'],
  [/^RED FLAG$/i, 'Drapeau rouge'], [/^CHEQUERED FLAG$/i, 'Drapeau à damier'], [/^TRACK CLEAR$/i, 'Piste dégagée'],
];

/** Traduit un message de la direction de course (les noms et numéros restent). */
function rcFr(message) {
  const m = String(message ?? '').trim();
  const known = RC_FR.find(([re]) => re.test(m));
  if (known) return known[1];
  return m
    .replace(/\bCAR (\d+) \(([A-Z]{3})\)/g, 'Voiture $1 ($2)')
    .replace(/\bTIME PENALTY\b/gi, 'pénalité de temps')
    .replace(/\bUNDER INVESTIGATION\b/gi, 'sous enquête')
    .replace(/\bNO FURTHER (ACTION|INVESTIGATION)\b/gi, 'aucune autre mesure')
    .replace(/\bTRACK LIMITS\b/gi, 'limites de la piste')
    .replace(/\bLAP TIME (\S+) DELETED\b/gi, 'temps au tour $1 supprimé')
    .replace(/\bBLACK AND WHITE FLAG\b/gi, 'drapeau noir et blanc')
    .replace(/\bYELLOW\b/g, 'JAUNE').replace(/\bDOUBLE YELLOW\b/g, 'DOUBLE JAUNE')
    .replace(/\bCLEAR\b/g, 'DÉGAGÉ').replace(/\bIN TRACK SECTOR\b/gi, 'dans le secteur')
    .replace(/\bCAUSING A COLLISION\b/gi, 'pour avoir causé une collision')
    .replace(/\bUNSAFE RELEASE\b/gi, 'sortie des stands dangereuse')
    .replace(/\bSECONDS?\b/gi, 's');
}

/** Pénalité ou enquête ? (pour les notifications de tes pilotes). */
export const isSanction = (m) => /penalt|investigation|black and white|deleted|reprimand|disqualif/i.test(m ?? '');

/**
 * Messages de la direction de course, du plus récent au plus ancien :
 * [{ date, lap, text, raw, flag, number }].
 */
export async function fetchRaceControl(session) {
  const info = await sessionOf(session);
  if (!info) return [];
  return list(await get(`race_control?session_key=${info.session_key}`))
    .map((x) => ({ date: x.date ? new Date(x.date) : null, lap: x.lap_number ?? null, text: rcFr(x.message), raw: x.message ?? '', flag: x.flag ?? '', number: x.driver_number ?? null }))
    .filter((x) => x.text)
    .reverse();
}

/** Numéros des pilotes de la séance, par nom tassé (pour relier OpenF1 et ESPN). */
export async function driverNumbers(session) {
  const info = await sessionOf(session);
  if (!info) return new Map();
  const drivers = await driversOf(info.session_key);
  return new Map([...drivers.values()].map((d) => [d.last, d.number]));
}

/* ---------- Tout le reste d'une séance ---------- */

const lapText = (s) => {
  if (!Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(3).padStart(6, '0');
  return m ? `${m}:${rest}` : rest;
};

/**
 * Le reste d'une séance, d'après OpenF1 : { weather, pits, control, radio,
 * best, track, telemetry }. Chaque partie vaut null si OpenF1 ne l'a pas.
 * `favs` : noms tassés de tes pilotes (télémétrie et radio d'abord).
 */
export async function fetchF1Extras(session, favs = []) {
  const info = await sessionOf(session).catch(() => null);
  if (!info) return null;
  const key = info.session_key;
  const live = session.state === 'in';
  const [drivers, weather, pits, control, radio, laps] = await Promise.all([
    driversOf(key).catch(() => new Map()),
    get(`weather?session_key=${key}`).catch(() => []),
    get(`pit?session_key=${key}`).catch(() => []),
    fetchRaceControl(session).catch(() => []),
    get(`team_radio?session_key=${key}`).catch(() => []),
    get(`laps?session_key=${key}`).catch(() => []),
  ]);
  const who = (n) => drivers.get(n) ?? { number: n, name: `Voiture ${n}`, acronym: String(n), color: '#888', last: '' };
  const favNumbers = [...drivers.values()].filter((d) => favs.includes(d.last)).map((d) => d.number);

  // Météo : la dernière mesure.
  const w = list(weather).at(-1);
  const meteo = w ? {
    air: w.air_temperature, track: w.track_temperature, humidity: w.humidity,
    rain: Number(w.rainfall) > 0, wind: w.wind_speed,
  } : null;

  // Arrêts aux stands : durée à l'arrêt (stop_duration) si connue, sinon dans la voie des stands.
  const stops = list(pits).map((p) => ({ ...who(p.driver_number), lap: p.lap_number, stop: p.stop_duration ?? null, lane: p.pit_duration ?? null }))
    .sort((a, b) => (a.lap ?? 0) - (b.lap ?? 0));

  // Tours : le meilleur tour de la séance, et le meilleur de chaque pilote.
  const valid = list(laps).filter((l) => Number(l.lap_duration) > 0);
  const bestOf = new Map();
  for (const l of valid) {
    const b = bestOf.get(l.driver_number);
    if (!b || l.lap_duration < b.lap_duration) bestOf.set(l.driver_number, l);
  }
  const ranking = [...bestOf.values()].sort((a, b) => a.lap_duration - b.lap_duration)
    .map((l) => ({ ...who(l.driver_number), time: lapText(l.lap_duration), seconds: l.lap_duration, lap: l.lap_number, speed: l.st_speed ?? null }));
  const lapCount = valid.reduce((n, l) => Math.max(n, l.lap_number ?? 0), 0);

  // Radio : les 12 derniers messages, ceux de tes pilotes d'abord.
  const clips = list(radio).filter((r) => /^https:\/\//.test(r.recording_url ?? ''))
    .map((r) => ({ ...who(r.driver_number), date: r.date ? new Date(r.date) : null, url: r.recording_url }))
    .sort((a, b) => (favNumbers.includes(b.number) - favNumbers.includes(a.number)) || ((b.date ?? 0) - (a.date ?? 0)))
    .slice(0, 12);

  // Carte du circuit : le tracé du meilleur tour, et la dernière position de chaque voiture.
  let track = null;
  const top = ranking[0] ? valid.find((l) => l.driver_number === ranking[0].number && l.lap_number === ranking[0].lap) : null;
  if (top?.date_start) {
    const from = new Date(top.date_start);
    const to = new Date(from.getTime() + top.lap_duration * 1000);
    const pts = list(await get(`location?session_key=${key}&driver_number=${top.driver_number}&date>${from.toISOString()}&date<${to.toISOString()}`).catch(() => []))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (p.x || p.y));
    if (pts.length > 20) {
      track = { outline: pts.filter((_, i) => i % 2 === 0).map((p) => [p.x, p.y]), cars: [] };
      if (live) {
        const since = new Date(Date.now() - 8000).toISOString();
        const now = list(await get(`location?session_key=${key}&date>${since}`).catch(() => []));
        const last = new Map();
        for (const p of now) last.set(p.driver_number, p);
        track.cars = [...last.values()].filter((p) => p.x || p.y).map((p) => ({ ...who(p.driver_number), x: p.x, y: p.y, fav: favNumbers.includes(p.driver_number) }));
      }
    }
  }

  // Télémétrie de tes pilotes : en direct, la dernière mesure ; sinon la vitesse de pointe.
  const telemetry = [];
  for (const n of favNumbers.slice(0, 2)) {
    const d = who(n);
    if (live) {
      const since = new Date(Date.now() - 8000).toISOString();
      const s = list(await get(`car_data?session_key=${key}&driver_number=${n}&date>${since}`).catch(() => [])).at(-1);
      if (s) telemetry.push({ ...d, live: true, speed: s.speed, gear: s.n_gear, throttle: s.throttle, brake: s.brake, drs: Number(s.drs) >= 10, rpm: s.rpm });
    } else {
      const fast = list(await get(`car_data?session_key=${key}&driver_number=${n}&speed>=300`).catch(() => []));
      const topSpeed = fast.reduce((m, s) => Math.max(m, s.speed ?? 0), 0);
      if (topSpeed) telemetry.push({ ...d, live: false, top: topSpeed });
    }
  }

  return {
    weather: meteo,
    pits: stops.length ? stops : null,
    control: control.length ? control.slice(0, 20) : null,
    radio: clips.length ? clips : null,
    best: ranking.length ? { ranking: ranking.slice(0, 10), laps: lapCount } : null,
    track,
    telemetry: telemetry.length ? telemetry : null,
  };
}
