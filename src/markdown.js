// Markdown to plain speakable text, for imported .md files (main process; the phone never loads this).
// ponytail: regexes, not a parser; nested constructs, raw HTML blocks and rarer entities come through mostly as-is.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
// Escaped and code characters are parked in the private-use area so no rule below touches them.
const hide = c => String.fromCharCode(0xE000 + c.charCodeAt(0))

// YAML or TOML front matter: key: value or key = value (keys like "date created", "og.image" or quoted ones),
// - item, # comment, [table], indented and blank lines only. A prose line means the first '---' was a rule.
// ponytail: a file that opens with a '---' rule and only "words: text" lines up to the next one loses them; parse YAML if that bites.
const KEY = String.raw`([\p{L}\p{N}_][\p{L}\p{N}_ \t.-]*|"[^"\n]*"[ \t]*|'[^'\n]*'[ \t]*)[:=]`
const FRONT_MATTER = new RegExp(String.raw`^(---|\+\+\+)[ \t]*\n(?=${KEY})((${KEY}|[ \t#\[]|-[ \t]).*\n|\n)*?\1[ \t]*(\n|$)`, 'u')

export function mdToText(md) {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(FRONT_MATTER, '')
    .replace(/\\([!-\/:-@[-`{-~])/g, (_, c) => hide(c))
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, (_, code) => code.replace(/[!-\/:-@[-`{-~]/g, hide))
    .replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g, '') // real tags only, not "< 200 ms"
    .replace(/<([^\s<>]+[:@][^\s<>]+)>/g, '$1') // <https://…> and <name@mail> links
    .replace(/^ {0,3}\[\^[^\]]+\]:.*\n?/gm, '') // footnote definitions
    .replace(/^ {0,3}\[[^\]]+\]:[ \t]*\S+([ \t]+["'(].*)?$\n?/gm, '') // link reference definitions
    .replace(/[ \t]*\[\^[^\]\s]+\]/g, '') // footnote markers
    .replace(/!\[[^\]]*\](\([^)]*\)|\[[^\]]*\])/g, '')
    .replace(/\[([^\]]*)\](\([^)]*\)|\[[^\]]*\])/g, '$1')
    .replace(/^[ \t]*(>[ \t]?)+/gm, '')
    .replace(/^[ \t]*(=+[ \t]*|([*_][ \t]*){3,}|\|?[ \t]*:?-[-: \t|]*)$\n?/gm, '') // rules, setext underlines, table separators
    .replace(/^[ \t]*(#{1,6}|[-*+]([ \t]+\[[ xX]\])?)[ \t]+/gm, '') // headings, bullets and task boxes; numbers stay
    .replace(/^.*\|.*$/gm, row => row.split('|').map(c => c.trim()).filter(Boolean).join(' ')) // table rows
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)(.+?)\*/g, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    .replace(/&(#\d{1,6}|#x[\da-f]{1,5}|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) =>
      e[0] === '#' ? String.fromCodePoint(+('0' + e.slice(1))) : ENTITIES[e.toLowerCase()]) // &#65; and &#x41; alike
    .replace(/[-]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xE000))
    .replace(/\n(?:[ \t]*\n){2,}/g, '\n\n')
    .trim()
}
