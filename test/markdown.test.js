import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mdToText } from '../src/markdown.js'

test('mdToText strips markdown syntax', () => {
  const md = '# Title\n\nSome **bold** and _italic_ text with [a link](http://x.y) and `code`.\n\n- item one\n- item two\n\n```js\nskip()\n```\nsnake_case_word stays'
  assert.equal(mdToText(md), 'Title\n\nSome bold and italic text with a link and code.\n\nitem one\nitem two\n\nsnake_case_word stays')
})

test('mdToText keeps prose that only looks like markup', () => {
  for (const s of ['If latency is < 200 ms and errors are > 1%, we roll back.', 'Data -> model -> answer. I <3 this.',
    '1. Intro', '2024. What a year', '[Pause] Look at the camera.', 'Tom & Jerry'])
    assert.equal(mdToText(s), s)
  assert.equal(mdToText('See <https://example.com> or write to <name@example.com>.'), 'See https://example.com or write to name@example.com.')
  assert.equal(mdToText('Press <kbd>Enter</kbd>, <span class="x">then</span> wait <!-- cut\nthis -->now.'), 'Press Enter, then wait now.')
  assert.equal(mdToText('Use the `<video>` tag and `*.md` files.'), 'Use the <video> tag and *.md files.')
  assert.equal(mdToText('5 \\* 3 is \\*not\\* italic, snake\\_case\n\\# not a heading'), '5 * 3 is *not* italic, snake_case\n# not a heading')
})

test('mdToText drops front matter, tables, task boxes, footnotes and entities', () => {
  assert.equal(mdToText('---\ntitle: Talk\ntags: [a, b]\n---\n# Hello\n\nText'), 'Hello\n\nText')
  assert.equal(mdToText('+++\ntitle = "Talk"\n+++\nText'), 'Text')
  assert.equal(mdToText('---\nIntro paragraph\n\nSection\n---\nMore text'), 'Intro paragraph\n\nSection\nMore text') // a rule, not front matter
  assert.equal(mdToText('---\nNote: speak slowly.\n\nGood morning, everyone.\n---\nRevenue grew.'), 'Note: speak slowly.\n\nGood morning, everyone.\nRevenue grew.')
  assert.equal(mdToText('---\ntitle: Talk\ntags:\n  - a\n- b\n# draft\n\nsummary: |\n  Two\n  lines\n---\nText'), 'Text')
  assert.equal(mdToText('---\ndate created: Wednesday, May 1st 2024, 10:00 am\ntags: [talk]\nog.image: a.png\n"og:title": Talk\n---\nHi.'), 'Hi.')
  assert.equal(mdToText('+++\ntitle = "Talk"\n\n[params]\nauthor = "Me"\n+++\nText'), 'Text')
  assert.equal(mdToText('---\ntiêu đề: Bài nói\n---\nXin chào.'), 'Xin chào.')
  assert.equal(mdToText('---\nHere is the plan: three parts.\n\nFirst, the numbers.\n---\nText'), 'Here is the plan: three parts.\n\nFirst, the numbers.\nText')
  assert.equal(mdToText('# Title\r\n\r\n\r\n\r\nLine one\r\nLine two\r\n---\r\n'), 'Title\n\nLine one\nLine two')
  assert.equal(mdToText('Title\n=====\n\nSub\n---\nBody\n\n* * *\n\nEnd'), 'Title\n\nSub\nBody\n\nEnd')
  assert.equal(mdToText('| Name | Age |\n|---|:--:|\n| Bob | 42 |'), 'Name Age\nBob 42')
  assert.equal(mdToText('- [ ] Write intro\n- [x] Record'), 'Write intro\nRecord')
  assert.equal(mdToText('Goldfish is free.[^1] See [the docs][docs].\n\n[^1]: MIT license.\n[docs]: https://example.com "Docs"'), 'Goldfish is free. See the docs.')
  assert.equal(mdToText('Q&amp;A &lt;3 &quot;hi&quot; it&#39;s &#x41;&#66;&nbsp;C'), 'Q&A <3 "hi" it\'s AB C')
})
