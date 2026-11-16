/* OCR-assisted jianpu transcription.

   Windows' built-in OCR reads the printed digits; a small amount of pixel
   analysis recovers octave dots, rhythm underlines and rough measure breaks.
   The result is deliberately returned as editable text, not as a final score:
   jianpu notation is compact and a wrong octave dot is easy to hear but hard
   to infer, so the player gets the final say. */

function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片无法解码"));
    img.src = url;
  });
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
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

function makeBinary(gray) {
  const threshold = Math.min(200, otsu(gray) + 18);
  const binary = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) binary[i] = gray[i] < threshold ? 1 : 0;
  return binary;
}

function dotCount(binary, w, h, bx, by, bw, bh, side) {
  // side = -1 looks above the digit, +1 looks below.
  const x0 = Math.max(0, Math.floor(bx + bw * 0.08));
  const x1 = Math.min(w - 1, Math.ceil(bx + bw * 0.92));
  const y0 = side < 0
    ? Math.max(0, Math.floor(by - bh * 0.7))
    : Math.min(h - 1, Math.floor(by + bh * 0.78));
  const y1 = side < 0
    ? Math.max(0, Math.floor(by + bh * 0.22))
    : Math.min(h - 1, Math.floor(by + bh * 1.72));
  if (y1 <= y0 || x1 <= x0) return 0;
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const seen = new Uint8Array(cw * ch);
  const queue = [];
  let count = 0;
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      const idx = yy * cw + xx;
      if (seen[idx]) continue;
      const px = x0 + xx, py = y0 + yy;
      if (!binary[py * w + px]) continue;
      seen[idx] = 1;
      queue.length = 0;
      queue.push(idx);
      let minX = px, maxX = px, minY = py, maxY = py, area = 0;
      while (queue.length) {
        const cur = queue.pop();
        const cy = (cur / cw) | 0;
        const cx = cur - cy * cw;
        const gx = x0 + cx, gy = y0 + cy;
        area++;
        minX = Math.min(minX, gx); maxX = Math.max(maxX, gx);
        minY = Math.min(minY, gy); maxY = Math.max(maxY, gy);
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = cx + ox, ny = cy + oy;
          if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
          const ni = ny * cw + nx;
          if (seen[ni]) continue;
          seen[ni] = 1;
          if (binary[(y0 + ny) * w + x0 + nx]) queue.push(ni);
        }
      }
      const dw = maxX - minX + 1;
      const dh = maxY - minY + 1;
      const cx = (minX + maxX) / 2;
      const closeToCenter = Math.abs(cx - (bx + bw / 2)) < bw * 0.23;
      const aspect = dw / Math.max(1, dh);
      const fill = area / Math.max(1, dw * dh);
      // A real octave dot is a tiny, round, filled mark near the middle of
      // the digit. This rejects serifs and broken strokes of the digit itself.
      if (area >= 5 && area <= Math.min(105, bw * bh * 0.11)
        && dw >= 3 && dh >= 3 && dw <= bw * 0.28 && dh <= bh * 0.22
        && aspect >= 0.65 && aspect <= 1.55 && fill > 0.5 && closeToCenter) {
        count++;
      }
    }
  }
  return Math.min(2, count);
}

function underlineCount(binary, w, h, bx, by, bw, bh) {
  const x0 = Math.max(0, Math.floor(bx - bw * 0.14));
  const x1 = Math.min(w - 1, Math.ceil(bx + bw * 1.14));
  const y0 = Math.max(0, Math.floor(by + bh * 0.94));
  const y1 = Math.min(h - 1, Math.ceil(by + bh * 1.72));
  const width = x1 - x0 + 1;
  if (y1 <= y0) return 0;
  let groups = 0, inGroup = false, gap = 0;
  for (let y = y0; y <= y1; y++) {
    let dark = 0;
    let run = 0, maxRun = 0;
    let darkMin = w, darkMax = 0;
    for (let x = x0; x <= x1; x++) {
      if (binary[y * w + x]) {
        dark++;
        run++;
        maxRun = Math.max(maxRun, run);
        if (x < darkMin) darkMin = x;
        if (x > darkMax) darkMax = x;
      } else run = 0;
    }
    const span = darkMax >= darkMin ? darkMax - darkMin + 1 : 0;
    // Underlines extend slightly beyond the glyph sides; a digit's own
    // baseline serif does not. This prevents almost every false underline.
    const isLine = span > bw * 1.1 && dark / width > 0.48 && maxRun / width > 0.34;
    if (isLine) {
      if (!inGroup) { groups++; inGroup = true; }
      gap = 0;
    } else if (inGroup) {
      gap++;
      if (gap > 1) inGroup = false;
    }
  }
  return Math.min(3, groups);
}

function median(values) {
  if (!values.length) return 0;
  const arr = [...values].sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)];
}

function isDashWord(text) {
  return /^[-–—－_一]+$/.test(text.trim());
}

export async function ocrJianpuImage(file, onProgress = () => {}) {
  onProgress(8, "准备手机照片");
  const dataUrl = await readDataURL(file);
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const ocrScale = 1; // OCR runs on this already-normalised canvas
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  // iPhone photos are often HEIC. Normalise to a JPEG locally before sending
  // it to the Windows OCR helper so the server only has to handle one format.
  let ocrImage;
  try { ocrImage = canvas.toDataURL("image/jpeg", 0.9); }
  catch { throw new Error("图片转换失败，请换一张 JPG 或 PNG。"); }

  onProgress(22, "把图片交给本地 OCR");
  let response;
  try {
    response = await fetch("/api/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: ocrImage }),
    });
  } catch {
    throw new Error("无法连接本地 OCR 服务。请通过启动脚本打开应用，或改用「简谱输入」。");
  }
  const payload = await response.json().catch(() => null);
  if (!payload || !payload.ok) {
    throw new Error(payload?.error || "OCR 没有返回结果。请改用「简谱输入」。");
  }
  onProgress(45, "整理数字与音高记号");
  const imageData = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < imageData.length; i += 4, j++) {
    gray[j] = (imageData[i] * 0.299 + imageData[i + 1] * 0.587 + imageData[i + 2] * 0.114) | 0;
  }
  const binary = makeBinary(gray);

  // Collect digits globally rather than trusting OCR line grouping: jianpu
  // notes often sit at slightly different baselines and Windows OCR splits
  // them into many one-word "lines".
  const rawDigits = [];
  const dashBoxes = [];
  for (const line of payload.lines || []) {
    for (const word of line.words || []) {
      const chars = [...String(word.text || "")];
      const digitChars = chars.map((c, i) => ({ c, i })).filter((x) => /[0-7]/.test(x.c));
      for (const { c, i } of digitChars) {
        const cw = (word.w || 0) / Math.max(1, chars.length);
        rawDigits.push({
          value: Number(c),
          x: (word.x + i * cw) * ocrScale,
          y: word.y * ocrScale,
          w: cw * ocrScale,
          h: word.h * ocrScale,
        });
      }
      if (isDashWord(word.text)) {
        dashBoxes.push({ x: word.x * ocrScale, y: word.y * ocrScale, w: word.w * ocrScale, h: word.h * ocrScale });
      }
    }
  }
  if (!rawDigits.length) {
    throw new Error("没有从图片里读到简谱数字。请换一张更清晰的图片，或直接输入简谱。");
  }
  // Drop the tiny numbers in "1 = C 4/4" and page headers.
  const medianH = median(rawDigits.map((d) => d.h)) || 24;
  const usable = rawDigits.filter((d) => d.h >= medianH * 0.62 && d.w > d.h * 0.12);
  usable.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);
  const rows = [];
  for (const d of usable) {
    const cy = d.y + d.h / 2;
    const last = rows[rows.length - 1];
    const tolerance = Math.max(14, medianH * 0.7);
    if (last && Math.abs(cy - last.cy) < tolerance) {
      last.digits.push(d);
      last.cy = last.digits.reduce((s, x) => s + x.y + x.h / 2, 0) / last.digits.length;
    } else {
      rows.push({ cy, digits: [d] });
    }
  }
  const melodicRows = rows.filter((r) => r.digits.length >= 2);
  if (!melodicRows.length) {
    throw new Error("只读到零散数字，无法组成简谱。请换一张更清晰的图片，或直接输入简谱。");
  }
  onProgress(74, "还原八度点与节奏线");

  const outLines = [];
  for (const row of melodicRows) {
    row.digits.sort((a, b) => a.x - b.x);
    // Remove duplicate OCR boxes for the same glyph.
    const digits = [];
    for (const d of row.digits) {
      const dup = digits.find((x) => Math.abs(x.x - d.x) < Math.min(x.w, d.w) * 0.4 && Math.abs(x.y - d.y) < Math.min(x.h, d.h) * 0.4 && x.value === d.value);
      if (!dup) digits.push(d);
    }
    if (digits.length < 2) continue;
    const medH = median(digits.map((d) => d.h)) || 18;
    const parts = [];
    for (let i = 0; i < digits.length; i++) {
      const d = digits[i];
      let token = String(d.value);
      const top = dotCount(binary, w, h, d.x, d.y, d.w, d.h, -1);
      const bottom = dotCount(binary, w, h, d.x, d.y, d.w, d.h, 1);
      token += "'".repeat(top) + ",".repeat(bottom);
      const under = underlineCount(binary, w, h, d.x, d.y, d.w, d.h);
      token += "_".repeat(under);
      parts.push({ type: "note", token, x: d.x });
      // A dash between two digits represents a held beat.
      const next = digits[i + 1];
      const gapEnd = next ? next.x : d.x + d.w;
      const dashHere = dashBoxes.find((x) => x.x > d.x + d.w * 0.75 && x.x < gapEnd + d.w * 0.2);
      if (dashHere) parts.push({ type: "dash", token: "-" });
      const gap = next ? next.x - (d.x + d.w) : 0;
      if (next && gap > medH * 1.95) parts.push({ type: "bar", token: "|" });
    }
    outLines.push(parts.map((p) => p.token).join(" "));
  }
  if (!outLines.length) {
    throw new Error("没有整理出可用的简谱行。请换一张更清晰的图片，或直接输入简谱。");
  }
  const text = outLines.join(" |\n");
  const right = outLines[0] || "";
  const left = outLines.length === 2 ? outLines[1] : "";
  onProgress(100, "OCR 初稿完成");
  return {
    text,
    rows: outLines,
    right,
    left,
    language: payload.language,
    width: w,
    height: h,
    noteCount: (text.match(/[0-7]/g) || []).length,
  };
}
