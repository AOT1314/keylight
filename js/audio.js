/* A small, warm piano synthesizer built on the Web Audio API.
   Samples are generated locally from additive partials so the app has
   no external assets and works fully offline. */

import { clamp, midiToFreq } from "./util.js";

const SAMPLE_RATE = 32000;
const MAX_CACHE = 56;

let sharedNoiseSeed = 0x2f6e2b1;

function rand() {
  // Deterministic-ish noise, cheap xorshift.
  let x = sharedNoiseSeed;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  sharedNoiseSeed = x >>> 0;
  return (sharedNoiseSeed / 4294967296) * 2 - 1;
}

function renderPianoSample(midi, velocity = 0.75, sampleRate = SAMPLE_RATE) {
  const f0 = midiToFreq(midi);
  const lengthSec = clamp(6.4 - (midi - 21) * 0.031, 2.2, 6.2);
  const n = Math.max(1, Math.ceil(lengthSec * sampleRate));
  const out = new Float32Array(n);
  const nyquist = sampleRate * 0.46;
  const inharmonicity = 0.00022 * Math.pow(2, (midi - 60) / 26);
  const brightness = 0.42 + velocity * 0.68;
  const partialCount = clamp(Math.round(17 - (midi - 21) * 0.13), 5, 17);
  const pianoDecay = 0.56 + Math.pow(Math.max(0, 60 - midi), 1.2) * 0.0018;

  for (let k = 1; k <= partialCount; k++) {
    const freq = f0 * k * Math.sqrt(1 + inharmonicity * k * k);
    if (freq >= nyquist) break;
    const amp = Math.pow(k, -1.32)
      * (k <= 2 ? 1 : brightness)
      * (k > 8 ? 0.72 : 1)
      * (0.9 + 0.1 * Math.sin(k * 1.7));
    const decay = pianoDecay + k * 0.23 + f0 * 0.00022;
    const attack = 0.0015 + 0.0024 / Math.sqrt(k);
    const phase0 = (k * 2.399 + midi * 0.71) % (Math.PI * 2);
    const omega = 2 * Math.PI * freq / sampleRate;
    const cosw = Math.cos(omega);
    let sPrev = Math.sin(phase0 - omega);
    let s = Math.sin(phase0);
    let env = amp;
    const envStep = Math.exp(-decay / sampleRate);
    const attackStep = Math.exp(-1 / (attack * sampleRate));
    let attackEnv = 0;
    for (let i = 0; i < n; i++) {
      env *= envStep;
      attackEnv = 1 - (1 - attackEnv) * attackStep;
      const sNext = 2 * cosw * s - sPrev;
      sPrev = s;
      s = sNext;
      out[i] += s * env * attackEnv;
    }
  }

  // Hammer / felt noise. A soft burst at the very start.
  let lp = 0;
  const noiseLength = Math.min(n, Math.floor(0.042 * sampleRate));
  for (let i = 0; i < noiseLength; i++) {
    const t = i / sampleRate;
    lp += (rand() - lp) * 0.42;
    out[i] += lp * Math.exp(-t / 0.009) * (0.035 + velocity * 0.045);
  }

  // A little body resonance around 180Hz, only for the lower half.
  if (midi < 64) {
    const bodyFreq = 155 + (midi - 36) * 0.9;
    const om = 2 * Math.PI * bodyFreq / sampleRate;
    const cw = Math.cos(om);
    let bPrev = Math.sin(-om);
    let b = 0;
    const amount = 0.018 * (1 - clamp((midi - 36) / 32, 0, 1));
    for (let i = 0; i < n; i++) {
      const next = 2 * cw * b - bPrev;
      bPrev = b;
      b = next;
      out[i] += b * Math.exp(-i / sampleRate / 1.7) * amount;
    }
  }

  // Normalize and fade the very end to avoid clicks.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const gain = peak > 0 ? (0.78 + velocity * 0.16) / peak : 1;
  const fade = Math.min(n, Math.floor(0.09 * sampleRate));
  for (let i = 0; i < n; i++) {
    let g = gain;
    if (i > n - fade) g *= (n - i) / fade;
    out[i] *= g;
  }
  return out;
}

function makeImpulse(ctx, seconds = 2.1, decay = 2.8) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, decay) * Math.exp(-t * 2.2);
      lp += (rand() - lp) * 0.34;
      data[i] = lp * env * (ch ? 0.82 : 1);
    }
    // A few early reflections make the space feel more like a room.
    for (const [ms, amt] of [[17, .32], [31, .23], [53, .16], [79, .11]]) {
      const idx = Math.floor((rate * ms) / 1000) + ch * 7;
      if (idx < length) data[idx] += amt;
    }
  }
  return impulse;
}

export class PianoEngine {
  constructor() {
    this.ctx = null;
    this.cache = new Map();
    this.voices = new Set();
    this.ready = false;
    this.volume = 0.86;
    this.prefetching = false;
    this._prefetchQueue = [];
    this._prefetchTimer = 0;
    this.onError = null;
  }

  init() {
    if (this.ready) return true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("当前浏览器不支持 Web Audio");
      this.ctx = new Ctx({ latencyHint: "interactive" });
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -17;
      this.compressor.knee.value = 22;
      this.compressor.ratio.value = 2.6;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.34;
      this.master.connect(this.compressor);
      this.compressor.connect(ctx.destination);

      this.dry = ctx.createGain();
      this.dry.gain.value = 0.92;
      this.dry.connect(this.master);

      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeImpulse(ctx);
      this.wet = ctx.createGain();
      this.wet.gain.value = 0.2;
      this.reverb.connect(this.wet);
      this.wet.connect(this.master);
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.46;
      this.reverbSend.connect(this.reverb);

      this.ready = true;
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  async resume() {
    if (!this.init()) return false;
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch { return false; }
    }
    return this.ctx.state === "running";
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  _cacheKey(midi, velocity) {
    return `${midi}:${velocity < 0.62 ? "s" : velocity < 0.83 ? "m" : "h"}`;
  }

  ensureSample(midi, velocity = 0.75) {
    if (!this.init()) return null;
    const key = this._cacheKey(midi, velocity);
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh LRU order.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const data = renderPianoSample(midi, velocity, SAMPLE_RATE);
    const buffer = this.ctx.createBuffer(1, data.length, SAMPLE_RATE);
    buffer.copyToChannel(data, 0);
    this.cache.set(key, buffer);
    if (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    return buffer;
  }

  playNote(midi, velocity = 0.76, when = null, durationSec = 1.4) {
    if (!this.ready) this.init();
    if (!this.ready) return null;
    const ctx = this.ctx;
    const at = Math.max(ctx.currentTime + 0.001, when == null ? ctx.currentTime + 0.003 : when);
    const buffer = this.ensureSample(midi, velocity);
    if (!buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = clamp((midi - 60) / 54, -0.34, 0.34);
    const audible = clamp(0.24 + velocity * 0.72, 0.2, 0.95);
    gain.gain.setValueAtTime(audible, at);
    const releaseAt = at + Math.max(0.25, durationSec);
    gain.gain.setValueAtTime(audible, releaseAt);
    gain.gain.linearRampToValueAtTime(0.0001, releaseAt + 0.13);
    src.connect(gain);
    if (pan) {
      gain.connect(pan);
      pan.connect(this.dry);
      pan.connect(this.reverbSend);
    } else {
      gain.connect(this.dry);
      gain.connect(this.reverbSend);
    }
    const stopAt = Math.min(at + buffer.duration, releaseAt + 0.18);
    try {
      src.start(at);
      src.stop(stopAt);
    } catch { return null; }
    const voice = { src, gain, pan };
    this.voices.add(voice);
    src.onended = () => {
      this.voices.delete(voice);
      try { gain.disconnect(); pan?.disconnect(); } catch { /* noop */ }
    };
    return voice;
  }

  preview(midi, durationSec = 0.8, velocity = 0.72) {
    return this.playNote(midi, velocity, null, durationSec);
  }

  click(accent = false, when = null) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const at = when == null ? ctx.currentTime + 0.004 : when;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(accent ? 1860 : 1380, at);
    osc.frequency.exponentialRampToValueAtTime(accent ? 1080 : 900, at + 0.035);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.12 : 0.055, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.055);
    osc.connect(gain).connect(this.dry);
    osc.start(at);
    osc.stop(at + 0.07);
  }

  stopAll() {
    for (const voice of this.voices) {
      try {
        voice.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        voice.gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.012);
        voice.src.stop(this.ctx.currentTime + 0.03);
      } catch { /* already stopped */ }
    }
    this.voices.clear();
  }

  /** Warm the sample cache in the background without blocking the UI. */
  prepare(notes = []) {
    const keys = new Set();
    for (const n of notes) {
      if (!n || n.midi == null) continue;
      const midi = Math.round(n.midi);
      const vel = n.velocity == null ? 0.76 : n.velocity;
      keys.add(this._cacheKey(midi, vel));
      if (keys.size >= 48) break;
    }
    this._prefetchQueue = [...keys].filter((k) => !this.cache.has(k));
    if (this.prefetching || !this._prefetchQueue.length) return;
    this.prefetching = true;
    const tick = () => {
      if (!this._prefetchQueue.length) {
        this.prefetching = false;
        return;
      }
      const key = this._prefetchQueue.shift();
      const [midi, layer] = key.split(":");
      const vel = layer === "s" ? 0.5 : layer === "h" ? 0.9 : 0.74;
      try { this.ensureSample(Number(midi), vel); } catch { /* noop */ }
      this._prefetchTimer = setTimeout(tick, 8);
    };
    this._prefetchTimer = setTimeout(tick, 40);
  }

  destroy() {
    clearTimeout(this._prefetchTimer);
    this.stopAll();
    try { this.ctx?.close(); } catch { /* noop */ }
    this.ready = false;
  }
}
