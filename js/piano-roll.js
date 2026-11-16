/* Piano-roll review editor. Canvas based, with direct manipulation of pitch,
   start time and duration. Designed to make correcting OMR results quick. */

import {
  clamp, isBlackKey, noteName, measureBeats, roundRect, snap, midiToFreq,
} from "./util.js";

const HAND_COLORS = {
  R: { main: "231, 172, 91", light: "250, 220, 174", dark: "159, 102, 39" },
  L: { main: "103, 196, 181", light: "183, 241, 233", dark: "42, 123, 113" },
};

function cloneNotes(notes) {
  return notes.map((n) => ({ ...n }));
}

export class PianoRoll {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.score = null;
    this.onChange = opts.onChange || null;
    this.onSelect = opts.onSelect || null;
    this.onPreview = opts.onPreview || null;
    this.onSeek = opts.onSeek || null;
    this.onStatus = opts.onStatus || null;
    this.activeHand = "R";
    this.newDuration = 1;
    this.selectedId = null;
    this.hoverId = null;
    this.playhead = null;
    this.history = [];
    this.redoStack = [];
    this.w = 0;
    this.h = 0;
    this.scrollY = 0;
    this.scrollX = 0;
    this.rowH = 14;
    this.ppb = 52;
    this.leftWidth = 54;
    this.rulerH = 28;
    this._dragging = null;
    this._pointer = { x: 0, y: 0 };
    this._raf = 0;
    this._dirty = true;
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement || canvas);
    this._bind();
    this.resize();
  }

  setScore(score, { preserveSelection = false } = {}) {
    this.score = score;
    if (!preserveSelection) this.selectedId = null;
    this.history = [];
    this.redoStack = [];
    this.scrollX = 0;
    this.scrollY = 0;
    this._computeRange();
    this._computeScale();
    this._centerVertically();
    this._emitSelection();
    this.resize();
    this.redraw();
  }

  setActiveHand(hand) {
    this.activeHand = hand === "L" ? "L" : "R";
  }

  setNewDuration(d) {
    this.newDuration = Math.max(0.0625, Number(d) || 1);
  }

  setPlayhead(beat, { follow = false } = {}) {
    this.playhead = beat == null ? null : Math.max(0, beat);
    if (follow && this.playhead != null) {
      const visible = (this.w - this.leftWidth) / this.ppb;
      if (this.playhead < this.scrollX + visible * 0.1 || this.playhead > this.scrollX + visible * 0.82) {
        this.scrollX = clamp(this.playhead - visible * 0.18, 0, this.maxScrollX);
      }
    }
    this.redraw();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dprCap = window.innerWidth < 700 ? 1.5 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    this.w = rect.width;
    this.h = rect.height;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._computeScale();
    this.redraw();
  }

  refresh() {
    this.resize();
    this._computeRange();
    this._computeScale();
    if (!Number.isFinite(this.scrollY)) this.scrollY = 0;
    this._centerVertically();
    this.redraw();
  }

  _centerVertically() {
    if (!this.h) { this.scrollY = 0; return; }
    const availH = this.h - this.rulerH - 10;
    this.scrollY = clamp((this.span * this.rowH - availH) / 2, 0, this.maxScrollY);
  }

  _computeRange() {
    const notes = this.score?.notes || [];
    let lo = notes.length ? Math.min(...notes.map((n) => n.midi)) : 48;
    let hi = notes.length ? Math.max(...notes.map((n) => n.midi)) : 72;
    lo = Math.max(21, lo - 2);
    hi = Math.min(108, hi + 2);
    while (hi - lo < 23) {
      if (lo > 21) lo--;
      else hi++;
    }
    while (isBlackKey(lo) && lo > 21) lo--;
    while (isBlackKey(hi) && hi < 108) hi++;
    this.low = lo;
    this.high = hi;
    this.span = hi - lo + 1;
  }

  _computeScale() {
    if (!this.score || !this.w) return;
    const mb = measureBeats(this.score);
    const totalBeats = Math.max(this.score.measures * mb, ...(this.score.notes.map((n) => n.start + n.duration)), 4);
    const availW = this.w - this.leftWidth - 18;
    this.ppb = clamp(availW / Math.max(totalBeats + 1, 8), 13, 76);
    this.totalBeats = totalBeats + 4;
    this.maxScrollX = Math.max(0, this.totalBeats - availW / this.ppb - 1);
    this.scrollX = clamp(this.scrollX, 0, this.maxScrollX);
    const availH = this.h - this.rulerH - 10;
    this.rowH = clamp(availH / this.span, 8.5, 18);
    this.contentH = this.span * this.rowH;
    this.maxScrollY = Math.max(0, this.contentH - availH);
    if (!Number.isFinite(this.scrollY)) this.scrollY = 0;
    this.scrollY = clamp(this.scrollY, 0, this.maxScrollY);
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._pointerDown(e));
    c.addEventListener("pointermove", (e) => this._pointerMove(e));
    c.addEventListener("pointerup", (e) => this._pointerUp(e));
    c.addEventListener("pointercancel", (e) => this._pointerUp(e));
    c.addEventListener("pointerleave", () => {
      if (!this._dragging) {
        this.hoverId = null;
        c.style.cursor = "default";
        this.redraw();
      }
    });
    c.addEventListener("dblclick", (e) => this._doubleClick(e));
    c.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _noteRect(note) {
    const x = this.leftWidth + (note.start - this.scrollX) * this.ppb;
    const y = this.rulerH + (this.high - note.midi) * this.rowH - this.scrollY;
    return {
      x, y, w: Math.max(4, note.duration * this.ppb), h: Math.max(4, this.rowH - 1.5),
    };
  }

  _hitTest(x, y) {
    if (!this.score || x < this.leftWidth || y < this.rulerH) return null;
    const notes = this.score.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const rect = this._noteRect(notes[i]);
      if (x >= rect.x - 2 && x <= rect.x + rect.w + 2 && y >= rect.y - 1 && y <= rect.y + rect.h + 1) {
        return { note: notes[i], rect, edge: x > rect.x + rect.w - Math.max(5, Math.min(9, rect.w * 0.18)) };
      }
    }
    return null;
  }

  _pitchAt(y) {
    return clamp(this.high - Math.floor((y - this.rulerH + this.scrollY) / this.rowH), 21, 108);
  }

  _beatAt(x) {
    return Math.max(0, (x - this.leftWidth) / this.ppb + this.scrollX);
  }

  _snapshot() {
    return {
      notes: cloneNotes(this.score.notes),
      measures: this.score.measures,
      selected: this.selectedId,
    };
  }

  _pushHistory(before) {
    this.history.push(before);
    if (this.history.length > 80) this.history.shift();
    this.redoStack = [];
  }

  _restore(snap) {
    this.score.notes = cloneNotes(snap.notes);
    this.score.measures = snap.measures;
    this.selectedId = snap.selected;
    this._computeRange();
    this._computeScale();
    this._emitSelection();
    this.onChange?.(this.score, { action: "restore", silent: true });
    this.redraw();
  }

  undo() {
    if (!this.history.length) return false;
    const current = this._snapshot();
    const prev = this.history.pop();
    this.redoStack.push(current);
    this._restore(prev);
    this.onStatus?.("已撤销");
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    const current = this._snapshot();
    const next = this.redoStack.pop();
    this.history.push(current);
    this._restore(next);
    this.onStatus?.("已重做");
    return true;
  }

  _afterMutation(action = "edit") {
    if (!this.score) return;
    const mb = measureBeats(this.score);
    const end = this.score.notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
    this.score.measures = Math.max(this.score.measures, Math.ceil(end / mb - 1e-9), 1);
    this._computeRange();
    this._computeScale();
    this.onChange?.(this.score, { action });
    this.redraw();
  }

  _emitSelection() {
    const note = this.score?.notes.find((n) => n.id === this.selectedId) || null;
    this.onSelect?.(note);
  }

  select(id, preview = false) {
    this.selectedId = id;
    this._emitSelection();
    this.redraw();
    if (preview && id) {
      const note = this.score.notes.find((n) => n.id === id);
      if (note) this.onPreview?.(note.midi, Math.min(1.1, note.duration * 0.35 + 0.3), note.velocity);
    }
  }

  deleteSelected() {
    if (!this.selectedId) return false;
    const idx = this.score.notes.findIndex((n) => n.id === this.selectedId);
    if (idx < 0) return false;
    const before = this._snapshot();
    this.score.notes.splice(idx, 1);
    this.selectedId = null;
    this._pushHistory(before);
    this._emitSelection();
    this._afterMutation("delete");
    this.onStatus?.("已删除音符");
    return true;
  }

  nudgePitch(delta) {
    const note = this.score?.notes.find((n) => n.id === this.selectedId);
    if (!note) return false;
    const target = clamp(note.midi + delta, 21, 108);
    if (target === note.midi) return false;
    const before = this._snapshot();
    note.midi = target;
    this._pushHistory(before);
    this._emitSelection();
    this._afterMutation("pitch");
    this.onPreview?.(note.midi, 0.55, note.velocity);
    return true;
  }

  nudgeTime(delta) {
    const note = this.score?.notes.find((n) => n.id === this.selectedId);
    if (!note) return false;
    const target = Math.max(0, snap(note.start + delta, 0.25));
    if (target === note.start) return false;
    const before = this._snapshot();
    note.start = target;
    this._pushHistory(before);
    this._emitSelection();
    this._afterMutation("time");
    return true;
  }

  changeDuration(delta) {
    const note = this.score?.notes.find((n) => n.id === this.selectedId);
    if (!note) return false;
    const target = Math.max(0.125, snap(note.duration + delta, 0.25));
    if (target === note.duration) return false;
    const before = this._snapshot();
    note.duration = target;
    this._pushHistory(before);
    this._emitSelection();
    this._afterMutation("duration");
    return true;
  }

  changeHand(hand) {
    const note = this.score?.notes.find((n) => n.id === this.selectedId);
    if (!note || note.hand === hand) return false;
    const before = this._snapshot();
    note.hand = hand;
    this._pushHistory(before);
    this._emitSelection();
    this._afterMutation("hand");
    return true;
  }

  quantize() {
    if (!this.score) return false;
    const before = this._snapshot();
    let changed = false;
    for (const n of this.score.notes) {
      const s = Math.round(n.start * 4) / 4;
      of: {
        if (Math.abs(s - n.start) > 1e-6) { n.start = s; changed = true; }
        const d = Math.max(0.25, Math.round(n.duration * 4) / 4);
        if (Math.abs(d - n.duration) > 1e-6) { n.duration = d; changed = true; }
      }
    }
    if (!changed) {
      this.onStatus?.("音符已经在 1/16 网格上");
      return false;
    }
    this._pushHistory(before);
    this._afterMutation("quantize");
    this.onStatus?.("已吸附到 1/16 网格");
    return true;
  }

  autoScrollToSelection() {
    if (!this.selectedId) return;
    const note = this.score.notes.find((n) => n.id === this.selectedId);
    if (!note) return;
    const visible = (this.w - this.leftWidth) / this.ppb;
    if (note.start < this.scrollX || note.start > this.scrollX + visible - 2) {
      this.scrollX = clamp(note.start - visible * 0.2, 0, this.maxScrollX);
    }
    this.redraw();
  }

  _pointerDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this._pos(e);
    this._pointer = { x, y };
    if (!this.score) return;
    if (y < this.rulerH) {
      this._dragging = { type: "seek" };
      this.canvas.setPointerCapture(e.pointerId);
      this._seekAt(x);
      return;
    }
    if (x < this.leftWidth) return;
    const hit = this._hitTest(x, y);
    if (hit) {
      this.selectedId = hit.note.id;
      this._emitSelection();
      if (hit.edge) {
        this._dragging = {
          type: "resize", note: hit.note, startX: x, startY: y,
          initialDuration: hit.note.duration, before: this._snapshot(), changed: false,
        };
      } else {
        this._dragging = {
          type: "move", note: hit.note, startX: x, startY: y,
          initialStart: hit.note.start, initialMidi: hit.note.midi,
          before: this._snapshot(), changed: false, lastPreview: 0,
        };
      }
      this.canvas.setPointerCapture(e.pointerId);
      this.redraw();
      this.onPreview?.(hit.note.midi, 0.65, hit.note.velocity);
    } else {
      this._dragging = {
        type: "pan", startX: x, startY: y, initialScrollX: this.scrollX,
        initialScrollY: this.scrollY, moved: false,
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.selectedId = null;
      this._emitSelection();
      this.redraw();
    }
  }

  _pointerMove(e) {
    const { x, y } = this._pos(e);
    this._pointer = { x, y };
    const drag = this._dragging;
    if (!drag) {
      const hit = this._hitTest(x, y);
      const id = hit?.note?.id || null;
      if (id !== this.hoverId) {
        this.hoverId = id;
        this.redraw();
      }
      if (hit) this.canvas.style.cursor = hit.edge ? "ew-resize" : "grab";
      else if (y < this.rulerH) this.canvas.style.cursor = "pointer";
      else this.canvas.style.cursor = "grab";
      return;
    }
    if (drag.type === "pan") {
      const dx = x - drag.startX;
      const dy = y - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        this.scrollX = clamp(drag.initialScrollX - dx / this.ppb, 0, this.maxScrollX);
        this.scrollY = clamp(drag.initialScrollY - dy, 0, this.maxScrollY);
        this.redraw();
      }
      return;
    }
    if (drag.type === "seek") {
      this._seekAt(x);
      return;
    }
    if (drag.type === "resize") {
      const delta = (x - drag.startX) / this.ppb;
      const next = Math.max(0.125, snap(drag.initialDuration + delta, 0.25));
      if (next !== drag.note.duration) {
        drag.note.duration = next;
        drag.changed = true;
        this._afterMutation("resize-live");
      }
      return;
    }
    if (drag.type === "move") {
      const deltaX = (x - drag.startX) / this.ppb;
      const deltaY = (y - drag.startY) / this.rowH;
      const nextStart = Math.max(0, snap(drag.initialStart + deltaX, 0.25));
      const nextMidi = clamp(Math.round(drag.initialMidi - deltaY), 21, 108);
      let changed = false;
      if (nextStart !== drag.note.start) { drag.note.start = nextStart; changed = true; }
      if (nextMidi !== drag.note.midi) {
        drag.note.midi = nextMidi;
        changed = true;
        const now = performance.now();
        if (now - drag.lastPreview > 55) {
          drag.lastPreview = now;
          this.onPreview?.(nextMidi, 0.45, drag.note.velocity);
        }
      }
      if (changed) {
        drag.changed = true;
        this._afterMutation("move-live");
        this._emitSelection();
      }
    }
  }

  _seekAt(x) {
    const beat = Math.max(0, this._beatAt(x));
    this.playhead = beat;
    this.onSeek?.(beat);
    this.redraw();
  }

  _pointerUp(e) {
    const drag = this._dragging;
    this._dragging = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (!drag) return;
    if (drag.type === "seek") {
      this.canvas.style.cursor = "pointer";
      return;
    }
    if (drag.type === "pan") {
      this.canvas.style.cursor = "grab";
      return;
    }
    if (drag.changed) {
      this._pushHistory(drag.before);
      this._emitSelection();
      this._afterMutation(drag.type === "resize" ? "duration" : "move");
      this.onStatus?.(drag.type === "resize" ? "已修改时值" : "已移动音符");
    }
    this.canvas.style.cursor = drag.type === "resize" ? "ew-resize" : "grab";
  }

  _doubleClick(e) {
    if (!this.score) return;
    const { x, y } = this._pos(e);
    if (x < this.leftWidth || y < this.rulerH) return;
    if (this._hitTest(x, y)) return;
    const beat = Math.max(0, snap(this._beatAt(x), 0.25));
    const midi = this._pitchAt(y);
    const before = this._snapshot();
    const note = {
      id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      midi,
      start: beat,
      duration: this.newDuration,
      hand: this.activeHand,
      velocity: this.activeHand === "L" ? 0.58 : 0.76,
      confidence: 1,
    };
    this.score.notes.push(note);
    this.selectedId = note.id;
    this._pushHistory(before);
    this._emitSelection();
    this._afterMutation("add");
    this.onPreview?.(midi, 0.7, note.velocity);
    this.onStatus?.("已添加音符，可拖动调整");
  }

  _wheel(e) {
    if (!this.score) return;
    e.preventDefault();
    if (e.ctrlKey) {
      this.ppb = clamp(this.ppb * (e.deltaY > 0 ? 0.92 : 1.08), 10, 120);
      this._computeScale();
      this.redraw();
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const delta = e.shiftKey ? e.deltaY : e.deltaX;
      this.scrollX = clamp(this.scrollX + delta / this.ppb, 0, this.maxScrollX);
    } else {
      this.scrollY = clamp(this.scrollY + e.deltaY, 0, this.maxScrollY);
    }
    this.redraw();
  }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._draw();
    });
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx || !this.w || !this.h || !this.score) return;
    const { w, h, leftWidth, rulerH, rowH, high, low, ppb } = this;
    const mb = measureBeats(this.score);
    ctx.clearRect(0, 0, w, h);

    // Background.
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#15110e");
    bg.addColorStop(1, "#100d0b");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Pitch rows.
    for (let midi = low; midi <= high; midi++) {
      const y = rulerH + (high - midi) * rowH - this.scrollY;
      if (y < rulerH - rowH || y > h) continue;
      const black = isBlackKey(midi);
      if (black) {
        ctx.fillStyle = "rgba(0,0,0,.16)";
        ctx.fillRect(leftWidth, y, w - leftWidth, rowH);
      }
      if (midi % 12 === 0) {
        ctx.fillStyle = "rgba(231,172,91,.045)";
        ctx.fillRect(leftWidth, y, w - leftWidth, rowH);
        ctx.strokeStyle = "rgba(238,222,199,.08)";
        ctx.beginPath();
        ctx.moveTo(leftWidth, y + rowH + 0.5);
        ctx.lineTo(w, y + rowH + 0.5);
        ctx.stroke();
      }
    }

    // Vertical beat grid.
    const startBeat = Math.max(0, Math.floor(this.scrollX));
    const endBeat = this.scrollX + (w - leftWidth) / ppb;
    const gridStep = ppb >= 38 ? 0.25 : 0.5;
    for (let beat = Math.floor(startBeat / gridStep) * gridStep; beat <= endBeat; beat += gridStep) {
      const x = leftWidth + (beat - this.scrollX) * ppb;
      if (x < leftWidth) continue;
      const isMeasure = Math.abs(beat % mb) < 1e-6;
      const isWhole = Math.abs(beat - Math.round(beat)) < 1e-6;
      ctx.strokeStyle = isMeasure
        ? "rgba(238,222,199,.18)"
        : isWhole ? "rgba(238,222,199,.075)" : "rgba(238,222,199,.035)";
      ctx.lineWidth = isMeasure ? 1.2 : 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, rulerH);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }

    // Ruler.
    ctx.fillStyle = "rgba(19,15,12,.96)";
    ctx.fillRect(0, 0, w, rulerH);
    ctx.strokeStyle = "rgba(238,222,199,.1)";
    ctx.beginPath(); ctx.moveTo(0, rulerH + 0.5); ctx.lineTo(w, rulerH + 0.5); ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `500 8px "Cascadia Code",Consolas,monospace`;
    for (let beat = Math.floor(startBeat / mb) * mb; beat <= endBeat; beat += mb) {
      const x = leftWidth + (beat - this.scrollX) * ppb;
      if (x < leftWidth - 1) continue;
      const measure = Math.round(beat / mb) + 1;
      ctx.fillStyle = "rgba(231,172,91,.72)";
      ctx.fillRect(x, rulerH - 6, 1, 5);
      ctx.fillStyle = "rgba(194,181,164,.72)";
      ctx.fillText(String(measure), x + 5, rulerH - 9);
    }
    // Left corner.
    ctx.fillStyle = "rgba(19,15,12,.98)";
    ctx.fillRect(0, 0, leftWidth, rulerH);
    ctx.fillStyle = "rgba(143,130,114,.72)";
    ctx.font = `500 8px "Cascadia Code",Consolas,monospace`;
    ctx.textAlign = "right";
    ctx.fillText(`${this.score.timeSignature[0]}/${this.score.timeSignature[1]}`, leftWidth - 7, rulerH / 2 + 0.5);

    // Keyboard strip.
    ctx.fillStyle = "#0c0a08";
    ctx.fillRect(0, rulerH, leftWidth, h - rulerH);
    ctx.strokeStyle = "rgba(238,222,199,.1)";
    ctx.beginPath(); ctx.moveTo(leftWidth + 0.5, 0); ctx.lineTo(leftWidth + 0.5, h); ctx.stroke();
    for (let midi = low; midi <= high; midi++) {
      const y = rulerH + (high - midi) * rowH - this.scrollY;
      if (y < rulerH - rowH || y > h) continue;
      const black = isBlackKey(midi);
      const isC = midi % 12 === 0;
      // Keep the keyboard strip light but quiet.
      ctx.fillStyle = black ? "#201a16" : "#d9cbb8";
      ctx.fillRect(0, y + 0.4, leftWidth - (isC ? 4 : 9), rowH - 0.8);
      if (midi % 12 === 4 || midi % 12 === 11) {
        ctx.fillStyle = "rgba(0,0,0,.18)";
        ctx.fillRect(leftWidth - 7, y, 7, rowH);
      }
      if (isC) {
        ctx.fillStyle = "rgba(66,52,39,.85)";
        ctx.font = `600 ${clamp(rowH * 0.55, 6, 9)}px "Aptos","Segoe UI",sans-serif`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`C${midi / 12 - 1}`, leftWidth - 8, y + rowH / 2);
      }
    }

    // Notes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(leftWidth, rulerH, w - leftWidth, h - rulerH);
    ctx.clip();
    const selectedId = this.selectedId;
    for (const note of this.score.notes) {
      const rect = this._noteRect(note);
      if (rect.x + rect.w < leftWidth || rect.x > w || rect.y + rect.h < rulerH || rect.y > h) continue;
      const color = HAND_COLORS[note.hand] || HAND_COLORS.R;
      const selected = note.id === selectedId;
      const hover = note.id === this.hoverId;
      const lowConf = note.confidence != null && note.confidence < 0.55;
      const x = Math.max(rect.x, leftWidth);
      const y = Math.max(rect.y, rulerH);
      const ww = Math.max(3, rect.w - (rect.x < leftWidth ? leftWidth - rect.x : 0));
      const hh = Math.max(3, rect.h);
      const grad = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
      grad.addColorStop(0, `rgba(${color.light}, .95)`);
      grad.addColorStop(0.45, `rgba(${color.main}, .92)`);
      grad.addColorStop(1, `rgba(${color.dark}, .94)`);
      ctx.save();
      if (selected || hover) {
        ctx.shadowColor = `rgba(${color.main}, .55)`;
        ctx.shadowBlur = selected ? 13 : 7;
      }
      ctx.fillStyle = grad;
      roundRect(ctx, x, y, ww, Math.min(hh, h - y), 3);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = selected ? "rgba(255,247,232,.9)" : lowConf ? "rgba(239,135,104,.65)" : `rgba(${color.light}, .55)`;
      ctx.lineWidth = selected ? 1.4 : 0.8;
      roundRect(ctx, x + 0.5, y + 0.5, Math.max(1, ww - 1), Math.max(1, Math.min(hh, h - y) - 1), 3);
      ctx.stroke();
      if (lowConf) {
        ctx.fillStyle = "rgba(239,135,104,.9)";
        ctx.beginPath();
        ctx.arc(x + 3.3, y + 3.3, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (ww > 25 && hh >= 10) {
        ctx.fillStyle = "rgba(28,18,8,.72)";
        ctx.font = `600 ${clamp(hh * 0.58, 7, 10)}px "Aptos","Segoe UI",sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const label = noteName(note.midi);
        const maxChars = Math.max(2, Math.floor((ww - 7) / (hh * 0.5)));
        ctx.fillText(label.slice(0, maxChars), x + 4, y + hh / 2 + 0.5);
      }
      if (selected) {
        // Duration handle.
        const hx = x + ww - 3;
        ctx.fillStyle = "rgba(255,247,232,.75)";
        roundRect(ctx, hx, y + Math.min(5, hh * 0.22), 2.4, Math.max(3, hh - 10), 1.2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Playhead.
    if (this.playhead != null) {
      const x = leftWidth + (this.playhead - this.scrollX) * ppb;
      if (x >= leftWidth && x <= w) {
        const g = ctx.createLinearGradient(0, rulerH, 0, h);
        g.addColorStop(0, "rgba(247,236,218,.8)");
        g.addColorStop(1, "rgba(247,236,218,.14)");
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, rulerH);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
        ctx.fillStyle = "#f2e5d0";
        ctx.beginPath();
        ctx.moveTo(x - 3.5, rulerH - 6);
        ctx.lineTo(x + 4.5, rulerH - 6);
        ctx.lineTo(x + 0.5, rulerH);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Empty state.
    if (!this.score.notes.length) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(194,181,164,.55)";
      ctx.font = `500 12px "Aptos","Segoe UI",sans-serif`;
      ctx.fillText("双击网格添加第一个音符", leftWidth + (w - leftWidth) / 2, rulerH + (h - rulerH) / 2);
    }

    // Scroll hint.
    if (this.maxScrollX > 0.01) {
      const trackW = w - leftWidth - 24;
      const thumbW = Math.max(30, trackW * ((w - leftWidth) / ppb) / this.totalBeats);
      const thumbX = leftWidth + 12 + (trackW - thumbW) * (this.scrollX / this.maxScrollX);
      ctx.fillStyle = "rgba(238,222,199,.07)";
      roundRect(ctx, leftWidth + 12, h - 5, trackW, 2, 2);
      ctx.fill();
      ctx.fillStyle = "rgba(238,222,199,.22)";
      roundRect(ctx, thumbX, h - 5, thumbW, 2, 2);
      ctx.fill();
    }
  }

  destroy() {
    this._resizeObserver.disconnect();
    cancelAnimationFrame(this._raf);
  }
}
