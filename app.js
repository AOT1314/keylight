/* KEYLIGHT · 琴键跟弹
   Main application controller. No framework, no network, no tracking. */

import {
  $, $$, clamp, debounce, formatTime, measureBeats, noteName, titleFromFilename,
  parseTimeSignature, isTypingTarget,
} from "./js/util.js";
import {
  createScore, normalizeScore, getDemoScore, metaLine, scoreStats, scoreEndBeat,
  jianpuToScore, musicXmlToScore, midiToScore, measureBeats as scoreMeasureBeats,
} from "./js/model.js";
import { PianoEngine } from "./js/audio.js";
import { Playback } from "./js/playback.js";
import { StageView, HeroPreview } from "./js/stage.js";
import { PianoRoll } from "./js/piano-roll.js";
import { recognizeStaffImage } from "./js/omr.js";
import { ocrJianpuImage } from "./js/jianpu-ocr.js";

const STORAGE_KEY = "keylight.projects.v1";
const engine = new PianoEngine();
const playback = new Playback(engine);

const state = {
  view: "home",
  score: null,
  sourceImage: null,
  sourceThumb: null,
  sourceType: "manual",
  sourceName: "",
  pendingImage: null,
  pendingFile: null,
  pendingTitle: "",
  importTab: "image",
  importBusy: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  sourceNatural: null,
  seeking: false,
  seekWasPlaying: false,
  hasStarted: false,
  projects: [],
  lastStageHud: 0,
  lastTransportAt: 0,
  recognitionDebug: null,
  jianpuFromImage: false,
  staticMode: false,
};

let roll = null;
let stage = null;
let hero = null;
let saveTimer = 0;
let confirmResolver = null;
let liveTimer = 0;
let wakeLock = null;

async function keepScreenAwake(on) {
  if (!("wakeLock" in navigator)) return;
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

const dom = {};

/* ───────────────────────── generic UI ───────────────────────── */

function toast(message, type = "", duration = 3200) {
  const el = document.createElement("div");
  el.className = `toast ${type ? `is-${type}` : ""}`;
  el.textContent = message;
  dom.toastStack.appendChild(el);
  while (dom.toastStack.children.length > 3) dom.toastStack.firstElementChild.remove();
  setTimeout(() => {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 260);
  }, duration);
}

function setRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty("--fill", `${clamp(pct, 0, 100)}%`);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImageEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = url;
  });
}

async function makeThumbnail(dataUrl) {
  if (!dataUrl) return null;
  try {
    const img = await loadImageEl(dataUrl);
    const scale = Math.min(1, 440 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

function askConfirm(title, text, okLabel = "确认") {
  dom.confirmTitle.textContent = title;
  dom.confirmText.textContent = text;
  dom.btnConfirmOk.textContent = okLabel;
  dom.confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function resolveConfirm(value) {
  if (dom.confirmDialog.open) dom.confirmDialog.close();
  if (confirmResolver) {
    const fn = confirmResolver;
    confirmResolver = null;
    fn(value);
  }
}

/* ───────────────────────── storage ───────────────────────── */

function loadProjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    state.projects = Array.isArray(list) ? list.filter((p) => p && p.title && Array.isArray(p.notes)) : [];
  } catch {
    state.projects = [];
  }
  renderRecent();
}

function persistProjects() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.projects.slice(0, 10)));
  } catch {
    toast("最近的琴谱较多，浏览器本地存储已满。", "error");
  }
}

function scoreForStorage(score) {
  return {
    id: score.id,
    title: score.title,
    composer: score.composer || "",
    tempo: score.tempo,
    timeSignature: score.timeSignature,
    keyFifths: score.keyFifths,
    notes: score.notes.map((n) => ({
      id: n.id, midi: n.midi, start: n.start, duration: n.duration,
      hand: n.hand, velocity: n.velocity, confidence: n.confidence,
    })),
    measures: score.measures,
    quality: score.quality || null,
    sourceType: state.sourceType,
    thumbnail: state.sourceThumb || null,
    updatedAt: Date.now(),
  };
}

function saveCurrentProject({ quiet = true } = {}) {
  if (!state.score || state.score.source?.type === "demo" || state.sourceType === "demo") return;
  if (!state.score.notes.length) return;
  const record = scoreForStorage(state.score);
  const index = state.projects.findIndex((p) => p.id === record.id);
  if (index >= 0) state.projects.splice(index, 1);
  state.projects.unshift(record);
  state.projects = state.projects.slice(0, 10);
  persistProjects();
  renderRecent();
  if (!quiet) toast("已保存到本机", "success");
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveCurrentProject(), 900);
}

function renderRecent() {
  dom.recentSection.hidden = !state.projects.length;
  dom.recentGrid.innerHTML = "";
  for (const project of state.projects.slice(0, 6)) {
    const card = document.createElement("button");
    card.className = "recent-card";
    card.type = "button";
    const icon = document.createElement("span");
    icon.className = "recent-score-icon";
    if (project.thumbnail) {
      const img = document.createElement("img");
      img.src = project.thumbnail;
      img.alt = "";
      icon.appendChild(img);
    } else {
      icon.textContent = "♬";
    }
    const main = document.createElement("span");
    main.className = "recent-card-main";
    const title = document.createElement("b");
    title.textContent = project.title;
    const sub = document.createElement("small");
    const date = new Date(project.updatedAt || Date.now());
    sub.textContent = `${project.notes.length} 个音 · ${project.measures} 小节 · ${date.getMonth() + 1}/${date.getDate()}`;
    main.append(title, sub);
    const arrow = document.createElement("span");
    arrow.className = "recent-card-arrow";
    arrow.textContent = "↗";
    card.append(icon, main, arrow);
    card.addEventListener("click", () => openProject(project));
    dom.recentGrid.appendChild(card);
  }
}

function openProject(project) {
  const restored = createScore({
    ...project,
    source: { type: project.sourceType || "saved" },
    quality: project.quality,
    createdAt: project.updatedAt,
    updatedAt: project.updatedAt,
  });
  state.sourceImage = project.thumbnail || null;
  state.sourceThumb = project.thumbnail || null;
  state.sourceType = project.sourceType || "saved";
  state.sourceName = "";
  prepareReview(restored);
  switchView("review");
}

/* ───────────────────────── view / hero ───────────────────────── */

function switchView(name) {
  state.view = name;
  $$(".view").forEach((view) => view.classList.remove("is-active"));
  const map = { home: dom.viewHome, review: dom.viewReview, play: dom.viewPlay };
  map[name]?.classList.add("is-active");
  document.body.classList.toggle("play-mode", name === "play");
  const stepOrder = { home: -1, review: 1, play: 2 };
  $$(".step", dom.stepNav).forEach((step) => {
    const idx = { import: 0, review: 1, play: 2 }[step.dataset.step];
    step.classList.toggle("is-active", idx === stepOrder[name]);
    step.classList.toggle("is-done", idx < stepOrder[name]);
  });
  if (name === "home") {
    hero?.start();
    stage?.stop();
  } else {
    hero?.stop();
  }
  if (name === "review") {
    requestAnimationFrame(() => {
      roll?.refresh();
      resetSourceView();
    });
  }
  if (name === "play") {
    stage?.start();
    requestAnimationFrame(() => {
      stage?.setScore(state.score);
      stage?.draw();
      if (document.fullscreenElement === null) window.scrollTo(0, 0);
    });
  } else {
    stage?.stop();
  }
  updateIosInstallTip();
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

function initHero() {
  hero = new HeroPreview(dom.heroCanvas, {
    keyChip: dom.heroKeyChip,
    measureLabel: dom.heroMeasure,
    beatLabel: dom.heroBeat,
  });
  hero.start();
}

/* ───────────────────────── import dialog ───────────────────────── */

const PROGRESS_LABELS = ["读取谱面", "校正倾斜", "定位谱表", "识别音符", "整理节奏", "完成"];

function resetImportDialog() {
  state.pendingImage = null;
  state.pendingFile = null;
  state.pendingTitle = "";
  state.recognitionDebug = null;
  state.jianpuFromImage = false;
  dom.scoreFile.value = "";
  dom.fileInput.value = "";
  dom.dropEmpty.hidden = false;
  dom.dropPreview.hidden = true;
  dom.scorePreview.removeAttribute("src");
  dom.filePicked.hidden = true;
  dom.fileName.textContent = "—";
  dom.fileMeta.textContent = "—";
  dom.scoreImageType.value = "staff";
  dom.importProgress.hidden = true;
  dom.jianpuRight.value = "";
  dom.jianpuLeft.value = "";
  dom.jianpuLive.classList.remove("is-error");
  dom.jianpuLive.innerHTML = "<span></span>还没有输入音符";
  dom.imageReadNote.hidden = false;
  setImportTab("image");
  setImportBusy(false);
}

function openImport(tab = "image") {
  resetImportDialog();
  setImportTab(tab);
  if (!dom.importDialog.open) dom.importDialog.showModal();
  setTimeout(() => dom.scoreFile.focus?.(), 50);
}

function setImportTab(tab) {
  if (state.importBusy) return;
  state.importTab = tab;
  $$(".import-tab").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.importTab === tab));
  $$(".import-pane").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.pane === tab));
  updateImportFooter();
  if (tab === "jianpu") updateJianpuLive();
}

function updateImportFooter() {
  const imageType = dom.scoreImageType?.value || "staff";
  const imageLabel = imageType === "jianpu" ? "识别简谱" : "开始识谱";
  const labels = { image: imageLabel, jianpu: "生成跟弹谱", file: "导入琴谱" };
  dom.btnDoImport.textContent = labels[state.importTab];
  const appendArrow = document.createElement("span");
  appendArrow.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m0 0-5.5-5.5M19 12l-5.5 5.5"/></svg>`;
  dom.btnDoImport.appendChild(appendArrow.firstElementChild);
  dom.importFootNote.textContent = state.importTab === "image"
    ? (imageType === "jianpu" ? "先提取数字，校对确认后再生成跟弹谱" : "五线谱自动识别 · 简谱使用本地 OCR 辅助")
    : state.importTab === "jianpu"
      ? "数字、八度点和时值都可以在文本里修改"
      : "数字乐谱会保留最准确的音高与节奏";
}

function setImportBusy(busy, text = null) {
  state.importBusy = busy;
  dom.btnDoImport.disabled = busy;
  dom.btnCloseImport.disabled = busy;
  dom.btnCancelImport.disabled = busy;
  $$(".import-tab").forEach((btn) => { btn.disabled = busy; });
  if (!busy) updateImportFooter();
  else if (text) {
    dom.btnDoImport.textContent = text;
  }
}

function setupProgress() {
  dom.importProgress.hidden = false;
  dom.progressTitle.textContent = "准备识谱…";
  dom.progressPct.textContent = "0%";
  dom.progressFill.style.width = "0%";
  dom.progressSteps.innerHTML = PROGRESS_LABELS.map((label, i) => `<span data-i="${i}">${label}</span>`).join("");
}

function updateProgress({ pct = 0, label = "", step = "" }) {
  dom.importProgress.hidden = false;
  if (label) dom.progressTitle.textContent = label;
  dom.progressPct.textContent = `${Math.round(pct)}%`;
  dom.progressFill.style.width = `${clamp(pct, 0, 100)}%`;
  const thresholds = [0, 16, 32, 48, 68, 92];
  $$("#progressSteps span").forEach((el, i) => {
    el.classList.toggle("is-done", pct > thresholds[i] + 8);
    el.classList.toggle("is-active", pct <= thresholds[i] + 8 && pct >= thresholds[i]);
  });
}

async function handleImageFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("请选择 PNG、JPG、WebP 或 BMP 图片。", "error");
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast("图片有点大，请压缩到 20MB 以内。", "error");
    return;
  }
  try {
    const dataUrl = await fileToDataURL(file);
    state.pendingImage = { file, dataUrl, name: file.name };
    state.pendingTitle = titleFromFilename(file.name);
    dom.scorePreview.src = dataUrl;
    dom.dropEmpty.hidden = true;
    dom.dropPreview.hidden = false;
    dom.importProgress.hidden = true;
  } catch (err) {
    toast(err.message || "图片读取失败", "error");
  }
}

function clearPendingImage() {
  state.pendingImage = null;
  dom.scorePreview.removeAttribute("src");
  dom.dropEmpty.hidden = false;
  dom.dropPreview.hidden = true;
  dom.scoreFile.value = "";
  dom.importProgress.hidden = true;
}

async function startStaffRecognition() {
  if (!state.pendingImage) {
    dom.scoreFile.click();
    return;
  }
  setupProgress();
  setImportBusy(true, "正在识谱…");
  updateProgress({ pct: 2, label: "准备读取图片…", step: "read" });
  try {
    await new Promise((r) => setTimeout(r, 60));
    const result = await recognizeStaffImage(state.pendingImage.file, {
      timeSignature: dom.imageTime.value,
      keyFifths: Number(dom.imageKey.value) || 0,
      tempo: Number(dom.imageTempo.value) || 84,
      fileName: state.pendingImage.name,
      title: state.pendingTitle || "图片识谱",
    }, (p) => updateProgress(p));
    result.score.title = state.pendingTitle || "图片识谱";
    state.sourceImage = state.pendingImage.dataUrl;
    state.sourceThumb = await makeThumbnail(state.sourceImage);
    state.sourceType = "staff-image";
    state.sourceName = state.pendingImage.name;
    state.recognitionDebug = result.debug;
    dom.importDialog.close();
    prepareReview(result.score);
    switchView("review");
    toast(`已识别 ${result.score.notes.length} 个音，请对照原谱校对。`, "success", 4200);
  } catch (err) {
    dom.progressTitle.textContent = "识谱没有完成";
    dom.progressPct.textContent = "—";
    dom.progressFill.style.width = "0%";
    toast(err.message || "识谱失败，请换一张更清晰的图片。", "error", 5200);
  } finally {
    setImportBusy(false);
  }
}

async function startJianpuOcr() {
  if (!state.pendingImage) {
    dom.scoreFile.click();
    return;
  }
  setupProgress();
  setImportBusy(true, "正在提取简谱…");
  try {
    const result = await ocrJianpuImage(state.pendingImage.file, (pct, label) => {
      updateProgress({ pct, label, step: "notes" });
    });
    dom.jianpuRight.value = result.right || result.text;
    dom.jianpuLeft.value = result.left || "";
    state.sourceImage = state.pendingImage.dataUrl;
    state.sourceThumb = await makeThumbnail(state.sourceImage);
    state.sourceType = "jianpu";
    state.jianpuFromImage = true;
    state.pendingTitle = titleFromFilename(state.pendingImage.name) || "简谱练习";
    dom.importProgress.hidden = true;
    setImportBusy(false);
    setImportTab("jianpu");
    updateJianpuLive();
    const splitHint = result.left ? "，已按上下两行填入左右手" : "";
    toast(`已提取 ${result.noteCount} 个简谱数字${splitHint}，请对照图片核对后再生成。`, "success", 5600);
  } catch (err) {
    dom.progressTitle.textContent = "简谱提取没有完成";
    dom.progressPct.textContent = "—";
    dom.progressFill.style.width = "0%";
    toast(err.message || "简谱 OCR 失败，请改用文本输入。", "error", 5200);
    setImportBusy(false);
  }
}

function buildJianpuScore() {
  const score = jianpuToScore(dom.jianpuRight.value, dom.jianpuLeft.value, {
    title: state.pendingTitle || (state.pendingImage ? "简谱练习" : "简谱速记"),
    key: dom.jianpuKey.value,
    time: dom.jianpuTime.value,
    tempo: Number(dom.jianpuTempo.value) || 84,
  });
  if (state.jianpuFromImage) {
    score.quality = {
      confidence: 0.62,
      warnings: ["简谱数字来自图片 OCR，八度点、下划线与漏字可能不准确，请对照原图逐行核对。"],
    };
  }
  return score;
}

function updateJianpuLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    const right = dom.jianpuRight.value.trim();
    const left = dom.jianpuLeft.value.trim();
    if (!right && !left) {
      dom.jianpuLive.classList.remove("is-error");
      dom.jianpuLive.innerHTML = "<span></span>还没有输入音符";
      return;
    }
    try {
      const score = buildJianpuScore();
      dom.jianpuLive.classList.remove("is-error");
      dom.jianpuLive.innerHTML = `<span></span>将生成 ${score.notes.length} 个音 · ${score.measures} 小节 · ${metaLine(score)}`;
    } catch (err) {
      dom.jianpuLive.classList.add("is-error");
      dom.jianpuLive.innerHTML = `<span></span>${err.message}`;
    }
  }, 180);
}

async function submitJianpu() {
  try {
    const score = buildJianpuScore();
    if (!score.notes.length) throw new Error("没有可播放的音符");
    state.sourceType = "jianpu";
    if (state.pendingImage) {
      state.sourceImage = state.pendingImage.dataUrl;
      state.sourceThumb = await makeThumbnail(state.sourceImage);
    } else {
      state.sourceImage = null;
      state.sourceThumb = null;
    }
    dom.importDialog.close();
    prepareReview(score);
    switchView("review");
    toast("简谱已转换，可在校对页试听和调整。", "success");
  } catch (err) {
    toast(err.message || "简谱格式有误，请检查输入。", "error", 4800);
  }
}

async function handleImportFile(file) {
  if (!file) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "mxl") {
    toast("暂时不支持压缩的 .mxl，请在制谱软件里导出 .musicxml 或 MIDI。", "error", 5000);
    return;
  }
  state.pendingFile = file;
  state.pendingTitle = titleFromFilename(file.name);
  dom.filePicked.hidden = false;
  dom.fileName.textContent = file.name;
  dom.fileMeta.textContent = `${(file.size / 1024).toFixed(1)} KB · ${ext.toUpperCase()}`;
  dom.fileInput.value = "";
}

function clearPendingFile() {
  state.pendingFile = null;
  dom.filePicked.hidden = true;
  dom.fileInput.value = "";
}

async function submitFile() {
  if (!state.pendingFile) {
    dom.fileInput.click();
    return;
  }
  setupProgress();
  setImportBusy(true, "正在导入…");
  updateProgress({ pct: 25, label: "读取数字乐谱…" });
  try {
    const file = state.pendingFile;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    let score;
    if (ext === "mid" || ext === "midi") {
      score = midiToScore(await file.arrayBuffer(), file.name);
    } else {
      const text = await file.text();
      score = musicXmlToScore(text, file.name);
    }
    state.sourceImage = null;
    state.sourceThumb = null;
    state.sourceType = ext === "mid" || ext === "midi" ? "midi" : "musicxml";
    state.sourceName = file.name;
    updateProgress({ pct: 100, label: "导入完成" });
    dom.importDialog.close();
    prepareReview(score);
    switchView("review");
    toast(`已导入 ${score.notes.length} 个音，音高与节奏来自文件本身。`, "success");
  } catch (err) {
    dom.progressTitle.textContent = "导入没有完成";
    dom.progressPct.textContent = "—";
    toast(err.message || "文件无法解析，请换一个文件。", "error", 5000);
  } finally {
    setImportBusy(false);
  }
}

async function doImport() {
  if (state.importBusy) return;
  if (state.importTab === "image") {
    if (dom.scoreImageType.value === "jianpu") await startJianpuOcr();
    else await startStaffRecognition();
  } else if (state.importTab === "jianpu") {
    await submitJianpu();
  } else if (state.importTab === "file") {
    await submitFile();
  }
}

/* ───────────────────────── review ───────────────────────── */

function prepareReview(score, { sourceImage = null, sourceType = null } = {}) {
  const normalized = normalizeScore(score);
  state.score = normalized;
  if (sourceImage) state.sourceImage = sourceImage;
  if (sourceType) state.sourceType = sourceType;
  if (!state.sourceThumb && state.sourceImage) {
    makeThumbnail(state.sourceImage).then((thumb) => { state.sourceThumb = thumb; });
  }
  playback.stop();
  playback.load(normalized);
  playback.speed = 0.8;
  dom.scoreTitleInput.value = normalized.title;
  dom.reviewTempo.value = normalized.tempo;
  dom.reviewTempoOut.textContent = normalized.tempo;
  setRangeFill(dom.reviewTempo);
  updateReviewMeta();
  dom.btnStartPlay.disabled = !normalized.notes.length;
  dom.btnReviewListen.disabled = !normalized.notes.length;
  dom.btnPlayRoll.disabled = !normalized.notes.length;
  dom.rollEmpty.hidden = normalized.notes.length > 0;
  dom.stageEmpty.hidden = true;

  // Source reference. Without an image the editor gets the full width.
  const hasSource = Boolean(state.sourceImage);
  dom.sourcePanel.hidden = !hasSource;
  dom.reviewGrid.classList.toggle("no-source", !hasSource);
  if (hasSource) {
    dom.sourceImage.hidden = false;
    dom.sourceEmpty.hidden = true;
    dom.sourceImage.src = state.sourceImage;
    dom.playSheetImage.src = state.sourceImage;
    dom.sheetPopEmpty.hidden = true;
    dom.btnSheetToggle.disabled = false;
  } else {
    dom.sourceImage.hidden = true;
    dom.sourceEmpty.hidden = false;
    dom.sourceImage.removeAttribute("src");
    dom.playSheetImage.removeAttribute("src");
    dom.sheetPopEmpty.hidden = false;
    dom.btnSheetToggle.disabled = true;
  }
  resetSourceView();

  const warnings = normalized.quality?.warnings || [];
  const confidence = normalized.quality?.confidence;
  const showNotice = normalized.quality && (state.sourceType === "staff-image" || state.sourceType === "jianpu") && (warnings.length || confidence < 0.9);
  dom.reviewNotice.hidden = !showNotice;
  if (showNotice) {
    const pct = confidence != null ? `${Math.round(confidence * 100)}%` : "—";
    dom.reviewNotice.querySelector("b").textContent = `自动识谱完成 · 识别置信度 ${pct}`;
    dom.reviewNoticeText.textContent = warnings.slice(0, 2).join(" ");
  }

  dom.playTitle.textContent = normalized.title;
  dom.playMeta.textContent = metaLine(normalized);
  dom.btnHands.innerHTML = `<span class="hand-pair"><i class="rh"></i><i class="lh"></i></span>双手`;
  dom.btnHands.classList.remove("is-on");
  dom.btnLabels.classList.add("is-on");
  dom.btnMetronome.classList.remove("is-on");
  dom.btnLoop.classList.remove("is-on");
  dom.btnLoop.textContent = "";
  dom.btnLoop.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V8a4 4 0 0 1 4-4h10m0 0-3-3m3 3-3 3"/><path d="M20 14v2a4 4 0 0 1-4 4H6m0 0 3 3m-3-3 3-3"/></svg>循环`;
  state.sourceImage = state.sourceImage || null;
  dom.sheetPop.hidden = true;
  dom.btnSheetToggle.classList.remove("is-on");
  playback.setHands("both");
  playback.setMetronome(false);
  playback.loop = false;
  playback.loopRange = null;
  playback.setSpeed(0.8);
  updatePlaybackButtons();
  updateTransportDisplay(0);
  stage?.setScore(normalized);
  stage?.setHands("both");
  stage?.setLabels(true);
  stage?.setBeatSec(playback.beatSeconds);
  engine.prepare(normalized.notes);
  state.hasStarted = false;
  dom.nbTitle.textContent = "准备好后，按空格开始";
  dom.nbKeys.textContent = `右手 ${normalized.notes.filter((n) => n.hand === "R").length} 个音 · 左手 ${normalized.notes.filter((n) => n.hand === "L").length} 个音`;
  roll?.setScore(normalized);
  roll?.setPlayhead(0);
  updateReviewMeta();
  scheduleSave();
}

function updateReviewMeta() {
  if (!state.score) return;
  const stats = scoreStats(state.score);
  const [n, d] = state.score.timeSignature;
  dom.reviewMeta.textContent = `${stats.notes} 个音 · 右手 ${stats.right} · 左手 ${stats.left} · ${stats.measures} 小节 · ${formatTime(scoreEndBeat(state.score) * (60 / state.score.tempo))} · ${n}/${d}`;
}

function renderInspector(note) {
  if (!note) {
    dom.inspector.innerHTML = `<span class="inspector-empty">未选中音符</span>`;
    return;
  }
  const color = note.hand === "L" ? "var(--teal)" : "var(--gold)";
  dom.inspector.innerHTML = `
    <span class="inspector-pill"><i style="background:${color}"></i><b>${noteName(note.midi)}</b></span>
    <span class="inspector-pill">第 <b>${Math.floor(note.start / scoreMeasureBeats(state.score) + 1e-9) + 1}</b> 小节</span>
    <span class="inspector-pill">时值 <b>${Number(note.duration.toFixed(2))}</b></span>
    <span class="inspector-pill"><button type="button" data-action="preview">试听</button></span>
    <span class="inspector-pill"><button type="button" data-action="hand">换手</button></span>
    <span class="inspector-pill"><button type="button" data-action="delete" title="删除">×</button></span>
  `;
}

async function previewNote(midi, duration = 0.8, velocity = 0.7) {
  await engine.resume();
  engine.preview(midi, duration, velocity);
}

async function toggleReviewPreview() {
  if (!state.score?.notes.length) return;
  if (playback.isPlaying) {
    playback.pause();
    return;
  }
  await engine.resume();
  let pos = playback.getPosition();
  if (pos >= playback.totalBeat - 0.04) {
    playback.seek(0, { preserve: false });
    pos = 0;
  }
  await playback.play(pos, { countIn: false });
}

async function enterPlay({ autoplay = false } = {}) {
  if (!state.score?.notes.length) {
    toast("还没有可播放的音符。", "error");
    return;
  }
  saveCurrentProject();
  playback.pause();
  playback.stop();
  playback.load(state.score);
  playback.speed = 0.8;
  playback.setSpeed(0.8);
  playback.setHands("both");
  playback.setMetronome(false);
  playback.setLoop(false);
  state.hasStarted = false;
  dom.speedRange.value = 80;
  dom.speedLabel.textContent = "0.8×";
  setRangeFill(dom.speedRange);
  dom.playTitle.textContent = state.score.title;
  dom.playMeta.textContent = metaLine(state.score);
  dom.btnHands.innerHTML = `<span class="hand-pair"><i class="rh"></i><i class="lh"></i></span>双手`;
  dom.btnHands.classList.remove("is-on");
  dom.btnLabels.classList.add("is-on");
  dom.btnMetronome.classList.remove("is-on");
  dom.btnLoop.classList.remove("is-on");
  dom.btnSheetToggle.classList.remove("is-on");
  dom.sheetPop.hidden = true;
  stage.setScore(state.score);
  stage.setHands("both");
  stage.setLabels(true);
  stage.setBeatSec(playback.beatSeconds);
  switchView("play");
  keepScreenAwake(true);
  updateTransportDisplay(0);
  updatePlaybackButtons();
  dom.nbTitle.textContent = "准备好后，按空格开始";
  dom.nbKeys.textContent = `右手 ${state.score.notes.filter((n) => n.hand === "R").length} 个音 · 左手 ${state.score.notes.filter((n) => n.hand === "L").length} 个音`;
  if (autoplay) {
    await new Promise((r) => setTimeout(r, 180));
    const ok = await engine.resume();
    if (ok) {
      state.hasStarted = true;
      await playback.play(0, { countIn: true });
      updatePlaybackButtons();
    }
  }
}

function leavePlay(toReview = true) {
  playback.pause();
  playback.setLoop(false);
  stage.stop();
  keepScreenAwake(false);
  dom.sheetPop.hidden = true;
  saveCurrentProject();
  if (toReview) {
    prepareReview(state.score);
    switchView("review");
  } else {
    switchView("home");
  }
}

/* ───────────────────────── play controls ───────────────────────── */

function updatePlaybackButtons() {
  const playing = playback.isPlaying;
  dom.btnTransport.classList.toggle("is-playing", playing);
  dom.btnTransport.setAttribute("aria-label", playing ? "暂停" : "播放");
  const pos = playback.getPosition();
  let pauseLabel;
  if (playing) pauseLabel = "暂停";
  else if (playback.state === "paused" && pos >= playback.totalBeat - 0.02) pauseLabel = "重播";
  else if (playback.state === "paused" && pos > 0.02) pauseLabel = "继续";
  else pauseLabel = "播放";
  dom.btnPause.classList.toggle("is-active", playing);
  dom.btnPause.disabled = !state.score?.notes.length;
  dom.btnPauseText.textContent = pauseLabel;
  dom.btnPause.setAttribute("aria-label", pauseLabel);
  dom.btnPause.title = playing ? "暂停（P）" : `${pauseLabel}（P）`;
  dom.btnReviewListen.classList.toggle("is-playing", playing);
  dom.btnReviewListen.innerHTML = playing
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>暂停`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>试听`;
  dom.btnPlayRoll.innerHTML = playing
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>暂停`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>试听`;
}

function updateTransportDisplay(beat, total = playback.totalBeat) {
  if (!state.score) return;
  const totalBeats = total || playback.totalBeat || 1;
  const pct = clamp((beat / totalBeats) * 100, 0, 100);
  dom.seekFill.style.width = `${pct}%`;
  dom.seekThumb.style.left = `${pct}%`;
  if (!state.seeking) {
    dom.seekRange.value = String(Math.round(pct * 10));
  }
  dom.timeCurrent.textContent = formatTime(beat * playback.beatSeconds);
  dom.timeTotal.textContent = formatTime(totalBeats * playback.beatSeconds);
  if (state.view === "review" && roll) {
    roll.setPlayhead(beat, { follow: playback.isPlaying });
  }
}

function showCountIn(num) {
  if (!num) {
    dom.countIn.hidden = true;
    return;
  }
  dom.countIn.hidden = false;
  dom.countInNum.textContent = String(num);
  dom.countInNum.style.animation = "none";
  void dom.countInNum.offsetWidth;
  dom.countInNum.style.animation = "";
}

async function toggleTransport() {
  if (playback.isPlaying) {
    playback.pause();
    updatePlaybackButtons();
    return;
  }
  if (!state.score?.notes.length) return;
  await engine.resume();
  if (playback.getPosition() >= playback.totalBeat - 0.04) {
    playback.seek(0, { preserve: false });
    state.hasStarted = false;
  }
  const ok = await playback.play(null, { countIn: true });
  if (ok) state.hasStarted = true;
  updatePlaybackButtons();
}

function cycleHands() {
  const next = playback.hands === "both" ? "R" : playback.hands === "R" ? "L" : "both";
  playback.setHands(next);
  stage.setHands(next);
  const label = next === "both" ? "双手" : next === "R" ? "右手" : "左手";
  dom.btnHands.innerHTML = `<span class="hand-pair"><i class="rh"></i><i class="lh"></i></span>${label}`;
  dom.btnHands.classList.toggle("is-on", next !== "both");
  const visible = next === "both" ? state.score.notes : state.score.notes.filter((n) => n.hand === next);
  dom.stageEmpty.hidden = visible.length > 0;
  dom.nbKeys.textContent = next === "both"
    ? `右手 ${state.score.notes.filter((n) => n.hand === "R").length} 个音 · 左手 ${state.score.notes.filter((n) => n.hand === "L").length} 个音`
    : `当前只看${label} · ${visible.length} 个音`;
  stage.draw();
}

function onStageFrame(data) {
  const now = performance.now();
  if (now - state.lastStageHud < 90) return;
  state.lastStageHud = now;
  if (!state.score) return;
  dom.measureLabel.textContent = `第 ${data.measure} / ${data.totalMeasures} 小节`;
  const beats = state.score.timeSignature[0];
  const beatNum = clamp(Math.floor(data.beatInMeasure + 1e-9) + 1, 1, beats);
  dom.beatLabel.textContent = `${beatNum} / ${beats}`;
  if (playback.state === "paused") {
    const atEnd = playback.getPosition() >= playback.totalBeat - 0.02;
    dom.nbTitle.textContent = atEnd ? "已到结尾 · 按「重播」再练一次" : "已暂停 · 按「继续」或空格恢复";
    return;
  }
  if (!data.active.length) {
    if (playback.isCountingIn) {
      dom.nbTitle.textContent = "跟着节拍准备…";
    } else if (playback.isPlaying) {
      dom.nbTitle.textContent = "看下一个落下的音符";
    } else if (!state.hasStarted) {
      dom.nbTitle.textContent = "准备好后，按空格开始";
    } else {
      dom.nbTitle.textContent = "已暂停 · 按空格继续";
    }
    return;
  }
  const names = [...new Set(data.active.map((n) => noteName(n.midi)))].slice(0, 4);
  const rh = data.active.filter((n) => n.hand === "R").length;
  const lh = data.active.filter((n) => n.hand === "L").length;
  dom.nbTitle.textContent = `现在按下 ${names.join(" · ")}`;
  dom.nbKeys.textContent = `右手 ${rh} 个音 · 左手 ${lh} 个音`;
}

/* ───────────────────────── source image zoom ───────────────────────── */

function applySourceTransform() {
  if (!state.sourceImage) return;
  dom.sourceImage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  dom.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function resetSourceView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applySourceTransform();
}

function setSourceZoom(next) {
  state.zoom = clamp(next, 0.7, 6);
  if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
  applySourceTransform();
}

/* ───────────────────────── init & binding ───────────────────────── */

function isIosDevice() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandaloneApp() {
  return Boolean(navigator.standalone) || window.matchMedia?.("(display-mode: standalone)").matches;
}

function updateIosInstallTip() {
  if (!dom.iosInstallTip) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem("keylight.iosTipDismissed") === "1"; } catch { /* noop */ }
  const show = isIosDevice() && !isStandaloneApp() && !dismissed && state.view === "home";
  dom.iosInstallTip.hidden = !show;
}

function setupPwa() {
  // iOS allows "Add to Home Screen" over plain LAN HTTP, but service workers
  // require HTTPS, so only register the cache when it can actually work.
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  }
  setTimeout(updateIosInstallTip, 1600);
}

async function copyMobileUrl() {
  const url = dom.mobileUrl?.textContent?.trim();
  if (!url || url.includes("…") || url.includes("获取")) {
    toast("还没有拿到局域网地址，请确认服务已启动。", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("局域网地址已复制", "success");
  } catch {
    window.prompt("复制这个地址到手机 Safari 打开：", url);
  }
}

function cacheDom() {
  const ids = [
    "appbar", "stepNav", "toastStack", "heroCanvas", "heroKeyChip", "heroMeasure", "heroBeat",
    "viewHome", "viewReview", "viewPlay", "recentSection", "recentGrid", "recentGrid",
    "reviewNotice", "reviewNoticeText", "scoreTitleInput", "reviewMeta", "reviewTempo",
    "reviewTempoOut", "btnStartPlay", "btnReviewListen", "btnPlayRoll", "btnDeleteNote",
    "btnUndo", "btnRedo", "btnQuantize", "newDuration", "rollCanvas", "rollEmpty",
    "sourceImage", "sourceEmpty", "sourceViewport", "zoomLabel", "btnZoomIn", "btnZoomOut",
    "btnZoomFit", "inspector", "reviewGrid", "sourcePanel", "playTitle", "playMeta", "btnHands", "btnLabels",
    "btnMetronome", "btnLoop", "speedLabel", "speedRange", "btnSheetToggle", "btnFullscreen",
    "btnPlayBack", "btnPlayEdit", "nbTitle", "nbKeys", "stage", "stageCanvas", "measureLabel",
    "beatLabel", "countIn", "countInNum", "stageEmpty", "sheetPop", "btnCloseSheet",
    "playSheetImage", "sheetPopEmpty", "btnTransport", "btnPause", "btnPauseText",
    "timeCurrent", "timeTotal", "seekFill",
    "seekThumb", "seekRange", "btnRestart", "scoreDrop", "scoreFile", "dropEmpty", "dropPreview",
    "scorePreview", "btnRemoveImage", "scoreImageType", "imageKey", "imageTime", "imageTempo",
    "imageReadNote", "importProgress", "progressTitle", "progressPct", "progressFill",
    "progressSteps", "jianpuKey", "jianpuTime", "jianpuTempo", "btnJianpuExample", "jianpuRight",
    "jianpuLeft", "jianpuLive", "fileDrop", "fileInput", "filePicked", "fileName", "fileMeta",
    "btnRemoveFile", "importDialog", "btnCloseImport", "btnCancelImport", "importFootNote",
    "btnDoImport", "helpDialog", "btnCloseHelp", "btnHelpOk", "confirmDialog", "confirmTitle",
    "confirmText", "btnConfirmCancel", "btnConfirmOk", "btnHelp", "btnImportTop", "btnHeroImport",
    "btnPlayDemo", "demoGrid", "brandHome", "btnReviewBack", "btnDismissNotice",
    "btnPlayRoll", "btnClearRecent", "playNoteBanner", "mobileUrl", "btnCopyMobileUrl",
    "btnMobileHelp", "iosInstallTip", "btnDismissIosTip",
  ];
  for (const id of ids) {
    if (!dom[id]) dom[id] = document.getElementById(id);
  }
  // A couple of ids have different casing in the DOM cache.
  dom.btnReviewBack = dom.btnReviewBack || document.getElementById("btnReviewBack");
}

function bindEvents() {
  dom.brandHome.addEventListener("click", () => {
    playback.pause();
    saveCurrentProject();
    switchView("home");
  });
  dom.btnHelp.addEventListener("click", () => dom.helpDialog.showModal());
  dom.btnCloseHelp.addEventListener("click", () => dom.helpDialog.close());
  dom.btnHelpOk.addEventListener("click", () => dom.helpDialog.close());
  dom.btnMobileHelp.addEventListener("click", () => {
    updateIosInstallTip();
    dom.helpDialog.showModal();
  });
  dom.btnCopyMobileUrl.addEventListener("click", copyMobileUrl);
  dom.btnDismissIosTip.addEventListener("click", () => {
    try { localStorage.setItem("keylight.iosTipDismissed", "1"); } catch { /* noop */ }
    dom.iosInstallTip.hidden = true;
  });
  dom.btnImportTop.addEventListener("click", () => openImport("image"));
  dom.btnHeroImport.addEventListener("click", () => openImport("image"));
  dom.btnPlayDemo.addEventListener("click", () => loadDemo("twinkle", true));
  dom.demoGrid.addEventListener("click", (e) => {
    const card = e.target.closest("[data-demo]");
    if (card) loadDemo(card.dataset.demo, true);
  });
  dom.btnClearRecent.addEventListener("click", async () => {
    const ok = await askConfirm("清空练习记录？", "已保存的琴谱会从这台电脑移除。", "清空");
    if (!ok) return;
    state.projects = [];
    persistProjects();
    renderRecent();
    toast("练习记录已清空");
  });
  dom.btnReviewBack.addEventListener("click", () => {
    playback.pause();
    saveCurrentProject();
    switchView("home");
  });
  dom.btnStartPlay.addEventListener("click", () => {
    commitReviewMeta();
    enterPlay({ autoplay: false });
  });
  dom.btnReviewListen.addEventListener("click", toggleReviewPreview);
  dom.btnPlayRoll.addEventListener("click", toggleReviewPreview);
  dom.btnPlayEdit.addEventListener("click", () => leavePlay(true));
  dom.btnPlayBack.addEventListener("click", () => leavePlay(true));
  dom.btnDismissNotice.addEventListener("click", () => { dom.reviewNotice.hidden = true; });

  $$(".import-tab").forEach((btn) => btn.addEventListener("click", () => setImportTab(btn.dataset.importTab)));
  dom.btnCloseImport.addEventListener("click", closeImport);
  dom.btnCancelImport.addEventListener("click", closeImport);
  dom.btnDoImport.addEventListener("click", doImport);
  dom.scoreFile.addEventListener("change", () => handleImageFile(dom.scoreFile.files[0]));
  dom.scoreDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    dom.scoreDrop.classList.add("is-drag");
  });
  dom.scoreDrop.addEventListener("dragleave", () => dom.scoreDrop.classList.remove("is-drag"));
  dom.scoreDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    dom.scoreDrop.classList.remove("is-drag");
    handleImageFile(e.dataTransfer.files[0]);
  });
  dom.btnRemoveImage.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearPendingImage();
  });
  dom.scoreImageType.addEventListener("change", updateImportFooter);
  dom.fileInput.addEventListener("change", () => handleImportFile(dom.fileInput.files[0]));
  dom.fileDrop.addEventListener("dragover", (e) => { e.preventDefault(); dom.fileDrop.classList.add("is-drag"); });
  dom.fileDrop.addEventListener("dragleave", () => dom.fileDrop.classList.remove("is-drag"));
  dom.fileDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    dom.fileDrop.classList.remove("is-drag");
    handleImportFile(e.dataTransfer.files[0]);
  });
  dom.btnRemoveFile.addEventListener("click", clearPendingFile);
  dom.jianpuRight.addEventListener("input", updateJianpuLive);
  dom.jianpuLeft.addEventListener("input", updateJianpuLive);
  [dom.jianpuKey, dom.jianpuTime, dom.jianpuTempo].forEach((el) => el.addEventListener("change", updateJianpuLive));
  dom.btnJianpuExample.addEventListener("click", () => {
    state.jianpuFromImage = false;
    dom.jianpuRight.value = "1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 -";
    dom.jianpuLeft.value = "1, 5, | 4, 1, | 1, 5, | 5, 1,";
    updateJianpuLive();
  });
  dom.importDialog.addEventListener("cancel", (e) => {
    if (state.importBusy) e.preventDefault();
  });
  dom.importDialog.addEventListener("click", (e) => {
    if (e.target === dom.importDialog && !state.importBusy) closeImport();
  });

  dom.scoreTitleInput.addEventListener("input", () => {
    if (!state.score) return;
    state.score.title = dom.scoreTitleInput.value || "未命名琴谱";
    dom.playTitle.textContent = state.score.title;
    scheduleSave();
  });
  dom.scoreTitleInput.addEventListener("blur", () => {
    if (state.score && !dom.scoreTitleInput.value.trim()) {
      dom.scoreTitleInput.value = "未命名琴谱";
      state.score.title = dom.scoreTitleInput.value;
    }
    scheduleSave();
  });
  dom.reviewTempo.addEventListener("input", () => {
    if (!state.score) return;
    const tempo = Number(dom.reviewTempo.value);
    state.score.tempo = tempo;
    dom.reviewTempoOut.textContent = tempo;
    setRangeFill(dom.reviewTempo);
    updateReviewMeta();
    dom.playMeta.textContent = metaLine(state.score);
    if (playback.score === state.score) {
      playback.score.tempo = tempo;
      if (playback.state === "playing") playback.updateScore(state.score);
    }
    scheduleSave();
  });
  dom.reviewTempo.addEventListener("change", () => {
    if (playback.score === state.score) playback.updateScore(state.score);
    scheduleSave();
  });

  dom.btnUndo.addEventListener("click", () => roll?.undo());
  dom.btnRedo.addEventListener("click", () => roll?.redo());
  dom.btnQuantize.addEventListener("click", () => roll?.quantize());
  dom.btnDeleteNote.addEventListener("click", () => roll?.deleteSelected());
  dom.newDuration.addEventListener("change", () => roll?.setNewDuration(Number(dom.newDuration.value)));
  $$(".hand-btn").forEach((btn) => btn.addEventListener("click", () => {
    $$(".hand-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    roll?.setActiveHand(btn.dataset.hand);
  }));
  dom.inspector.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action || !roll) return;
    const note = state.score?.notes.find((n) => n.id === roll.selectedId);
    if (!note) return;
    if (action === "delete") roll.deleteSelected();
    else if (action === "hand") roll.changeHand(note.hand === "R" ? "L" : "R");
    else if (action === "preview") previewNote(note.midi, 0.8, note.velocity);
  });

  dom.btnZoomIn.addEventListener("click", () => setSourceZoom(state.zoom * 1.25));
  dom.btnZoomOut.addEventListener("click", () => setSourceZoom(state.zoom / 1.25));
  dom.btnZoomFit.addEventListener("click", resetSourceView);
  dom.sourceViewport.addEventListener("wheel", (e) => {
    if (!state.sourceImage) return;
    e.preventDefault();
    setSourceZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });
  let sourceDrag = null;
  dom.sourceViewport.addEventListener("pointerdown", (e) => {
    if (!state.sourceImage || e.button !== 0) return;
    sourceDrag = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
    dom.sourceViewport.classList.add("is-dragging");
    dom.sourceViewport.setPointerCapture(e.pointerId);
  });
  dom.sourceViewport.addEventListener("pointermove", (e) => {
    if (!sourceDrag) return;
    state.panX = sourceDrag.panX + e.clientX - sourceDrag.x;
    state.panY = sourceDrag.panY + e.clientY - sourceDrag.y;
    applySourceTransform();
  });
  const endSourceDrag = () => {
    sourceDrag = null;
    dom.sourceViewport.classList.remove("is-dragging");
  };
  dom.sourceViewport.addEventListener("pointerup", endSourceDrag);
  dom.sourceViewport.addEventListener("pointercancel", endSourceDrag);
  dom.sourceImage.addEventListener("load", () => {
    state.sourceNatural = { width: dom.sourceImage.naturalWidth, height: dom.sourceImage.naturalHeight };
    applySourceTransform();
  });

  dom.btnTransport.addEventListener("click", toggleTransport);
  dom.btnPause.addEventListener("click", toggleTransport);
  dom.btnRestart.addEventListener("click", () => {
    playback.pause();
    playback.seek(0, { preserve: false });
    state.hasStarted = false;
    stage.draw();
    updatePlaybackButtons();
  });
  dom.seekRange.addEventListener("pointerdown", () => {
    state.seeking = true;
    state.seekWasPlaying = playback.isPlaying;
    if (playback.isPlaying) playback.pause();
  });
  dom.seekRange.addEventListener("input", () => {
    if (!state.score) return;
    const pct = Number(dom.seekRange.value) / 1000;
    const beat = pct * playback.totalBeat;
    playback.seek(beat, { preserve: false });
    updateTransportDisplay(beat);
    stage.draw();
  });
  dom.seekRange.addEventListener("change", async () => {
    state.seeking = false;
    if (state.seekWasPlaying) {
      await engine.resume();
      await playback.play(null, { countIn: false });
      updatePlaybackButtons();
    }
    state.seekWasPlaying = false;
  });
  dom.speedRange.addEventListener("input", () => {
    const speed = Number(dom.speedRange.value) / 100;
    dom.speedLabel.textContent = `${speed.toFixed(1)}×`;
    setRangeFill(dom.speedRange);
    playback.setSpeed(speed);
    stage.setBeatSec(playback.beatSeconds);
    updateTransportDisplay(playback.getPosition());
  });
  dom.btnHands.addEventListener("click", cycleHands);
  dom.btnLabels.addEventListener("click", () => {
    const on = !dom.btnLabels.classList.contains("is-on");
    dom.btnLabels.classList.toggle("is-on", on);
    stage.setLabels(on);
    stage.draw();
  });
  dom.btnMetronome.addEventListener("click", () => {
    const on = !dom.btnMetronome.classList.contains("is-on");
    dom.btnMetronome.classList.toggle("is-on", on);
    playback.setMetronome(on);
    if (on) toast("节拍器已打开", "success", 1600);
  });
  dom.btnLoop.addEventListener("click", () => {
    const on = !dom.btnLoop.classList.contains("is-on");
    dom.btnLoop.classList.toggle("is-on", on);
    playback.setLoop(on);
    if (on) toast(`循环第 ${playback.loopMeasureNumber} 小节`, "success", 2200);
  });
  dom.btnSheetToggle.addEventListener("click", () => {
    if (!state.sourceImage) {
      toast("这份琴谱没有原图。");
      return;
    }
    dom.sheetPop.hidden = !dom.sheetPop.hidden;
    dom.btnSheetToggle.classList.toggle("is-on", !dom.sheetPop.hidden);
  });
  dom.btnCloseSheet.addEventListener("click", () => {
    dom.sheetPop.hidden = true;
    dom.btnSheetToggle.classList.remove("is-on");
  });
  dom.btnFullscreen.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await dom.stage.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      toast("当前浏览器不支持全屏。");
    }
  });
  dom.helpDialog.addEventListener("click", (e) => {
    if (e.target === dom.helpDialog) dom.helpDialog.close();
  });
  dom.btnConfirmCancel.addEventListener("click", () => resolveConfirm(false));
  dom.btnConfirmOk.addEventListener("click", () => resolveConfirm(true));
  dom.confirmDialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    resolveConfirm(false);
  });

  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("beforeunload", () => saveCurrentProject());
  window.addEventListener("resize", debounce(() => {
    if (state.view === "review") roll?.refresh();
    if (state.view === "play") stage?.draw();
  }, 120));
  document.addEventListener("fullscreenchange", () => {
    dom.btnFullscreen.classList.toggle("is-on", Boolean(document.fullscreenElement));
    if (state.view === "play") setTimeout(() => stage?.draw(), 80);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.view === "play") {
      keepScreenAwake(true);
    }
  });
}

function closeImport() {
  if (state.importBusy) return;
  dom.importDialog.close();
}

function commitReviewMeta() {
  if (!state.score) return;
  state.score.title = dom.scoreTitleInput.value.trim() || "未命名琴谱";
  state.score.tempo = Number(dom.reviewTempo.value) || state.score.tempo;
  scheduleSave();
}

function onKeyDown(e) {
  if (dom.importDialog.open || dom.helpDialog.open || dom.confirmDialog.open) return;
  if (isTypingTarget(e.target)) return;
  if (e.key === " " || e.code === "Space") {
    if (state.view === "play") {
      e.preventDefault();
      toggleTransport();
    } else if (state.view === "review") {
      e.preventDefault();
      toggleReviewPreview();
    }
    return;
  }
  if (state.view === "review") {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) roll?.redo(); else roll?.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      roll?.redo();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (roll?.selectedId) { e.preventDefault(); roll.deleteSelected(); }
      return;
    }
    if (e.key === "ArrowUp") { e.preventDefault(); roll?.nudgePitch(e.shiftKey ? 12 : 1); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); roll?.nudgePitch(e.shiftKey ? -12 : -1); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); roll?.nudgeTime(e.shiftKey ? -1 : -0.25); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); roll?.nudgeTime(e.shiftKey ? 1 : 0.25); return; }
  }
  if (state.view === "play") {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      playback.seek(Math.max(0, playback.getPosition() - 1), { preserve: playback.isPlaying });
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      playback.seek(Math.min(playback.totalBeat, playback.getPosition() + 1), { preserve: playback.isPlaying });
    }
    if (e.key.toLowerCase() === "l") {
      dom.btnLoop.click();
    }
    if (e.key.toLowerCase() === "p") {
      e.preventDefault();
      toggleTransport();
    }
    if (e.key === "Escape" && !document.fullscreenElement) {
      leavePlay(true);
    }
  }
}

function loadDemo(id, autoplay = true) {
  const score = getDemoScore(id);
  state.sourceImage = null;
  state.sourceThumb = null;
  state.sourceType = "demo";
  state.sourceName = "";
  state.pendingImage = null;
  prepareReview(score);
  if (autoplay) enterPlay({ autoplay: true });
  else switchView("review");
}

function initPlaybackHooks() {
  playback.onStateChange = () => {
    updatePlaybackButtons();
    if (!playback.isPlaying) {
      dom.countIn.hidden = true;
    }
    if (playback.state === "paused" && playback.getPosition() >= playback.totalBeat - 0.01) {
      dom.nbTitle.textContent = "已弹到结尾 · 按播放重新开始";
    }
  };
  playback.onTime = (beat, total) => {
    updateTransportDisplay(beat, total);
    if (!playback.isCountingIn) dom.countIn.hidden = true;
  };
  playback.onEnded = () => {
    toast("全曲结束。可以倒回任意位置再练一次。", "success", 3200);
  };
  playback.onCountIn = (num) => showCountIn(num);
  engine.onError = (err) => toast(`声音引擎没有启动：${err?.message || err}`, "error", 4500);
}

async function checkOcrHealth() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error("static deployment");
    const data = await res.json();
    if (data.lan_url) {
      dom.mobileUrl.textContent = data.lan_url;
      dom.btnCopyMobileUrl.disabled = false;
    } else if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
      dom.mobileUrl.textContent = location.origin + "/";
    } else {
      dom.mobileUrl.textContent = "未启用局域网访问";
      dom.btnCopyMobileUrl.disabled = true;
    }
    if (!data.ocr) {
      dom.imageReadNote.innerHTML = `<span class="read-dot"></span><p><b>简谱 OCR 不可用：</b>当前系统没有可用的 Windows OCR 语言包。五线谱识别和简谱文本输入仍然可用。</p>`;
    }
  } catch {
    // GitHub Pages / any static HTTPS deployment has no /api/ endpoint.
    // Keep everything local: staff OMR, text/MIDI import, audio and follow
    // mode still work; only the Windows-powered jianpu OCR is unavailable.
    state.staticMode = true;
    const hosted = location.protocol === "https:";
    dom.mobileUrl.textContent = hosted ? "在线版已部署" : "未连接到本地服务";
    dom.btnCopyMobileUrl.disabled = true;
    dom.imageReadNote.innerHTML = hosted
      ? `<span class="read-dot"></span><p><b>在线离线版：</b>简谱图片 OCR 需要 Windows 电脑，本版本不支持；请使用「简谱输入」。五线谱图片识别、文本/MIDI 导入和跟弹仍可正常使用。</p>`
      : `<span class="read-dot"></span><p><b>简谱 OCR 需要本地服务：</b>请通过 <code>启动琴谱工坊.bat</code> 打开应用。五线谱识谱和文本输入仍然可用。</p>`;
    const jianpuOption = dom.scoreImageType?.querySelector('option[value="jianpu"]');
    if (jianpuOption) {
      jianpuOption.disabled = true;
      jianpuOption.textContent = "简谱（请用文本输入）";
    }
    if (dom.scoreImageType?.value === "jianpu") {
      dom.scoreImageType.value = "staff";
      updateImportFooter();
    }
    const helpNote = document.querySelector(".help-mobile .mobile-note");
    if (helpNote) {
      helpNote.textContent = hosted
        ? "当前是已部署的在线离线版，添加到主屏幕后无需电脑。简谱图片 OCR 不可用，请使用简谱文本。"
        : "当前未连接局域网服务；五线谱识谱和简谱文本仍可使用。";
    }
    const helpKicker = document.querySelector(".help-mobile-head span");
    if (helpKicker && hosted) helpKicker.textContent = "ONLINE APP";
  }
}

function initRoll() {
  roll = new PianoRoll(dom.rollCanvas, {
    onChange: (score) => {
      state.score = score;
      updateReviewMeta();
      dom.btnStartPlay.disabled = !score.notes.length;
      dom.btnReviewListen.disabled = !score.notes.length;
      dom.btnPlayRoll.disabled = !score.notes.length;
      dom.rollEmpty.hidden = score.notes.length > 0;
      if (playback.isPlaying) playback.pause();
      if (playback.score === score) playback.updateScore(score);
      stage?.setScore(score);
      scheduleSave();
    },
    onSelect: renderInspector,
    onPreview: (midi, duration, velocity) => previewNote(midi, duration, velocity),
    onSeek: (beat) => {
      if (playback.isPlaying) playback.pause();
      playback.seek(beat, { preserve: false });
      stage?.draw();
    },
    onStatus: (message) => toast(message, "", 1700),
  });
}

function initStage() {
  stage = new StageView(dom.stageCanvas, {
    getBeat: () => playback.getPosition(),
    isCountingIn: () => playback.isCountingIn,
    onFrame: onStageFrame,
    onKeyDown: async (midi) => {
      await engine.resume();
      engine.preview(midi, 0.85, 0.72);
    },
  });
}

function init() {
  cacheDom();
  initPlaybackHooks();
  initRoll();
  initStage();
  initHero();
  bindEvents();
  loadProjects();
  setRangeFill(dom.reviewTempo);
  setRangeFill(dom.speedRange);
  updateImportFooter();
  dom.jianpuKey.value = "C";
  dom.jianpuTime.value = "4/4";
  dom.imageTime.value = "4/4";
  setupPwa();
  checkOcrHealth();
  switchView("home");

  const bootSplash = document.getElementById("bootSplash");
  if (bootSplash) {
    requestAnimationFrame(() => bootSplash.classList.add("is-hidden"));
    setTimeout(() => bootSplash.remove(), 420);
  }

  // Friendly deep links: ?demo=twinkle, ?demo=ode&autoplay=1
  const params = new URLSearchParams(location.search);
  const demoId = params.get("demo");
  if (demoId) {
    setTimeout(() => loadDemo(demoId, params.get("autoplay") === "1"), 120);
  } else if (params.get("dialog") === "import") {
    setTimeout(() => openImport("image"), 180);
  }
}

init();
