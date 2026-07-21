const DB_NAME = "pdf-reader-batch-index-v2";
const DB_VERSION = 1;
const PAGE_STORE = "pages";
const FILE_STORE = "files";
const OCR_CONFIDENCE_WARNING = 70;
const SEARCH_RESULT_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 160;
const TESSERACT_MODULE_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm";

const els = {
  pickFolderBtn: document.getElementById("pick-folder-btn"),
  fileInput: document.getElementById("batch-file-input"),
  clearBtn: document.getElementById("clear-index-btn"),
  status: document.getElementById("batch-status"),
  progress: document.getElementById("batch-progress"),
  search: document.getElementById("search-input"),
  results: document.getElementById("search-results"),
  summary: document.getElementById("index-summary"),
  files: document.getElementById("index-files"),
  exportBtn: document.getElementById("export-text-btn"),
  readerFileInput: document.getElementById("file-input"),
  readerFileName: document.getElementById("file-name"),
  readerPageInput: document.getElementById("page-input"),
  readerPageCount: document.getElementById("page-count"),
  readerStatus: document.getElementById("status"),
  readerText: document.getElementById("text-output")
};

const state = {
  db: null,
  indexing: false,
  fileSources: new Map(),
  indexedFiles: [],
  indexedPages: [],
  searchTimer: null,
  ocrWorkerPromise: null,
  currentOcrLabel: ""
};

function setStatus(message) {
  els.status.textContent = message;
}

function setProgress(done, total) {
  els.progress.hidden = !total;
  els.progress.max = Math.max(total, 1);
  els.progress.value = done;
}

function setIndexing(active) {
  state.indexing = active;
  els.pickFolderBtn.disabled = active;
  els.fileInput.disabled = active;
  els.clearBtn.disabled = active;
  els.exportBtn.disabled = active || !state.indexedPages.length;
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

function normalizeSpace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function hasUsefulText(text) {
  return text.replace(/\s/g, "").length >= 3;
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

async function renderPageForOcr(page) {
  const viewport = page.getViewport({ scale: 2.2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

async function getOcrWorker() {
  if (!state.ocrWorkerPromise) {
    state.ocrWorkerPromise = import(TESSERACT_MODULE_URL)
      .then(({ createWorker }) => createWorker("chi_tra+eng", 1, {
        logger(message) {
          if (message.status === "recognizing text" && state.currentOcrLabel) {
            setStatus(`${state.currentOcrLabel}：OCR ${Math.round(message.progress * 100)}%`);
          }
        }
      }))
      .catch(error => {
        state.ocrWorkerPromise = null;
        throw new Error(`無法載入 OCR 引擎：${error.message || error}`);
      });
  }
  return state.ocrWorkerPromise;
}

async function recognizePage(page, label) {
  const canvas = await renderPageForOcr(page);
  state.currentOcrLabel = label;
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(canvas);
    return {
      text: normalizeSpace(data.text),
      confidence: Number.isFinite(data.confidence) ? Math.round(data.confidence) : null
    };
  } finally {
    state.currentOcrLabel = "";
    canvas.width = 1;
    canvas.height = 1;
  }
}

function calculateMetrics(pages) {
  const totalPages = pages.length;
  const recognizedPages = pages.filter(page => hasUsefulText(page.text)).length;
  const ocrPages = pages.filter(page => page.method === "ocr");
  const confidences = ocrPages
    .map(page => page.confidence)
    .filter(Number.isFinite);
  const ocrAverageConfidence = confidences.length
    ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length)
    : null;
  const lowConfidencePages = ocrPages
    .filter(page => !hasUsefulText(page.text) || !Number.isFinite(page.confidence) || page.confidence < OCR_CONFIDENCE_WARNING)
    .map(page => page.page);

  return {
    totalPages,
    recognizedPages,
    recognitionRate: totalPages ? Math.round(recognizedPages / totalPages * 100) : 0,
    textLayerPages: pages.filter(page => page.method === "text-layer").length,
    ocrPages: ocrPages.length,
    ocrAverageConfidence,
    lowConfidencePages
  };
}

async function extractPdf(file, fileId, displayPath) {
  const pdfjs = globalThis.pdfjsLib;
  if (!pdfjs?.getDocument) throw new Error("PDF.js 尚未完成載入");

  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const pdf = await loadingTask.promise;
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      setStatus(`建立索引中：${displayPath}（第 ${pageNumber}/${pdf.numPages} 頁）`);
      const page = await pdf.getPage(pageNumber);
      const textLayer = extractTextItems(await page.getTextContent());
      let text = textLayer;
      let method = "text-layer";
      let confidence = null;

      if (!hasUsefulText(textLayer)) {
        method = "ocr";
        const result = await recognizePage(page, `${displayPath} 第 ${pageNumber} 頁`);
        text = result.text;
        confidence = result.confidence;
      }

      pages.push({
        id: `${fileId}::${pageNumber}`,
        fileId,
        page: pageNumber,
        text,
        method,
        confidence
      });
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }

  return { pages, metrics: calculateMetrics(pages) };
}

function makeFileRecord(file, handle, path, metrics) {
  return {
    id: path,
    name: file.name,
    path,
    size: file.size,
    lastModified: file.lastModified,
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

  setIndexing(true);
  setProgress(0, pdfs.length);
  let succeeded = 0;
  const failures = [];

  try {
    for (let index = 0; index < pdfs.length; index += 1) {
      const { file, handle = null } = pdfs[index];
      const path = pdfs[index].path || file.webkitRelativePath || file.name;
      try {
        const { pages, metrics } = await extractPdf(file, path, path);
        const record = makeFileRecord(file, handle, path, metrics);
        await replaceFileIndex(record, pages);
        state.fileSources.set(path, { file, handle });
        succeeded += 1;
      } catch (error) {
        console.error(error);
        failures.push({ path, message: error.message || String(error) });
      }
      setProgress(index + 1, pdfs.length);
      await refreshCache();
    }
  } finally {
    setProgress(0, 0);
    setIndexing(false);
  }

  if (failures.length) {
    setStatus(`完成 ${succeeded} 份，失敗 ${failures.length} 份：${failures.map(item => item.path).join("、")}`);
  } else {
    setStatus(`索引完成：${succeeded} 份 PDF。OCR 信心為估計值，並非人工校對準確率。`);
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
  if (file.ocrPages) {
    parts.push(`OCR ${file.ocrPages} 頁`);
    parts.push(Number.isFinite(file.ocrAverageConfidence)
      ? `平均信心 ${file.ocrAverageConfidence}%`
      : "無可用 OCR 信心");
  } else {
    parts.push("全部來自原生文字層");
  }
  if (file.lowConfidencePages?.length) {
    parts.push(`低信心／無文字：第 ${file.lowConfidencePages.join("、")} 頁`);
  }
  return parts.join(" · ");
}

function renderFileNotes() {
  if (!state.indexedFiles.length) {
    els.files.innerHTML = "";
    return;
  }
  els.files.innerHTML = state.indexedFiles.map(file => {
    const warning = file.lowConfidencePages?.length ? " file-index-item--warning" : "";
    return `
      <div class="file-index-item${warning}">
        <div class="file-index-name">${escapeHtml(file.path || file.name)}</div>
        <div class="file-index-metrics">${escapeHtml(fileMetricText(file))}</div>
        ${file.ocrPages ? '<div class="file-index-help">OCR 信心是引擎估計值，不等於人工校對後的正確率。</div>' : ""}
      </div>
    `;
  }).join("");
}

function makeSnippet(text, query) {
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index < 0) return escapeHtml(text.slice(0, 140));
  const start = Math.max(0, index - 48);
  const end = Math.min(text.length, index + query.length + 72);
  return `${start ? "..." : ""}${escapeHtml(text.slice(start, index))}<mark>${escapeHtml(text.slice(index, index + query.length))}</mark>${escapeHtml(text.slice(index + query.length, end))}${end < text.length ? "..." : ""}`;
}

function runSearch() {
  const query = els.search.value.trim();
  if (!query) {
    els.results.innerHTML = state.indexedPages.length
      ? `<div class="empty-results">已索引 ${state.indexedPages.length} 頁，輸入文字開始搜尋。</div>`
      : '<div class="empty-results">尚未建立索引。</div>';
    return;
  }

  const lowerQuery = query.toLocaleLowerCase();
  const matches = state.indexedPages
    .filter(page => page.text.toLocaleLowerCase().includes(lowerQuery))
    .slice(0, SEARCH_RESULT_LIMIT);
  if (!matches.length) {
    els.results.innerHTML = `<div class="empty-results">沒有找到「${escapeHtml(query)}」。</div>`;
    return;
  }

  const files = new Map(state.indexedFiles.map(file => [file.id, file]));
  els.results.innerHTML = matches.map(page => {
    const file = files.get(page.fileId);
    const confidence = page.method === "ocr" && Number.isFinite(page.confidence)
      ? ` · OCR 信心 ${page.confidence}%`
      : "";
    return `
      <button class="result-item" data-file-id="${escapeHtml(page.fileId)}" data-page="${page.page}">
        <div class="result-file">${escapeHtml(file?.path || file?.name || page.fileId)}</div>
        <div class="result-meta">第 ${page.page} 頁${confidence}</div>
        <div class="result-snippet">${makeSnippet(page.text, query)}</div>
      </button>
    `;
  }).join("");
}

async function refreshCache() {
  const [files, pages] = await Promise.all([getAll(FILE_STORE), getAll(PAGE_STORE)]);
  state.indexedFiles = files.sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name));
  state.indexedPages = pages;
  const recognizedPages = pages.filter(page => hasUsefulText(page.text)).length;
  els.summary.textContent = `已索引 ${files.length} 份 PDF、${pages.length} 頁，其中 ${recognizedPages} 頁可搜尋。`;
  els.exportBtn.disabled = state.indexing || !pages.length;
  renderFileNotes();
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

async function openResult(fileId, pageNumber) {
  try {
    const file = await getFileForResult(fileId);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    els.readerFileName.textContent = "";
    els.readerPageCount.textContent = "0";
    els.readerText.value = "";
    els.readerFileInput.files = transfer.files;
    els.readerFileInput.dispatchEvent(new Event("change", { bubbles: true }));
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
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error));
  }
}

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
    const confidence = page.method === "ocr" && Number.isFinite(page.confidence)
      ? `（OCR 信心 ${page.confidence}%）`
      : "";
    lines.push("", `--- 第 ${page.page} 頁${confidence} ---`, page.text || "[未辨識到文字]");
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
  indexFiles(files).catch(error => {
    console.error(error);
    setStatus(error.message || String(error));
  });
});

els.clearBtn.addEventListener("click", () => clearIndex().catch(error => {
  console.error(error);
  setStatus(error.message || String(error));
}));

els.search.addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
});

els.search.addEventListener("keydown", event => event.stopPropagation());

els.results.addEventListener("click", event => {
  const item = event.target.closest(".result-item");
  if (item) openResult(item.dataset.fileId, Number(item.dataset.page));
});

els.exportBtn.addEventListener("click", () => exportText().catch(error => {
  console.error(error);
  setStatus(error.message || String(error));
}));

openDb()
  .then(refreshCache)
  .catch(error => {
    console.error(error);
    setStatus(error.message || String(error));
  });
