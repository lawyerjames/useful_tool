export const TEXT_QUALITY_LABELS = {
  "no-text": "原文字層沒有有效文字",
  "sparse-text": "原文字層過少",
  "replacement-characters": "含有亂碼",
  "private-use-characters": "含有非標準字形",
  "low-searchable-ratio": "可搜尋字元比例偏低",
  "repeated-characters": "字元異常重複"
};

function compactText(value) {
  return String(value || "").replace(/\s+/g, "");
}

export function searchableCharacterCount(value) {
  return (String(value || "").match(/[\p{L}\p{N}]/gu) || []).length;
}

export function assessTextLayerQuality(value) {
  const text = String(value || "");
  const compact = compactText(text);
  const searchableCount = searchableCharacterCount(text);
  const flags = [];

  if (searchableCount < 3) {
    flags.push("no-text");
  } else if (searchableCount < 24) {
    flags.push("sparse-text");
  }

  if (/\uFFFD/.test(text)) flags.push("replacement-characters");
  if (/[\uE000-\uF8FF]/u.test(text)) flags.push("private-use-characters");

  const searchableRatio = compact.length ? searchableCount / compact.length : 0;
  if (compact.length >= 8 && searchableRatio < 0.55) {
    flags.push("low-searchable-ratio");
  }
  if (compact.length >= 16 && /(.)\1{7,}/u.test(compact)) {
    flags.push("repeated-characters");
  }

  return {
    flags,
    hasUsableText: searchableCount >= 3,
    needsOcr: flags.length > 0,
    searchableCount,
    searchableRatio
  };
}

function normalizeForContainment(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function mergeRecognizedTexts(textLayerText, ocrText) {
  const layer = String(textLayerText || "").replace(/\s+/g, " ").trim();
  const ocr = String(ocrText || "").replace(/\s+/g, " ").trim();
  if (!layer) return { primaryText: ocr, searchText: ocr };
  if (!ocr) return { primaryText: layer, searchText: layer };

  const normalizedLayer = normalizeForContainment(layer);
  const normalizedOcr = normalizeForContainment(ocr);
  let searchText;
  if (normalizedLayer.includes(normalizedOcr)) {
    searchText = layer;
  } else if (normalizedOcr.includes(normalizedLayer)) {
    searchText = ocr;
  } else {
    searchText = `${layer} ${ocr}`;
  }

  const primaryText = searchableCharacterCount(ocr) > searchableCharacterCount(layer)
    ? ocr
    : layer;
  return { primaryText, searchText };
}

export function classifyAuditIssues(page, confidenceWarning = 70) {
  const issues = [];
  const usesOcr = page.method === "ocr" || page.method === "hybrid";
  if (searchableCharacterCount(page.searchText || page.text) < 3) {
    issues.push("unrecognized");
  }
  if (usesOcr && (!Number.isFinite(page.confidence) || page.confidence < confidenceWarning)) {
    issues.push("low-confidence");
  }
  if (page.method === "hybrid" && (page.qualityFlags || []).length) {
    issues.push("suspicious");
  }
  if (page.refined) issues.push("refined");
  return issues;
}
