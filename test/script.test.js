import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, tokenize, locate, mdToText, guessLang } from '../src/script.js'

const EN = `Good morning everyone, and thank you for joining us today. Over the last quarter our team focused on three things: making onboarding faster, cutting infrastructure costs, and shipping the new mobile app. I want to walk you through each of these, share what worked, what did not, and what we are planning for the next three months. Let us start with onboarding, because it had the biggest impact on revenue. Two years ago a new customer needed eleven days to go live. Today it takes four.`
const VI = `Xin chào tất cả mọi người, cảm ơn các bạn đã tham gia buổi họp hôm nay. Trong quý vừa qua, nhóm chúng tôi tập trung vào ba việc chính: rút ngắn thời gian onboarding, giảm chi phí hạ tầng và ra mắt ứng dụng di động mới.`
const ZH = `大家早上好，感谢各位今天参加会议。上个季度，我们团队主要专注于三件事：加快新用户上手速度，降低基础设施成本，以及发布新的移动应用。`

const words = (idx, a, b) => idx.parts.filter(p => p.w >= a && p.w < b).map(p => p.text).join(' ')

test('normalize drops case, punctuation, accents and tones', () => {
  assert.equal(normalize('Tiếng Việt, Đà Nẵng!'), 'tiengvietdanang')
  assert.equal(normalize('Café — naïve'), 'cafenaive')
  assert.equal(normalize('カタカナ'), normalize('かたかな'))
})

test('tokenize keeps the original text and indexes words', () => {
  for (const [text, lang] of [[EN, 'en'], [VI, 'vi'], [ZH, 'zh'], ['สวัสดีครับ ยินดีต้อนรับ', 'th']]) {
    const idx = tokenize(text, lang)
    assert.equal(idx.parts.map(p => p.text).join(''), text)
    assert.ok(idx.count > 3)
    assert.equal(idx.charWord.length, idx.chars.length)
  }
  assert.equal(tokenize('Hello, world. 40% done', 'en').count, 4)
})

test('follows a speaker reading word by word (rolling 12-word window)', () => {
  const idx = tokenize(EN, 'en')
  let pos = 0
  for (let k = 4; k <= idx.count; k++) {
    const next = locate(idx, words(idx, k - 12, k), pos)
    if (next > 0) pos = next
    assert.ok(pos === k || (k < 6 && pos === 0), `heard up to ${k}, at ${pos}`)
  }
})

test('tolerates recognition errors', () => {
  const idx = tokenize(EN, 'en')
  const pos = locate(idx, 'are team focus on tree things making on boarding fast her', 13)
  assert.ok(pos >= 22 && pos <= 23, `at ${pos}`)
})

test('ignores ad-libs and already-read text', () => {
  const idx = tokenize(EN, 'en')
  assert.equal(locate(idx, 'so yeah um I think we should grab lunch after this okay', 20), -1)
  assert.equal(locate(idx, 'the weather tomorrow will be sunny with a chance of rain', 20), -1)
  assert.equal(locate(idx, words(idx, 8, 20), 20), -1)
})

test('jumps ahead only with strong evidence', () => {
  const idx = tokenize(EN, 'en')
  assert.equal(locate(idx, words(idx, 60, 64), 10), -1)
  assert.equal(locate(idx, words(idx, 60, 74), 10), 74)
})

test('prefers the nearby copy of a repeated sentence', () => {
  const idx = tokenize(`${EN} Thank you for joining us today. ${EN}`, 'en')
  assert.equal(locate(idx, words(idx, 2, 11), 3), 11)
})

test('vietnamese without tone marks and noisy chinese still advance', () => {
  const vi = tokenize(VI, 'vi')
  const vpos = locate(vi, 'trong quy vua qua nhom chung toi tap trung vao ba viec chinh', 16)
  assert.ok(vpos >= 28 && vpos <= 30, `vi at ${vpos}`)
  const zh = tokenize(ZH, 'zh')
  const zpos = locate(zh, '上个季度我们团对主要专住于三件是', 4)
  assert.ok(zpos > 4 && zh.parts.filter(p => p.w >= 0 && p.w < zpos).map(p => p.text).join('').includes('三'), `zh at ${zpos}`)
  assert.equal(locate(zh, '今天天气很好，我们下午去公园散步吧', 4), -1)
})

test('guessLang reads the writing system', () => {
  assert.equal(guessLang(VI, 'en'), 'vi')
  assert.equal(guessLang(ZH, 'en'), 'zh')
  assert.equal(guessLang('今日はいい天気ですね。会議を始めましょう。', 'en'), 'ja')
  assert.equal(guessLang('안녕하세요 여러분, 오늘 회의를 시작하겠습니다.', 'en'), 'ko')
  assert.equal(guessLang('สวัสดีครับ ยินดีต้อนรับทุกคน', 'en'), 'th')
  assert.equal(guessLang(EN, 'id'), 'id')
  assert.equal(guessLang(`${EN} Thanks to Nguyễn Văn An and 李明.`, 'en'), 'en')
  assert.equal(guessLang('', 'fr'), 'fr')
})

test('mdToText strips markdown syntax', () => {
  const md = '# Title\n\nSome **bold** and _italic_ text with [a link](http://x.y) and `code`.\n\n- item one\n- item two\n\n```js\nskip()\n```\nsnake_case_word stays'
  assert.equal(mdToText(md), 'Title\n\nSome bold and italic text with a link and code.\n\nitem one\nitem two\n\nsnake_case_word stays')
})
