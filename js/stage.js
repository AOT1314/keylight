/* The follow-along stage: a focused piano window with falling notes that
   land exactly on the key to press. Everything is drawn locally on canvas. */

import {
  clamp, isBlackKey, noteName, measureBeats, roundRect, canvasSize,
} from "./util.js";

const LEAD_SECONDS = 3.15;
const RH = "231, 172, 91";
const LH = "103, 196, 181";

function rgb(hand, a = 1) {
  return `rgba(${hand === "L" ? LH : RH}, ${a})`;
}

function keyLabel(midi) {
  return noteName(midi);
}

function buildRange(notes) {
  if (!notes.length) return { low: 21, high: 108 };
  let lo = Math.min(...notes.map((n) => n.midi));
  let hi = Math.max(...notes.map((n) => n.midi));
  lo = Math.max(21, lo - 3);
  hi = Math.min(108, hi + 3);
  if (hi - lo < 30) {
    const extra = Math.ceil((30 - (hi - lo)) / 2);
    lo = Math.max(21, lo - extra);
    hi = Math.min(108, hi + extra);
  }
  while (isBlackKey(lo) && lo > 21) lo--;
  while (isBlackKey(hi) && hi < 108) hi++;
  return { low: lo, high: hi };
}

export class StageView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.bg = document.createElement("canvas");
    this.bgCtx = this.bg.getContext("2d");
    this.score = null;
    this.notes = [];
    this.hands = "both";
    this.labels = true;
    this.beatSec = 60 / 84;
    this.getBeat = opts.getBeat || (() => 0);
    this.isCountingIn = opts.isCountingIn || null;
    this.onFrame = opts.onFrame || null;
    this.onKeyDown = opts.onKeyDown || null;
    this.range = { low: 21, high: 108 };
    this.keys = new Map();
    this.flashes = [];
    this._raf = 0;
    this._lastTime = 0;
    this._frameGap = window.innerWidth < 700 ? 1000 / 30 : 0;
    this._lastBeat = 0;
    this._lastOnsets = new Set();
    this._activeNotes = [];
    this._visible = true;
    this._dirty = true;
    this.onFrameTick = this._tick.bind(this);
    this._resizeObserver = new ResizeObserver(() => {
      this._dirty = true;
      this._build();
    });
    this._resizeObserver.observe(canvas.parentElement || canvas);
    canvas.addEventListener("pointerdown", (ev) => this._handlePointer(ev));
    this._build();
  }

  setScore(score) {
    this.score = score;
    this.notes = score ? [...score.notes] : [];
    this.range = buildRange(this.notes);
    this._dirty = true;
    this._lastOnsets.clear();
    this._build();
  }

  setHands(hands) {
    this.hands = hands;
    this._lastOnsets.clear();
  }

  setLabels(on) {
    this.labels = on;
    this._dirty = true;
    this._build();
  }

  setBeatSec(sec) {
    this.beatSec = Math.max(0.15, sec || 0.7);
  }

  start() {
    if (this._raf) return;
    this._lastTime = performance.now();
    this._raf = requestAnimationFrame(this.onFrameTick);
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  draw() {
    this._build();
    this._render();
  }

  flash(midi, hand = "R") {
    this.flashes.push({ midi, hand, at: performance.now() });
    if (this.flashes.length > 30) this.flashes.shift();
  }

  pickKey(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (y < this.geom.keyTop || y > this.geom.keyTop + this.geom.kbH) return null;
    // Black keys sit on top of white keys.
    for (const [midi, key] of this.keys) {
      if (key.black && x >= key.x && x <= key.x + key.w && y <= this.geom.keyTop + this.geom.kbH * 0.62) return midi;
    }
    for (const [midi, key] of this.keys) {
      if (!key.black && x >= key.x && x <= key.x + key.w && y >= this.geom.keyTop) return midi;
    }
    return null;
  }

  _handlePointer(ev) {
    const midi = this.pickKey(ev.clientX, ev.clientY);
    if (midi == null) return;
    const key = this.keys.get(midi);
    this.flash(midi, key?.hand || "R");
    this.onKeyDown?.(midi);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    // Phones have 3x screens; 2x already looks sharp, 1.5x keeps the large
    // canvas and its gradients fluid on older iPhones and iPads.
    const dprCap = window.innerWidth < 700 ? 1.5 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.bg.width = Math.round(w * dpr);
      this.bg.height = Math.round(h * dpr);
      this._dirty = true;
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, dpr };
  }

  _computeGeometry() {
    const w = this.w, h = this.h;
    const kbH = clamp(h * 0.285, 126, 226);
    const bottom = h - 14;
    const keyTop = bottom - kbH;
    const x0 = Math.max(12, Math.min(26, w * 0.017));
    const x1 = w - x0;
    const { low, high } = this.range;
    const whiteList = [];
    for (let m = low; m <= high; m++) if (!isBlackKey(m)) whiteList.push(m);
    const whiteW = (x1 - x0) / Math.max(1, whiteList.length);
    const blackW = clamp(whiteW * 0.62, 5, 20);
    const keys = new Map();
    const whiteIndex = new Map();
    whiteList.forEach((midi, i) => {
      keys.set(midi, { x: x0 + i * whiteW, w: whiteW, black: false, index: i });
      whiteIndex.set(midi, i);
    });
    for (let m = low; m <= high; m++) {
      if (!isBlackKey(m)) continue;
      // Find the white key immediately below this black key.
      let prev = m - 1;
      while (prev >= low && isBlackKey(prev)) prev--;
      const idx = whiteIndex.get(prev);
      if (idx == null) continue;
      keys.set(m, { x: x0 + (idx + 1) * whiteW - blackW / 2, w: blackW, black: true, index: idx });
    }
    return { w, h, x0, x1, keyTop, kbH, bottom, whiteW, blackW, keys, low, high, whiteList };
  }

  _build() {
    if (!this._resize()) return;
    if (!this._dirty && this.geom) return;
    const geom = this._computeGeometry();
    this.geom = geom;
    this.keys = geom.keys;
    const ctx = this.bgCtx;
    const { w, h, keyTop, kbH, x0, x1, whiteW, blackW, keys } = geom;
    ctx.clearRect(0, 0, w, h);

    // Deep stage background.
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0a0908");
    bg.addColorStop(0.55, "#100d0b");
    bg.addColorStop(1, "#17120e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Center spotlight.
    const spot = ctx.createRadialGradient(w * 0.52, keyTop * 0.2, 10, w * 0.52, keyTop * 0.45, Math.max(w * 0.5, h * 0.55));
    spot.addColorStop(0, "rgba(231, 172, 91, .075)");
    spot.addColorStop(0.5, "rgba(140, 100, 55, .025)");
    spot.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, w, h);

    // Quiet staff-line texture in the upper air.
    const staffAlpha = 0.035;
    ctx.strokeStyle = `rgba(244, 236, 223, ${staffAlpha})`;
    ctx.lineWidth = 1;
    const staffGap = clamp(h * 0.018, 8, 15);
    const groups = 4;
    const groupGap = staffGap * 9;
    const top = h * 0.1;
    for (let g = 0; g < groups; g++) {
      const base = top + g * groupGap;
      if (base > keyTop * 0.68) break;
      for (let line = 0; line < 5; line++) {
        const y = base + line * staffGap;
        ctx.beginPath();
        ctx.moveTo(x0 - 4, y);
        ctx.lineTo(x1 + 4, y);
        ctx.stroke();
      }
    }
    // Oversized watermark clef.
    ctx.save();
    ctx.globalAlpha = 0.028;
    ctx.fillStyle = "#f4ecdf";
    ctx.font = `600 ${Math.min(330, h * 0.6)}px "Iowan Old Style","Palatino Linotype","Songti SC",serif`;
    ctx.textAlign = "left";
    ctx.fillText("𝄞", x0 + w * 0.015, keyTop * 0.92);
    ctx.restore();

    // Soft vertical guide lines every two octaves.
    ctx.strokeStyle = "rgba(244, 236, 223, .028)";
    for (let oct = 0; oct < 8; oct++) {
      const x = x0 + (w - 2 * x0) * (oct / 8);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, keyTop);
      ctx.stroke();
    }

    // Vignette.
    const vg = ctx.createRadialGradient(w / 2, h * 0.45, Math.min(w, h) * 0.25, w / 2, h * 0.55, Math.max(w, h) * 0.7);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.42)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    // Keyboard shadow / landing zone.
    const shadow = ctx.createLinearGradient(0, keyTop - 42, 0, keyTop + 6);
    shadow.addColorStop(0, "rgba(0,0,0,0)");
    shadow.addColorStop(1, "rgba(0,0,0,.55)");
    ctx.fillStyle = shadow;
    ctx.fillRect(x0 - 10, keyTop - 42, x1 - x0 + 20, 48);

    // Glow strip right above keys.
    const strip = ctx.createLinearGradient(0, keyTop - 18, 0, keyTop);
    strip.addColorStop(0, "rgba(231,172,91,0)");
    strip.addColorStop(1, "rgba(231,172,91,.1)");
    ctx.fillStyle = strip;
    ctx.fillRect(x0, keyTop - 18, x1 - x0, 18);

    // Felt.
    ctx.fillStyle = "#2a1310";
    roundRect(ctx, x0 - 3, keyTop - 5, x1 - x0 + 6, 7, 2);
    ctx.fill();
    ctx.fillStyle = "rgba(179, 82, 55, .48)";
    ctx.fillRect(x0 - 2, keyTop - 4, x1 - x0 + 4, 2.2);
    ctx.fillStyle = "rgba(255,255,255,.06)";
    ctx.fillRect(x0 - 2, keyTop - 4, x1 - x0 + 4, 0.7);

    // White keys.
    for (const [midi, key] of keys) {
      if (key.black) continue;
      const g = ctx.createLinearGradient(0, keyTop, 0, keyTop + kbH);
      g.addColorStop(0, "#f7f0e4");
      g.addColorStop(0.22, "#efe4d3");
      g.addColorStop(0.82, "#ddcdb7");
      g.addColorStop(1, "#cdbba3");
      ctx.fillStyle = g;
      const inset = 0.6;
      roundRect(ctx, key.x + inset, keyTop + 1, key.w - inset * 2, kbH - 1, 4);
      ctx.fill();
      // Bottom lip.
      ctx.fillStyle = "rgba(122, 95, 68, .22)";
      ctx.fillRect(key.x + 1.4, keyTop + kbH - 4, key.w - 2.8, 1.2);
      // Key gap.
      ctx.fillStyle = "rgba(28, 22, 17, .38)";
      ctx.fillRect(key.x + key.w - 0.8, keyTop + 1, 0.8, kbH - 1);
      // Subtle top shade.
      const ts = ctx.createLinearGradient(0, keyTop, 0, keyTop + 18);
      ts.addColorStop(0, "rgba(0,0,0,.14)");
      ts.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = ts;
      ctx.fillRect(key.x + 1, keyTop + 1, key.w - 2, 18);
    }

    // Octave letters / labels.
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (const [midi, key] of keys) {
      if (key.black) continue;
      const isC = midi % 12 === 0;
      const showAll = this.labels && whiteW >= 23;
      if (!isC && !showAll) continue;
      ctx.font = isC ? `600 ${clamp(whiteW * 0.29, 7, 10)}px "Aptos","Segoe UI",sans-serif`
        : `${clamp(whiteW * 0.24, 6, 8)}px "Aptos","Segoe UI",sans-serif`;
      ctx.fillStyle = isC ? "rgba(66, 52, 39, .62)" : "rgba(86, 70, 53, .3)";
      const label = showAll ? keyLabel(midi) : `C${Math.floor(midi / 12) - 1}`;
      ctx.fillText(label, key.x + key.w / 2, keyTop + kbH - 9);
    }

    // Black keys.
    for (const [midi, key] of keys) {
      if (!key.black) continue;
      const bh = kbH * 0.62;
      const g = ctx.createLinearGradient(0, keyTop, 0, keyTop + bh);
      g.addColorStop(0, "#3a302a");
      g.addColorStop(0.12, "#211b17");
      g.addColorStop(0.8, "#100d0b");
      g.addColorStop(1, "#27201b");
      ctx.shadowColor = "rgba(0,0,0,.6)";
      ctx.shadowBlur = 7 * (whiteW > 13 ? 1 : 0.4);
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = g;
      roundRect(ctx, key.x, keyTop - 1, key.w, bh, 3.2);
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      // Highlight.
      const hl = ctx.createLinearGradient(0, keyTop, 0, keyTop + bh * 0.55);
      hl.addColorStop(0, "rgba(255,255,255,.17)");
      hl.addColorStop(0.4, "rgba(255,255,255,.035)");
      hl.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = hl;
      roundRect(ctx, key.x + 1, keyTop, Math.max(1, key.w - 2), bh * 0.6, 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.1)";
      ctx.fillRect(key.x + 1.5, keyTop + 1, Math.max(0.5, key.w * 0.18), bh * 0.5);
      // Bottom bevel.
      ctx.fillStyle = "rgba(255,255,255,.055)";
      ctx.fillRect(key.x + 2, keyTop + bh - 3, key.w - 4, 1);
    }

    // Vertical fade at top so notes emerge softly.
    const fadeTop = ctx.createLinearGradient(0, 0, 0, h * 0.18);
    fadeTop.addColorStop(0, "rgba(12, 11, 9, .75)");
    fadeTop.addColorStop(1, "rgba(12, 11, 9, 0)");
    ctx.fillStyle = fadeTop;
    ctx.fillRect(0, 0, w, h * 0.18);

    this._dirty = false;
  }

  _activeAt(beat) {
    const mb = measureBeats(this.score || { timeSignature: [4, 4] });
    const active = [];
    for (const note of this.notes) {
      if (this.hands !== "both" && note.hand !== this.hands) continue;
      if (beat >= note.start - 0.015 && beat < note.start + note.duration - 0.005) {
        active.push(note);
      }
    }
    // Deduplicate by MIDI, preferring the louder / right hand.
    const byMidi = new Map();
    for (const n of active) {
      const cur = byMidi.get(n.midi);
      if (!cur || n.velocity > cur.velocity) byMidi.set(n.midi, n);
    }
    return { list: [...byMidi.values()], raw: active, mb };
  }

  _render() {
    if (!this.w || !this.h || !this.geom) return;
    const ctx = this.ctx;
    const geom = this.geom;
    const displayBeat = this.getBeat();
    const countingIn = Boolean(this.isCountingIn?.());
    // Keep the first chord just above the keys while the count-in runs, rather
    // than lighting the keys before the player should press them.
    const beat = countingIn ? displayBeat - 0.25 : displayBeat;
    const now = performance.now();
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.bg, 0, 0, this.w, this.h);

    const { list: active, raw } = this._activeAt(beat);
    const leadSec = LEAD_SECONDS;
    const beatSec = this.beatSec;
    const leadBeats = leadSec / beatSec;
    const travel = geom.keyTop - 16;
    const notes = this.notes;

    // New onsets trigger flashes.
    const onsetSet = new Set();
    for (const n of raw) {
      onsetSet.add(n.id);
      if (!this._lastOnsets.has(n.id) && beat >= n.start - 0.01) {
        this.flash(n.midi, n.hand);
      }
    }
    this._lastOnsets = onsetSet;
    if (this._lastBeat !== beat && this._lastBeat < beat) {
      // Catch any onset crossed since the last frame, even if this frame skipped it.
      for (const n of notes) {
        if (n.start > this._lastBeat && n.start <= beat) this.flash(n.midi, n.hand);
      }
    }
    this._lastBeat = beat;

    // Active key glow.
    const activeMap = new Map();
    for (const n of active) activeMap.set(n.midi, n);
    for (const [midi, note] of activeMap) {
      this._drawActiveKey(ctx, midi, note.hand, now);
    }

    // Falling notes, clipped above the keyboard.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.w, geom.keyTop - 3);
    ctx.clip();
    const visible = [];
    for (const note of notes) {
      if (this.hands !== "both" && note.hand !== this.hands) continue;
      const delta = note.start - beat;
      if (delta > leadBeats + 0.3) continue;
      if (note.start + note.duration < beat - 0.25) continue;
      visible.push({ note, delta });
    }
    visible.sort((a, b) => b.delta - a.delta);
    for (const { note, delta } of visible) {
      this._drawFallingNote(ctx, note, delta, beatSec, leadSec, travel, geom);
    }
    ctx.restore();

    // Hit line.
    const hit = ctx.createLinearGradient(0, geom.keyTop - 2, 0, geom.keyTop + 2);
    hit.addColorStop(0, "rgba(231,172,91,.02)");
    hit.addColorStop(0.5, "rgba(231,172,91,.2)");
    hit.addColorStop(1, "rgba(231,172,91,.02)");
    ctx.fillStyle = hit;
    ctx.fillRect(geom.x0, geom.keyTop - 2, geom.x1 - geom.x0, 4);

    // Flashes.
    this.flashes = this.flashes.filter((f) => now - f.at < 650);
    for (const f of this.flashes) {
      const key = this.keys.get(f.midi);
      if (!key) continue;
      const t = (now - f.at) / 650;
      const alpha = (1 - t) * 0.55;
      const cx = key.x + key.w / 2;
      const cy = geom.keyTop;
      const radius = (key.black ? key.w * 2.2 : key.w * 1.35) * (0.4 + t * 1.2);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      g.addColorStop(0, rgb(f.hand, alpha));
      g.addColorStop(0.5, rgb(f.hand, alpha * 0.35));
      g.addColorStop(1, rgb(f.hand, 0));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      // Two small sparks.
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i - 1) * 0.55;
        const dist = t * (key.w * 1.5 + 14) + 6;
        const sx = cx + Math.cos(a) * dist;
        const sy = cy + Math.sin(a) * dist * 0.8;
        ctx.fillStyle = rgb(f.hand, (1 - t) * 0.7);
        ctx.beginPath();
        ctx.arc(sx, sy, 1.2 + (1 - t) * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (this.onFrame) {
      const mb = measureBeats(this.score || { timeSignature: [4, 4] });
      const measure = Math.floor(displayBeat / mb + 1e-9) + 1;
      this.onFrame({
        beat: displayBeat,
        measure,
        beatInMeasure: displayBeat % mb,
        active: active.map((n) => ({ midi: n.midi, hand: n.hand })),
        totalMeasures: this.score?.measures || 1,
      });
    }
  }

  _drawFallingNote(ctx, note, delta, beatSec, leadSec, travel, geom) {
    const key = this.keys.get(note.midi);
    if (!key) return;
    const secondsAhead = delta * beatSec;
    const yBottom = geom.keyTop - 2 - (secondsAhead / leadSec) * travel;
    const durPx = Math.max(5, (note.duration * beatSec / leadSec) * travel);
    let yTop = yBottom - durPx;
    if (yBottom < -40) return;
    const isBlack = key.black;
    const pad = isBlack ? 1 : Math.max(1.2, key.w * 0.055);
    const x = key.x + pad;
    const w = Math.max(2, key.w - pad * 2);
    const hand = note.hand;
    const active = delta <= 0.02;
    const alpha = active ? 0.9 : 1;

    // Soft halo.
    ctx.save();
    ctx.shadowColor = rgb(hand, 0.32);
    ctx.shadowBlur = isBlack ? 9 : 14;
    const grad = ctx.createLinearGradient(0, yTop, 0, yBottom);
    grad.addColorStop(0, rgb(hand, 0.22));
    grad.addColorStop(0.3, rgb(hand, 0.68));
    grad.addColorStop(1, rgb(hand, 0.96));
    ctx.fillStyle = grad;
    roundRect(ctx, x, Math.max(-30, yTop), w, Math.min(yBottom, geom.keyTop) - Math.max(-30, yTop), Math.min(5, w / 3));
    ctx.globalAlpha = alpha;
    ctx.fill();
    ctx.restore();

    // Rim light.
    ctx.strokeStyle = rgb(hand, active ? 0.95 : 0.55);
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, Math.max(-30, yTop) + 0.5, w - 1, Math.min(yBottom, geom.keyTop) - Math.max(-30, yTop) - 1, Math.min(5, w / 3));
    ctx.stroke();

    // A brighter tip where the note will land.
    if (yBottom > 0 && yBottom < geom.keyTop + 2) {
      ctx.fillStyle = rgb(hand, 0.95);
      roundRect(ctx, x + 0.4, yBottom - 3.5, w - 0.8, 3.2, 2);
      ctx.fill();
    }

    // Label.
    if (this.labels && w >= 21 && yBottom - Math.max(yTop, 0) > 28) {
      ctx.font = `600 ${clamp(w * 0.27, 7.5, 11)}px "Aptos","Segoe UI",sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(25, 17, 9, .8)";
      const label = keyLabel(note.midi);
      const ly = Math.min(yBottom - 14, Math.max(yTop + 14, yBottom - 16));
      ctx.fillText(label, x + w / 2, ly);
    }
  }

  _drawActiveKey(ctx, midi, hand, now) {
    const key = this.keys.get(midi);
    if (!key) return;
    const geom = this.geom;
    const isBlack = key.black;
    const bh = isBlack ? geom.kbH * 0.62 : geom.kbH - 1;
    const x = key.x + 1;
    const y = geom.keyTop + 1;
    const w = key.w - 2;
    const h = bh - 2;
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    if (isBlack) {
      grad.addColorStop(0, hand === "L" ? "rgba(131, 224, 213, .95)" : "rgba(250, 202, 133, .98)");
      grad.addColorStop(1, hand === "L" ? "rgba(50, 137, 128, .96)" : "rgba(180, 116, 47, .98)");
    } else {
      grad.addColorStop(0, hand === "L" ? "rgba(183, 241, 233, .98)" : "rgba(255, 229, 184, .98)");
      grad.addColorStop(0.55, hand === "L" ? "rgba(113, 211, 198, .94)" : "rgba(239, 183, 98, .94)");
      grad.addColorStop(1, hand === "L" ? "rgba(63, 164, 152, .92)" : "rgba(198, 133, 58, .92)");
    }
    ctx.save();
    ctx.shadowColor = rgb(hand, 0.55);
    ctx.shadowBlur = isBlack ? 15 : 22;
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, w, h, isBlack ? 3 : 4);
    ctx.fill();
    ctx.restore();
    // Key press highlight.
    ctx.fillStyle = "rgba(255,255,255,.25)";
    roundRect(ctx, x + 1.5, y + 1.5, Math.max(1, w - 3), Math.min(8, h * 0.12), 2);
    ctx.fill();
    // Bottom glow.
    const g = ctx.createRadialGradient(key.x + key.w / 2, geom.keyTop, 0, key.x + key.w / 2, geom.keyTop, key.w * 2);
    g.addColorStop(0, rgb(hand, 0.3));
    g.addColorStop(1, rgb(hand, 0));
    ctx.fillStyle = g;
    ctx.fillRect(key.x - key.w, geom.keyTop - 20, key.w * 3, 40);
  }

  _tick(t) {
    this._raf = requestAnimationFrame(this.onFrameTick);
    if (this._frameGap && t - this._lastTime < this._frameGap) return;
    this._lastTime = t;
    this._render();
  }

  destroy() {
    this.stop();
    this._resizeObserver.disconnect();
  }
}

/* ─────────────── decorative hero preview ─────────────── */

export class HeroPreview {
  constructor(canvas, { keyChip, measureLabel, beatLabel } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.keyChip = keyChip;
    this.measureLabel = measureLabel;
    this.beatLabel = beatLabel;
    this.raf = 0;
    this.startTime = performance.now() / 1000;
    this.cycle = 16.5;
    this._lastFrame = 0;
    this._frameGap = window.innerWidth < 700 ? 1000 / 30 : 0;
    this.notes = [];
    const seq = [
      ["C4", 3, 0.8], ["E4", 3.5, 0.8], ["G4", 4, 0.8], ["C5", 4.5, 1.4],
      ["A4", 7, 0.8], ["C5", 7.5, 0.8], ["E5", 8, 1.4],
      ["G4", 10.5, 0.8], ["B4", 11, 0.8], ["D5", 11.5, 0.8], ["G5", 12, 1.2],
      ["F4", 13, 0.6], ["A4", 13.5, 0.6], ["C5", 14, 1.2],
    ];
    const pitch = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    for (const [name, start, dur] of seq) {
      const m = /^([A-G])(\d)$/.exec(name);
      const midi = (Number(m[2]) + 1) * 12 + pitch[m[1]];
      this.notes.push({ midi, start, dur, hand: midi < 60 ? "L" : "R" });
    }
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(canvas.parentElement || canvas);
    this._resize();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2) return;
    const dprCap = window.innerWidth < 700 ? 1.5 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.w = rect.width;
    this.h = rect.height;
    this.dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._geometry();
  }

  _geometry() {
    const w = this.w, h = this.h;
    const kbH = Math.min(94, h * 0.34);
    const keyTop = h - kbH - 4;
    const x0 = 12, x1 = w - 12;
    const whites = [];
    for (let m = 48; m <= 84; m++) if (!isBlackKey(m)) whites.push(m);
    const ww = (x1 - x0) / whites.length;
    const keys = new Map();
    whites.forEach((m, i) => keys.set(m, { x: x0 + i * ww, w: ww, black: false }));
    for (let m = 48; m <= 84; m++) {
      if (!isBlackKey(m)) continue;
      const prev = m - 1;
      const idx = whites.indexOf(prev);
      if (idx < 0) continue;
      keys.set(m, { x: x0 + (idx + 1) * ww - ww * 0.3, w: ww * 0.6, black: true });
    }
    this.geom = { w, h, x0, x1, keyTop, kbH, keys, ww };
  }

  start() {
    if (this.raf) return;
    const loop = (t) => {
      this.raf = requestAnimationFrame(loop);
      if (this._frameGap && t - this._lastFrame < this._frameGap) return;
      this._lastFrame = t;
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  draw() {
    if (!this.w) this._resize();
    if (!this.w) return;
    const { ctx, w, h, geom } = this;
    const t = ((performance.now() / 1000 - this.startTime) % this.cycle);
    ctx.clearRect(0, 0, w, h);

    // Faint stage lines.
    ctx.strokeStyle = "rgba(244,236,223,.035)";
    ctx.lineWidth = 1;
    for (let g = 0; g < 2; g++) {
      for (let i = 0; i < 5; i++) {
        const y = h * 0.12 + g * 72 + i * 9;
        ctx.beginPath(); ctx.moveTo(16, y); ctx.lineTo(w - 16, y); ctx.stroke();
      }
    }

    const active = this.notes.filter((n) => t >= n.start && t < n.start + n.dur * 0.55);
    const activeMap = new Map(active.map((n) => [n.midi, n]));
    const keyHeight = geom.kbH;
    const keyBottom = geom.keyTop + keyHeight;

    // White key bed.
    for (const [m, key] of geom.keys) {
      if (key.black) continue;
      const g = ctx.createLinearGradient(0, geom.keyTop, 0, keyBottom);
      g.addColorStop(0, "#f9f2e7");
      g.addColorStop(0.65, "#e9dcc9");
      g.addColorStop(1, "#d6c4ab");
      ctx.fillStyle = g;
      roundRect(ctx, key.x + 0.7, geom.keyTop + 1, key.w - 1.4, keyHeight - 1, 2.5);
      ctx.fill();
      ctx.fillStyle = "rgba(35,27,20,.26)";
      ctx.fillRect(key.x + key.w - 0.8, geom.keyTop + 1, 0.8, keyHeight - 1);
      ctx.fillStyle = "rgba(255,255,255,.34)";
      ctx.fillRect(key.x + 1.2, geom.keyTop + 1, Math.max(0.6, key.w * 0.08), keyHeight - 3);
    }

    // Lit white keys first, so black keys remain on top.
    for (const [m, key] of geom.keys) {
      if (key.black || !activeMap.has(m)) continue;
      const g = ctx.createLinearGradient(0, geom.keyTop, 0, keyBottom);
      g.addColorStop(0, "rgba(255,239,205,.98)");
      g.addColorStop(0.6, "rgba(239,184,99,.96)");
      g.addColorStop(1, "rgba(197,132,55,.94)");
      ctx.save();
      ctx.shadowColor = "rgba(231,172,91,.48)";
      ctx.shadowBlur = 16;
      ctx.fillStyle = g;
      roundRect(ctx, key.x + 1, geom.keyTop + 1, key.w - 2, keyHeight - 2, 2.5);
      ctx.fill();
      ctx.restore();
    }

    // Black key bed.
    for (const [m, key] of geom.keys) {
      if (!key.black) continue;
      const bh = keyHeight * 0.63;
      const g = ctx.createLinearGradient(0, geom.keyTop, 0, geom.keyTop + bh);
      g.addColorStop(0, "#41352d");
      g.addColorStop(0.16, "#211b17");
      g.addColorStop(1, "#0c0a08");
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,.45)";
      ctx.shadowBlur = 5;
      ctx.fillStyle = g;
      roundRect(ctx, key.x, geom.keyTop - 1, key.w, bh, 2.4);
      ctx.fill();
      ctx.restore();
      if (activeMap.has(m)) {
        const ag = ctx.createLinearGradient(0, geom.keyTop, 0, geom.keyTop + bh);
        ag.addColorStop(0, "rgba(255,222,168,.98)");
        ag.addColorStop(1, "rgba(169,103,41,.98)");
        ctx.save();
        ctx.shadowColor = "rgba(231,172,91,.5)";
        ctx.shadowBlur = 12;
        ctx.fillStyle = ag;
        roundRect(ctx, key.x + 0.8, geom.keyTop, key.w - 1.6, bh - 1, 2.2);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = "rgba(255,255,255,.1)";
      ctx.fillRect(key.x + 1.5, geom.keyTop, Math.max(0.5, key.w * 0.16), bh * 0.48);
    }

    // Octave labels.
    ctx.textAlign = "center";
    ctx.font = `500 8px "Aptos","Segoe UI",sans-serif`;
    for (const [m, key] of geom.keys) {
      if (m % 12 === 0) {
        ctx.fillStyle = activeMap.has(m) ? "rgba(52,33,13,.7)" : "rgba(65,52,38,.55)";
        ctx.fillText(`C${m / 12 - 1}`, key.x + key.w / 2, keyBottom - 10);
      }
    }

    // Felt strip and soft floor shadow.
    ctx.fillStyle = "rgba(62,21,15,.75)";
    ctx.fillRect(geom.x0 - 2, geom.keyTop - 3, geom.x1 - geom.x0 + 4, 3.5);
    const kbG = ctx.createLinearGradient(0, keyBottom, 0, h);
    kbG.addColorStop(0, "rgba(12,10,8,0)");
    kbG.addColorStop(1, "rgba(12,10,8,.5)");
    ctx.fillStyle = kbG;
    ctx.fillRect(0, keyBottom, w, h - keyBottom);

    // Falling notes.
    const lead = 3.5;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, geom.keyTop - 2); ctx.clip();
    for (const n of this.notes) {
      const key = geom.keys.get(n.midi);
      if (!key) continue;
      const ahead = n.start - t;
      if (ahead > lead || n.start + n.dur < t) continue;
      const travel = geom.keyTop - 12;
      const yb = geom.keyTop - (ahead / lead) * travel;
      const dpx = Math.max(5, (n.dur * 0.56 / lead) * travel);
      const grad = ctx.createLinearGradient(0, yb - dpx, 0, yb);
      grad.addColorStop(0, "rgba(231,172,91,.1)");
      grad.addColorStop(0.3, "rgba(231,172,91,.62)");
      grad.addColorStop(1, "rgba(246,203,140,.96)");
      ctx.fillStyle = grad;
      ctx.shadowColor = "rgba(231,172,91,.28)";
      ctx.shadowBlur = 10;
      roundRect(ctx, key.x + 1, Math.max(-20, yb - dpx), key.w - 2, Math.min(yb, geom.keyTop) - Math.max(-20, yb - dpx), 3);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.restore();

    // Glow under active keys.
    for (const n of active.slice(0, 1)) {
      const key = geom.keys.get(n.midi);
      if (!key) continue;
      const cx = key.x + key.w / 2;
      const g = ctx.createRadialGradient(cx, geom.keyTop, 0, cx, geom.keyTop, geom.ww * 1.8);
      g.addColorStop(0, "rgba(231,172,91,.34)");
      g.addColorStop(1, "rgba(231,172,91,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - geom.ww * 2, geom.keyTop - 30, geom.ww * 4, 52);
    }

    if (this.keyChip) {
      const n = active[0] || this.notes.find((x) => x.start > t) || this.notes[0];
      const name = noteName(n.midi);
      if (this.keyChip.textContent !== name) this.keyChip.textContent = name;
    }
    if (this.measureLabel) {
      const measure = Math.floor(t / 4) + 1;
      const label = `第 ${measure} 小节`;
      if (this.measureLabel.textContent !== label) this.measureLabel.textContent = label;
    }
    if (this.beatLabel) {
      const beat = Math.floor((t % 4)) + 1;
      const label = `${beat} / 4`;
      if (this.beatLabel.textContent !== label) this.beatLabel.textContent = label;
    }
  }

  destroy() {
    this.stop();
    this._resizeObserver.disconnect();
  }
}
