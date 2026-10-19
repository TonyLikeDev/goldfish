import { tokenize, guessLang } from './script.js'

const api = window.goldfish
const $ = s => document.querySelector(s)
const isMac = api.platform === 'darwin'
const clean = e => (e?.message ?? String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const MODELS = {
  'large-v3-turbo-q5_0': ['Best: large-v3-turbo', 574, 'Most accurate in every language. Needs a graphics card (any Apple Silicon Mac, most Windows PCs).'],
  'small-q5_1': ['Balanced: small', 190, 'Fine for English and major European languages on older computers.'],
  'base-q5_1': ['Fast: base', 60, 'Least accurate. For slow computers.'],
}
// Every language Whisper understands.
const LANGS = 'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue'.split(' ')

let { settings, notices = [] } = await api.invoke('settings')
api.on('notice', notice)
let scripts = await api.invoke('library')
let models = await api.invoke('models')
let current = null, running = false, refreshTimer = 0, stale = null

function button(label, onclick, className = '') {
  return Object.assign(document.createElement('button'), { type: 'button', textContent: label, onclick, className })
}

function banner(text, kind = 'info', actions = []) {
  const el = $('#banner')
  el.hidden = !text
  el.className = kind
  delete el.dataset.model // download() marks a banner that is about one model
  el.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }),
    ...actions.map(([label, fn]) => button(label, fn)), Object.assign(button('✕', () => banner(''), 'close'), { ariaLabel: 'Close' }))
}

// Notices from main: { text, kind, action?: { label, id } }; the action id is the channel to invoke.
function notice(...list) {
  const kinds = ['info', 'ok', 'warn', 'error']
  banner(list.map(n => n.text).join('\n'), kinds[Math.max(...list.map(n => kinds.indexOf(n.kind)))],
    list.filter(n => n.action).map(({ action }) => [action.label, () => api.invoke(action.id)]))
}

async function setSetting(patch) {
  Object.assign(settings, patch)
  const r = await api.invoke('settings:set', patch)
  settings = r.settings
  if (r.failed.length) banner(`These shortcuts are taken by another app: ${r.failed.join(', ')}`, 'warn')
}

// ---------- languages ----------

const english = new Intl.DisplayNames(['en'], { type: 'language' })
function langName(code) {
  const c = code === 'jw' ? 'jv' : code // Whisper's code for Javanese
  const en = english.of(c)
  let own = ''
  try { own = new Intl.DisplayNames([c], { type: 'language' }).of(c) } catch {}
  return own && own.toLowerCase() !== en.toLowerCase() ? `${en} · ${own[0].toLocaleUpperCase(c)}${own.slice(1)}` : en
}
$('#lang').append(new Option('Detect automatically', 'auto'),
  ...LANGS.map(c => [langName(c), c]).sort((a, b) => a[0].localeCompare(b[0])).map(([name, c]) => new Option(name, c)))

// ---------- script library and editor ----------

function renderList() {
  const focused = $('#list').contains(document.activeElement)
  $('#list').replaceChildren(...scripts.map(s => {
    const b = button('', () => select(s)), li = document.createElement('li')
    if (s === current) b.ariaCurrent = 'true'
    b.append(Object.assign(document.createElement('b'), { textContent: s.title || 'Untitled script' }),
      Object.assign(document.createElement('small'), { textContent: s.text.trim().slice(0, 80) || 'Empty' }))
    li.append(b)
    return li
  }))
  if (focused) $('#list [aria-current]')?.focus() // keep keyboard focus on the list after picking a script
}

function renderStats() {
  const n = tokenize(current.text, current.lang).count
  $('#stats').textContent = n ? `${n.toLocaleString()} words · about ${Math.max(1, Math.round(n / 140))} min` : ''
}

function select(s) {
  refresh()
  current = s
  $('#title').value = s.title
  $('#text').value = s.text
  $('#lang').value = s.lang
  renderList()
  renderStats()
}

// Every edit reaches main at once; the list, stats and language guess catch up a moment later.
function edited() {
  api.send('library:save', current)
  stale = current
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(refresh, 300)
}
function refresh() {
  clearTimeout(refreshTimer)
  const s = stale
  if (!s) return
  stale = null
  if (s.langPicked === false) { // nobody picked its language yet: keep guessing from the text
    const lang = guessLang(s.text, settings.lang)
    if (lang !== s.lang) { s.lang = lang; api.send('library:save', s) }
  }
  if (s === current) $('#lang').value = s.lang
  renderList()
  renderStats()
}
addEventListener('pagehide', refresh)

$('#title').oninput = $('#text').oninput = () => {
  const legacy = current.langPicked === undefined && !current.text.trim() // empty v0.1.0 script
  current.title = $('#title').value
  current.text = $('#text').value
  // ponytail: guessed once from its first text, falling back to its own language as v0.1.0 did, so a language picked
  // by hand survives; text typed in key by key keeps that first guess
  if (legacy && current.text.trim()) $('#lang').value = current.lang = guessLang(current.text, current.lang)
  edited()
}
$('#lang').onchange = () => {
  current.lang = $('#lang').value
  current.langPicked = true
  edited()
  setSetting({ lang: current.lang }) // default for new scripts
}

function addScript(s) {
  scripts.unshift(s)
  select(s)
}
$('#new').onclick = () => {
  addScript({ id: crypto.randomUUID(), title: '', text: '', lang: settings.lang, langPicked: false, updated: Date.now() })
  api.send('library:save', current)
  $('#title').focus()
}
$('#delete').onclick = async () => {
  if (!confirm(`Delete “${current.title || 'Untitled script'}”?`)) return
  const s = current
  stale = null // a pending language guess would save it again
  await api.invoke('library:delete', s.id)
  scripts = scripts.filter(x => x !== s)
  scripts.length ? select(scripts[0]) : $('#new').onclick()
}

async function importFiles(paths) {
  try {
    const { added, errors } = await api.invoke('library:import', paths), n = added.length
    if (n) { scripts.unshift(...added); select(added[0]) }
    // One line per problem file; main also warns here about files it did import.
    if (errors.length) banner([n ? `Imported ${n} script${n > 1 ? 's' : ''}.` : 'Nothing was imported.', ...errors.slice(0, 5),
      ...errors.length > 5 ? [`and ${errors.length - 5} more`] : []].join('\n'), n ? 'warn' : 'error')
  } catch (e) {
    banner(`Couldn't import that file: ${clean(e)}`, 'error')
  }
}
$('#import').onclick = () => importFiles()
addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() })
addEventListener('drop', e => {
  if (!e.dataTransfer.types.includes('Files')) return
  e.preventDefault()
  const paths = [...e.dataTransfer.files].map(f => api.pathOf(f)).filter(Boolean) // main checks the file types
  paths.length ? importFiles(paths) : banner('Goldfish can import .docx, .txt and .md files saved on this computer.', 'error')
})

// ---------- speech model ----------

function needModel() {
  const [label, size] = MODELS[settings.model]
  banner(`To follow your voice, Goldfish needs a speech model (${label}, ${size} MB, downloaded once).`, 'info', [
    ['Download', () => download(settings.model)],
    ['Use “Scroll while I talk”', () => setMode('talk')],
  ])
}

// Another model's result never covers a download's progress, or an error about the model Start needs.
async function download(name) {
  const [label, size] = MODELS[name], el = $('#banner')
  banner(`Downloading the ${label} speech model (${size} MB)…`)
  el.append(document.createElement('progress'))
  el.dataset.model = name
  const mine = () => (el.dataset.model ?? name) === name
  try {
    await api.invoke('model:download', name)
    models = await api.invoke('models')
    // Only the model Start uses is "ready".
    if (mine()) banner(name === settings.model ? 'Speech model ready. Press Start and begin reading.' : `The ${label} speech model is downloaded.`, 'ok')
  } catch (e) {
    if (mine() || name === settings.model) {
      banner(`Couldn't download the ${label} speech model: ${clean(e)}`, 'error', [['Try again', () => download(name)]])
      if (name === settings.model) el.dataset.model = name
    }
  }
  if (name === settings.model) renderModel() // the status line shows only that model
}

api.on('model:progress', ({ name, got, total }) => {
  if (!total) return
  const p = $('#banner progress')
  if (p && $('#banner').dataset.model === name) Object.assign(p, { max: total, value: got })
  if (name === settings.model) $('#model-status').textContent = `Downloading… ${Math.round(got / total * 100)}%`
})

function renderModel() {
  const id = settings.model, el = $('#model-status')
  el.replaceChildren(`${MODELS[id][2]} `, models[id] ? 'Downloaded.' : button('Download', () => download(id), 'link'))
}

// ---------- mode, start and stop ----------

function setMode(mode) {
  $(`input[name=mode][value=${mode}]`).checked = true
  setSetting({ mode })
  mode === 'voice' && !models[settings.model] ? needModel() : banner('')
}
for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = () => setMode(r.value)

$('#start').onclick = async () => {
  if (running) return api.invoke('session:stop')
  refresh() // a language guess still waiting must reach main before the session reads the script
  const r = await api.invoke('session:start', current.id)
  if (r.error === 'model-missing') needModel()
  else if (r.error) banner(r.error, 'error')
  else if (r.warning) banner(r.warning, 'warn')
  else banner('')
}

api.on('session', s => {
  running = s.running
  $('#start').textContent = running ? 'Stop' : 'Start'
  $('#start').classList.toggle('stop', running)
  $('#live').hidden = !running
  if (!running) return
  const pct = s.total ? Math.round(s.pos / s.total * 100) : 0
  $('#live').textContent = s.status || `${!s.playing ? 'Paused' : s.speaking ? 'Hearing you' : 'Listening'} · ${pct}%`
  $('#live').className = s.status ? s.statusKind : !s.playing ? 'paused' : s.speaking ? 'on' : ''
  $('#live').title = s.status || '' // long errors are cut short in the pill
})

// ---------- settings dialog ----------

const UNITS = { speed: ' words/s', fontSize: ' px', barWidth: ' px', lines: '' }
function showOutput(el) {
  const out = el.nextElementSibling
  if (out?.tagName !== 'OUTPUT') return
  out.textContent = el.dataset.key === 'sensitivity' ? `${Math.round(el.value * 100)}%` : el.value + UNITS[el.dataset.key]
}

const keyLabel = k => !k ? 'Off' : k.replace('CommandOrControl', isMac ? 'Cmd' : 'Ctrl').replace('Alt', isMac ? 'Option' : 'Alt').replaceAll('+', ' + ')

async function openSettings() {
  $('[data-key=model]').replaceChildren(...Object.entries(MODELS).map(([id, [label, size]]) => new Option(`${label} (${size} MB)`, id)))
  for (const el of document.querySelectorAll('[data-key]')) {
    if (el.type === 'checkbox') el.checked = settings[el.dataset.key]
    else el.value = settings[el.dataset.key]
    showOutput(el)
  }
  for (const el of document.querySelectorAll('[data-shortcut]')) el.value = keyLabel(settings.keys[el.dataset.shortcut])
  renderModel()
  $('#settings').showModal()

  const displays = await api.invoke('displays')
  fill('display', [new Option('Main screen', 0), ...displays.map(d => new Option(d.label, d.id))], 'Saved screen (not connected)')
  // Microphone names are only listed after mic access has been granted once, so open the mic only then.
  let devices = await navigator.mediaDevices.enumerateDevices()
  if (devices.some(d => d.kind === 'audioinput' && !d.label)) {
    await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()), () => {})
    devices = await navigator.mediaDevices.enumerateDevices()
  }
  const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  fill('mic', [new Option('System default', ''), ...mics.map(d => new Option(d.label || 'Microphone', d.deviceId))], 'Saved microphone (not connected)')
}

// A saved choice that isn't plugged in stays listed, so the box isn't blank.
function fill(key, options, missing) {
  const el = $(`[data-key=${key}]`), value = String(settings[key])
  if (!options.some(o => o.value === value)) options.push(new Option(missing, value))
  el.replaceChildren(...options)
  el.value = value
}

for (const el of document.querySelectorAll('[data-key]')) {
  el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
    const key = el.dataset.key
    let value = el.type === 'checkbox' ? el.checked : el.value
    if (el.type === 'range' || key === 'display') value = Number(value)
    if (key === 'remotePort') el.value = value = Math.min(65535, Math.max(1024, Math.round(value) || 7373))
    showOutput(el)
    setSetting({ [key]: value }).then(() => key === 'model' && renderModel())
  })
}

// Shortcut boxes record the keys you press; Backspace turns a shortcut off.
const NAMED_KEYS = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End' }
function accelerator(e) {
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5)
    : /^F\d{1,2}$/.test(e.code) ? e.code : NAMED_KEYS[e.code]
  if (!key) return null
  const mods = [e.metaKey && (isMac ? 'CommandOrControl' : 'Super'), e.ctrlKey && (isMac ? 'Control' : 'CommandOrControl'),
    e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
  return [...mods, key].join('+')
}
for (const el of document.querySelectorAll('[data-shortcut]')) {
  el.onkeydown = e => {
    if (e.key === 'Tab' || e.key === 'Escape') return
    e.preventDefault()
    const key = e.key === 'Backspace' || e.key === 'Delete' ? '' : accelerator(e)
    if (key === null) return
    el.value = keyLabel(key)
    setSetting({ keys: { ...settings.keys, [el.dataset.shortcut]: key } })
  }
}

// ---------- phone remote dialog ----------

async function openRemote() {
  const r = await api.invoke('remote'), body = $('#remote-body')
  const p = (textContent, className = '') => Object.assign(document.createElement('p'), { textContent, className })
  if (!r.enabled) {
    body.replaceChildren(p('See your script on your phone, and pause, go back or skip ahead from anywhere in the room.'),
      button('Turn on phone remote', async () => { await setSetting({ remote: true }); openRemote() }, 'primary'))
  } else if (r.error) {
    body.replaceChildren(p(r.error, 'error'))
  } else {
    body.replaceChildren(Object.assign(document.createElement('img'), { className: 'qr', src: r.qr, alt: 'QR code' }),
      p("Scan with your phone's camera. It has to be on the same Wi-Fi as this computer."),
      p(r.url, 'url'),
      ...r.others?.length ? [p(`Not loading? Try: ${r.others.join(', ')}`, 'url')] : [],
      p('Page not loading? Allow Goldfish through your firewall when your computer asks.', 'hint'))
  }
  if (!$('#remote').open) $('#remote').showModal()
}

// ---------- start ----------

$('#gear').onclick = openSettings
$('#phone').onclick = openRemote
$('#capture-hint').hidden = !isMac
$(`input[name=mode][value=${settings.mode}]`).checked = true
if (scripts.length) select(scripts[0])
else $('#new').onclick()
if (settings.mode === 'voice' && !models[settings.model]) needModel()
if (notices.length) notice(...notices)
