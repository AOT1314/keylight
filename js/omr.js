/* Local optical music recognition for clean, printed staff notation.

   This is intentionally a "first draft" recognizer: it finds staves,
   noteheads and barlines, then infers pitch from staff position and timing
   from horizontal engraving spacing. Complex scores still need review, so
   every detected note is editable in the piano roll.  No network calls. */

import {
  clamp, isBlackKey, diatonicToMidi, keyLabelFor, parseTimeSignature,
} from "./util.js";
import { createScore } from "./model.js";

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

async function loadImageSource(source) {
  // Deliberately use an HTMLImageElement instead of createImageBitmap. Some
  // Chromium builds occasionally hang createImageBitmap for large camera
  // photos; <img> decoding is predictable and fast enough for this pipeline.
  const isBlob = source instanceof Blob;
  const url = isBlob ? URL.createObjectURL(source) : String(source);
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve({
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      revoke: () => { if (isBlob) URL.revokeObjectURL(url); },
    });
    img.onerror = () => {
      if (isBlob) URL.revokeObjectURL(url);
      reject(new Error("图片无法读取，请换一张 JPG / PNG 试试。"));
    };
    img.src = url;
  });
}

function getGray(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const a = data[i + 3] / 255;
    const r = data[i] * a + 255 * (1 - a);
    const g = data[i + 1] * a + 255 * (1 - a);
    const b = data[i + 2] * a + 255 * (1 - a);
    gray[j] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
  }
  return gray;
}

function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

function binarize(gray, w, h) {
  const global = otsu(gray);
  // Integral image of luminance for a local adaptive threshold.
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowOff = (y + 1) * (w + 1);
    const prevOff = y * (w + 1);
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[rowOff + x + 1] = integral[prevOff + x + 1] + rowSum;
    }
  }
  const binary = new Uint8Array(w * h);
  const radius = Math.max(8, Math.round(Math.min(w, h) * 0.012));
  let darkCount = 0;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / area;
      const threshold = Math.min(global + 32, mean - 7);
      if (gray[y * w + x] < threshold) {
        binary[y * w + x] = 1;
        darkCount++;
      }
    }
  }
  // If the page is mostly dark (an inverted scan or a photo of a screen),
  // fall back to the global threshold.
  if (darkCount > w * h * 0.42) {
    binary.fill(0);
    for (let i = 0; i < gray.length; i++) binary[i] = gray[i] < global ? 1 : 0;
  }
  return { binary, global };
}

function estimateSkew(binary, w, h) {
  const stepX = Math.max(1, Math.floor(w / 760));
  const stepY = Math.max(1, Math.floor(h / 1100));
  let bestAngle = 0, bestScore = -1;
  for (let deg = -2; deg <= 2.0001; deg += 0.1) {
    const a = (deg * Math.PI) / 180;
    const slope = Math.tan(a);
    const bins = new Float64Array(h + Math.ceil(Math.abs(slope) * w) + 8);
    const offset = slope < 0 ? Math.ceil(-slope * w) + 2 : 2;
    for (let y = 0; y < h; y += stepY) {
      const row = y * w;
      for (let x = 0; x < w; x += stepX) {
        if (!binary[row + x]) continue;
        const yy = Math.round(y - slope * x) + offset;
        if (yy >= 0 && yy < bins.length) bins[yy]++;
      }
    }
    let score = 0;
    for (let i = 0; i < bins.length; i++) score += bins[i] * bins[i];
    if (score > bestScore) { bestScore = score; bestAngle = deg; }
  }
  return bestAngle;
}

function rowRuns(binary, w, h) {
  const runCount = new Float32Array(h);
  const all = new Float32Array(h);
  const minRun = Math.max(6, Math.round(w * 0.004));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let run = 0;
    let dark = 0;
    for (let x = 0; x < w; x++) {
      if (binary[row + x]) {
        run++;
        dark++;
      } else {
        if (run >= minRun) runCount[y] += run;
        run = 0;
      }
    }
    if (run >= minRun) runCount[y] += run;
    all[y] = dark;
  }
  return { runCount, all };
}

function findStaves(binary, w, h, { peakThreshold = 0.1, groupThreshold = 0.065 } = {}) {
  const { runCount, all } = rowRuns(binary, w, h);
  const contentWidth = Math.max(1, Math.max(...all) * 0.92);
  const scores = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const avg = (runCount[y] + (runCount[Math.max(0, y - 1)] || 0) + (runCount[Math.min(h - 1, y + 1)] || 0)) / 3;
    scores[y] = avg / contentWidth;
  }
  // Group adjacent rows into peaks.
  const peaks = [];
  for (let y = 1; y < h - 1; y++) {
    if (scores[y] < peakThreshold) continue;
    if (scores[y] >= scores[y - 1] && scores[y] >= scores[y + 1]) {
      let sy = y * scores[y], sw = scores[y], start = y, end = y;
      while (start > 0 && scores[start - 1] > groupThreshold) { start--; sy += start * scores[start]; sw += scores[start]; }
      while (end < h - 1 && scores[end + 1] > groupThreshold) { end++; sy += end * scores[end]; sw += scores[end]; }
      const thickness = end - start + 1;
      if (thickness <= 7) peaks.push({ y: sy / sw, score: scores[y], thickness, start, end });
      y = end;
    }
  }
  if (!peaks.length) return { staves: [], scores, debug: { peaks: 0 } };
  peaks.sort((a, b) => a.y - b.y);

  // If rotation/anti-aliasing causes one staff line to merge into its neighbor,
  // recover it when a gap is almost exactly two normal staff spaces wide.
  const adjacentGaps = [];
  for (let i = 1; i < peaks.length; i++) {
    const g = peaks[i].y - peaks[i - 1].y;
    if (g > 4) adjacentGaps.push(g);
  }
  adjacentGaps.sort((a, b) => a - b);
  const medianGap = adjacentGaps.length ? adjacentGaps[Math.floor(adjacentGaps.length / 2)] : 12;
  for (let i = 1; i < peaks.length; i++) {
    const gap = peaks[i].y - peaks[i - 1].y;
    if (gap < medianGap * 1.55 || gap > medianGap * 2.55) continue;
    const mid = (peaks[i].y + peaks[i - 1].y) / 2;
    if (peaks.some((p) => Math.abs(p.y - mid) < Math.max(2.2, medianGap * 0.3))) continue;
    const yy = clamp(Math.round(mid), 0, h - 1);
    peaks.push({ y: mid, score: Math.max(0.052, scores[yy]), thickness: 1, virtual: true });
  }
  peaks.sort((a, b) => a.y - b.y);

  const maxSpace = Math.max(6, Math.min(40, Math.round(h * 0.02)));
  const candidates = [];
  for (let i = 0; i < peaks.length; i++) {
    for (let s = 5; s <= maxSpace; s++) {
      const chain = [i];
      let totalScore = peaks[i].score;
      let ok = true;
      for (let k = 1; k < 5; k++) {
        const target = peaks[i].y + s * k;
        let bestIdx = -1, bestD = Infinity;
        for (let j = 0; j < peaks.length; j++) {
          if (chain.includes(j)) continue;
          const d = Math.abs(peaks[j].y - target);
          if (d < bestD) { bestD = d; bestIdx = j; }
        }
        if (bestIdx < 0 || bestD > Math.max(1.8, s * 0.19)) { ok = false; break; }
        chain.push(bestIdx);
        totalScore += peaks[bestIdx].score;
      }
      if (!ok) continue;
      const ys = chain.map((idx) => peaks[idx].y).sort((a, b) => a - b);
      const gaps = [];
      for (let k = 1; k < 5; k++) gaps.push(ys[k] - ys[k - 1]);
      const meanGap = gaps.reduce((a, b) => a + b, 0) / 4;
      const variance = gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / 4;
      const consistency = Math.max(0, 1 - Math.sqrt(variance) / meanGap);
      const score = totalScore * (0.58 + consistency * 0.62) + consistency * 2.4 - s * 0.018;
      if (consistency > 0.52 && score > 0.28) {
        candidates.push({
          top: ys[0], bottom: ys[4], middleY: (ys[0] + ys[4]) / 2,
          space: (ys[4] - ys[0]) / 4, lines: ys,
          clef: "treble", confidence: clamp(score / 2.8, 0.35, 0.98), score,
        });
      }
    }
  }
  // Keep the strongest candidate for each physical staff. This avoids losing a
  // real staff merely because a weaker, overlapping chain claimed its peaks.
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((st) => Math.abs(st.top - candidate.top) < Math.max(st.space, candidate.space) * 2.4)) continue;
    selected.push(candidate);
  }
  selected.sort((a, b) => a.top - b.top);
  return {
    staves: selected,
    scores,
    peaks: peaks.map((p) => ({ y: Math.round(p.y * 10) / 10, score: Math.round(p.score * 1000) / 1000 })),
    candidates: candidates.slice(0, 16).map((c) => ({ top: Math.round(c.top), space: Math.round(c.space * 10) / 10, score: Math.round(c.score * 100) / 100 })),
  };
}

function longestVerticalRun(binary, w, h, x, y0, y1) {
  let best = 0, run = 0;
  for (let y = y0; y <= y1; y++) {
    if (binary[y * w + x]) run++;
    else { if (run > best) best = run; run = 0; }
  }
  return Math.max(best, run);
}

function staffLineExtent(binary, w, h, staff) {
  const minX = Math.round(staff.lines[0] * 0) + 0;
  let left = w, right = 0;
  for (let x = 0; x < w; x++) {
    let hits = 0;
    for (const ly of staff.lines) {
      const y = Math.round(ly);
      for (let dy = -1; dy <= 1; dy++) {
        if (y + dy >= 0 && y + dy < h && binary[(y + dy) * w + x]) { hits++; break; }
      }
    }
    if (hits >= 3) {
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  if (right <= left) return { x0: 0, x1: w - 1 };
  return { x0: left, x1: right };
}

function removeStaffLines(binary, w, h, staves) {
  const clean = binary.slice();
  for (const staff of staves) {
    const x0 = Math.max(0, staff.x0 - 4);
    const x1 = Math.min(w - 1, staff.x1 + 4);
    for (const ly of staff.lines) {
      for (let yy = Math.round(ly) - 1; yy <= Math.round(ly) + 1; yy++) {
        if (yy < 0 || yy >= h) continue;
        let x = x0;
        while (x <= x1) {
          if (!binary[yy * w + x]) { x++; continue; }
          let end = x;
          while (end + 1 <= x1 && binary[yy * w + end + 1]) end++;
          const len = end - x + 1;
          if (len > staff.space * 2.2) {
            for (let xx = x; xx <= end; xx++) {
              let up = 0, down = 0;
              while (up < 4 && yy - up - 1 >= 0 && binary[(yy - up - 1) * w + xx]) up++;
              while (down < 4 && yy + down + 1 < h && binary[(yy + down + 1) * w + xx]) down++;
              if (up + down + 1 <= 3) clean[yy * w + xx] = 0;
            }
          }
          x = end + 1;
        }
      }
    }
  }
  return clean;
}

function hasSystemConnector(binary, w, h, upper, lower) {
  const gap = lower.top - upper.bottom;
  if (gap < upper.space * 1.2 || gap > upper.space * 13) return false;
  const x0 = Math.max(0, Math.min(upper.x0, lower.x0) - Math.round(upper.space * 1.8));
  const x1 = Math.min(w - 1, Math.max(upper.x0, lower.x0) + Math.round(upper.space * 0.8));
  const y0 = Math.max(0, Math.floor(upper.bottom + 1));
  const y1 = Math.min(h - 1, Math.ceil(lower.top - 1));
  if (y1 <= y0) return false;
  let darkRows = 0;
  for (let y = y0; y <= y1; y++) {
    let rowDark = false;
    for (let x = x0; x <= x1; x++) {
      if (binary[y * w + x]) { rowDark = true; break; }
    }
    if (rowDark) darkRows++;
  }
  return darkRows / (y1 - y0 + 1) > 0.42;
}

function groupSystems(staves, binary, w, h) {
  if (!staves.length) return [];
  const systems = [];
  let current = [staves[0]];
  for (let i = 1; i < staves.length; i++) {
    const prev = staves[i - 1];
    const next = staves[i];
    const gap = next.top - prev.bottom;
    const plausible = gap > prev.space * 2.2 && gap < prev.space * 12;
    const connector = hasSystemConnector(binary, w, h, prev, next);
    // Two staves on a page are almost always a piano grand staff even if the
    // brace is cropped. For longer pages, require a literal left connector so
    // we do not merge two separate systems into one pair.
    const pairOfTwo = staves.length === 2 && plausible;
    if (connector || pairOfTwo) current.push(next);
    else {
      systems.push(current);
      current = [next];
    }
  }
  systems.push(current);
  return systems;
}

function assignClefs(systems, binary, w, h) {
  for (const system of systems) {
    if (system.length >= 2) {
      // Piano systems are conventionally treble above bass.
      for (let i = 0; i < system.length; i++) {
        if (i === 0) system[i].clef = "treble";
        else if (i === 1) system[i].clef = "bass";
        else system[i].clef = i % 2 === 0 ? "treble" : "bass";
      }
    } else {
      const st = system[0];
      // Look at the first glyph after the left barline. Treble clefs are tall,
      // bass clefs sit within roughly three staff spaces.
      const x0 = Math.max(0, Math.round(st.x0 + st.space * 0.8));
      const x1 = Math.min(w - 1, Math.round(st.x0 + st.space * 3.2));
      const y0 = Math.max(0, Math.floor(st.top - st.space * 2));
      const y1 = Math.min(h - 1, Math.ceil(st.bottom + st.space * 2));
      let minY = y1, maxY = y0;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if (!binary[y * w + x]) continue;
          // Ignore staff-line rows.
          if (st.lines.some((ly) => Math.abs(y - ly) < 1.2)) continue;
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      const glyphHeight = maxY - minY;
      st.clef = glyphHeight > st.space * 4.2 ? "treble" : "bass";
    }
  }
}

function findComponents(clean, w, h, x0, x1, y0, y1) {
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  if (rw <= 0 || rh <= 0) return [];
  const visited = new Uint8Array(rw * rh);
  const queue = new Int32Array(rw * rh);
  const components = [];
  for (let yy = 0; yy < rh; yy++) {
    const gy = y0 + yy;
    for (let xx = 0; xx < rw; xx++) {
      const local = yy * rw + xx;
      if (visited[local]) continue;
      const gx = x0 + xx;
      if (!clean[gy * w + gx]) continue;
      let head = 0, tail = 0;
      queue[tail++] = local;
      visited[local] = 1;
      let minX = gx, maxX = gx, minY = gy, maxY = gy, area = 0;
      const rows = new Map();
      while (head < tail) {
        const p = queue[head++];
        const ly = (p / rw) | 0;
        const lx = p - ly * rw;
        const px = x0 + lx, py = y0 + ly;
        area++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        let st = rows.get(py);
        if (!st) { st = { min: px, max: px, count: 0 }; rows.set(py, st); }
        if (px < st.min) st.min = px;
        if (px > st.max) st.max = px;
        st.count++;
        for (let oy = -1; oy <= 1; oy++) {
          const ny = ly + oy;
          if (ny < 0 || ny >= rh) continue;
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue;
            const nx = lx + ox;
            if (nx < 0 || nx >= rw) continue;
            const nl = ny * rw + nx;
            if (visited[nl]) continue;
            visited[nl] = 1;
            if (clean[(y0 + ny) * w + x0 + nx]) queue[tail++] = nl;
          }
        }
      }
      components.push({ minX, maxX, minY, maxY, area, rows, width: maxX - minX + 1, height: maxY - minY + 1 });
    }
  }
  return components;
}

function extractHeadsFromComponent(comp, space, staff) {
  const rows = [];
  for (const [y, st] of comp.rows) {
    const span = st.max - st.min + 1;
    rows.push({ y, min: st.min, max: st.max, span, count: st.count });
  }
  rows.sort((a, b) => a.y - b.y);
  const candidates = [];
  let cluster = [];
  const flush = () => {
    if (!cluster.length) return;
    const first = cluster[0].y;
    const last = cluster[cluster.length - 1].y;
    const h = last - first + 1;
    const centerY = (first + last) / 2;
    if (h >= Math.max(2, space * 0.35) && h <= space * 1.35) {
      let sum = 0, spanSum = 0;
      for (const r of cluster) { sum += (r.min + r.max) / 2; spanSum += r.span; }
      const centerX = sum / cluster.length;
      const avgSpan = spanSum / cluster.length;
      const maxSpan = Math.max(...cluster.map((r) => r.span));
      if (avgSpan >= space * 0.52 && maxSpan <= space * 2.2) {
        const midY = (staff.top + staff.bottom) / 2;
        if (centerY > staff.top - space * 3.1 && centerY < staff.bottom + space * 3.1) {
          const pitchSteps = Math.round((midY - centerY) / (space / 2));
          candidates.push({
            x: centerX, y: centerY,
            width: avgSpan, height: h, area: cluster.reduce((a, r) => a + r.count, 0),
            stepOffset: pitchSteps,
          });
        }
      }
    }
    cluster = [];
  };
  for (const r of rows) {
    const isHeadRow = r.span >= space * 0.52 && r.span <= space * 2.25 && r.count >= 2;
    if (isHeadRow) {
      if (cluster.length && r.y - cluster[cluster.length - 1].y <= 2) cluster.push(r);
      else { flush(); cluster = [r]; }
    } else {
      flush();
    }
  }
  flush();
  // Merge split hollow-note fragments.
  const merged = [];
  for (const c of candidates) {
    const near = merged.find((m) => Math.abs(m.x - c.x) < space * 0.55 && Math.abs(m.y - c.y) < space * 0.72);
    if (near) {
      near.x = (near.x + c.x) / 2;
      near.y = (near.y + c.y) / 2;
      near.height = Math.max(near.height, c.height);
      near.confidence = Math.min(0.86, (near.confidence || 0.6) + 0.08);
    } else {
      merged.push({ ...c, confidence: 0.72 });
    }
  }
  return merged;
}

function detectNoteheads(clean, binary, w, h, systems) {
  const heads = [];
  for (const system of systems) {
    const x0 = Math.max(0, Math.floor(Math.min(...system.map((s) => s.x0))));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(...system.map((s) => s.x1))));
    const y0 = Math.max(0, Math.floor(Math.min(...system.map((s) => s.top)) - system[0].space * 3.1));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(...system.map((s) => s.bottom)) + system[0].space * 3.1));
    const comps = findComponents(clean, w, h, x0, x1, y0, y1);
    for (const comp of comps) {
      if (comp.area < 3) continue;
      if (comp.height <= 1) continue;
      if (comp.width > system[0].space * 4.2 && comp.height < system[0].space * 0.5) continue;
      // Exclude the clef / key / time signature area at the start of a system.
      // These glyphs produce several wide row-clusters that look like noteheads.
      if (comp.minX < x0 + system[0].space * 6.2) continue;
      for (const staff of system) {
        const part = extractHeadsFromComponent(comp, staff.space, staff);
        for (const c of part) {
          // Assign to the vertically nearest staff.
          let bestStaff = staff;
          let bestDist = Math.abs(c.y - (staff.top + staff.bottom) / 2);
          for (const st of system) {
            const d = Math.abs(c.y - (st.top + st.bottom) / 2);
            if (d < bestDist) { bestDist = d; bestStaff = st; }
          }
          if (bestStaff !== staff) continue;
          const staffIndex = system.indexOf(staff);
          heads.push({
            ...c,
            staff,
            system,
            staffIndex,
            hand: staffIndex === 0 ? "R" : staffIndex === 1 ? "L" : staffIndex % 2 === 0 ? "R" : "L",
            clef: staff.clef,
          });
        }
      }
    }
  }
  // Deduplicate candidates that survive in overlapping components.
  const deduped = [];
  for (const hd of heads.sort((a, b) => a.x - b.x || a.y - b.y)) {
    const space = hd.staff.space;
    const near = deduped.find((o) => Math.abs(o.x - hd.x) < space * 0.45 && Math.abs(o.y - hd.y) < space * 0.45);
    if (near) {
      if (hd.confidence > near.confidence) Object.assign(near, hd);
    } else deduped.push(hd);
  }
  return deduped;
}

function detectBarlines(binary, w, h, systems, heads) {
  const all = [];
  for (const system of systems) {
    const candidates = [];
    const staffCandidates = [];
    for (const staff of system) {
      const y0 = Math.max(0, Math.floor(staff.top - 1));
      const y1 = Math.min(h - 1, Math.ceil(staff.bottom + 1));
      const span = y1 - y0 + 1;
      const cols = [];
      for (let x = Math.floor(staff.x0 + staff.space * 1.3); x <= Math.ceil(staff.x1); x++) {
        const run = longestVerticalRun(binary, w, h, x, y0, y1);
        if (run >= span * 0.87) {
          let thick = 1;
          while (x + thick <= staff.x1 && longestVerticalRun(binary, w, h, x + thick, y0, y1) >= span * 0.75) thick++;
          cols.push({ x, thick });
          x += thick - 1;
        }
      }
      staffCandidates.push(cols);
      for (const c of cols) {
        if (c.thick > Math.max(6, staff.space * 0.7)) continue;
        // A stem ends in a notehead. A barline does not.
        const nearHead = heads.some((hd) => Math.abs(hd.x - c.x) < staff.space * 1.15 && hd.y > staff.top - staff.space && hd.y < staff.bottom + staff.space);
        if (nearHead) continue;
        candidates.push(c);
      }
    }
    // Consensus between grand-staff staves is strong evidence.
    const merged = [];
    for (const c of candidates) {
      if (merged.some((m) => Math.abs(m.x - c.x) < 4)) continue;
      let support = 0;
      for (const list of staffCandidates) if (list.some((s) => Math.abs(s.x - c.x) < 4)) support++;
      if (system.length > 1 && support < 2) continue;
      merged.push(c);
    }
    const x0 = Math.floor(Math.min(...system.map((s) => s.x0)));
    const x1 = Math.ceil(Math.max(...system.map((s) => s.x1)));
    const filtered = merged.filter((c) => c.x > x0 + system[0].space * 2.2 && c.x < x1 - system[0].space * 0.4);
    const boundaries = [x0, ...filtered.map((c) => c.x), x1];
    // Remove boundaries that are implausibly close (usually stray stems).
    const cleanBounds = [boundaries[0]];
    for (let i = 1; i < boundaries.length; i++) {
      if (boundaries[i] - cleanBounds[cleanBounds.length - 1] > system[0].space * 3.5) cleanBounds.push(boundaries[i]);
    }
    if (cleanBounds.length < 2) cleanBounds.push(x1);
    all.push({ system, boundaries: cleanBounds, barlines: filtered });
  }
  return all;
}

function attachPitches(heads, keyFifths) {
  for (const hd of heads) {
    const baseStep = hd.clef === "bass" ? 22 : 34;
    // Derive the pitch from the final staff assignment and the actual
    // notehead centre. This removes any ambiguity left by shared components.
    const midY = (hd.staff.top + hd.staff.bottom) / 2;
    const stepOffset = Math.round((midY - hd.y) / (hd.staff.space / 2));
    hd.stepOffset = stepOffset;
    hd.midi = diatonicToMidi(baseStep + stepOffset, keyFifths, 0);
    hd.step = baseStep + stepOffset;
    // Lower confidence for ledger-line regions.
    const outside = hd.y < hd.staff.top - hd.staff.space * 0.4 || hd.y > hd.staff.bottom + hd.staff.space * 0.4;
    hd.confidence = clamp(hd.confidence - (outside ? 0.08 : 0), 0.3, 0.9);
  }
}

function assembleScore(heads, barSystems, options) {
  const [timeNum, timeDen] = parseTimeSignature(options.timeSignature || "4/4");
  const mb = (timeNum * 4) / timeDen;
  const notes = [];
  let measureOffset = 0;
  let usedBarlines = 0;

  for (const { system, boundaries } of barSystems) {
    const systemHeads = heads.filter((h) => system.includes(h.staff));
    if (!systemHeads.length) {
      // Keep the measure count sensible for empty systems.
      measureOffset += Math.max(1, boundaries.length - 1);
      continue;
    }
    const localCount = Math.max(1, boundaries.length - 1);
    const left = boundaries[0];
    const right = boundaries[boundaries.length - 1];
    if (localCount === 1) {
      const rough = Math.max(1, Math.round((right - left) / (system[0].space * 17)));
      // Only use the estimate if the system is wide enough to look like
      // several measures; otherwise keep a single measure.
      if (rough > 1) usedBarlines += 0;
    }
    for (let m = 0; m < localCount; m++) {
      const b0 = boundaries[m];
      const b1 = boundaries[m + 1] || right;
      const width = Math.max(1, b1 - b0);
      const inMeasure = systemHeads.filter((h) => h.x >= b0 - system[0].space * 0.2 && h.x < b1 - system[0].space * 0.08);
      if (!inMeasure.length) continue;
      inMeasure.sort((a, b) => a.x - b.x);
      // Group near-simultaneous notes (chords / both hands).
      const groups = [];
      for (const hd of inMeasure) {
        const group = groups[groups.length - 1];
        const threshold = hd.staff.space * 0.95;
        if (group && Math.abs(hd.x - group.avgX) < threshold) {
          group.notes.push(hd);
          group.avgX = group.notes.reduce((s, n) => s + n.x, 0) / group.notes.length;
        } else {
          groups.push({ avgX: hd.x, notes: [hd] });
        }
      }
      // Convert x positions to beats and merge groups that quantize together.
      const mapped = groups.map((g) => {
        let beat = ((g.avgX - b0) / width) * mb;
        if (beat < mb * 0.08) beat = 0;
        beat = clamp(Math.round(beat * 4) / 4, 0, Math.max(0, mb - 0.25));
        return { ...g, beat };
      }).sort((a, b) => a.beat - b.beat);
      const merged = [];
      for (const g of mapped) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(last.beat - g.beat) < 0.13) {
          last.notes.push(...g.notes);
          last.avgX = (last.avgX + g.avgX) / 2;
        } else merged.push(g);
      }
      for (let i = 0; i < merged.length; i++) {
        const g = merged[i];
        let dur;
        if (i < merged.length - 1) dur = merged[i + 1].beat - g.beat;
        else dur = mb - g.beat;
        dur = clamp(Math.round(dur * 4) / 4, 0.25, mb);
        for (const hd of g.notes) {
          notes.push({
            midi: hd.midi,
            start: (measureOffset + m) * mb + g.beat,
            duration: dur,
            hand: hd.hand,
            velocity: hd.hand === "L" ? 0.58 : 0.76,
            confidence: hd.confidence,
          });
        }
      }
    }
    measureOffset += localCount;
    usedBarlines += Math.max(0, boundaries.length - 2);
  }

  const measures = Math.max(1, measureOffset);
  return { notes, measures, usedBarlines };
}

export async function recognizeStaffImage(source, options = {}, onProgress = () => {}) {
  const progress = (pct, label, step) => onProgress({ pct: clamp(pct, 0, 100), label, step });
  progress(4, "读取谱面图片", "read");
  const loaded = await loadImageSource(source);
  const { image, width: iw, height: ih } = loaded;

  // Work at a useful resolution: enough for staff lines and noteheads, but
  // small enough to keep recognition responsive in the browser. PDF pages can
  // ask for their native rendered resolution, which matters for dense scores
  // where staff lines are only a few pixels apart.
  const requestedWidth = clamp(Number(options.maxWidth) || 1700, 1000, 3200);
  const maxWidth = clamp(Number(options.maxWidth) || 2300, 1000, 3200);
  const maxHeight = clamp(Number(options.maxHeight) || 3100, 1200, 4200);
  let scale = clamp(requestedWidth / iw, 0.7, 2.1);
  if (iw * scale > maxWidth) scale = maxWidth / iw;
  if (ih * scale > maxHeight) scale = Math.min(scale, maxHeight / ih);
  const w = Math.max(500, Math.round(iw * scale));
  const h = Math.max(400, Math.round(ih * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, w, h);
  loaded.revoke?.();
  progress(12, "分析墨迹与对比度", "read");

  let gray = getGray(canvas);
  let binData = binarize(gray, w, h);
  let binary = binData.binary;

  await yieldUI();
  progress(20, "校正谱面倾斜", "deskew");
  const skew = estimateSkew(binary, w, h);
  let usedSkew = 0;
  if (Math.abs(skew) >= 0.22 && Math.abs(skew) <= 3.2) {
    const rotated = makeCanvas(w, h);
    const rctx = rotated.getContext("2d", { willReadFrequently: true });
    rctx.fillStyle = "#ffffff";
    rctx.fillRect(0, 0, w, h);
    rctx.translate(w / 2, h / 2);
    rctx.rotate((-skew * Math.PI) / 180);
    rctx.drawImage(canvas, -w / 2, -h / 2);
    gray = getGray(rotated);
    binData = binarize(gray, w, h);
    binary = binData.binary;
    canvas.getContext("2d").drawImage(rotated, 0, 0);
    usedSkew = skew;
  }

  await yieldUI();
  progress(32, "定位五线谱表", "staff");
  let staffResult = findStaves(binary, w, h);
  let staffFallback = false;
  // Dense or faint scores can fall below the normal projection threshold.
  // Retry once with a more sensitive peak picker before giving up.
  if (!staffResult.staves.length) {
    staffResult = findStaves(binary, w, h, { peakThreshold: 0.06, groupThreshold: 0.042 });
    staffFallback = staffResult.staves.length > 0;
  }
  const { staves } = staffResult;
  if (!staves.length) {
    throw new Error("没有找到完整的五线谱表。整页密集钢琴谱请尝试把每 1–2 行谱表裁成单独图片，或导出更高分辨率；复杂谱建议改用 MusicXML / MIDI。");
  }
  for (const st of staves) {
    const ext = staffLineExtent(binary, w, h, st);
    st.x0 = ext.x0;
    st.x1 = ext.x1;
  }
  const systems = groupSystems(staves, binary, w, h);
  assignClefs(systems, binary, w, h);

  await yieldUI();
  progress(46, "擦除谱线，定位音符", "notes");
  const clean = removeStaffLines(binary, w, h, staves);
  let heads = detectNoteheads(clean, binary, w, h, systems);
  if (heads.length < 2) {
    throw new Error("找到谱表，但没有识别出足够的音符。请尝试更清晰、分辨率更高的图片，或使用简谱输入。");
  }
  progress(63, `找到 ${heads.length} 个音符`, "notes");

  await yieldUI();
  progress(72, "寻找小节线", "rhythm");
  const barSystems = detectBarlines(binary, w, h, systems, heads);
  attachPitches(heads, normalizeFifths(options.keyFifths || 0));

  await yieldUI();
  progress(83, "整理节奏与左右手", "assemble");
  const assembled = assembleScore(heads, barSystems, options);
  if (!assembled.notes.length) throw new Error("识别到谱表，但未能整理出有效音符。请尝试更清晰的图片。");

  // Confidence is a combination of staff detection and notehead quality.
  const avgStaff = staves.reduce((s, st) => s + st.confidence, 0) / staves.length;
  const avgNote = heads.reduce((s, hd) => s + hd.confidence, 0) / heads.length;
  const complexityPenalty = Math.min(0.12, Math.max(0, heads.length / 160));
  const confidence = clamp(avgStaff * 0.42 + avgNote * 0.5 + 0.12, 0.35, 0.92) - complexityPenalty;
  const warnings = [
    "音高已按所选调号换算，临时升降号暂未自动识别，请重点核对。",
    "节奏是根据音符横向间距估算的，切分、附点与休止符建议逐小节校对。",
    systems.length > 1 ? `按 ${systems.length} 行谱表合并为 ${assembled.measures} 个小节。` : "左右手按上下谱表分配，可在编辑器中修改。",
  ];
  if (staffFallback) warnings.unshift("谱线较浅或较密，已用更敏感的谱表检测重试；请重点核对漏音和错行。");
  if (Math.abs(usedSkew) > 1.4) warnings.unshift(`谱面倾斜 ${Math.abs(usedSkew).toFixed(1)}°，已自动旋转，建议检查边缘音符。`);
  if (staves.length === 1) warnings.push("只检测到一行谱表，已默认使用高音谱号；如为低音谱表，请在编辑器中调整音高。");
  progress(100, "识谱完成", "done");

  const score = createScore({
    title: options.title || "图片识谱",
    composer: options.composer || "",
    tempo: clamp(Number(options.tempo) || 84, 30, 220),
    timeSignature: options.timeSignature || "4/4",
    keyFifths: normalizeFifths(options.keyFifths || 0),
    notes: assembled.notes,
    measures: assembled.measures,
    source: { type: "image-staff", fileName: options.fileName || "" },
    quality: { confidence, warnings, staves: staves.length, systems: systems.length },
  });

  return {
    score,
    debug: {
      width: w,
      height: h,
      staves: staves.map((s) => ({ top: s.top, bottom: s.bottom, x0: s.x0, x1: s.x1, space: s.space, clef: s.clef })),
      noteheads: heads.map((hd) => ({ x: hd.x, y: hd.y, midi: hd.midi, hand: hd.hand, confidence: hd.confidence })),
      boundaries: barSystems.map((b) => b.boundaries),
      skew: usedSkew,
      peaks: staffResult.peaks,
      candidates: staffResult.candidates,
    },
  };
}

function normalizeFifths(v) {
  return clamp(Number(v) || 0, -7, 7);
}

export function drawRecognitionDebug(canvas, debug) {
  if (!canvas || !debug) return;
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const source = canvas.getBoundingClientRect();
  const sw = debug.width, sh = debug.height;
  const scale = Math.min(source.width / sw, source.height / sh);
  const ox = (source.width - sw * scale) / 2;
  const oy = (source.height - sh * scale) / 2;
  canvas.width = Math.round(source.width * dpr);
  canvas.height = Math.round(source.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, source.width, source.height);
  for (const st of debug.staves || []) {
    ctx.strokeStyle = "rgba(231,172,91,.32)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + st.x0 * scale, oy + st.top * scale, (st.x1 - st.x0) * scale, (st.bottom - st.top) * scale);
  }
  for (const hd of debug.noteheads || []) {
    ctx.fillStyle = hd.hand === "L" ? "rgba(103,196,181,.9)" : "rgba(231,172,91,.92)";
    ctx.beginPath();
    ctx.arc(ox + hd.x * scale, oy + hd.y * scale, 2.3, 0, Math.PI * 2);
    ctx.fill();
  }
}
