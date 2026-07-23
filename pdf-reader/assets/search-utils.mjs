const SAFE_VARIANT_MAP = new Map([
  ["臺", "台"],
  ["檯", "台"],
  ["裏", "裡"],
  ["祕", "秘"],
  ["衞", "衛"],
  ["羣", "群"],
  ["峯", "峰"],
  ["竝", "並"],
  ["僞", "偽"],
  ["啓", "啟"]
]);

const OCR_CONFUSION_GROUPS = [
  "0o〇○",
  "1il丨",
  "5s",
  "8b",
  "徵徴微",
  "收収牧",
  "未末",
  "己已巳",
  "土士",
  "日曰",
  "人入",
  "口囗",
  "目自"
];

const OCR_CONFUSION_LOOKUP = new Map();
for (const group of OCR_CONFUSION_GROUPS) {
  for (const character of group) OCR_CONFUSION_LOOKUP.set(character, group);
}

function normalizeCharacter(character) {
  return SAFE_VARIANT_MAP.get(character) || character;
}

function isSearchCharacter(character) {
  return /[\p{L}\p{N}]/u.test(character);
}

export function buildSearchDocument(value) {
  const raw = String(value || "");
  const normalizedCharacters = [];
  const rawRanges = [];
  let rawOffset = 0;

  for (const rawCharacter of raw) {
    const rawStart = rawOffset;
    rawOffset += rawCharacter.length;
    const folded = rawCharacter.normalize("NFKC").toLocaleLowerCase();
    for (const foldedCharacter of folded) {
      const normalizedCharacter = normalizeCharacter(foldedCharacter);
      if (!isSearchCharacter(normalizedCharacter)) continue;
      normalizedCharacters.push(normalizedCharacter);
      rawRanges.push({ start: rawStart, end: rawOffset });
    }
  }

  return {
    raw,
    rawLower: raw.toLocaleLowerCase(),
    normalized: normalizedCharacters.join(""),
    rawRanges
  };
}

export function normalizeSearchText(value) {
  return buildSearchDocument(value).normalized;
}

function charactersAreConfusable(left, right) {
  if (left === right) return true;
  const leftGroup = OCR_CONFUSION_LOOKUP.get(left);
  return Boolean(leftGroup && leftGroup === OCR_CONFUSION_LOOKUP.get(right));
}

function weightedEditDistance(left, right, maximumDistance) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1]
        ? 0
        : charactersAreConfusable(left[leftIndex - 1], right[rightIndex - 1]) ? 0.35 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > maximumDistance + 1) return rowMinimum;
    for (let index = 0; index < previous.length; index += 1) previous[index] = current[index];
  }

  return previous[right.length];
}

function allowedFuzzyDistance(length) {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  if (length <= 14) return 2;
  return Math.min(3, Math.floor(length / 6));
}

function collectCandidateStarts(text, query, allowance) {
  const starts = new Set();
  for (let queryIndex = 0; queryIndex < query.length - 1; queryIndex += 1) {
    const gram = query.slice(queryIndex, queryIndex + 2);
    let textIndex = text.indexOf(gram);
    while (textIndex >= 0) {
      const estimatedStart = textIndex - queryIndex;
      for (let adjustment = -allowance; adjustment <= allowance; adjustment += 1) {
        const start = estimatedStart + adjustment;
        if (start >= 0 && start < text.length) starts.add(start);
      }
      textIndex = text.indexOf(gram, textIndex + 1);
    }
  }
  return starts;
}

function toRawRange(document, normalizedStart, normalizedEnd) {
  const first = document.rawRanges[normalizedStart];
  const last = document.rawRanges[normalizedEnd - 1];
  if (!first || !last) return { start: 0, end: 0 };
  return { start: first.start, end: last.end };
}

function findFuzzyMatch(document, query) {
  const allowance = allowedFuzzyDistance(query.length);
  if (!allowance || document.normalized.length < query.length - allowance) return null;

  const starts = collectCandidateStarts(document.normalized, query, allowance);
  let best = null;
  for (const start of starts) {
    for (
      let windowLength = Math.max(1, query.length - allowance);
      windowLength <= query.length + allowance;
      windowLength += 1
    ) {
      const end = start + windowLength;
      if (end > document.normalized.length) continue;
      const candidate = document.normalized.slice(start, end);
      const distance = weightedEditDistance(query, candidate, allowance);
      if (distance > allowance) continue;
      const similarity = Math.max(0, 1 - distance / Math.max(query.length, candidate.length));
      if (!best || similarity > best.similarity) {
        best = { normalizedStart: start, normalizedEnd: end, distance, similarity };
      }
    }
  }

  if (!best) return null;
  const rawRange = toRawRange(document, best.normalizedStart, best.normalizedEnd);
  return {
    kind: "fuzzy",
    score: Math.round(best.similarity * 90),
    distance: Number(best.distance.toFixed(2)),
    start: rawRange.start,
    end: rawRange.end
  };
}

export function matchSearchTerm(document, term) {
  const rawTerm = String(term || "").trim();
  const exactTerm = rawTerm.toLocaleLowerCase();
  const exactIndex = exactTerm ? document.rawLower.indexOf(exactTerm) : -1;
  if (exactIndex >= 0) {
    return {
      kind: "exact",
      score: 100,
      distance: 0,
      start: exactIndex,
      end: exactIndex + rawTerm.length
    };
  }

  const normalizedTerm = normalizeSearchText(rawTerm);
  if (!normalizedTerm) return null;
  const normalizedIndex = document.normalized.indexOf(normalizedTerm);
  if (normalizedIndex >= 0) {
    const rawRange = toRawRange(document, normalizedIndex, normalizedIndex + normalizedTerm.length);
    return {
      kind: "normalized",
      score: 96,
      distance: 0,
      start: rawRange.start,
      end: rawRange.end
    };
  }

  return findFuzzyMatch(document, normalizedTerm);
}

export function evaluatePageSearch(document, terms, mode = "strict") {
  const termMatches = terms.map(term => matchSearchTerm(document, term));
  const matched = termMatches.filter(Boolean);
  const matchedCount = matched.length;
  const requiredMatches = mode === "recall" && terms.length > 1
    ? Math.max(1, terms.length - 1)
    : terms.length;
  if (matchedCount < requiredMatches) return null;

  let tier;
  if (matchedCount < terms.length) {
    tier = "partial";
  } else if (matched.every(match => match.kind === "exact")) {
    tier = "exact";
  } else if (matched.every(match => match.kind !== "fuzzy")) {
    tier = "normalized";
  } else {
    tier = "fuzzy";
  }

  const coverage = terms.length ? matchedCount / terms.length : 0;
  const averageScore = matched.reduce((sum, match) => sum + match.score, 0)
    / Math.max(matchedCount, 1);
  return {
    tier,
    score: Math.round(averageScore * coverage),
    matchedCount,
    termMatches
  };
}
