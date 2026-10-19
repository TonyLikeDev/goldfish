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

// Language guess, so pasted or imported scripts get the right speech language: the writing system,
// then Vietnamese tone marks, then the common words of big Latin-script languages.
// (The phone page loads this file too: keep it to syntax Safari 15 understands, no lookbehind.)
const SCRIPTS = [
  ['ja', /[぀-ヿ]/g, 0.1], ['ko', /\p{Script=Hangul}/gu, 0.3], ['zh', /\p{Script=Han}/gu, 0.3],
  ['th', /\p{Script=Thai}/gu, 0.3], ['ru', /\p{Script=Cyrillic}/gu, 0.3], ['ar', /\p{Script=Arabic}/gu, 0.3],
  ['he', /\p{Script=Hebrew}/gu, 0.3], ['el', /\p{Script=Greek}/gu, 0.3], ['hi', /\p{Script=Devanagari}/gu, 0.3],
  ['vi', /[ơưđạảấầẩẫậắằẳẵặẻẽếềểễệỉịỏốồổỗộớờởỡợủứừửữựỳỵỷỹ]/giu, 0.03],
]
// ponytail: stop-word counts, not a language model. Needs a sentence or two, and close relatives pass for
// each other (gl as pt, ms as id, af as nl), hence the same-script rule in guessLang. Words shared by
// several of these languages ("de", "la", "que", "en") are left out on purpose.
const WORDS = Object.entries({
  en: 'the and of to that it for you with this are have not be we our will they what can from but your about there would',
  es: 'el los las y del con pero más muy también hay yo fue cuando nosotros lo una mis hoy voy hasta ya sus esto eso qué cómo donde ahora aquí tiene puede están hemos',
  fr: 'le les des du et est une qui pour dans pas sur au aux avec je nous vous ne cette ces sont être très aussi ça ont été notre votre comme tout tous plus',
  de: 'der die und das ist nicht ein eine einen zu mit von sich auf für dem ich wir uns euch ihr auch sie wie dass sind haben hat wird werden aber oder noch im bei nach aus kann schon mehr heute',
  it: 'di il che è per non sono della ho gli ci questo anche più nel dei delle molto io noi voi loro cosa nella questa perché oggi abbiamo siamo ma tutti sul essere così grazie ancora dove fare',
  pt: 'o os do da dos é em um uma não com mais ao muito mas também isso você são foi eu vocês hoje aqui nossa nosso pelo pela seu estão então agora já só tudo bem',
  nl: 'het een van dat niet op zijn met voor ik ook maar wat dit deze naar wordt worden hebben heeft aan nog bij wij ons onze jullie uit zo hij kunnen moet veel heel goed geen mijn waar omdat dus',
  id: 'yang dan ini itu dengan untuk tidak dari dalam akan pada juga ke karena ada bisa kami kita saya aku kamu sudah adalah bahwa atau mereka anda lebih sangat semua oleh telah seperti jika kalau harus hanya masih belum lagi',
  tl: 'ang ng sa mga ay ko mo siya hindi ito naman lang kung nga ka ako kayo sila niya nila natin namin tayo ating inyo ninyo dito ba rin lahat ngayon dahil kasi yung',
  pl: 'się że nie jest w z jak ale co tak od przez już tylko może czy dla są być był była było który które która oraz bardzo też więc tego będzie jestem wam nam nas żeby jeśli jeszcze teraz dzisiaj wszystko mnie nasz',
  tr: 've bir bu için ile çok ama gibi daha olarak kadar sonra ki şey ben biz siz olan değil yok mı şu nasıl şimdi sizin bizim ise ancak veya artık sadece böyle işte tüm bütün kendi çünkü eğer bana oldu olduğu',
  sv: 'och att är inte ett jag från också när här vad mycket till för av hade ska bara vara finns än något någon detta dessa då våra',
}).map(([lang, words]) => [lang, new Set(words.split(' '))])
const KNOWN = new Set(SCRIPTS.concat(WORDS).map(([lang]) => lang))

// The language whose common words clearly dominate: at least 3 of them, 8% of all words, twice the runner-up.
function byWords(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) || []
  const [[lang, a], [, b]] = WORDS.map(([l, set]) => [l, words.filter(w => set.has(w)).length]).sort((x, y) => y[1] - x[1])
  if (a >= 3 && a >= words.length * 0.08 && a >= 2 * b) return lang
}

// Writing system of a language code, zh and yue counted as one; undefined for 'auto' and unknown codes.
const script = lang => { try { return new Intl.Locale(lang).maximize().script.replace('Hant', 'Hans') } catch {} }

export function guessLang(text, fallback) {
  text = text.normalize('NFC')
  const letters = text.match(/\p{L}/gu)?.length
  if (!letters) return fallback
  const guess = SCRIPTS.find(([, re, min]) => (text.match(re)?.length ?? 0) / letters > min)?.[0] ?? byWords(text)
  if (!guess) return fallback
  // Your own language wins when the guess can't rule it out: uk is written like ru, ca like es.
  // Tone marks rule out everything but vi, and a language known here would have been recognized.
  return guess === 'vi' || KNOWN.has(fallback) || script(guess) !== script(fallback) ? guess : fallback
}
