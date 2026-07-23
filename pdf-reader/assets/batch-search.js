import {
  buildSearchDocument,
  evaluatePageSearch,
  normalizeSearchText
} from "./search-utils.mjs";
import {
  assessTextLayerQuality,
  classifyAuditIssues,
  mergeRecognizedTexts,
  searchableCharacterCount,
  TEXT_QUALITY_LABELS
} from "./recognition-utils.mjs";

const DB_NAME = "pdf-reader-batch-index-v2";
const DB_VERSION = 1;
const PAGE_STORE = "pages";
const FILE_STORE = "files";
const OCR_CONFIDENCE_WARNING = 70;
const OCR_RETRY_CONFIDENCE = 60;
const OCR_FAST_MAX_PIXELS = 2000000;
const OCR_DETAIL_MAX_PIXELS = 4000000;
const OCR_FAST_MAX_SCALE = 1.8;
const OCR_DETAIL_MAX_SCALE = 2.5;
const OCR_FAST_MAX_EDGE = 4096;
const OCR_DETAIL_MAX_EDGE = 6144;
const OCR_DETAIL_PROFILE = {
  name: "精細",
  maxPixels: OCR_DETAIL_MAX_PIXELS,
  maxScale: OCR_DETAIL_MAX_SCALE,
  maxEdge: OCR_DETAIL_MAX_EDGE
};
const OCR_MODE_STORAGE_KEY = "pdfReader.batchOcrMode";
const OCR_MODES = {
  quick: {
    label: "快速",
    concurrency: 2,
    retryConfidence: null,
    fastProfile: {
      name: "快速",
      maxPixels: 1200000,
      maxScale: 1.35,
      maxEdge: 3000
    }
  },
  balanced: {
    label: "平衡",
    concurrency: 2,
    retryConfidence: 45,
    fastProfile: {
      name: "平衡",
      maxPixels: 1500000,
      maxScale: 1.55,
      maxEdge: 3400
    }
  },
  accurate: {
    label: "精準",
    concurrency: 1,
    retryConfidence: OCR_RETRY_CONFIDENCE,
    fastProfile: {
      name: "精準",
      maxPixels: OCR_FAST_MAX_PIXELS,
      maxScale: OCR_FAST_MAX_SCALE,
      maxEdge: OCR_FAST_MAX_EDGE
    }
  }
};
const SEARCH_RESULT_LIMIT = 100;
const AUDIT_DISPLAY_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 160;
const TESSERACT_MODULE_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm";
const CJK_CHARACTERS = "\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
const CJK_PUNCTUATION = ",.:;!?%()\\[\\]{}";
const SMART_SPACE_PATTERNS = [
  new RegExp(`([${CJK_CHARACTERS}])[ \\t]+(?=[${CJK_CHARACTERS}])`, "g"),
  new RegExp(`([${CJK_CHARACTERS}])[ \\t]+(?=[${CJK_PUNCTUATION}])`, "g"),
  new RegExp(`([${CJK_PUNCTUATION}])[ \\t]+(?=[${CJK_CHARACTERS}])`, "g")
];

const els = {
  pickFolderBtn: document.getElementById("pick-folder-btn"),
  fileInput: document.getElementById("batch-file-input"),
  clearBtn: document.getElementById("clear-index-btn"),
  status: document.getElementById("batch-status"),
  progress: document.getElementById("batch-progress"),
  pauseBtn: document.getElementById("pause-index-btn"),
  ocrMode: document.getElementById("ocr-mode"),
  search: document.getElementById("search-input"),
  searchMode: document.getElementById("search-mode"),
  results: document.getElementById("search-results"),
  summary: document.getElementById("index-summary"),
  files: document.getElementById("index-files"),
  exportBtn: document.getElementById("export-text-btn"),
  auditCount: document.getElementById("audit-count"),
  auditFilter: document.getElementById("audit-filter"),
  auditList: document.getElementById("audit-list"),
  exportReviewBtn: document.getElementById("export-review-btn"),
  batchTabs: Array.from(document.querySelectorAll("[data-batch-tab]")),
  batchPanels: Array.from(document.querySelectorAll("[data-batch-panel]")),
  readerFileInput: document.getElementById("file-input"),
  readerFileName: document.getElementById("file-name"),
  readerViewer: document.getElementById("viewer"),
  readerPrimaryCanvas: document.getElementById("pdf-canvas"),
  readerSecondaryCanvas: document.getElementById("pdf-canvas-secondary"),
  readerHighlightLayer: document.getElementById("pdf-highlight-layer"),
  readerPageLayout: document.getElementById("page-layout"),
  readerPageInput: document.getElementById("page-input"),
  readerPageCount: document.getElementById("page-count"),
  readerPrevBtn: document.getElementById("prev"),
  readerNextBtn: document.getElementById("next"),
  readerZoomInBtn: document.getElementById("zoom-in"),
  readerZoomOutBtn: document.getElementById("zoom-out"),
  readerZoomLevel: document.getElementById("zoom-level"),
  readerStatus: document.getElementById("status"),
  readerText: document.getElementById("text-output"),
  readerCopyBtn: document.getElementById("copy-btn"),
  readerStripBtn: document.getElementById("strip-btn"),
  batchDivider: document.getElementById("batch-divider"),
  batchPanel: document.querySelector(".batch-panel"),
  workspace: document.querySelector(".workspace")
};

const state = {
  db: null,
  indexing: false,
  fileSources: new Map(),
  indexedFiles: [],
  indexedPages: [],
  searchTimer: null,
  ocrModulePromise: null,
  ocrWorkerPromises: [],
  currentOcrLabels: [],
  reviewingPageId: null,
  pauseAvailable: false,
  pauseRequested: false,
  paused: false,
  pauseResolvers: [],
  readerPreviewPdf: null,
  readerPreviewFileName: "",
  readerPreviewToken: 0,
  activeHighlight: null,
  highlightToken: 0,
  currentSearchTerms: []
};

function setStatus(message) {
  els.status.textContent = message;
}

function setProgress(done, total) {
  els.progress.hidden = !total;
  els.progress.max = Math.max(total, 1);
  els.progress.value = done;
}

function selectedOcrMode() {
  return OCR_MODES[els.ocrMode.value] || OCR_MODES.balanced;
}

function updatePauseButton() {
  els.pauseBtn.disabled = !state.indexing || !state.pauseAvailable;
  els.pauseBtn.textContent = state.pauseRequested ? "繼續" : "暫停";
  els.pauseBtn.classList.toggle("btn--primary", state.pauseRequested);
  els.pauseBtn.setAttribute("aria-pressed", String(state.pauseRequested));
}

function releasePauseWaiters() {
  const resolvers = state.pauseResolvers.splice(0);
  for (const resolve of resolvers) resolve();
}

function setIndexing(active, pauseAvailable = false) {
  state.indexing = active;
  state.pauseAvailable = active && pauseAvailable;
  if (!active) {
    state.pauseRequested = false;
    state.paused = false;
    releasePauseWaiters();
  }
  els.pickFolderBtn.disabled = active;
  els.fileInput.disabled = active;
  els.clearBtn.disabled = active;
  els.exportBtn.disabled = active || !state.indexedPages.length;
  els.ocrMode.disabled = active;
  updatePauseButton();
  renderQualityAudit();
}

function toggleIndexPause() {
  if (!state.indexing || !state.pauseAvailable) return;
  if (state.pauseRequested) {
    state.pauseRequested = false;
    state.paused = false;
    releasePauseWaiters();
    setStatus("正在繼續批次索引…");
  } else {
    state.pauseRequested = true;
    setStatus("將在目前頁面辨識完成後暫停…");
  }
  updatePauseButton();
}

async function waitWhilePaused(label) {
  if (!state.pauseAvailable || !state.pauseRequested) return;
  state.paused = true;
  updatePauseButton();
  setStatus(`已暫停：${label}`);
  await new Promise(resolve => state.pauseResolvers.push(resolve));
  state.paused = false;
  updatePauseButton();
  if (state.indexing) setStatus(`繼續處理：${label}`);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function openDb() {
  if (state.db) return state.db;
  state.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PAGE_STORE)) {
        const store = db.createObjectStore(PAGE_STORE, { keyPath: "id" });
        store.createIndex("fileId", "fileId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return state.db;
}

async function getAll(storeName) {
  const db = await openDb();
  return requestToPromise(db.transaction(storeName).objectStore(storeName).getAll());
}

async function clearIndexStores() {
  const db = await openDb();
  const tx = db.transaction([FILE_STORE, PAGE_STORE], "readwrite");
  tx.objectStore(FILE_STORE).clear();
  tx.objectStore(PAGE_STORE).clear();
  await txDone(tx);
}

async function replaceFileIndex(fileRecord, pages) {
  const db = await openDb();
  const tx = db.transaction([FILE_STORE, PAGE_STORE], "readwrite");
  const pageStore = tx.objectStore(PAGE_STORE);
  const oldKeys = await requestToPromise(pageStore.index("fileId").getAllKeys(fileRecord.id));
  for (const key of oldKeys) pageStore.delete(key);
  for (const page of pages) pageStore.put(page);
  tx.objectStore(FILE_STORE).put(fileRecord);
  await txDone(tx);
}

async function upsertFileIndexPage(fileRecord, page) {
  const db = await openDb();
  const tx = db.transaction([FILE_STORE, PAGE_STORE], "readwrite");
  tx.objectStore(PAGE_STORE).put(page);
  tx.objectStore(FILE_STORE).put(fileRecord);
  await txDone(tx);
}

async function putFileRecord(fileRecord) {
  const db = await openDb();
  const tx = db.transaction(FILE_STORE, "readwrite");
  tx.objectStore(FILE_STORE).put(fileRecord);
  await txDone(tx);
}

async function putPageRecord(page) {
  const db = await openDb();
  const tx = db.transaction(PAGE_STORE, "readwrite");
  tx.objectStore(PAGE_STORE).put(page);
  await txDone(tx);
}

async function getFileIndexSnapshot(fileId) {
  const db = await openDb();
  const tx = db.transaction([FILE_STORE, PAGE_STORE], "readonly");
  const completion = txDone(tx);
  const recordRequest = tx.objectStore(FILE_STORE).get(fileId);
  const pagesRequest = tx.objectStore(PAGE_STORE).index("fileId").getAll(fileId);
  const [record, pages] = await Promise.all([
    requestToPromise(recordRequest),
    requestToPromise(pagesRequest)
  ]);
  await completion;
  return {
    record,
    pages: pages.sort((left, right) => left.page - right.page)
  };
}

async function createFileFingerprint(file) {
  const sampleSize = 65536;
  const first = await file.slice(0, sampleSize).arrayBuffer();
  const lastStart = Math.max(0, file.size - sampleSize);
  const last = await file.slice(lastStart, file.size).arrayBuffer();
  const metadata = new TextEncoder().encode(`${file.size}:${file.name}:`);
  const bytes = new Uint8Array(metadata.length + first.byteLength + last.byteLength);
  bytes.set(metadata, 0);
  bytes.set(new Uint8Array(first), metadata.length);
  bytes.set(new Uint8Array(last), metadata.length + first.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

function fileMatchesIndex(file, fingerprint, record) {
  if (!record || record.size !== file.size) return false;
  if (record.fingerprint && fingerprint) return record.fingerprint === fingerprint;
  return record.lastModified === file.lastModified;
}

function removeSmartSpaces(text) {
  let normalized = text;
  let previous;
  do {
    previous = normalized;
    for (const pattern of SMART_SPACE_PATTERNS) {
      normalized = normalized.replace(pattern, "$1");
    }
  } while (normalized !== previous);
  return normalized;
}

function normalizeSpace(text) {
  const collapsed = String(text || "").replace(/\s+/g, " ").trim();
  return removeSmartSpaces(collapsed);
}

function combineSearchSources(...values) {
  const seen = new Set();
  const sources = [];
  for (const value of values) {
    const source = normalizeSpace(value);
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  return sources.join("\n");
}

function hasUsefulText(text) {
  return searchableCharacterCount(text) >= 3;
}

function extractTextItems(content) {
  let text = "";
  for (const item of content.items || []) {
    if (typeof item.str !== "string") continue;
    text += item.str;
    text += item.hasEOL ? "\n" : " ";
  }
  return normalizeSpace(text);
}

function getAdaptiveOcrScale(page, maxPixels, maxScale, maxEdge) {
  const baseViewport = page.getViewport({ scale: 1 });
  const basePixels = Math.max(1, baseViewport.width * baseViewport.height);
  const pixelScale = Math.sqrt(maxPixels / basePixels);
  const edgeScale = maxEdge / Math.max(baseViewport.width, baseViewport.height, 1);
  return Math.max(0.25, Math.min(maxScale, pixelScale, edgeScale));
}

async function renderPageForOcr(page, profile) {
  const scale = getAdaptiveOcrScale(page, profile.maxPixels, profile.maxScale, profile.maxEdge);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return { canvas, scale };
}

function isLikelyBlankCanvas(canvas) {
  const sample = document.createElement("canvas");
  sample.width = 64;
  sample.height = 64;
  const context = sample.getContext("2d", { alpha: false, willReadFrequently: true });
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  let darkPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
    if (luminance < 238) darkPixels += 1;
  }
  sample.width = 1;
  sample.height = 1;
  return darkPixels / (pixels.length / 4) < 0.0015;
}

async function getOcrWorker(slot) {
  if (!state.ocrModulePromise) {
    state.ocrModulePromise = import(TESSERACT_MODULE_URL).catch(error => {
      state.ocrModulePromise = null;
      throw new Error(`無法載入 OCR 引擎：${error.message || error}`);
    });
  }
  if (!state.ocrWorkerPromises[slot]) {
    state.ocrWorkerPromises[slot] = state.ocrModulePromise
      .then(({ createWorker }) => createWorker("chi_tra+eng", 1, {
        logger(message) {
          const label = state.currentOcrLabels[slot];
          if (message.status === "recognizing text" && label) {
            setStatus(`${label}：OCR ${Math.round(message.progress * 100)}%`);
          }
        }
      }))
      .catch(error => {
        state.ocrWorkerPromises[slot] = null;
        throw new Error(`無法載入 OCR 引擎：${error.message || error}`);
      });
  }
  return state.ocrWorkerPromises[slot];
}

function releaseCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
  canvas.remove();
}

function collectOcrWords(data) {
  if (Array.isArray(data?.words) && data.words.length) return data.words;
  const words = [];
  for (const block of data?.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        words.push(...(line.words || []));
      }
    }
  }
  return words;
}

function normalizeOcrWordBoxes(data, canvas) {
  if (!canvas.width || !canvas.height) return [];
  return collectOcrWords(data).flatMap(word => {
    const box = word?.bbox;
    const text = normalizeSpace(word?.text);
    if (!text || !box) return [];
    const x0 = Math.max(0, Math.min(canvas.width, Number(box.x0) || 0));
    const y0 = Math.max(0, Math.min(canvas.height, Number(box.y0) || 0));
    const x1 = Math.max(x0, Math.min(canvas.width, Number(box.x1) || 0));
    const y1 = Math.max(y0, Math.min(canvas.height, Number(box.y1) || 0));
    if (x1 <= x0 || y1 <= y0) return [];
    return [{
      text,
      x: x0 / canvas.width,
      y: y0 / canvas.height,
      width: (x1 - x0) / canvas.width,
      height: (y1 - y0) / canvas.height
    }];
  });
}

async function runOcrPass(page, label, profile, slot = 0) {
  setStatus(`${label}：準備${profile.name}辨識…`);
  const { canvas, scale } = await renderPageForOcr(page, profile);
  if (isLikelyBlankCanvas(canvas)) {
    releaseCanvas(canvas);
    return { text: "", confidence: null, words: [], scale, blank: true };
  }
  state.currentOcrLabels[slot] = `${label}（${profile.name}）`;
  try {
    const worker = await getOcrWorker(slot);
    const { data } = await worker.recognize(canvas);
    return {
      text: normalizeSpace(data.text),
      confidence: Number.isFinite(data.confidence) ? Math.round(data.confidence) : null,
      words: normalizeOcrWordBoxes(data, canvas),
      scale,
      blank: false
    };
  } finally {
    state.currentOcrLabels[slot] = "";
    releaseCanvas(canvas);
  }
}

function usefulCharacterCount(text) {
  return searchableCharacterCount(text);
}

function shouldRetryOcr(result, mode) {
  if (result.blank || mode.retryConfidence === null) return false;
  return usefulCharacterCount(result.text) < 8
    || !Number.isFinite(result.confidence)
    || result.confidence < mode.retryConfidence;
}

function ocrResultScore(result) {
  const confidence = Number.isFinite(result.confidence) ? result.confidence : 0;
  return confidence + Math.min(usefulCharacterCount(result.text), 200) / 4;
}

async function recognizePage(page, label, mode, slot = 0) {
  const fastResult = await runOcrPass(page, label, mode.fastProfile, slot);
  const detailScale = getAdaptiveOcrScale(
    page,
    OCR_DETAIL_PROFILE.maxPixels,
    OCR_DETAIL_PROFILE.maxScale,
    OCR_DETAIL_PROFILE.maxEdge
  );

  if (!shouldRetryOcr(fastResult, mode) || detailScale <= fastResult.scale * 1.05) {
    return { ...fastResult, refined: false, selectedPass: "fast" };
  }

  await waitWhilePaused(`${label}，等待精細辨識`);
  const detailResult = await runOcrPass(page, label, OCR_DETAIL_PROFILE, slot);
  const selected = ocrResultScore(detailResult) >= ocrResultScore(fastResult)
    ? { ...detailResult, selectedPass: "detail" }
    : { ...fastResult, selectedPass: "fast" };
  return { ...selected, refined: true };
}

async function recognizePageDetailed(page, label) {
  const result = await runOcrPass(page, label, OCR_DETAIL_PROFILE, 0);
  return { ...result, refined: true, selectedPass: "detail" };
}

function calculateMetrics(pages, totalPages = pages.length) {
  const recognizedPages = pages.filter(page => hasUsefulText(page.searchText || page.text)).length;
  const ocrPages = pages.filter(page => page.method === "ocr" || page.method === "hybrid");
  const confidences = ocrPages
    .map(page => page.confidence)
    .filter(Number.isFinite);
  const ocrAverageConfidence = confidences.length
    ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length)
    : null;
  const lowConfidencePages = ocrPages
    .filter(page => !hasUsefulText(page.searchText || page.text)
      || !Number.isFinite(page.confidence)
      || page.confidence < OCR_CONFIDENCE_WARNING)
    .map(page => page.page);
  const suspiciousTextLayerPages = pages
    .filter(page => page.method === "hybrid" && (page.qualityFlags || []).length)
    .map(page => page.page);

  return {
    totalPages,
    processedPages: pages.length,
    recognizedPages,
    recognitionRate: totalPages ? Math.round(recognizedPages / totalPages * 100) : 0,
    textLayerPages: pages.filter(page => page.method === "text-layer").length,
    ocrPages: ocrPages.length,
    hybridPages: pages.filter(page => page.method === "hybrid").length,
    refinedOcrPages: ocrPages.filter(page => page.refined).length,
    ocrAverageConfidence,
    lowConfidencePages,
    suspiciousTextLayerPages
  };
}

async function extractPdfPage(pdf, fileId, displayPath, pageNumber, totalPages, mode, slot) {
  setStatus(`建立索引中：${displayPath}（第 ${pageNumber}/${totalPages} 頁）`);
  const page = await pdf.getPage(pageNumber);
  try {
    const textLayerText = extractTextItems(await page.getTextContent());
    const quality = assessTextLayerQuality(textLayerText);
    let text = textLayerText;
    let searchText = textLayerText;
    let ocrText = "";
    let method = "text-layer";
    let confidence = null;
    let refined = false;
    let selectedPass = null;
    let ocrWords = [];

    if (quality.needsOcr) {
      const qualityReason = quality.flags
        .map(flag => TEXT_QUALITY_LABELS[flag] || flag)
        .join("、");
      const result = await recognizePage(
        page,
        `${displayPath} 第 ${pageNumber} 頁（${qualityReason}）`,
        mode,
        slot
      );
      ocrText = result.text;
      confidence = result.confidence;
      ocrWords = result.words || [];
      refined = result.refined;
      selectedPass = result.selectedPass;
      method = quality.hasUsableText ? "hybrid" : "ocr";
      const merged = mergeRecognizedTexts(textLayerText, ocrText);
      text = merged.primaryText;
      searchText = merged.searchText;
    }

    return {
      id: `${fileId}::${pageNumber}`,
      fileId,
      page: pageNumber,
      text,
      searchText,
      textLayerText,
      ocrText,
      ocrWords,
      method,
      confidence,
      qualityFlags: quality.flags,
      refined,
      selectedPass
    };
  } finally {
    page.cleanup();
  }
}

async function extractPdf(file, fileId, displayPath, options = {}) {
  const pdfjs = globalThis.pdfjsLib;
  if (!pdfjs?.getDocument) throw new Error("PDF.js 尚未完成載入");

  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const mode = options.mode || OCR_MODES.balanced;
  const pages = [...(options.existingPages || [])];
  const existingPageNumbers = new Set(pages.map(page => page.page));
  const pendingPageNumbers = Array.from(
    { length: totalPages },
    (_, index) => index + 1
  ).filter(pageNumber => !existingPageNumbers.has(pageNumber));
  let nextPageIndex = 0;
  let persistenceQueue = Promise.resolve();

  try {
    async function runWorker(slot) {
      while (true) {
        await waitWhilePaused(`${displayPath}，等待第 ${nextPageIndex + 1} 個索引工作`);
        const pageNumber = pendingPageNumbers[nextPageIndex];
        nextPageIndex += 1;
        if (!pageNumber) return;
        const indexedPage = await extractPdfPage(
          pdf,
          fileId,
          displayPath,
          pageNumber,
          totalPages,
          mode,
          slot
        );
        pages.push(indexedPage);
        if (options.onPageIndexed) {
          const pageSnapshot = [...pages].sort((left, right) => left.page - right.page);
          persistenceQueue = persistenceQueue.then(() => (
            options.onPageIndexed(indexedPage, pageSnapshot, totalPages)
          ));
          await persistenceQueue;
        }
      }
    }
    const workerCount = Math.max(1, Math.min(mode.concurrency, pendingPageNumbers.length || 1));
    await Promise.all(Array.from({ length: workerCount }, (_, slot) => runWorker(slot)));
    await persistenceQueue;
  } finally {
    await pdf.destroy();
  }

  pages.sort((left, right) => left.page - right.page);
  return { pages, metrics: calculateMetrics(pages, totalPages), totalPages };
}

function makeFileRecord(file, handle, path, metrics, fingerprint = null) {
  return {
    id: path,
    name: file.name,
    path,
    size: file.size,
    lastModified: file.lastModified,
    fingerprint,
    handle,
    indexedAt: Date.now(),
    ...metrics
  };
}

async function indexFiles(items) {
  if (state.indexing) return;
  const pdfs = items.filter(({ file }) => file && (/\.pdf$/i.test(file.name) || file.type === "application/pdf"));
  if (!pdfs.length) {
    setStatus("沒有找到 PDF 檔案。");
    return;
  }

  setIndexing(true, true);
  setProgress(0, pdfs.length);
  let succeeded = 0;
  let skipped = 0;
  const failures = [];
  const mode = selectedOcrMode();

  try {
    for (let index = 0; index < pdfs.length; index += 1) {
      const { file, handle = null } = pdfs[index];
      const path = pdfs[index].path || file.webkitRelativePath || file.name;
      await waitWhilePaused(`${path}（第 ${index + 1}/${pdfs.length} 份）`);
      try {
        state.fileSources.set(path, { file, handle });
        setStatus(`檢查檔案是否需要更新：${path}`);
        let fingerprint = null;
        try {
          fingerprint = await createFileFingerprint(file);
        } catch (error) {
          console.warn("無法建立檔案指紋，改用檔案時間判斷。", error);
        }
        const snapshot = await getFileIndexSnapshot(path);
        const matchesExisting = fileMatchesIndex(file, fingerprint, snapshot.record);
        const existingPages = matchesExisting ? snapshot.pages : [];
        const indexedPageNumbers = new Set(existingPages.map(page => page.page));
        const complete = matchesExisting
          && snapshot.record.totalPages > 0
          && indexedPageNumbers.size >= snapshot.record.totalPages
          && Array.from(
            { length: snapshot.record.totalPages },
            (_, pageIndex) => indexedPageNumbers.has(pageIndex + 1)
          ).every(Boolean);
        if (complete) {
          skipped += 1;
          setStatus(`未修改，沿用既有索引：${path}`);
          await refreshCache();
          continue;
        }

        let partialIndexStarted = existingPages.length > 0;
        const resumeText = partialIndexStarted
          ? `（續跑，已完成 ${existingPages.length} 頁）`
          : "";
        setStatus(`準備${mode.label}索引：${path}${resumeText}`);
        const { metrics } = await extractPdf(file, path, path, {
          mode,
          existingPages,
          onPageIndexed: async (page, processedPages, totalPages) => {
            const partialMetrics = calculateMetrics(processedPages, totalPages);
            const partialRecord = makeFileRecord(
              file,
              handle,
              path,
              partialMetrics,
              fingerprint
            );
            if (!partialIndexStarted) {
              await replaceFileIndex(partialRecord, [page]);
              partialIndexStarted = true;
            } else {
              await upsertFileIndexPage(partialRecord, page);
            }
            setProgress(processedPages.length, totalPages);
            await refreshCache();
          }
        });
        const record = makeFileRecord(file, handle, path, metrics, fingerprint);
        if (!partialIndexStarted) {
          await replaceFileIndex(record, []);
        } else {
          await putFileRecord(record);
        }
        succeeded += 1;
      } catch (error) {
        console.error(error);
        failures.push({ path, message: error.message || String(error) });
      }
      await refreshCache();
    }
  } finally {
    setProgress(0, 0);
    setIndexing(false);
  }

  if (failures.length) {
    setStatus(`完成 ${succeeded} 份，沿用 ${skipped} 份，失敗 ${failures.length} 份：${failures.map(item => item.path).join("、")}`);
  } else {
    setStatus(`索引完成：新增或續跑 ${succeeded} 份，沿用未修改 ${skipped} 份（${mode.label}模式）。`);
  }
}

async function pickFolder() {
  if (!globalThis.showDirectoryPicker) {
    els.fileInput.click();
    return;
  }

  let root;
  try {
    root = await showDirectoryPicker({ mode: "read" });
  } catch (error) {
    if (error.name === "AbortError") return;
    throw error;
  }

  const items = [];
  async function walk(dirHandle, prefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      const path = `${prefix}/${name}`;
      if (handle.kind === "directory") {
        await walk(handle, path);
      } else if (/\.pdf$/i.test(name)) {
        items.push({ file: await handle.getFile(), handle, path });
      }
    }
  }

  await walk(root, root.name);
  await indexFiles(items);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function fileMetricText(file) {
  const parts = [
    `可搜尋 ${file.recognizedPages}/${file.totalPages} 頁（${file.recognitionRate}%）`
  ];
  if (Number.isFinite(file.processedPages) && file.processedPages < file.totalPages) {
    parts.unshift(`處理進度 ${file.processedPages}/${file.totalPages} 頁`);
  }
  if (file.ocrPages) {
    parts.push(`含 OCR ${file.ocrPages} 頁`);
    if (file.hybridPages) parts.push(`混合辨識 ${file.hybridPages} 頁`);
    if (file.refinedOcrPages) parts.push(`精細重辨 ${file.refinedOcrPages} 頁`);
    parts.push(Number.isFinite(file.ocrAverageConfidence)
      ? `平均信心 ${file.ocrAverageConfidence}%`
      : "無可用 OCR 信心");
  } else {
    parts.push("全部來自原生文字層");
  }
  if (file.lowConfidencePages?.length) {
    parts.push(`低信心／無文字：第 ${file.lowConfidencePages.join("、")} 頁`);
  }
  if (file.suspiciousTextLayerPages?.length) {
    parts.push(`可疑文字層：第 ${file.suspiciousTextLayerPages.join("、")} 頁`);
  }
  return parts.join(" · ");
}

function renderFileNotes() {
  if (!state.indexedFiles.length) {
    els.files.innerHTML = "";
    return;
  }
  els.files.innerHTML = state.indexedFiles.map(file => {
    const warning = file.lowConfidencePages?.length || file.suspiciousTextLayerPages?.length
      ? " file-index-item--warning"
      : "";
    return `
      <div class="file-index-item${warning}">
        <div class="file-index-name">${escapeHtml(file.path || file.name)}</div>
        <div class="file-index-metrics">${escapeHtml(fileMetricText(file))}</div>
        ${file.ocrPages ? '<div class="file-index-help">可疑文字層會保留原文並補跑 OCR；信心值不等於人工校對正確率。</div>' : ""}
      </div>
    `;
  }).join("");
}

function pageSourceLabel(page) {
  if (page.method === "hybrid") return "文字層＋OCR";
  if (page.method === "ocr") return "OCR";
  return "PDF 文字層";
}

function pageQualityText(page) {
  return (page.qualityFlags || [])
    .map(flag => TEXT_QUALITY_LABELS[flag] || flag)
    .join("、");
}

function indexedPageDisplayText(page) {
  if (page.method === "hybrid" && page.textLayerText && page.ocrText) {
    return `【PDF 文字層】\n${page.textLayerText}\n\n【OCR 補充】\n${page.ocrText}`;
  }
  return page.text || page.searchText || "";
}

function setBatchTab(tabName) {
  for (const tab of els.batchTabs) {
    const active = tab.dataset.batchTab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of els.batchPanels) {
    const active = panel.dataset.batchPanel === tabName;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
}

const AUDIT_ISSUE_LABELS = {
  "low-confidence": "OCR 低信心",
  unrecognized: "未辨識到可搜尋文字",
  suspicious: "可疑文字層",
  refined: "已精細重辨"
};

function auditIssuesForPage(page) {
  return classifyAuditIssues(page, OCR_CONFIDENCE_WARNING);
}

function auditPriority(entry) {
  if (entry.issues.includes("unrecognized")) return 0;
  if (entry.issues.includes("low-confidence")) return 1;
  if (entry.issues.includes("suspicious")) return 2;
  return 3;
}

function getAuditEntries(filter = "all") {
  return state.indexedPages
    .map(page => ({ page, issues: auditIssuesForPage(page) }))
    .filter(entry => entry.issues.length && (filter === "all" || entry.issues.includes(filter)))
    .sort((left, right) => (
      auditPriority(left) - auditPriority(right)
      || left.page.fileId.localeCompare(right.page.fileId)
      || left.page.page - right.page.page
    ));
}

function renderQualityAudit() {
  if (!els.auditList) return;
  const allEntries = getAuditEntries();
  const entries = getAuditEntries(els.auditFilter.value);
  const files = new Map(state.indexedFiles.map(file => [file.id, file]));
  els.auditCount.textContent = String(allEntries.length);
  els.exportReviewBtn.disabled = state.indexing || !allEntries.length;

  if (!entries.length) {
    els.auditList.innerHTML = '<div class="audit-empty">此分類目前沒有需要複核的頁面。</div>';
    return;
  }

  const visibleEntries = entries.slice(0, AUDIT_DISPLAY_LIMIT);
  const overflow = entries.length > AUDIT_DISPLAY_LIMIT
    ? `<div class="audit-empty">另有 ${entries.length - AUDIT_DISPLAY_LIMIT} 頁，請匯出清單查看。</div>`
    : "";
  els.auditList.innerHTML = visibleEntries.map(({ page, issues }) => {
    const file = files.get(page.fileId);
    const issueText = issues.map(issue => AUDIT_ISSUE_LABELS[issue]).join("、");
    const quality = pageQualityText(page);
    const confidence = Number.isFinite(page.confidence) ? `${page.confidence}%` : "無";
    const recheckLabel = page.refined ? "再次精細辨識" : "精細辨識此頁";
    const reviewing = state.reviewingPageId === page.id;
    const disabled = state.indexing ? " disabled" : "";
    return `
      <div class="audit-item">
        <div class="audit-item__file">${escapeHtml(file?.path || file?.name || page.fileId)}</div>
        <div class="audit-item__meta">第 ${page.page} 頁 · ${pageSourceLabel(page)} · OCR 信心 ${confidence}</div>
        <div class="audit-item__issues">${escapeHtml(issueText)}${quality ? ` · ${escapeHtml(quality)}` : ""}</div>
        <div class="audit-item__actions">
          <button class="btn" data-audit-action="open" data-file-id="${escapeHtml(page.fileId)}" data-page="${page.page}"${disabled}>開啟頁面</button>
          <button class="btn btn--primary" data-audit-action="reocr" data-file-id="${escapeHtml(page.fileId)}" data-page="${page.page}"${disabled}>${reviewing ? "辨識中…" : recheckLabel}</button>
        </div>
      </div>
    `;
  }).join("") + overflow;
}

function csvCell(value) {
  const text = String(value ?? "");
  const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function exportReviewList() {
  const files = new Map(state.indexedFiles.map(file => [file.id, file]));
  const rows = [[
    "檔案",
    "頁碼",
    "辨識來源",
    "OCR 信心",
    "稽核項目",
    "品質原因",
    "精細重辨",
    "最近重辨時間"
  ]];
  for (const { page, issues } of getAuditEntries()) {
    const file = files.get(page.fileId);
    rows.push([
      file?.path || file?.name || page.fileId,
      page.page,
      pageSourceLabel(page),
      Number.isFinite(page.confidence) ? page.confidence : "",
      issues.map(issue => AUDIT_ISSUE_LABELS[issue]).join("、"),
      pageQualityText(page),
      page.refined ? "是" : "否",
      page.reviewedAt ? new Date(page.reviewedAt).toLocaleString("zh-TW") : ""
    ]);
  }
  const csv = "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "pdf-quality-review.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stripSearchQuotes(term) {
  const quotePairs = [["\"", "\""], ["'", "'"], ["「", "」"], ["『", "』"]];
  for (const [open, close] of quotePairs) {
    if (term.startsWith(open) && term.endsWith(close) && term.length > open.length + close.length) {
      return term.slice(open.length, -close.length).trim();
    }
  }
  return term;
}

function parseSearchTerms(value) {
  const seen = new Set();
  return value
    .split(/[&＆]+/)
    .map(term => normalizeSpace(stripSearchQuotes(term.trim())))
    .filter(term => {
      const key = normalizeSearchText(term);
      if (!term || !key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function highlightRanges(text, ranges) {
  const sortedRanges = ranges
    .filter(range => range && range.end > range.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let html = "";
  let cursor = 0;
  for (const range of sortedRanges) {
    if (range.end <= cursor) continue;
    const start = Math.max(cursor, range.start);
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark>${escapeHtml(text.slice(start, range.end))}</mark>`;
    cursor = range.end;
  }
  return html + escapeHtml(text.slice(cursor));
}

function makeSnippet(text, termMatches) {
  const hitRanges = termMatches
    .filter(Boolean)
    .map(match => ({ start: match.start, end: match.end }));
  const snippetRanges = hitRanges
    .map(range => ({
      start: Math.max(0, range.start - 36),
      end: Math.min(text.length, range.end + 56)
    }))
    .sort((a, b) => a.start - b.start);

  if (!snippetRanges.length) return escapeHtml(text.slice(0, 140));
  const merged = [];
  for (const range of snippetRanges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 20) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged.map(range => {
    const localHits = hitRanges
      .filter(hit => hit.end > range.start && hit.start < range.end)
      .map(hit => ({
        start: Math.max(0, hit.start - range.start),
        end: Math.min(range.end, hit.end) - range.start
      }));
    const snippet = highlightRanges(text.slice(range.start, range.end), localHits);
    return `${range.start ? "..." : ""}${snippet}${range.end < text.length ? "..." : ""}`;
  }).join('<span class="result-snippet-separator"> ｜ </span>');
}

const SEARCH_TIER_DETAILS = {
  exact: { label: "完全符合", rank: 0 },
  normalized: { label: "正規化符合", rank: 1 },
  fuzzy: { label: "疑似符合", rank: 2 },
  partial: { label: "部分符合", rank: 3 }
};

function runSearch() {
  const terms = parseSearchTerms(els.search.value);
  state.currentSearchTerms = terms;
  if (!terms.length) {
    els.results.innerHTML = state.indexedPages.length
      ? `<div class="empty-results">已索引 ${state.indexedPages.length} 頁，輸入文字開始搜尋。</div>`
      : '<div class="empty-results">尚未建立索引。</div>';
    return;
  }

  const mode = els.searchMode.value;
  const matches = state.indexedPages
    .map(page => ({
      page,
      evaluation: evaluatePageSearch(page.searchDocument, terms, mode)
    }))
    .filter(item => item.evaluation)
    .sort((left, right) => (
      SEARCH_TIER_DETAILS[left.evaluation.tier].rank - SEARCH_TIER_DETAILS[right.evaluation.tier].rank
      || right.evaluation.score - left.evaluation.score
      || left.page.fileId.localeCompare(right.page.fileId)
      || left.page.page - right.page.page
    ));
  if (!matches.length) {
    const modeHelp = mode === "strict"
      ? "可切換成「防漏」模式，查看部分條件或模糊符合的頁面。"
      : "沒有發現完全、模糊或部分符合的頁面。";
    els.results.innerHTML = `<div class="empty-results">沒有找到「${escapeHtml(terms.join("」及「"))}」。${modeHelp}</div>`;
    return;
  }

  const files = new Map(state.indexedFiles.map(file => [file.id, file]));
  const visibleMatches = matches.slice(0, SEARCH_RESULT_LIMIT);
  const summary = mode === "recall"
    ? `防漏模式找到 ${matches.length} 頁，包含模糊及部分條件符合。`
    : `嚴格模式找到 ${matches.length} 頁，每個條件都必須符合。`;
  els.results.innerHTML = `
    <div class="search-result-summary">
      ${summary}${matches.length > SEARCH_RESULT_LIMIT ? ` 僅顯示前 ${SEARCH_RESULT_LIMIT} 筆。` : ""}
    </div>
  ` + visibleMatches.map(({ page, evaluation }) => {
    const file = files.get(page.fileId);
    const confidence = (page.method === "ocr" || page.method === "hybrid") && Number.isFinite(page.confidence)
      ? ` · OCR 信心 ${page.confidence}%`
      : "";
    const source = ` · ${pageSourceLabel(page)}`;
    const quality = pageQualityText(page);
    const qualityNote = quality ? ` · 品質提醒：${quality}` : "";
    const refined = page.refined ? " · 已精細重辨" : "";
    const compound = terms.length > 1
      ? ` · 同頁符合 ${evaluation.matchedCount}/${terms.length} 個詞`
      : "";
    const tier = SEARCH_TIER_DETAILS[evaluation.tier];
    return `
      <button class="result-item" data-file-id="${escapeHtml(page.fileId)}" data-page="${page.page}">
        <div class="result-file">${escapeHtml(file?.path || file?.name || page.fileId)}</div>
        <div class="result-meta">
          <span class="result-match-badge result-match-badge--${evaluation.tier}">${tier.label}</span>
          相似度 ${evaluation.score}% · 第 ${page.page} 頁${source}${confidence}${refined}${compound}${qualityNote}
        </div>
        <div class="result-snippet">${makeSnippet(page.searchCorpus, evaluation.termMatches)}</div>
      </button>
    `;
  }).join("");
}

async function refreshCache() {
  const [files, pages] = await Promise.all([getAll(FILE_STORE), getAll(PAGE_STORE)]);
  state.indexedFiles = files.sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name));
  const filesById = new Map(state.indexedFiles.map(file => [file.id, file]));
  state.indexedPages = pages.map(page => {
    const text = normalizeSpace(page.text);
    const searchText = normalizeSpace(page.searchText || text);
    const textLayerText = normalizeSpace(page.textLayerText
      || (page.method === "text-layer" ? text : ""));
    const ocrText = normalizeSpace(page.ocrText
      || (page.method === "ocr" ? text : ""));
    const file = filesById.get(page.fileId);
    const filePath = page.page === 1
      ? file?.path || file?.name || page.fileId
      : "";
    const searchCorpus = combineSearchSources(
      filePath,
      page.searchText,
      page.text,
      page.textLayerText,
      page.ocrText
    );
    return {
      ...page,
      text,
      searchText,
      searchCorpus,
      textLayerText,
      ocrText,
      ocrWords: Array.isArray(page.ocrWords) ? page.ocrWords : [],
      qualityFlags: Array.isArray(page.qualityFlags) ? page.qualityFlags : [],
      refined: Boolean(page.refined),
      searchDocument: buildSearchDocument(searchCorpus)
    };
  });
  const recognizedPages = state.indexedPages.filter(page => hasUsefulText(page.searchText)).length;
  const hybridPages = state.indexedPages.filter(page => page.method === "hybrid").length;
  const qualitySummary = hybridPages ? `，${hybridPages} 頁採文字層＋OCR 混合辨識` : "";
  els.summary.textContent = `索引庫：${files.length} 份 PDF，共 ${pages.length} 頁；其中 ${recognizedPages} 頁可搜尋${qualitySummary}。`;
  els.exportBtn.disabled = state.indexing || !pages.length;
  renderFileNotes();
  renderQualityAudit();
  runSearch();
}

async function loadFileRecord(fileId) {
  const db = await openDb();
  return requestToPromise(db.transaction(FILE_STORE).objectStore(FILE_STORE).get(fileId));
}

async function getFileForResult(fileId) {
  const source = state.fileSources.get(fileId);
  if (source?.file) return source.file;
  const record = await loadFileRecord(fileId);
  if (!record?.handle) throw new Error("此 PDF 需要重新選取原資料夾後才能開啟。");

  if (record.handle.queryPermission) {
    let permission = await record.handle.queryPermission({ mode: "read" });
    if (permission !== "granted" && record.handle.requestPermission) {
      permission = await record.handle.requestPermission({ mode: "read" });
    }
    if (permission !== "granted") throw new Error("尚未取得此 PDF 的讀取權限。");
  }

  const file = await record.handle.getFile();
  state.fileSources.set(fileId, { file, handle: record.handle });
  return file;
}

function readerIsIdle(expectedName, minimumPages = 1) {
  const status = els.readerStatus.textContent || "";
  return els.readerFileName.textContent === expectedName
    && Number(els.readerPageCount.textContent || 0) >= minimumPages
    && !/載入|渲染|擷取/.test(status);
}

async function waitForCondition(check, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(message);
}

function clearPdfHighlights() {
  state.highlightToken += 1;
  els.readerHighlightLayer.replaceChildren();
  els.readerHighlightLayer.hidden = true;
}

function wordMatchesAnyTerm(text, terms) {
  const normalizedWord = normalizeSearchText(text);
  if (!normalizedWord) return false;
  return terms.some(term => {
    const normalizedTerm = normalizeSearchText(term);
    return normalizedTerm && (
      normalizedWord.includes(normalizedTerm)
      || (normalizedTerm.length > 1 && normalizedTerm.includes(normalizedWord))
    );
  });
}

function matchingOcrBoxes(words, terms) {
  return (words || [])
    .filter(word => wordMatchesAnyTerm(word.text, terms))
    .map(word => ({
      x: word.x,
      y: word.y,
      width: word.width,
      height: word.height
    }));
}

async function textLayerHighlightBoxes(pageNumber, terms) {
  if (!state.readerPreviewPdf || !terms.length) return [];
  const page = await state.readerPreviewPdf.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const util = globalThis.pdfjsLib?.Util;
    if (!util?.transform || !viewport.width || !viewport.height) return [];
    const boxes = [];
    for (const item of textContent.items || []) {
      if (typeof item.str !== "string" || !item.str.trim()) continue;
      const rawText = item.str;
      const rawLower = rawText.toLocaleLowerCase();
      const transform = util.transform(viewport.transform, item.transform);
      const height = Math.max(2, Math.hypot(transform[2], transform[3]));
      const fullWidth = Math.max(2, Math.abs((Number(item.width) || 0) * viewport.scale));
      for (const term of terms) {
        const termLower = term.toLocaleLowerCase();
        const exactIndex = rawLower.indexOf(termLower);
        const normalizedMatch = exactIndex < 0
          && normalizeSearchText(rawText).includes(normalizeSearchText(term));
        if (exactIndex < 0 && !normalizedMatch) continue;
        const startRatio = exactIndex >= 0 ? exactIndex / Math.max(rawText.length, 1) : 0;
        const widthRatio = exactIndex >= 0
          ? Math.max(term.length / Math.max(rawText.length, 1), 0.04)
          : 1;
        boxes.push({
          x: (transform[4] + fullWidth * startRatio) / viewport.width,
          y: (transform[5] - height) / viewport.height,
          width: Math.min(fullWidth * widthRatio, fullWidth) / viewport.width,
          height: height / viewport.height
        });
      }
    }
    return boxes;
  } finally {
    page.cleanup();
  }
}

function renderPdfHighlightBoxes(boxes) {
  const canvas = els.readerPrimaryCanvas;
  const layer = els.readerHighlightLayer;
  if (!boxes.length || canvas.hidden || !canvas.offsetWidth || !canvas.offsetHeight) {
    layer.replaceChildren();
    layer.hidden = true;
    return;
  }
  layer.style.left = `${canvas.offsetLeft}px`;
  layer.style.top = `${canvas.offsetTop}px`;
  layer.style.width = `${canvas.offsetWidth}px`;
  layer.style.height = `${canvas.offsetHeight}px`;
  layer.replaceChildren(...boxes.map(box => {
    const mark = document.createElement("span");
    mark.className = "pdf-highlight";
    mark.style.left = `${Math.max(0, box.x) * 100}%`;
    mark.style.top = `${Math.max(0, box.y) * 100}%`;
    mark.style.width = `${Math.max(0.004, Math.min(1 - box.x, box.width)) * 100}%`;
    mark.style.height = `${Math.max(0.004, Math.min(1 - box.y, box.height)) * 100}%`;
    return mark;
  }));
  layer.hidden = false;
}

async function locatePdfHighlights(fileId, pageNumber, terms, options = {}) {
  const token = ++state.highlightToken;
  state.activeHighlight = { fileId, pageNumber, terms: [...terms] };
  els.readerHighlightLayer.replaceChildren();
  els.readerHighlightLayer.hidden = true;
  if (!terms.length || !state.readerPreviewPdf) return 0;

  const indexedPage = state.indexedPages.find(page => (
    page.fileId === fileId && page.page === pageNumber
  ));
  let boxes = await textLayerHighlightBoxes(pageNumber, terms);
  if (token !== state.highlightToken) return 0;
  boxes.push(...matchingOcrBoxes(indexedPage?.ocrWords, terms));

  const pageTextHasTerm = terms.some(term => (
    normalizeSearchText(indexedPage?.searchText || indexedPage?.text)
      .includes(normalizeSearchText(term))
  ));
  if (!boxes.length && pageTextHasTerm && indexedPage
      && !state.indexing && !state.reviewingPageId && !options.skipOnDemandOcr) {
    els.readerStatus.textContent = `正在定位「${terms.join("、")}」…`;
    const pdfPage = await state.readerPreviewPdf.getPage(pageNumber);
    try {
      const result = await runOcrPass(
        pdfPage,
        `定位第 ${pageNumber} 頁`,
        OCR_MODES.quick.fastProfile,
        0
      );
      if (token !== state.highlightToken) return 0;
      indexedPage.ocrWords = result.words || [];
      boxes.push(...matchingOcrBoxes(indexedPage.ocrWords, terms));
      if (indexedPage.ocrWords.length) {
        putPageRecord(toStoredPage(indexedPage)).catch(error => {
          console.warn("無法保存關鍵字定位資料", error);
        });
      }
    } finally {
      pdfPage.cleanup();
    }
  }

  if (token !== state.highlightToken) return 0;
  state.activeHighlight = {
    fileId,
    pageNumber,
    terms: [...terms],
    boxes: boxes.map(box => ({ ...box }))
  };
  renderPdfHighlightBoxes(boxes);
  return boxes.length;
}

function schedulePdfHighlightRefresh(delay = 140) {
  const active = state.activeHighlight;
  if (!active) return;
  const expectedPage = active.pageNumber;
  setTimeout(() => {
    if (!state.activeHighlight || state.activeHighlight.pageNumber !== expectedPage) return;
    if (Number(els.readerPageInput.value) !== expectedPage) {
      clearPdfHighlights();
      state.activeHighlight = null;
      return;
    }
    renderPdfHighlightBoxes(state.activeHighlight.boxes || []);
  }, delay);
}

function clearHighlightWhenPageChanged() {
  if (!state.activeHighlight) return;
  if (Number(els.readerPageInput.value) === state.activeHighlight.pageNumber) return;
  clearPdfHighlights();
  state.activeHighlight = null;
}

async function openResult(fileId, pageNumber, terms = state.currentSearchTerms) {
  try {
    clearPdfHighlights();
    state.activeHighlight = null;
    const file = await getFileForResult(fileId);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    els.readerFileName.textContent = "";
    els.readerPageCount.textContent = "0";
    els.readerText.value = "";
    els.readerFileInput.files = transfer.files;
    els.readerFileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForCondition(
      () => state.readerPreviewFileName === file.name && state.readerPreviewPdf,
      30000,
      `無法準備 PDF 關鍵字定位：${file.name}`
    );
    await waitForCondition(() => readerIsIdle(file.name), 30000, `無法載入：${file.name}`);

    if (pageNumber > 1) {
      els.readerPageInput.value = String(pageNumber);
      els.readerPageInput.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForCondition(
        () => Number(els.readerPageInput.value) === pageNumber && readerIsIdle(file.name, pageNumber),
        30000,
        `無法切換到第 ${pageNumber} 頁`
      );
    }

    const indexedPage = state.indexedPages.find(page => (
      page.fileId === fileId && page.page === pageNumber
    ));
    if (indexedPage && hasUsefulText(indexedPage.searchText || indexedPage.text)) {
      els.readerText.value = indexedPageDisplayText(indexedPage);
      els.readerCopyBtn.disabled = false;
      els.readerStripBtn.disabled = false;
      const source = pageSourceLabel(indexedPage);
      const confidence = (indexedPage.method === "ocr" || indexedPage.method === "hybrid")
        && Number.isFinite(indexedPage.confidence)
        ? `，信心 ${indexedPage.confidence}%`
        : "";
      const quality = pageQualityText(indexedPage);
      const qualityNote = quality ? `；品質提醒：${quality}` : "";
      els.readerStatus.textContent = `已套用批次索引文字（${source}${confidence}${qualityNote}）`;
    }
    const highlightCount = await locatePdfHighlights(fileId, pageNumber, terms);
    if (highlightCount) {
      els.readerStatus.textContent = `第 ${pageNumber} 頁，已高亮 ${highlightCount} 處關鍵字`;
    } else if (terms.length) {
      els.readerStatus.textContent = pageNumber === 1
        ? "此結果可能命中檔名；頁面內沒有可高亮文字"
        : "已跳到命中頁；目前無法取得文字位置";
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error));
  }
}

function toStoredPage(page) {
  const { searchDocument, ...storedPage } = page;
  return storedPage;
}

async function reRecognizeIndexedPage(fileId, pageNumber) {
  if (state.indexing || state.reviewingPageId) return;
  const pageId = `${fileId}::${pageNumber}`;
  const existingPage = state.indexedPages.find(page => page.id === pageId);
  if (!existingPage) throw new Error("找不到要重新辨識的索引頁面。");

  state.reviewingPageId = pageId;
  setIndexing(true, false);
  let pdf = null;
  let pdfPage = null;
  try {
    const file = await getFileForResult(fileId);
    const pdfjs = globalThis.pdfjsLib;
    if (!pdfjs?.getDocument) throw new Error("PDF.js 尚未完成載入");

    setStatus(`載入精細重辨頁面：${file.name} 第 ${pageNumber} 頁…`);
    const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
    pdf = await loadingTask.promise;
    if (pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error(`PDF 已變更，找不到第 ${pageNumber} 頁。`);
    }

    pdfPage = await pdf.getPage(pageNumber);
    const textLayerText = extractTextItems(await pdfPage.getTextContent());
    const quality = assessTextLayerQuality(textLayerText);
    const ocrResult = await recognizePageDetailed(
      pdfPage,
      `${file.name} 第 ${pageNumber} 頁（人工精細重辨）`
    );
    const previousOcrText = existingPage.ocrText
      || (existingPage.method === "ocr" ? existingPage.text : "");
    const combinedOcrText = mergeRecognizedTexts(previousOcrText, ocrResult.text).searchText;
    const merged = mergeRecognizedTexts(textLayerText, combinedOcrText);
    const updatedPage = {
      ...toStoredPage(existingPage),
      text: merged.primaryText,
      searchText: merged.searchText,
      textLayerText,
      ocrText: combinedOcrText,
      ocrWords: ocrResult.words || existingPage.ocrWords || [],
      method: quality.hasUsableText ? "hybrid" : "ocr",
      confidence: ocrResult.confidence,
      qualityFlags: quality.flags,
      refined: true,
      selectedPass: "detail",
      reviewedAt: Date.now()
    };

    const filePages = state.indexedPages
      .filter(page => page.fileId === fileId)
      .map(page => page.id === pageId ? updatedPage : toStoredPage(page));
    const fileRecord = await loadFileRecord(fileId);
    if (!fileRecord) throw new Error("找不到此 PDF 的索引資料。");
    await replaceFileIndex(
      { ...fileRecord, ...calculateMetrics(filePages), indexedAt: Date.now() },
      filePages
    );
    await refreshCache();
    setStatus(`精細重辨完成：${file.name} 第 ${pageNumber} 頁。`);
  } finally {
    try {
      pdfPage?.cleanup();
      if (pdf) await pdf.destroy();
    } finally {
      state.reviewingPageId = null;
      setIndexing(false);
    }
  }
}

function readerPreviewScale() {
  const percent = Number.parseInt(els.readerZoomLevel.textContent, 10);
  return Number.isFinite(percent) ? percent / 100 : 1.2;
}

async function renderSecondaryPreview() {
  const token = ++state.readerPreviewToken;
  const spread = els.readerPageLayout.value === "spread";
  const currentPage = Number.parseInt(els.readerPageInput.value, 10) || 1;
  const hasSecondPage = spread
    && state.readerPreviewPdf
    && currentPage > 1;
  els.readerViewer.classList.toggle("viewer--two-page", Boolean(hasSecondPage));
  if (!hasSecondPage) {
    els.readerSecondaryCanvas.hidden = true;
    schedulePdfHighlightRefresh();
    return;
  }

  const page = await state.readerPreviewPdf.getPage(currentPage - 1);
  const renderCanvas = document.createElement("canvas");
  try {
    const viewport = page.getViewport({ scale: readerPreviewScale() });
    const outputScale = window.devicePixelRatio || 1;
    renderCanvas.width = Math.floor(viewport.width * outputScale);
    renderCanvas.height = Math.floor(viewport.height * outputScale);
    await page.render({
      canvasContext: renderCanvas.getContext("2d", { alpha: false }),
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
    }).promise;
    if (token !== state.readerPreviewToken) return;
    els.readerSecondaryCanvas.width = renderCanvas.width;
    els.readerSecondaryCanvas.height = renderCanvas.height;
    els.readerSecondaryCanvas.style.width = `${Math.floor(viewport.width)}px`;
    els.readerSecondaryCanvas.style.height = `${Math.floor(viewport.height)}px`;
    els.readerSecondaryCanvas
      .getContext("2d", { alpha: false })
      .drawImage(renderCanvas, 0, 0);
    els.readerSecondaryCanvas.hidden = false;
    schedulePdfHighlightRefresh();
  } finally {
    renderCanvas.width = 1;
    renderCanvas.height = 1;
    page.cleanup();
  }
}

async function loadReaderPreviewPdf(file) {
  if (!file || !(/\.pdf$/i.test(file.name) || file.type === "application/pdf")) return;
  state.readerPreviewFileName = "";
  const token = ++state.readerPreviewToken;
  const pdfjs = globalThis.pdfjsLib;
  if (!pdfjs?.getDocument) return;
  const previewPdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (token !== state.readerPreviewToken) {
    await previewPdf.destroy();
    return;
  }
  if (state.readerPreviewPdf) await state.readerPreviewPdf.destroy();
  state.readerPreviewPdf = previewPdf;
  state.readerPreviewFileName = file.name;
  await renderSecondaryPreview();
}

function moveReaderSpread(delta, event) {
  if (els.readerPageLayout.value !== "spread" || !state.readerPreviewPdf) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const currentPage = Number.parseInt(els.readerPageInput.value, 10) || 1;
  const totalPages = Number.parseInt(els.readerPageCount.textContent, 10) || 1;
  const nextPage = Math.min(totalPages, Math.max(1, currentPage + delta));
  els.readerPageInput.value = String(nextPage);
  els.readerPageInput.dispatchEvent(new Event("change", { bubbles: true }));
}

let resizingBatchPanel = false;

function resizeBatchPanel(clientX) {
  const workspaceRect = els.workspace.getBoundingClientRect();
  const dividerWidth = els.batchDivider.getBoundingClientRect().width;
  const minimumWidth = 280;
  const roomForViewerAndText = 200 + 220 + dividerWidth * 2;
  const maximumWidth = Math.max(minimumWidth, workspaceRect.width - roomForViewerAndText);
  const width = Math.min(maximumWidth, Math.max(minimumWidth, workspaceRect.right - clientX));
  els.batchPanel.style.flexBasis = `${width}px`;
}

els.batchDivider.addEventListener("mousedown", event => {
  if (getComputedStyle(els.batchDivider).display === "none") return;
  resizingBatchPanel = true;
  document.body.classList.add("is-resizing-panels");
  event.preventDefault();
});

window.addEventListener("mousemove", event => {
  if (resizingBatchPanel) resizeBatchPanel(event.clientX);
});

window.addEventListener("mouseup", () => {
  if (!resizingBatchPanel) return;
  resizingBatchPanel = false;
  document.body.classList.remove("is-resizing-panels");
  schedulePdfHighlightRefresh();
});

async function exportText() {
  const files = new Map(state.indexedFiles.map(file => [file.id, file]));
  const pages = [...state.indexedPages].sort((a, b) => a.fileId === b.fileId
    ? a.page - b.page
    : a.fileId.localeCompare(b.fileId));
  const lines = [];
  let currentFile = "";
  for (const page of pages) {
    if (page.fileId !== currentFile) {
      currentFile = page.fileId;
      const file = files.get(page.fileId);
      lines.push("", `===== ${file?.path || file?.name || page.fileId} =====`);
      if (file) lines.push(fileMetricText(file));
    }
    const confidence = (page.method === "ocr" || page.method === "hybrid") && Number.isFinite(page.confidence)
      ? `（OCR 信心 ${page.confidence}%）`
      : "";
    const quality = pageQualityText(page);
    const qualityNote = quality ? `（${quality}）` : "";
    lines.push(
      "",
      `--- 第 ${page.page} 頁 · ${pageSourceLabel(page)}${confidence}${qualityNote} ---`,
      indexedPageDisplayText(page) || "[未辨識到文字]"
    );
  }
  const blob = new Blob([lines.join("\n").trim() + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "pdf-batch-text.txt";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function clearIndex() {
  await clearIndexStores();
  state.fileSources.clear();
  await refreshCache();
  setStatus("索引已清除。");
}

els.pickFolderBtn.addEventListener("click", () => pickFolder().catch(error => {
  console.error(error);
  setStatus(error.message || String(error));
}));

els.fileInput.addEventListener("change", event => {
  const files = Array.from(event.target.files || []).map(file => ({ file }));
  event.target.value = "";
  if (files.length) {
    setStatus(`已選取 ${files.length} 份 PDF，準備建立索引…`);
  }
  indexFiles(files).catch(error => {
    console.error(error);
    setStatus(error.message || String(error));
  });
});

els.readerFileInput.addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (!file) return;
  clearPdfHighlights();
  state.activeHighlight = null;
  loadReaderPreviewPdf(file).catch(error => console.error("無法準備雙頁預覽", error));
}, { capture: true });

els.readerViewer.addEventListener("drop", event => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  loadReaderPreviewPdf(file).catch(error => console.error("無法準備雙頁預覽", error));
});

els.readerPageLayout.addEventListener("change", () => {
  schedulePdfHighlightRefresh();
  renderSecondaryPreview().catch(error => console.error("無法切換雙頁預覽", error));
});

els.readerPageInput.addEventListener("change", () => {
  schedulePdfHighlightRefresh();
  renderSecondaryPreview().catch(error => console.error("無法更新雙頁預覽", error));
});
els.readerPageInput.addEventListener("input", clearHighlightWhenPageChanged);

els.readerPrevBtn.addEventListener("click", event => moveReaderSpread(-2, event), true);
els.readerNextBtn.addEventListener("click", event => moveReaderSpread(2, event), true);
for (const pageButton of [els.readerPrevBtn, els.readerNextBtn]) {
  pageButton.addEventListener("click", () => setTimeout(clearHighlightWhenPageChanged, 0));
}

for (const zoomButton of [els.readerZoomInBtn, els.readerZoomOutBtn]) {
  zoomButton.addEventListener("click", () => {
    setTimeout(() => {
      renderSecondaryPreview().catch(error => console.error("無法更新雙頁縮放", error));
      schedulePdfHighlightRefresh(120);
    }, 100);
  });
}

document.addEventListener("keydown", event => {
  if (els.readerPageLayout.value !== "spread" || !state.readerPreviewPdf) return;
  if (event.target === els.readerPageInput || event.target === els.readerText) return;
  if (event.key === "ArrowLeft" || event.key === "PageUp") {
    moveReaderSpread(-2, event);
  } else if (event.key === "ArrowRight" || event.key === "PageDown") {
    moveReaderSpread(2, event);
  }
}, true);
document.addEventListener("keyup", clearHighlightWhenPageChanged);

els.clearBtn.addEventListener("click", () => clearIndex().catch(error => {
  console.error(error);
  setStatus(error.message || String(error));
}));

els.search.addEventListener("input", () => {
  setBatchTab("search");
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
});

els.search.addEventListener("keydown", event => event.stopPropagation());
els.searchMode.addEventListener("change", runSearch);
els.searchMode.addEventListener("keydown", event => event.stopPropagation());
els.ocrMode.addEventListener("change", () => {
  try {
    localStorage.setItem(OCR_MODE_STORAGE_KEY, els.ocrMode.value);
  } catch {
    // The selected mode still applies for this session.
  }
});
els.ocrMode.addEventListener("keydown", event => event.stopPropagation());

for (const tab of els.batchTabs) {
  tab.addEventListener("click", () => setBatchTab(tab.dataset.batchTab));
  tab.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = els.batchTabs.indexOf(tab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? els.batchTabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + els.batchTabs.length)
          % els.batchTabs.length;
    const nextTab = els.batchTabs[nextIndex];
    setBatchTab(nextTab.dataset.batchTab);
    nextTab.focus();
  });
}

els.pauseBtn.addEventListener("click", toggleIndexPause);

els.auditFilter.addEventListener("change", renderQualityAudit);
els.auditFilter.addEventListener("keydown", event => event.stopPropagation());

els.auditList.addEventListener("click", event => {
  const button = event.target.closest("[data-audit-action]");
  if (!button || button.disabled) return;
  const fileId = button.dataset.fileId;
  const pageNumber = Number(button.dataset.page);
  if (button.dataset.auditAction === "open") {
    openResult(fileId, pageNumber, []);
  } else if (button.dataset.auditAction === "reocr") {
    reRecognizeIndexedPage(fileId, pageNumber).catch(error => {
      console.error(error);
      setStatus(error.message || String(error));
    });
  }
});

els.exportReviewBtn.addEventListener("click", exportReviewList);

els.results.addEventListener("click", event => {
  const item = event.target.closest(".result-item");
  if (item) openResult(item.dataset.fileId, Number(item.dataset.page), state.currentSearchTerms);
});

window.addEventListener("resize", () => schedulePdfHighlightRefresh());

els.exportBtn.addEventListener("click", () => exportText().catch(error => {
  console.error(error);
  setStatus(error.message || String(error));
}));

try {
  const storedOcrMode = localStorage.getItem(OCR_MODE_STORAGE_KEY);
  if (OCR_MODES[storedOcrMode]) els.ocrMode.value = storedOcrMode;
} catch {
  // Use the default balanced mode when storage is unavailable.
}

openDb()
  .then(refreshCache)
  .catch(error => {
    console.error(error);
    setStatus(error.message || String(error));
  });
