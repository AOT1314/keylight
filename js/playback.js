/* Transport + look-ahead scheduler. One source of truth for the playhead,
   so the canvas, progress bar and audio all stay in sync. */

import { clamp, measureBeats } from "./util.js";
import { scoreEndBeat } from "./model.js";

export class Playback {
  constructor(engine) {
    this.engine = engine;
    this.score = null;
    this.state = "stopped"; // stopped | playing | paused
    this.positionBeat = 0;
    this.speed = 0.8;
    this.hands = "both";
    this.metronome = false;
    this.loop = false;
    this.voices = [];
    this.timer = 0;
    this._ticker = 0;
    this.onStateChange = null;
    this.onTime = null;
    this.onEnded = null;
    this.onCountIn = null;
    this._lastCount = undefined;
  }

  load(score) {
    this.stop();
    this.score = score;
    this.positionBeat = 0;
    this.totalBeat = scoreEndBeat(score);
    this.loopRange = null;
    this._emitTime();
  }

  updateScore(score) {
    const wasPlaying = this.state === "playing";
    const beat = this.getPosition();
    this.score = score;
    this.totalBeat = scoreEndBeat(score);
    this.positionBeat = clamp(beat, 0, this.totalBeat);
    if (wasPlaying) this._restartAt(this.positionBeat, false);
  }

  get beatSeconds() {
    if (!this.score) return 0.7;
    return 60 / (this.score.tempo * this.speed);
  }

  get isPlaying() {
    return this.state === "playing";
  }

  get isCountingIn() {
    return this.state === "playing" && this.engine.ctx && this.engine.ctx.currentTime < this.musicStartTime;
  }

  async play(fromBeat = null, { countIn = false } = {}) {
    if (!this.score || !this.score.notes.length) return false;
    const ok = await this.engine.resume();
    if (!ok) return false;
    const start = clamp(fromBeat == null ? this.positionBeat : fromBeat, 0, Math.max(0, this.totalBeat - 0.01));
    if (this.state === "playing") return true;
    const wasPaused = this.state === "paused";
    this.state = "playing";
    const now = this.engine.now;
    const beatSec = this.beatSeconds;
    this.startBeat = start;
    this._useCountIn = Boolean(countIn && start < 0.01 && !wasPaused);
    const countBeats = this._useCountIn ? Math.min(4, Math.max(2, this.score.timeSignature[0])) : 0;
    this.countInBeats = countBeats;
    this.musicStartTime = now + 0.09 + countBeats * beatSec;
    this.scheduleCursor = start;
    this.nextClickBeat = Math.ceil(start - 1e-6);
    this.noteIndex = this._firstNoteIndex(start);
    this.voices = [];
    this._lastCount = undefined;

    if (countBeats) {
      for (let i = 0; i < countBeats; i++) {
        this.engine.click(i === 0, now + 0.09 + i * beatSec);
      }
    }
    this._schedule(now);
    this._startTicker();
    this._emitState();
    return true;
  }

  async toggle({ countIn = true } = {}) {
    if (this.state === "playing") {
      this.pause();
      return false;
    }
    return this.play(null, { countIn });
  }

  pause() {
    if (this.state !== "playing") return;
    const pos = this.getPosition();
    this.positionBeat = clamp(pos, 0, this.totalBeat);
    this.state = "paused";
    clearInterval(this.timer);
    clearInterval(this._ticker);
    this.engine.stopAll();
    this.voices = [];
    this._setCountIn(null);
    this._emitState();
    this._emitTime();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this._ticker);
    this.engine.stopAll();
    this.voices = [];
    this.state = "stopped";
    this.positionBeat = 0;
    this._setCountIn(null);
    this._emitState();
    this._emitTime();
  }

  restart({ play = false } = {}) {
    const wasPlaying = this.state === "playing";
    this.positionBeat = 0;
    this.loopRange = null;
    this.engine.stopAll();
    clearInterval(this.timer);
    clearInterval(this._ticker);
    if (play || wasPlaying) {
      this.state = "stopped";
      this.play(0, { countIn: true });
    } else {
      this.state = "paused";
      this._emitState();
      this._emitTime();
    }
  }

  seek(beat, { preserve = true } = {}) {
    const wasPlaying = this.state === "playing";
    const target = clamp(beat, 0, Math.max(0, this.totalBeat - 0.008));
    this.positionBeat = target;
    if (this.loop) {
      const mb = measureBeats(this.score);
      const start = Math.floor(target / mb + 1e-9) * mb;
      this.loopRange = { start, end: Math.min(start + mb, this.totalBeat) };
    }
    if (wasPlaying && preserve) {
      this._restartAt(target, false);
    } else if (wasPlaying) {
      this.pause();
      this.positionBeat = target;
      this._emitTime();
    } else {
      this._emitTime();
    }
  }

  setSpeed(speed) {
    const next = clamp(Number(speed) || 0.8, 0.25, 2);
    if (Math.abs(next - this.speed) < 1e-4) return;
    this.speed = next;
    if (this.state === "playing") {
      const beat = this.getPosition();
      this._restartAt(beat, false);
    } else {
      this._emitTime();
    }
  }

  setHands(hands) {
    if (hands !== "both" && hands !== "R" && hands !== "L") hands = "both";
    if (hands === this.hands) return;
    this.hands = hands;
    if (this.state === "playing") {
      const beat = this.getPosition();
      this._restartAt(beat, false);
    }
  }

  setMetronome(on) {
    this.metronome = Boolean(on);
    if (this.state === "playing" && this.engine.ctx) {
      this.nextClickBeat = Math.ceil(this.getPosition() - 1e-6);
    }
  }

  setLoop(on) {
    this.loop = Boolean(on);
    if (this.loop) {
      const mb = measureBeats(this.score);
      const pos = this.getPosition();
      const start = Math.floor(pos / mb + 1e-9) * mb;
      this.loopRange = { start, end: Math.min(start + mb, this.totalBeat) };
    } else {
      this.loopRange = null;
    }
    if (this.state === "playing") {
      const beat = this.getPosition();
      this._restartAt(beat, false);
    }
  }

  get loopMeasureNumber() {
    if (!this.loopRange || !this.score) return 1;
    return Math.floor(this.loopRange.start / measureBeats(this.score) + 1e-9) + 1;
  }

  getPosition() {
    if (!this.score) return 0;
    if (this.state === "playing") {
      if (!this.engine.ctx) return this.startBeat;
      const now = this.engine.ctx.currentTime;
      if (now < this.musicStartTime) return this.startBeat;
      let pos = this.startBeat + (now - this.musicStartTime) / this.beatSeconds;
      if (this.loopRange) pos = Math.min(pos, this.loopRange.end);
      return clamp(pos, 0, this.totalBeat);
    }
    return clamp(this.positionBeat, 0, this.totalBeat);
  }

  get countInRemaining() {
    if (!this.isCountingIn) return 0;
    const remain = (this.musicStartTime - this.engine.ctx.currentTime) / this.beatSeconds;
    return clamp(Math.ceil(remain - 0.08), 1, this.countInBeats || 4);
  }

  _firstNoteIndex(beat) {
    if (!this.score) return 0;
    const notes = this._notesForHands();
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].start < beat - 1e-6) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _notesForHands() {
    if (!this.score) return [];
    if (this.hands === "both") return this.score.notes;
    return this.score.notes.filter((n) => n.hand === this.hands);
  }

  _startTicker() {
    clearInterval(this.timer);
    clearInterval(this._ticker);
    this.timer = setInterval(() => this._tick(), 32);
    this._ticker = setInterval(() => this._emitTime(), 90);
  }

  _schedule(now = this.engine.now) {
    if (this.state !== "playing" || !this.score) return;
    const horizon = now + 0.26;
    const horizonBeat = this.startBeat + (horizon - this.musicStartTime) / this.beatSeconds;
    const notes = this._notesForHands();
    const loopEnd = this.loopRange ? this.loopRange.end : this.totalBeat;
    const limit = Math.min(horizonBeat, loopEnd - 0.001);

    while (this.noteIndex < notes.length) {
      const note = notes[this.noteIndex];
      if (note.start < this.startBeat - 1e-6) {
        this.noteIndex++;
        continue;
      }
      if (note.start > limit) break;
      const when = this.musicStartTime + (note.start - this.startBeat) * this.beatSeconds;
      if (when >= now - 0.01) {
        const durSec = Math.max(0.1, note.duration * this.beatSeconds * 0.98);
        const voice = this.engine.playNote(note.midi, note.velocity, when, durSec);
        if (voice) this.voices.push(voice);
      }
      this.noteIndex++;
    }

    if (this.metronome) {
      const mb = measureBeats(this.score);
      while (this.nextClickBeat <= limit + 1e-6) {
        const beat = this.nextClickBeat;
        const when = this.musicStartTime + (beat - this.startBeat) * this.beatSeconds;
        if (when >= now - 0.01) {
          const accent = Math.abs(beat % mb) < 1e-6;
          this.engine.click(accent, when);
        }
        this.nextClickBeat += 1;
      }
    }
  }

  _tick() {
    if (this.state !== "playing" || !this.engine.ctx) return;
    const now = this.engine.ctx.currentTime;
    if (now >= this.musicStartTime) {
      this._schedule(now);
      this._setCountIn(null);
    } else {
      this._setCountIn(this.countInRemaining);
    }
    const pos = this.getPosition();
    if (this.loopRange && pos >= this.loopRange.end - 0.012) {
      this._restartAt(this.loopRange.start, false);
      return;
    }
    if (!this.loopRange && pos >= this.totalBeat - 0.015) {
      this._finish();
    }
  }

  _finish() {
    clearInterval(this.timer);
    clearInterval(this._ticker);
    this.engine.stopAll();
    this.voices = [];
    this.state = "paused";
    this.positionBeat = this.totalBeat;
    this._setCountIn(null);
    this._emitState();
    this._emitTime();
    this.onEnded?.();
  }

  _restartAt(beat, countIn = false) {
    clearInterval(this.timer);
    clearInterval(this._ticker);
    this.engine.stopAll();
    this.voices = [];
    this.state = "stopped";
    this.positionBeat = clamp(beat, 0, this.totalBeat);
    if (this.state === "stopped") {
      this.play(this.positionBeat, { countIn }).catch(() => {});
    }
  }

  _setCountIn(value) {
    if (value === this._lastCount) return;
    this._lastCount = value;
    this.onCountIn?.(value);
  }

  _emitState() {
    this.onStateChange?.(this.state);
  }

  _emitTime() {
    if (!this.score) return;
    this.onTime?.(this.getPosition(), this.totalBeat);
  }

  destroy() {
    this.stop();
    this.score = null;
  }
}
