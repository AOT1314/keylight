/* Small helpers shared across the app. */

// Safari gained CanvasRenderingContext2D.roundRect fairly recently. Keep older
// iPhone / iPad versions working (the app draws every note through this).
if (typeof CanvasRenderingContext2D !== "undefined" && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function roundRectFallback(x, y, w, h, radii) {
    const r = Math.min(typeof radii === "number" ? radii : 0, Math.abs(w) / 2, Math.abs(h) / 2);
    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y);
    this.quadraticCurveTo(x + w, y, x + w, y + r);
    this.lineTo(x + w, y + h - r);
    this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    this.lineTo(x + r, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r);
    this.lineTo(x, y + r);
    this.quadraticCurveTo(x, y, x + r, y);
    this.closePath();
    return this;
  };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const snap = (v, step) => Math.round(v / step) * step;
export const mod = (n, m) => ((n % m) + m) % m;
export const uid = (prefix = "id") => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
export const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
export const SOLFEGE = ["do", "di", "re", "ri", "mi", "fa", "fi", "sol", "si", "la", "li", "ti"];

export function isBlackKey(midi) {
  return [1, 3, 6, 8, 10].includes(midi % 12);
}

export function noteName(midi, preferFlats = false, withOctave = true) {
  const name = (preferFlats ? FLAT_NAMES : NOTE_NAMES)[mod(midi, 12)];
  return withOctave ? `${name}${Math.floor(midi / 12) - 1}` : name;
}

export function noteOctave(midi) {
  return Math.floor(midi / 12) - 1;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function noteColor(hand, alpha = 1) {
  return hand === "L"
    ? `rgba(103, 196, 181, ${alpha})`
    : `rgba(231, 172, 91, ${alpha})`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatSecondsLong(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

export function parseTimeSignature(str) {
  const [a, b] = String(str || "4/4").split("/").map(Number);
  return [a > 0 ? a : 4, b > 0 ? b : 4];
}

export function measureBeats(timeSignature) {
  let n = 4, d = 4;
  if (Array.isArray(timeSignature)) {
    [n, d] = timeSignature;
  } else if (typeof timeSignature === "string" && timeSignature.includes("/")) {
    [n, d] = timeSignature.split("/").map(Number);
  }
  n = Number(n) > 0 ? Number(n) : 4;
  d = Number(d) > 0 ? Number(d) : 4;
  return (n * 4) / d;
}

export function downloadFile(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function debounce(fn, wait = 120) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function canvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { width: rect.width, height: rect.height, dpr };
}

export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

export function titleFromFilename(name = "未命名琴谱") {
  return name.replace(/\.(png|jpe?g|webp|bmp|pdf|musicxml|xml|midi?|mxl)$/i, "").replace(/[_-]+/g, " ").trim() || "未命名琴谱";
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

export const KEY_SIGNATURE_NAMES = {
  "-7": "C♭ 大调", "-6": "G♭ 大调", "-5": "D♭ 大调", "-4": "A♭ 大调", "-3": "E♭ 大调",
  "-2": "B♭ 大调", "-1": "F 大调", "0": "C 大调", "1": "G 大调", "2": "D 大调",
  "3": "A 大调", "4": "E 大调", "5": "B 大调", "6": "F♯ 大调", "7": "C♯ 大调",
};

export const JIANPU_KEYS = {
  "C": { tonic: 0, name: "C 大调" },
  "G": { tonic: 7, name: "G 大调" },
  "D": { tonic: 2, name: "D 大调" },
  "A": { tonic: 9, name: "A 大调" },
  "E": { tonic: 4, name: "E 大调" },
  "B": { tonic: 11, name: "B 大调" },
  "F": { tonic: 5, name: "F 大调" },
  "Bb": { tonic: 10, name: "B♭ 大调" },
  "Eb": { tonic: 3, name: "E♭ 大调" },
  "Ab": { tonic: 8, name: "A♭ 大调" },
};

/* Staff pitch mapping. Diatonic step 0 = C0. The middle line of a five-line
   staff is step 34 (B4) for treble and step 22 (D3) for bass. */
const LETTER_STEPS = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const LETTER_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const STEP_LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

export function keyAlterations(fifths = 0) {
  const alters = {};
  if (fifths > 0) SHARP_ORDER.slice(0, Math.min(7, fifths)).forEach((l) => { alters[l] = 1; });
  if (fifths < 0) FLAT_ORDER.slice(0, Math.min(7, -fifths)).forEach((l) => { alters[l] = -1; });
  return alters;
}

export function diatonicToMidi(step, fifths = 0, accidental = 0) {
  const letter = STEP_LETTERS[mod(step, 7)];
  const octave = Math.floor(step / 7);
  const keyAlt = keyAlterations(fifths)[letter] || 0;
  const natural = (octave + 1) * 12 + LETTER_SEMITONES[letter];
  return clamp(natural + keyAlt + accidental, 0, 127);
}

export function staffYToMidi(y, staff, fifths = 0) {
  const space = staff.space;
  const middleY = staff.middleY;
  // A diatonic step is half a staff space. Positive = upward.
  const stepOffset = Math.round((middleY - y) / (space / 2));
  const baseStep = staff.clef === "bass" ? 22 : 34;
  return diatonicToMidi(baseStep + stepOffset, fifths, 0);
}

export function midiToStaffStep(midi, clef = "treble", fifths = 0) {
  // Best-effort spelling for displaying a note back on a staff.
  const names = fifths < 0 ? FLAT_NAMES : NOTE_NAMES;
  const pc = mod(midi, 12);
  const name = names[pc].replace("♯", "#").replace("♭", "b");
  const letter = name[0];
  const acc = name.length > 1 ? (name[1] === "#" ? 1 : -1) : 0;
  const octave = noteOctave(midi);
  const naturalPc = LETTER_STEPS[letter];
  const naturalMidi = (octave + 1) * 12 + naturalPc;
  const keyAlt = keyAlterations(fifths)[letter] || 0;
  const step = octave * 7 + naturalPc - (keyAlt !== 0 ? 0 : 0);
  // step here counts from C-1=0; align with base step where C4=28.
  const absStep = octave * 7 + naturalPc;
  const baseStep = clef === "bass" ? 22 : 34;
  return absStep - baseStep + acc * 0;
}

export function keyLabelFor(fifths, preferFlats = false) {
  return KEY_SIGNATURE_NAMES[String(clamp(fifths, -7, 7))] || "C 大调";
}

export function normalizeFifths(value) {
  return clamp(Number(value) || 0, -7, 7);
}
