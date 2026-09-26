// Klaxon de but, sifflet, sirène… fabriqués avec Web Audio : aucun fichier
// son à livrer, et le volume se règle dans les réglages.
import { sportOf } from './leagues.js';

export const SOUNDS = {
  horn: 'Klaxon de but',
  whistle: 'Sifflet',
  buzzer: 'Sirène de fin',
  organ: "Orgue d'aréna",
  chime: 'Carillon',
};

/** Le son qui va avec le sport : klaxon au hockey, sifflet au soccer… */
export function soundFor(leagueId, kind = 'auto') {
  if (kind && kind !== 'auto' && SOUNDS[kind]) return kind;
  const sport = sportOf(leagueId);
  if (sport === 'hockey' || sport === 'football') return 'horn';
  if (sport === 'soccer') return 'whistle';
  if (sport === 'basketball') return 'buzzer';
  if (sport === 'baseball') return 'organ';
  return 'chime';
}

let ctx = null;

function audio() {
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Une note : oscillateur -> enveloppe -> sortie. */
function tone(a, out, { type = 'sine', freq, start, dur, attack = 0.02, release = 0.15, gain = 1, vibrato = 0 }) {
  const osc = a.createOscillator();
  const env = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (vibrato) {
    const lfo = a.createOscillator();
    const depth = a.createGain();
    lfo.frequency.value = vibrato.rate;
    depth.gain.value = vibrato.depth;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(start);
    lfo.stop(start + dur + release);
  }
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(gain, start + attack);
  env.gain.setValueAtTime(gain, start + dur);
  env.gain.linearRampToValueAtTime(0, start + dur + release);
  osc.connect(env).connect(out);
  osc.start(start);
  osc.stop(start + dur + release + 0.05);
}

const RECIPES = {
  // Klaxon d'aréna : accord grave et rugueux, filtré, environ 2 s.
  horn(a, out, t) {
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.connect(out);
    for (const [freq, gain] of [[110, 0.5], [138.6, 0.35], [165, 0.35], [220, 0.2]]) {
      tone(a, lp, { type: 'sawtooth', freq, start: t, dur: 1.9, attack: 0.06, release: 0.45, gain, vibrato: { rate: 5, depth: 1.2 } });
    }
  },
  // Sifflet d'arbitre : note aiguë qui roule (la bille du sifflet).
  whistle(a, out, t) {
    for (const [s, d] of [[0, 0.18], [0.28, 0.9]]) {
      tone(a, out, { freq: 2900, start: t + s, dur: d, attack: 0.01, release: 0.06, gain: 0.45, vibrato: { rate: 38, depth: 180 } });
    }
  },
  // Sirène de fin de quart, au basket.
  buzzer(a, out, t) {
    tone(a, out, { type: 'square', freq: 196, start: t, dur: 1.1, attack: 0.01, release: 0.08, gain: 0.3 });
    tone(a, out, { type: 'square', freq: 294, start: t, dur: 1.1, attack: 0.01, release: 0.08, gain: 0.18 });
  },
  // « Charge ! » à l'orgue du stade.
  organ(a, out, t) {
    const notes = [[392, 0, 0.14], [523, 0.16, 0.14], [659, 0.32, 0.14], [784, 0.48, 0.3], [659, 0.86, 0.14], [784, 1.02, 0.6]];
    for (const [freq, s, d] of notes) {
      for (const [mult, gain] of [[1, 0.35], [2, 0.15], [3, 0.08]]) {
        tone(a, out, { freq: freq * mult, start: t + s, dur: d, attack: 0.01, release: 0.08, gain });
      }
    }
  },
  // Trois notes douces, pour les autres sports.
  chime(a, out, t) {
    [[784, 0], [988, 0.15], [1319, 0.3]].forEach(([freq, s]) => {
      tone(a, out, { type: 'triangle', freq, start: t + s, dur: 0.12, attack: 0.005, release: 0.7, gain: 0.45 });
    });
  },
};

/** Joue un son ; volume de 0 à 100. Sans Web Audio, ne fait rien. */
export function playSound(kind, volume = 60) {
  const a = audio();
  const recipe = RECIPES[kind];
  if (!a || !recipe) return false;
  const master = a.createGain();
  // Volume illisible (réglage abîmé) : 60 %, plutôt qu'une erreur de Web Audio.
  const v = Number(volume);
  master.gain.value = Math.max(0, Math.min(1, (Number.isFinite(v) ? v : 60) / 100)) * 0.8;
  master.connect(a.destination);
  recipe(a, master, a.currentTime + 0.03);
  return true;
}
