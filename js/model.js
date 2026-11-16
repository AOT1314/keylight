/* Score model, demo pieces and import parsers. */

import {
  clamp, uid, measureBeats as measureBeatsOf, noteName, parseTimeSignature,
  JIANPU_KEYS, keyLabelFor, normalizeFifths, NOTE_NAMES,
} from "./util.js";

export const APP_SCORE_VERSION = 1;

export function measureBeats(score) {
  return measureBeatsOf(score.timeSignature);
}

export function createScore(overrides = {}) {
  const now = Date.now();
  const score = {
    id: uid("score"),
    title: "未命名琴谱",
    composer: "",
    tempo: 84,
    timeSignature: [4, 4],
    keyFifths: 0,
    notes: [],
    measures: 1,
    source: { type: "manual", image: null, fileName: "" },
    quality: null,
    createdAt: now,
    updatedAt: now,
    version: APP_SCORE_VERSION,
    ...overrides,
  };
  return normalizeScore(score);
}

export function normalizeScore(score) {
  const seen = new Set();
  score.timeSignature = parseTimeSignature(Array.isArray(score.timeSignature) ? score.timeSignature.join("/") : score.timeSignature);
  const mb = measureBeats(score);
  score.tempo = clamp(Number(score.tempo) || 84, 30, 240);
  score.keyFifths = normalizeFifths(score.keyFifths);
  score.notes = (Array.isArray(score.notes) ? score.notes : [])
    .filter((n) => n && Number.isFinite(Number(n.midi)) && Number.isFinite(Number(n.start)))
    .map((n) => {
      let id = n.id || uid("n");
      if (seen.has(id)) id = uid("n");
      seen.add(id);
      return {
        id,
        midi: clamp(Math.round(Number(n.midi)), 12, 120),
        start: Math.max(0, Number(n.start) || 0),
        duration: Math.max(0.0625, Number(n.duration) || 1),
        hand: n.hand === "L" ? "L" : "R",
        velocity: clamp(Number(n.velocity) || 0.76, 0.15, 1),
        confidence: n.confidence == null ? 1 : clamp(Number(n.confidence), 0, 1),
        ...(n.source ? { source: n.source } : {}),
      };
    })
    .sort((a, b) => a.start - b.start || b.midi - a.midi);
  const maxEnd = score.notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
  const minMeasures = Math.max(1, Math.ceil((maxEnd - 1e-6) / mb));
  score.measures = Math.max(Number(score.measures) || 1, minMeasures, 1);
  score.updatedAt = score.updatedAt || Date.now();
  score.createdAt = score.createdAt || Date.now();
  return score;
}

export function scoreEndBeat(score, includeMeasures = true) {
  const lastNote = score.notes.reduce((m, n) => Math.max(m, n.start + n.duration), 0);
  const lastMeasure = (includeMeasures ? score.measures : 0) * measureBeats(score);
  return Math.max(lastNote, lastMeasure);
}

export function scoreDuration(score) {
  return (scoreEndBeat(score) / 60) * score.tempo;
}

export function noteMeasure(note, score) {
  return Math.floor(note.start / measureBeats(score) + 1e-9) + 1;
}

export function scoreStats(score) {
  const right = score.notes.filter((n) => n.hand === "R").length;
  const left = score.notes.length - right;
  return {
    notes: score.notes.length,
    right,
    left,
    measures: score.measures,
    duration: scoreDuration(score),
    range: score.notes.reduce((r, n) => {
      r.lo = Math.min(r.lo, n.midi);
      r.hi = Math.max(r.hi, n.midi);
      return r;
    }, { lo: 127, hi: 0 }),
  };
}

export function metaLine(score) {
  const [n, d] = score.timeSignature;
  return `${keyLabelFor(score.keyFifths, score.keyFifths < 0)} · ${n}/${d} · ♩=${score.tempo}`;
}

export function cloneScore(score) {
  return normalizeScore(JSON.parse(JSON.stringify(score)));
}

/* ───────────────────────── demo scores ───────────────────────── */

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function pitchToMidi(name) {
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`无法识读音高: ${name}`);
  const base = PITCH_CLASS[m[1].toUpperCase()];
  const alt = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + alt;
}

function melody(events, hand = "R", start = 0) {
  const notes = [];
  let cursor = start;
  for (const ev of events) {
    const [pitch, dur = 1, velocity = 0.76] = ev;
    if (pitch) notes.push({ midi: typeof pitch === "number" ? pitch : pitchToMidi(pitch), start: cursor, duration: dur, hand, velocity });
    cursor += dur;
  }
  return notes;
}

function chord(pitches, start, duration, hand = "L", velocity = 0.62) {
  return pitches.map((p) => ({ midi: typeof p === "number" ? p : pitchToMidi(p), start, duration, hand, velocity }));
}

function buildTwinkle() {
  const melodyEvents = [
    ["C4", 1], ["C4", 1], ["G4", 1], ["G4", 1],
    ["A4", 1], ["A4", 1], ["G4", 2],
    ["F4", 1], ["F4", 1], ["E4", 1], ["E4", 1],
    ["D4", 1], ["D4", 1], ["C4", 2],
    ["G4", 1], ["G4", 1], ["F4", 1], ["F4", 1],
    ["E4", 1], ["E4", 1], ["D4", 2],
    ["G4", 1], ["G4", 1], ["F4", 1], ["F4", 1],
    ["E4", 1], ["E4", 1], ["D4", 2],
    ["C4", 1], ["C4", 1], ["G4", 1], ["G4", 1],
    ["A4", 1], ["A4", 1], ["G4", 2],
    ["F4", 1], ["F4", 1], ["E4", 1], ["E4", 1],
    ["D4", 1], ["D4", 1], ["C4", 2],
  ];
  const notes = melody(melodyEvents, "R", 0);
  const chords = [
    ["C3", "G3"], ["F3", "C4"], ["C3", "G3"], ["G3", "D4"],
    ["C3", "G3"], ["F3", "C4"], ["C3", "G3"], ["G3", "D4"],
    ["C3", "G3"], ["F3", "C4"], ["C3", "G3"], ["G3", "D4"],
  ];
  chords.forEach((p, i) => notes.push(...chord(p, i * 4, 4, "L", 0.55)));
  return createScore({
    title: "小星星",
    composer: "法国民谣",
    tempo: 88,
    keyFifths: 0,
    notes,
    measures: 12,
    source: { type: "demo" },
    quality: { confidence: 1, warnings: [] },
  });
}

function buildOde() {
  const notes = [];
  const phrases = [
    [["E4", 1], ["E4", 1], ["F4", 1], ["G4", 1]],
    [["G4", 1], ["F4", 1], ["E4", 1], ["D4", 1]],
    [["C4", 1], ["C4", 1], ["D4", 1], ["E4", 1]],
    [["E4", 1.5], ["D4", .5], ["D4", 2]],
    [["E4", 1], ["E4", 1], ["F4", 1], ["G4", 1]],
    [["G4", 1], ["F4", 1], ["E4", 1], ["D4", 1]],
    [["C4", 1], ["C4", 1], ["D4", 1], ["E4", 1]],
    [["D4", 1.5], ["C4", .5], ["C4", 2]],
  ];
  phrases.forEach((p, i) => notes.push(...melody(p, "R", i * 4)));
  const chords = ["C3", "G3", "C3", "G3", "C3", "G3", "F3", "C3"];
  chords.forEach((root, i) => {
    const r = pitchToMidi(root);
    notes.push(...chord([r, r + 7], i * 4, 4, "L", 0.5));
  });
  return createScore({
    title: "欢乐颂",
    composer: "贝多芬",
    tempo: 96,
    keyFifths: 0,
    notes,
    measures: 8,
    source: { type: "demo" },
    quality: { confidence: 1, warnings: [] },
  });
}

function buildCanon() {
  const notes = [];
  const lhPattern = [
    ["D3", "A3", "D4", "F#4", "A4", "F#4", "D4", "A3"],
    ["A2", "E3", "A3", "C#4", "E4", "C#4", "A3", "E3"],
    ["B2", "F#3", "B3", "D4", "F#4", "D4", "B3", "F#3"],
    ["F#2", "C#3", "F#3", "A3", "C#4", "A3", "F#3", "C#3"],
    ["G2", "D3", "G3", "B3", "D4", "B3", "G3", "D3"],
    ["D3", "A3", "D4", "F#4", "A4", "F#4", "D4", "A3"],
    ["G2", "D3", "G3", "B3", "D4", "B3", "G3", "D3"],
    ["A2", "E3", "A3", "C#4", "E4", "C#4", "A3", "E3"],
  ];
  const rhPattern = [
    ["F#5", "E5", "D5", "C#5", "B4", "A4", "B4", "C#5"],
    ["D5", "C#5", "B4", "A4", "G4", "F#4", "G4", "A4"],
    ["B4", "A4", "G4", "F#4", "E4", "D4", "E4", "F#4"],
    ["A4", "G4", "F#4", "E4", "D4", "C#4", "D4", "E4"],
    ["G4", "F#4", "E4", "D4", "C#4", "B3", "C#4", "D4"],
    ["F#4", "E4", "D4", "C#4", "B3", "A3", "B3", "C#4"],
    ["G4", "B4", "D5", "B4", "G4", "B4", "D5", "B4"],
    ["A4", "C#5", "E5", "C#5", "A4", "C#5", "E5", "C#5"],
  ];
  for (let bar = 0; bar < 8; bar++) {
    lhPattern[bar].forEach((p, i) => notes.push({
      midi: pitchToMidi(p), start: bar * 4 + i * 0.5, duration: 0.48, hand: "L", velocity: 0.48,
    }));
    rhPattern[bar].forEach((p, i) => notes.push({
      midi: pitchToMidi(p), start: bar * 4 + i * 0.5, duration: 0.46, hand: "R", velocity: 0.72,
    }));
  }
  return createScore({
    title: "卡农练习",
    composer: "帕赫贝尔和声 · 练习编配",
    tempo: 74,
    keyFifths: 2,
    notes,
    measures: 8,
    source: { type: "demo" },
    quality: { confidence: 1, warnings: [] },
  });
}

export function getDemoScore(id) {
  if (id === "ode") return buildOde();
  if (id === "canon") return buildCanon();
  return buildTwinkle();
}

export function demoScoreList() {
  return [
    { id: "twinkle", title: "小星星", desc: "法国民谣", level: "入门", score: buildTwinkle() },
    { id: "ode", title: "欢乐颂", desc: "贝多芬", level: "入门", score: buildOde() },
    { id: "canon", title: "卡农练习", desc: "帕赫贝尔和声", level: "进阶", score: buildCanon() },
  ];
}

/* ───────────────────────── jianpu parser ───────────────────────── */

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

export function jianpuToScore(rightText, leftText, options = {}) {
  const keyName = options.key || "C";
  const key = JIANPU_KEYS[keyName] || JIANPU_KEYS.C;
  const timeSignature = parseTimeSignature(options.time || "4/4");
  const tempo = clamp(Number(options.tempo) || 84, 30, 220);
  const result = parseJianpuLine(rightText, { ...options, key, timeSignature, hand: "R" });
  const left = parseJianpuLine(leftText, { ...options, key, timeSignature, hand: "L" });
  const notes = [...result.notes, ...left.notes];
  if (!notes.length) {
    throw new Error("没有解析到音符。请至少输入 1–7 中的数字。");
  }
  const measures = Math.max(result.measures, left.measures, 1);
  return createScore({
    title: options.title || "简谱速记",
    composer: options.composer || "",
    tempo,
    timeSignature,
    keyFifths: keyFifthsForKeyName(keyName),
    notes,
    measures,
    source: { type: "jianpu" },
    quality: { confidence: 0.98, warnings: result.warnings },
  });
}

function keyFifthsForKeyName(keyName) {
  return { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1, Bb: -2, Eb: -3, Ab: -4 }[keyName] ?? 0;
}

function normalizeJianpu(text) {
  return String(text || "")
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[｜丨]/g, "|")
    .replace(/[＿]/g, "_")
    .replace(/[’‘`]/g, "'")
    .replace(/[，]/g, ",")
    .replace(/[．]/g, ".")
    .replace(/[－—–]/g, "-")
    .replace(/[♯]/g, "#")
    .replace(/[♭]/g, "b")
    .replace(/\r/g, "\n");
}

function parseJianpuLine(text, opts) {
  const raw = normalizeJianpu(text);
  if (!raw.trim()) return { notes: [], measures: 0, warnings: [] };
  const beatLen = (opts.timeSignature[0] * 4) / opts.timeSignature[1];
  const tokens = raw
    .replace(/([0-7])([',]*)([_]*)(\.?)(~?)/g, " $1$2$3$4$5 ")
    .replace(/([#b])\s+([0-7])/g, "$1$2")
    .replace(/(\|+)/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);

  const notes = [];
  const warnings = [];
  let cursor = 0;
  let barStart = 0;
  let lastNoteGroup = null;
  let lastWasRest = false;
  let lastTie = null;
  let measureCount = 0;

  const commitMeasure = (force = false) => {
    const used = cursor - barStart;
    if (used > 1e-6 || force) measureCount = Math.max(measureCount, Math.floor(cursor / beatLen + 1e-9) + 1);
    if (!force && used > 1e-6) {
      const over = used % beatLen;
      if (over > 1e-6 && beatLen - over > 1e-6) {
        cursor = barStart + Math.ceil(used / beatLen - 1e-9) * beatLen;
      }
    }
    barStart = cursor;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\|+$/.test(token)) {
      commitMeasure();
      lastNoteGroup = null;
      lastWasRest = false;
      continue;
    }
    if (token === "-") {
      if (lastNoteGroup && !lastWasRest) {
        for (const n of lastNoteGroup) n.duration += 1;
      }
      cursor += 1;
      if (cursor - barStart > beatLen + 1e-6) {
        cursor = barStart + Math.ceil((cursor - barStart) / beatLen - 1e-9) * beatLen;
        barStart = cursor;
      }
      continue;
    }
    if (token === ".") continue;
    if (token === "~") continue;

    const chordParts = token.split("+").filter(Boolean);
    if (!chordParts.length) continue;
    let start = cursor;
    let groupDuration = 0;
    let anyNote = false;
    const group = [];

    for (let ci = 0; ci < chordParts.length; ci++) {
      const part = chordParts[ci];
      const m = /^([#b]?)([0-7])([',]*)([_]*)(\.?)(~?)$/.exec(part);
      if (!m) {
        warnings.push(`无法解析 "${part}"，已跳过`);
        continue;
      }
      const [, accidental, degreeStr, octaveMarks, underlines, dotted] = m;
      const degree = Number(degreeStr);
      let dur = Math.pow(2, -underlines.length) * (dotted ? 1.5 : 1);
      if (underlines.length > 3) dur = Math.pow(2, -3);
      if (ci === 0) groupDuration = dur;
      if (degree === 0) {
        anyNote = false;
        continue;
      }
      anyNote = true;
      const octaveShift = (octaveMarks.match(/'/g) || []).length - (octaveMarks.match(/,/g) || []).length;
      const tonicMidi = 60 + opts.key.tonic;
      let midi = tonicMidi + MAJOR_STEPS[degree - 1] + octaveShift * 12;
      if (accidental === "#") midi += 1;
      if (accidental === "b") midi -= 1;
      // Keep notes in the piano range by octave displacement.
      while (midi < 21) midi += 12;
      while (midi > 108) midi -= 12;
      const note = {
        midi, start, duration: dur, hand: opts.hand, velocity: opts.hand === "L" ? 0.58 : 0.74,
        confidence: 0.99,
      };
      notes.push(note);
      group.push(note);
    }
    if (!anyNote) {
      lastWasRest = true;
      lastNoteGroup = null;
    } else {
      lastWasRest = false;
      lastNoteGroup = group;
      lastTie = null;
    }
    const step = groupDuration || 1;
    cursor += step;
    if (!anyNote) lastNoteGroup = null;
  }

  if (cursor > 0) {
    measureCount = Math.max(measureCount, Math.floor(cursor / beatLen + 1e-9) + (cursor % beatLen > 1e-6 ? 1 : 0), 1);
  }
  // Merge simple tildes that survived tokenisation (e.g. "1~").
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].includes("~")) continue;
    const m = /^([#b]?)([0-7])([',]*)([_]*)(\.?)~$/.exec(tokens[i]);
    if (!m) continue;
  }
  return { notes, measures: measureCount, warnings: [...new Set(warnings)].slice(0, 4) };
}

/* ───────────────────────── MusicXML ───────────────────────── */

function child(node, name) {
  return Array.from(node.children || []).find((c) => c.localName === name);
}
function children(node, name) {
  return Array.from(node.children || []).filter((c) => c.localName === name);
}
function textOf(node, name, fallback = "") {
  const c = child(node, name);
  return c ? c.textContent.trim() : fallback;
}
function num(node, name, fallback = 0) {
  const v = Number(textOf(node, name, ""));
  return Number.isFinite(v) ? v : fallback;
}

export function musicXmlToScore(xmlText, fileName = "") {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("MusicXML 文件格式无法解析，请确认文件没有损坏。");
  const root = doc.documentElement;
  if (!root || root.localName !== "score-partwise") {
    throw new Error("目前只支持 score-partwise 格式的 MusicXML。请从制谱软件重新导出。");
  }

  const title = textOf(root, "movement-title") || textOf(child(root, "work") || root, "work-title") || "MusicXML 导入";
  let composer = "";
  const identification = child(root, "identification");
  if (identification) {
    for (const creator of children(identification, "creator")) {
      if (creator.getAttribute("type") === "composer") composer = creator.textContent.trim();
    }
  }

  const parts = children(root, "part");
  if (!parts.length) throw new Error("MusicXML 中没有找到声部。");

  let globalDivisions = 1;
  let tempo = 84;
  let timeSignature = [4, 4];
  let keyFifths = 0;
  let globalMeasures = 0;
  const allParts = [];

  for (const part of parts) {
    const partNotes = [];
    let divisions = globalDivisions;
    let cursor = 0;
    let lastStart = 0;
    let previousStart = 0;
    let localMeasures = 0;
    const tieOpen = new Map();
    const staffSet = new Set();

    for (const measure of children(part, "measure")) {
      localMeasures++;
      const attrs = child(measure, "attributes");
      if (attrs) {
        const d = child(attrs, "divisions");
        if (d) {
          divisions = Number(d.textContent) || 1;
          globalDivisions = divisions;
        }
        const key = child(attrs, "key");
        if (key && !keyFifths) keyFifths = num(key, "fifths", 0);
        const time = child(attrs, "time");
        if (time) {
          const beats = num(time, "beats", 4);
          const beatType = num(time, "beat-type", 4);
          if (beats && beatType) timeSignature = [beats, beatType];
        }
      }
      let measureCursor = cursor;
      cursor = measureCursor;
      for (const el of Array.from(measure.children)) {
        if (el.localName === "sound" && el.getAttribute("tempo")) {
          tempo = clamp(Number(el.getAttribute("tempo")) || tempo, 30, 240);
        }
        if (el.localName === "direction") {
          const sound = child(el, "sound");
          if (sound && sound.getAttribute("tempo")) tempo = clamp(Number(sound.getAttribute("tempo")), 30, 240);
          const metro = child(child(el, "direction-type") || el, "metronome");
          if (metro) {
            const perMinute = num(metro, "per-minute", 0);
            if (perMinute) tempo = clamp(perMinute, 30, 240);
          }
        }
        if (el.localName === "backup") {
          cursor -= num(el, "duration", 0) / divisions;
          continue;
        }
        if (el.localName === "forward") {
          cursor += num(el, "duration", 0) / divisions;
          continue;
        }
        if (el.localName !== "note") continue;
        const isGrace = Boolean(child(el, "grace"));
        const durationDiv = num(el, "duration", 0);
        const dur = durationDiv / divisions;
        const isChord = Boolean(child(el, "chord"));
        const voice = textOf(el, "voice", "1");
        const staff = Number(textOf(el, "staff", "1")) || 1;
        staffSet.add(staff);
        const start = isChord ? lastStart : cursor;
        if (!isChord) {
          previousStart = start;
          lastStart = start;
          cursor += dur;
        }
        if (isGrace) continue;
        const rest = child(el, "rest");
        if (rest) continue;
        const pitch = child(el, "pitch");
        if (!pitch) continue;
        const step = textOf(pitch, "step", "C").toUpperCase();
        const alter = num(pitch, "alter", 0);
        const octave = num(pitch, "octave", 4);
        const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step];
        if (pc == null) continue;
        let midi = (octave + 1) * 12 + pc + alter;
        if (midi < 0 || midi > 127) continue;
        const tieEls = children(el, "tie");
        const tieStop = tieEls.some((t) => t.getAttribute("type") === "stop");
        const tieStart = tieEls.some((t) => t.getAttribute("type") === "start");
        const tieKey = `${part.getAttribute("id")}|${staff}|${voice}|${midi}`;
        if (tieStop && tieOpen.has(tieKey)) {
          const prev = tieOpen.get(tieKey);
          prev.duration = Math.max(prev.duration, start + dur - prev.start);
          if (tieStart) tieOpen.set(tieKey, prev);
          else tieOpen.delete(tieKey);
          continue;
        }
        const note = {
          midi,
          start,
          duration: Math.max(0.0625, dur || 0.25),
          hand: "R",
          staff,
          velocity: clamp(0.47 + (Number(el.getAttribute("velocity")) || 0) / 220, 0.45, 0.9),
          confidence: 1,
        };
        partNotes.push(note);
        if (tieStart) tieOpen.set(tieKey, note);
        if (!isChord) {
          // Keep note cursors in sync even when previous notes are grace notes.
          cursor = Math.max(cursor, measureCursor + (start - measureCursor) + dur);
        }
      }
      // Honour an explicit measure length when bars are short due to voices.
      const expected = (timeSignature[0] * 4) / timeSignature[1];
      if (cursor < measureCursor + expected - 1e-4 && !partNotes.length) cursor = measureCursor + expected;
      cursor = Math.max(cursor, measureCursor + expected);
    }
    globalMeasures = Math.max(globalMeasures, localMeasures);
    allParts.push({ notes: partNotes, avg: partNotes.reduce((s, n) => s + n.midi, 0) / Math.max(1, partNotes.length), staffSet: [...staffSet] });
  }

  const noteParts = allParts.filter((p) => p.notes.length);
  if (!noteParts.length) throw new Error("MusicXML 中没有可播放的音符。");
  noteParts.forEach((part, idx) => {
    const twoStaves = part.staffSet.includes(2);
    let partHand = "R";
    if (!twoStaves && noteParts.length > 1) {
      partHand = part.avg < 60 ? "L" : idx === 0 ? "R" : "L";
    }
    for (const n of part.notes) {
      // A single piano part with two staves is the most common MusicXML
      // layout. Use the staff number, not the part, to choose the hand.
      n.hand = twoStaves ? (Number(n.staff) === 2 ? "L" : "R") : partHand;
      delete n.staff;
    }
  });
  const notes = noteParts.flatMap((p) => p.notes);

  return createScore({
    title: title || "MusicXML 导入",
    composer,
    tempo,
    timeSignature,
    keyFifths,
    notes,
    measures: Math.max(1, globalMeasures),
    source: { type: "musicxml", fileName },
    quality: { confidence: 0.96, warnings: ["左右手根据谱表/声部自动分配，可在校对页调整。"] },
  });
}

/* ───────────────────────── MIDI ───────────────────────── */

function readVarInt(view, state) {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const byte = view.getUint8(state.pos++);
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return value;
}

function decodeText(bytes) {
  try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); } catch { return ""; }
}

export function midiToScore(arrayBuffer, fileName = "") {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 14) throw new Error("MIDI 文件太小或已损坏。");
  const headerId = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (headerId !== "MThd") throw new Error("这不是标准 MIDI 文件。");
  const headerLen = view.getUint32(4);
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12) || 480;
  if (view.getUint16(12) & 0x8000) throw new Error("暂不支持 SMPTE 时间格式的 MIDI。");

  let pos = 8 + headerLen;
  let tempo = 100;
  let timeSignature = [4, 4];
  let keyFifths = 0;
  let title = "";
  const tracks = [];

  for (let t = 0; t < trackCount && pos < view.byteLength; t++) {
    if (pos + 8 > view.byteLength) break;
    const id = String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
    const len = view.getUint32(pos + 4);
    const start = pos + 8;
    const end = Math.min(view.byteLength, start + len);
    pos = end;
    if (id !== "MTrk") continue;
    const state = { pos: start };
    let tick = 0;
    let running = 0;
    const active = new Map();
    const notes = [];
    while (state.pos < end) {
      tick += readVarInt(view, state);
      if (state.pos >= end) break;
      let status = view.getUint8(state.pos++);
      if (status === 0xff) {
        const type = view.getUint8(state.pos++);
        const metaLen = readVarInt(view, state);
        const metaStart = state.pos;
        state.pos += metaLen;
        if (type === 0x51 && metaLen >= 3) {
          const us = (view.getUint8(metaStart) << 16) | (view.getUint8(metaStart + 1) << 8) | view.getUint8(metaStart + 2);
          if (us > 0) tempo = clamp(Math.round(60000000 / us), 30, 240);
        } else if (type === 0x58 && metaLen >= 2) {
          const n = view.getUint8(metaStart);
          const d = Math.pow(2, view.getUint8(metaStart + 1));
          if (n && d) timeSignature = [n, d];
        } else if (type === 0x59 && metaLen >= 1) {
          keyFifths = (view.getInt8(metaStart) << 24) >> 24;
        } else if (type === 0x03 && !title) {
          const bytes = new Uint8Array(arrayBuffer, metaStart, metaLen);
          title = decodeText(bytes);
        }
        if (type === 0x2f) break;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const metaLen = readVarInt(view, state);
        state.pos += metaLen;
        continue;
      }
      if (status < 0x80) {
        if (!running) break;
        state.pos--;
        status = running;
      } else {
        running = status;
      }
      const command = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = view.getUint8(state.pos++);
      const data2 = (command === 0xc0 || command === 0xd0) ? 0 : view.getUint8(state.pos++);
      if (command === 0x90 && data2 > 0) {
        const key = `${channel}:${data1}`;
        if (!active.has(key)) active.set(key, []);
        active.get(key).push({ tick, velocity: data2 / 127 });
      } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
        const key = `${channel}:${data1}`;
        const stack = active.get(key);
        if (stack && stack.length) {
          const on = stack.shift();
          notes.push({
            midi: data1,
            startTick: on.tick,
            endTick: Math.max(tick, on.tick + 1),
            velocity: clamp(on.velocity * 0.9 + 0.12, 0.2, 1),
          });
        }
      }
    }
    // Close hanging notes at the end of the track.
    for (const [key, stack] of active) {
      const midi = Number(key.split(":")[1]);
      for (const on of stack) {
        notes.push({ midi, startTick: on.tick, endTick: Math.max(tick, on.tick + division / 2), velocity: 0.7 });
      }
    }
    if (notes.length) tracks.push({ notes, avg: notes.reduce((s, n) => s + n.midi, 0) / notes.length });
  }

  if (!tracks.length) throw new Error("MIDI 中没有可播放的音符。");
  const toBeats = (ticks) => ticks / division;
  const allNotes = [];
  // MIDI track order is not standardised; use the average pitch to decide
  // which track is the left hand instead of assuming track 0 is the melody.
  const byPitch = [...tracks].sort((a, b) => a.avg - b.avg);
  const rank = new Map(byPitch.map((track, i) => [track, i]));
  tracks.forEach((track) => {
    const trackRank = rank.get(track);
    for (const n of track.notes) {
      const hand = tracks.length === 1
        ? (n.midi < 60 ? "L" : "R")
        : (trackRank === 0 ? "L" : "R");
      allNotes.push({
        midi: n.midi,
        start: toBeats(n.startTick),
        duration: Math.max(0.0625, toBeats(n.endTick - n.startTick)),
        hand,
        velocity: n.velocity,
        confidence: 1,
      });
    }
  });
  const measures = Math.max(1, Math.ceil(Math.max(...allNotes.map((n) => n.start + n.duration)) / ((timeSignature[0] * 4) / timeSignature[1])));
  return createScore({
    title: title || "MIDI 导入",
    composer: "",
    tempo,
    timeSignature,
    keyFifths,
    notes: allNotes,
    measures,
    source: { type: "midi", fileName },
    quality: { confidence: 0.98, warnings: ["左右手按音轨自动分配，可在校对页调整。"] },
  });
}

/* Build a compact human-readable note summary for the editor inspector. */
export function noteSummary(note) {
  return `${noteName(note.midi)} · ${Number(note.duration.toFixed(2))} 拍`;
}

export function isBlackPitchClass(midi) {
  return [1, 3, 6, 8, 10].includes(midi % 12);
}

export { NOTE_NAMES };
