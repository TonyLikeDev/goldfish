// Script text helpers shared by the main process, the bar, the phone remote and the tests.

// Comparable form of text: lowercase letters/digits only, accents and tone marks dropped
// ("Tiếng Việt" ~ "tiengviet"), katakana folded to hiragana.
export function normalize(s) {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[^\p{L}\p{N}]/gu, '')
}

// Splits a script into display parts; word parts carry their index `w`. `chars` is the normalized
// text of every word back to back and `charWord[k]` is the word that chars[k] belongs to.
export function tokenize(text, lang) {
  const seg = new Intl.Segmenter(lang && lang !== 'auto' ? lang : undefined, { granularity: 'word' })
  const parts = [], wordStart = [], charWord = []
  let chars = ''
  for (const { segment, isWordLike } of seg.segment(text)) {
    const n = isWordLike ? normalize(segment) : ''
    if (!n) { parts.push({ text: segment, w: -1 }); continue }
    parts.push({ text: segment, w: wordStart.length })
    for (let k = 0; k < n.length; k++) charWord.push(wordStart.length)
    wordStart.push(chars.length)
    chars += n
  }
  return { parts, wordStart, charWord, chars, count: wordStart.length }
}

// Window of script chars searched around the current position, the minimum alignment score
// to trust, and how far past the current position an alignment may start and still count
// as continuous reading (anything further is a jump and needs double the score).
// Calibrated on en/vi/zh samples: unrelated speech scores <= 26, four genuine words >= 36.
const BACK = 240, AHEAD = 360, MIN_SCORE = 32, SLACK = 48

// Where is the speaker now? Aligns what was heard against the script around word `pos`
// (Smith-Waterman on normalized chars, so spaced and unspaced languages work alike; a match
// scores +2, or +4 for CJK chars which carry more information, mismatch/gap -1) and returns
// how many words have been read, or -1 when nothing ahead of `pos` matches confidently.
// Never moves backwards.
export function locate(idx, heard, pos) {
  const r = normalize(heard)
  const c0 = pos < idx.count ? idx.wordStart[pos] : idx.chars.length
  const lo = Math.max(0, c0 - BACK), t = idx.chars.slice(lo, c0 + AHEAD), n = t.length
  // Scores of the previous/current row, plus where (in t) each cell's alignment starts.
  let prev = new Int32Array(n + 1), cur = new Int32Array(n + 1)
  let prevStart = new Int32Array(n + 1), curStart = new Int32Array(n + 1)
  let best = 0, end = 0, start = 0
  for (let i = 0; i < r.length; i++) {
    const hit = r[i] >= '぀' ? 4 : 2
    for (let j = 1; j <= n; j++) {
      const diag = prev[j - 1] + (r[i] === t[j - 1] ? hit : -1), up = prev[j] - 1, left = cur[j - 1] - 1
      const s = Math.max(0, diag, up, left)
      cur[j] = s
      curStart[j] = s === diag ? (prev[j - 1] ? prevStart[j - 1] : j - 1) : s === up ? prevStart[j] : curStart[j - 1]
      if (s > best) { best = s; end = j; start = curStart[j] }
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart]
  }
  const anchored = lo + start <= c0 + SLACK
  if (best < (anchored ? MIN_SCORE : 2 * MIN_SCORE)) return -1
  const next = idx.charWord[lo + end - 1] + 1
  return next > pos ? next : -1
}

// Language guess from the writing system, so pasted or imported scripts get the right speech
// language. Latin-script languages other than Vietnamese can't be told apart: `fallback`.
const SCRIPTS = [
  ['ja', /[぀-ヿ]/g, 0.1], ['ko', /\p{Script=Hangul}/gu, 0.3], ['zh', /\p{Script=Han}/gu, 0.3],
  ['th', /\p{Script=Thai}/gu, 0.3], ['ru', /\p{Script=Cyrillic}/gu, 0.3], ['ar', /\p{Script=Arabic}/gu, 0.3],
  ['he', /\p{Script=Hebrew}/gu, 0.3], ['el', /\p{Script=Greek}/gu, 0.3], ['hi', /\p{Script=Devanagari}/gu, 0.3],
  ['vi', /[ơưđạảấầẩẫậắằẳẵặẻẽếềểễệỉịỏốồổỗộớờởỡợủứừửữựỳỵỷỹ]/giu, 0.03],
]
export function guessLang(text, fallback) {
  const letters = text.match(/\p{L}/gu)?.length
  if (!letters) return fallback
  return SCRIPTS.find(([, re, min]) => (text.match(re)?.length ?? 0) / letters > min)?.[0] ?? fallback
}

// Markdown to plain speakable text. ponytail: regexes, not a parser; tables and nested
// constructs come through mostly as-is.
export function mdToText(md) {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)(.+?)\*/g, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
