import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, utilityProcess, systemPreferences, shell, Menu, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import mammoth from 'mammoth'
import QRCode from 'qrcode'
import { mdToText } from './src/markdown.js'
import { guessLang } from './src/script.js'

const dir = import.meta.dirname
const preload = path.join(dir, 'preload.cjs')
const isMac = process.platform === 'darwin'
let win = null, bar = null, session = null, barState = {}, exiting = false

// Errors are only logged, so no error box can freeze the app (or show in a screen share) mid-talk.
// Before the main window exists, an error means Goldfish couldn't start: say so and quit.
function fatal(text) {
  if (exiting) return
  exiting = true
  dialog.showErrorBox('Goldfish', text)
  app.exit(1)
}
function onError(e) {
  console.error(e)
  if (!win) fatal(`Goldfish couldn't start because of an unexpected error.\n\n${e?.stack ?? e}`)
}
process.on('uncaughtException', onError)
process.on('unhandledRejection', onError)
if (!app.requestSingleInstanceLock()) app.quit()

// ---------- storage: JSON files in the user data folder ----------

const dataFile = name => path.join(app.getPath('userData'), name)
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
let notices = [] // for the editor's banner, held until it asks for its settings

function notice(n) {
  if (notices) notices.push(n)
  else win?.webContents.send('notice', n)
}

// Antivirus, backup and sync tools can hold a file for a moment.
// ponytail: waits synchronously (main process blocked up to 0.25 s per failing save); go async if that ever shows.
function retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

// Reads a JSON file, or else its .bak copy. `fix` returns the data cleaned up, or nothing when its shape
// is wrong. A damaged file is moved aside. A file that's there but can't be read stops the app, because
// starting with defaults would overwrite it on the next save.
function load(name, fix, what) {
  const file = dataFile(name)
  let moved = ''
  for (const f of [file, `${file}.bak`]) {
    let data
    try {
      data = fix(JSON.parse(retry(() => fs.readFileSync(f, 'utf8')).replace(/^\uFEFF/, '')))
    } catch (e) {
      if (e.code === 'ENOENT') continue
      if (e.code) {
        fatal(`Goldfish can't open ${f}. Another program may be using it, such as a backup, sync or antivirus tool: close that program, then start Goldfish again.`)
        throw e
      }
    }
    if (data) {
      if (moved) notice({ kind: 'warn', text: `${what} damaged, so Goldfish restored the last backup. The damaged file is kept at ${moved}` })
      return data
    }
    if (f === file) {
      moved = `${file}.broken-${Date.now()}`
      try { retry(() => fs.renameSync(file, moved)) } catch (e) { console.error(e) }
    }
  }
  if (moved) notice({ kind: 'warn', text: `${what} damaged, so Goldfish started fresh. The damaged file is kept at ${moved}` })
}

function save(name, data) {
  const file = dataFile(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { flush: true }) // on disk before it replaces the old file
  try { fs.writeFileSync(`${file}.bak`, fs.readFileSync(file)) } catch {} // not copyFileSync: it would copy a read-only flag too
  retry(() => fs.renameSync(`${file}.tmp`, file))
}

// Never throws: the data is still in memory, and the next change tries again.
const failing = new Set()
function store(name, data, what, meanwhile) {
  try {
    save(name, data)
    if (failing.delete(name)) notice({ kind: 'ok', text: `Your ${what} are saved again.` })
  } catch (e) {
    console.error(e)
    failing.add(name)
    const why = e.code === 'ENOSPC' ? 'the disk is full'
      : ['EPERM', 'EACCES', 'EBUSY'].includes(e.code) ? 'the file is read-only or another program is using it' : e.message
    notice({ kind: 'error', text: `Couldn't save your ${what} (${why}). ${meanwhile}` })
  }
}

const MODELS = ['large-v3-turbo-q5_0', 'small-q5_1', 'base-q5_1']
const DEFAULTS = {
  mode: 'voice', // 'voice' = follow my voice, 'talk' = scroll while I talk
  model: 'large-v3-turbo-q5_0', gpu: true, mic: '', sensitivity: 0.5, speed: 2.5,
  fontSize: 24, barWidth: 640, lines: 3, highlight: '#ffd60a', display: 0, hideFromCapture: true,
  remote: false, remotePort: 7373, lang: 'en',
  keys: {
    toggle: 'CommandOrControl+Shift+Space', back: 'CommandOrControl+Shift+Up', forward: 'CommandOrControl+Shift+Down',
    faster: 'CommandOrControl+Shift+Right', slower: 'CommandOrControl+Shift+Left', hide: 'CommandOrControl+Shift+H',
  },
}
// Hand edits, older and newer versions can leave values this version can't use: those get the default.
function fixSettings(s) {
  if (!isObj(s)) return
  s = { ...DEFAULTS, ...s, keys: { ...DEFAULTS.keys, ...(isObj(s.keys) ? s.keys : {}) } }
  for (const k in DEFAULTS) if (typeof s[k] !== typeof DEFAULTS[k]) s[k] = DEFAULTS[k]
  if (!MODELS.includes(s.model)) s.model = DEFAULTS.model
  if (s.mode !== 'voice' && s.mode !== 'talk') s.mode = DEFAULTS.mode
  if (!Number.isInteger(s.remotePort) || s.remotePort < 1024 || s.remotePort > 65535) s.remotePort = DEFAULTS.remotePort
  return s
}
let settings = load('settings.json', fixSettings, 'Your settings were') ?? fixSettings({})
const saveSettings = () => store('settings.json', settings, 'settings', 'They still apply; Goldfish will try again on your next change.')

const isScript = s => isObj(s) && typeof s.id === 'string' && typeof s.text === 'string'
const mod = isMac ? 'Command' : 'Control'
let library = load('library.json', l => isObj(l) && Array.isArray(l.scripts) ? { scripts: l.scripts.filter(isScript) } : null,
  'Your script library was') ?? { scripts: [{
  id: crypto.randomUUID(), title: 'Welcome to Goldfish', lang: 'en', langPicked: false, updated: Date.now(),
  text: `Welcome to Goldfish! This is your teleprompter. Press Start and read this text out loud. Goldfish listens to your voice and highlights each word as you say it, so you never lose your place.

The bar sits right under your webcam, so you keep eye contact with your audience. ${isMac
  ? 'To keep it out of screen sharing and recordings, share a single window instead of your whole screen.'
  : 'It stays hidden from screen sharing and screen recordings.'}

Scroll the bar with your mouse or trackpad to jump ahead or back. Press ${mod} Shift Space to pause, and ${mod} Shift Up or Down to move one line.

Paste your own script here, or import a Word, text or Markdown file. Good luck with your presentation!`,
}] }

// Edits land in memory at once and on disk 0.4 s after the last one; quitting writes a pending or failed one.
let libraryTimer = 0
function saveLibrary() {
  clearTimeout(libraryTimer)
  libraryTimer = 0
  store('library.json', library, 'scripts', 'Your text is still in Goldfish; it will try again on your next edit.')
}
const flushLibrary = () => (libraryTimer || failing.has('library.json')) && saveLibrary()

// ---------- windows ----------

function createMain() {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 760, minHeight: 480, title: 'Goldfish', autoHideMenuBar: true,
    backgroundColor: '#16161a', webPreferences: { preload },
  })
  win.setContentProtection(settings.hideFromCapture)
  win.loadFile(path.join(dir, 'src/index.html'))
  // Not showMessageBoxSync: voice follow, shortcuts and the phone remote keep working while it asks.
  let asking = false
  win.on('close', e => {
    if (!session) return
    e.preventDefault()
    if (asking) return
    asking = true
    dialog.showMessageBox(win, { type: 'question', buttons: ['Keep presenting', 'Stop and quit'], defaultId: 0, cancelId: 0,
      message: 'Stop presenting and quit Goldfish?' }).then(({ response }) => {
      asking = false
      if (response) { stopSession(); win?.close() }
    })
  })
  win.on('session-end', flushLibrary) // Windows shutdown or logoff: no before-quit then
  win.on('closed', () => { win = null; exiting = true; app.quit() })
}

// The bar hugs the top edge of the chosen screen, centered under the webcam. On a Mac it
// also covers the menu bar strip, so text starts just below the notch.
function barBounds() {
  const d = screen.getAllDisplays().find(d => d.id === settings.display) ?? screen.getPrimaryDisplay()
  const top = isMac ? Math.max(d.workArea.y - d.bounds.y, 8) : 10
  const width = Math.min(settings.barWidth, d.bounds.width)
  const height = Math.round(top + settings.lines * settings.fontSize * 1.4 + 12)
  return { x: Math.round(d.bounds.x + (d.bounds.width - width) / 2), y: d.bounds.y, width, height, top }
}

function placeBar() {
  if (!bar) return
  const { top, ...bounds } = barBounds()
  bar.setBounds(bounds)
  bar.webContents.send('settings', { settings, top })
}

function openBar() {
  const { top, ...bounds } = barBounds()
  const b = bar = new BrowserWindow({
    ...bounds, frame: false, transparent: true, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, focusable: false,
    alwaysOnTop: true, show: false, type: isMac ? 'panel' : undefined,
    webPreferences: { preload, backgroundThrottling: false },
  })
  b.setAlwaysOnTop(true, 'screen-saver') // above fullscreen slideshows
  b.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  b.setContentProtection(settings.hideFromCapture)
  b.loadFile(path.join(dir, 'src/bar.html'))
  b.once('ready-to-show', () => b.showInactive())
  b.on('closed', () => { if (bar === b) { bar = null; stopSession() } })
  // A crashed bar reloads where it was (bar:init sends barState.pos); a second crash within 10 s ends the session.
  let crashedAt = 0
  b.webContents.on('render-process-gone', () => {
    if (bar !== b) return
    if (Date.now() - crashedAt < 10e3) {
      stopSession()
      return notice({ kind: 'error', text: 'The bar stopped unexpectedly. Press Start to continue.' })
    }
    crashedAt = Date.now()
    b.webContents.reload()
  })
}

function notify() {
  win?.webContents.send('session', { running: !!session, ...barState })
}

async function startSession(id) {
  const script = library.scripts.find(s => s.id === id)
  if (!script?.text.trim()) return { error: 'This script is empty.' }
  if (settings.mode === 'voice' && !fs.existsSync(modelPath(settings.model))) return { error: 'model-missing' }
  if (isMac && !await systemPreferences.askForMediaAccess('microphone'))
    return { error: 'Goldfish needs your microphone. Allow it in System Settings > Privacy & Security > Microphone.' }
  stopSession()
  clearTimeout(idleTimer)
  session = { script: { ...script } }
  barState = { pos: 0, total: 0, playing: true }
  engineFailures = 0
  openBar()
  const failed = registerKeys(), warnings = []
  if (failed.length) warnings.push(`These shortcuts are used by another app: ${failed.join(', ')}.`)
  // macOS 15+ lets ScreenCaptureKit apps record protected windows anyway; said once.
  if (isMac && settings.hideFromCapture && parseInt(process.getSystemVersion()) >= 15 && !settings.macCaptureTipShown) {
    settings.macCaptureTipShown = true
    saveSettings()
    warnings.push('On macOS 15 and later, some screen recorders can still capture the bar. To be safe, share a single window instead of your whole screen.')
  }
  notify()
  broadcast(remoteScript())
  return warnings.length ? { warning: warnings.join(' ') } : {}
}

function stopSession() {
  if (!session) return
  session = null
  globalShortcut.unregisterAll()
  clearTimeout(idleTimer)
  idleTimer = setTimeout(stopEngine, 10 * 60e3) // the model stays loaded for a quick restart, not forever
  if (bar && !bar.isDestroyed()) bar.destroy()
  app.dock?.show() // setVisibleOnAllWorkspaces hid it on macOS
  notify()
  broadcast(remoteScript())
}

// Shortcuts are global only while presenting, so they don't steal keys the rest of the time.
function registerKeys() {
  globalShortcut.unregisterAll()
  const failed = []
  for (const [name, key] of Object.entries(settings.keys)) {
    try { if (key && !globalShortcut.register(key, () => command(name))) failed.push(key) } catch { failed.push(key) }
  }
  return failed
}

function command(name) {
  if (!bar) return
  if (name === 'hide') return bar.isVisible() ? bar.hide() : bar.showInactive()
  bar.webContents.send('cmd', name)
}

// ---------- speech engine: whisper.cpp in a utility process, so a GPU driver crash can't take the app down ----------

const MODEL_URL = name => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`
const modelPath = name => path.join(app.getPath('userData'), 'models', `ggml-${name}.bin`)
let engine = null, engineReady = null, engineFailures = 0, gpuFailed = false, seq = 0, generation = 0, idleTimer = 0
const pending = new Map()

// Starts the engine once; a failed start is retried on the next call.
function ensureEngine() {
  const p = engineReady ??= startEngine().catch(e => { if (engineReady === p) engineReady = null; throw e })
  return p
}

function engineCall(msg) {
  return new Promise((resolve, reject) => {
    if (!engine) return reject(new Error('Speech engine stopped'))
    const id = ++seq
    pending.set(id, { resolve, reject })
    engine.postMessage({ ...msg, id })
  })
}

function rejectPending(reason) {
  for (const p of pending.values()) p.reject(new Error(reason))
  pending.clear()
}

async function startEngine() {
  if (engineFailures >= 3) throw new Error('The speech engine keeps crashing. Try a smaller model or turn off GPU in Settings.')
  const file = modelPath(settings.model)
  if (!fs.existsSync(file)) throw new Error('Speech model not downloaded. Open Settings to download it.')
  if (engine) stopEngine() // never two engines
  const gen = generation
  // Windows needs the Vulkan build for GPU; macOS (Metal) and CPU use the default build.
  const variant = !isMac && settings.gpu && !gpuFailed ? 'vulkan' : 'default'
  let loading = true
  const proc = engine = utilityProcess.fork(path.join(dir, 'whisper.js'), [], { serviceName: 'Goldfish Speech' })
  proc.on('message', m => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.reject(new Error(m.error)) : p.resolve(m)
  })
  proc.on('exit', code => {
    if (engine !== proc) return
    engine = null
    if (!loading) engineReady = null // while loading, the catch below decides what comes next
    rejectPending('Speech engine stopped')
    if (code) {
      engineFailures++
      if (variant === 'vulkan') gpuFailed = true // GPU trouble: fall back to CPU on restart
    }
  })
  try {
    await engineCall({ type: 'load', model: file, gpu: settings.gpu, variant })
    loading = false
  } catch (e) {
    if (engine === proc) engine = null
    proc.kill()
    if (gen !== generation || variant !== 'vulkan') throw e // stopped on purpose, or the CPU build failed too
    gpuFailed = true
    return startEngine()
  }
}

function stopEngine(reason = 'Speech engine stopped') {
  const proc = engine
  engine = engineReady = null
  generation++
  rejectPending(reason) // before kill(), so no call waits forever
  proc?.kill()
}

// ---------- phone remote: tiny HTTP server, Server-Sent Events out, POST commands in ----------

let server = null, remoteError = ''
const token = crypto.randomBytes(12).toString('hex')
const clients = new Set()

const remoteScript = () => ({ type: 'script', running: !!session, ...session?.script, fontSize: settings.fontSize })
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of clients) res.write(data)
}

// Never throws: a bad or busy port shows up in the phone remote dialog.
function startRemote() {
  remoteError = ''
  const failed = e => {
    const port = settings.remotePort
    remoteError = ['EADDRINUSE', 'EACCES'].includes(e.code) ? `Port ${port} is busy, pick another one.`
      : e.code === 'ERR_SOCKET_BAD_PORT' ? `Port ${port} can't be used, pick a whole number from 1024 to 65535.` : e.message
    server = null
  }
  server = http.createServer((req, res) => {
    const reply = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
    const url = URL.parse(req.url, 'http://local')
    if (!url) return reply(400, 'text/plain', 'Bad request')
    if (url.pathname === '/script.js') return reply(200, 'text/javascript', fs.readFileSync(path.join(dir, 'src/script.js')))
    if (url.searchParams.get('t') !== token) return reply(403, 'text/plain', 'Scan the QR code in Goldfish again.')
    if (url.pathname === '/') return reply(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(dir, 'src/remote.html')))
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(`data: ${JSON.stringify(remoteScript())}\n\ndata: ${JSON.stringify({ type: 'state', ...barState })}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (url.pathname === '/cmd' && req.method === 'POST') { command(url.searchParams.get('do')); return reply(204, 'text/plain', '') }
    reply(404, 'text/plain', 'Not found')
  })
  server.on('error', failed)
  try { server.listen(settings.remotePort, '0.0.0.0') } catch (e) { failed(e) }
}

function stopRemote() {
  for (const res of clients) res.end()
  clients.clear()
  server?.close()
  server = null
}

// Addresses a phone may reach, best first: typical home and office networks (192.168, 10, 172.16-31),
// then anything else, then virtual, VPN and container adapters (a Hyper-V switch can be the only real network).
// ponytail: adapters are judged by name, so a renamed VPN adapter can still win; the dialog lists the others.
function lanAddresses() {
  const rank = (name, ip) => (/virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|loopback|tailscale|zerotier|utun|tun|tap|vpn/i.test(name) ? 4 : 0)
    + (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3)
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) => addrs.filter(a => a.family === 'IPv4' && !a.internal).map(a => [rank(name, a.address), a.address]))
    .sort((a, b) => a[0] - b[0]).map(([, ip]) => ip)
}

// ---------- importing files ----------

// Text files: a BOM says UTF-8 or UTF-16; without one, UTF-8 if it's valid, else the system's legacy code page.
// Mostly valid UTF-8 (a Windows apostrophe pasted into it) stays UTF-8: bad bytes become U+FFFD, and the import warns.
function decode(buf) {
  const bom = (...bytes) => bytes.every((x, i) => buf[i] === x)
  const enc = bom(0xEF, 0xBB, 0xBF) ? 'utf-8' : bom(0xFF, 0xFE) ? 'utf-16le' : bom(0xFE, 0xFF) ? 'utf-16be' : ''
  if (enc) return new TextDecoder(enc).decode(buf)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch {}
  const text = new TextDecoder().decode(buf)
  return text.match(/[^\0-\x7F\uFFFD]/g)?.length > text.match(/\uFFFD/g).length ? text : new TextDecoder(legacyCodePage()).decode(buf)
}
const CODEPAGES = Object.fromEntries(Object.entries({
  shift_jis: 'ja', 'euc-kr': 'ko', 'windows-1258': 'vi', 'windows-874': 'th', 'windows-1251': 'ru uk bg sr mk be kk',
  'windows-1256': 'ar fa ur', 'windows-1255': 'he', 'windows-1253': 'el', 'windows-1254': 'tr az',
  'windows-1250': 'pl cs sk hu hr sl ro bs sq', 'windows-1257': 'lt lv et',
}).flatMap(([cp, langs]) => langs.split(' ').map(lang => [lang, cp])))
function legacyCodePage() {
  const locale = app.getSystemLocale().replace('_', '-'), lang = locale.split('-')[0]
  if (lang === 'zh') return /-(TW|HK|MO|Hant)\b/i.test(locale) ? 'big5' : 'gbk'
  return CODEPAGES[lang] ?? 'windows-1252'
}

// Word: paragraphs, headings, list items and table rows end with a blank line, Shift+Enter breaks with a newline.
// Footnote and endnote markers go, and so do the notes, which mammoth lists after the text.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"' }
const docxText = html => html
  .replace(/<sup><a href="#(foot|end)note-[^<]*<\/a><\/sup>|<ol><li id="(foot|end)note-[\s\S]*$/g, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|h[1-6]|li|tr)>|<[uo]l[^>]*>/gi, '\n\n') // a sub-list opens inside its parent item
  .replace(/<[^>]*>/g, '')
  .replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot));/gi, (_, dec, hex, name) =>
    name ? ENTITIES[name.toLowerCase()] : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16)))
  .replace(/\n{3,}/g, '\n\n')
  .trim()

// Returns the new script, or adds a plain-language line to `errors`.
const TYPES = ['.txt', '.md', '.markdown', '.docx']
async function importFile(file, errors) {
  const { base, name, ext } = path.parse(file), type = ext.toLowerCase()
  const fail = why => { errors.push(`${base}: ${why}`) }
  if (!TYPES.includes(type)) return fail('Goldfish can import .docx, .txt and .md files')
  try {
    let text = type === '.docx'
      ? docxText((await mammoth.convertToHtml({ path: file }, { convertImage: mammoth.images.imgElement(() => ({})) })).value) // pictures unread
      : decode(fs.readFileSync(file))
    if (type === '.md' || type === '.markdown') text = mdToText(text)
    text = text.trim()
    if (!text) return fail('this file has no text')
    if (text.includes('\uFFFD')) fail("some characters couldn't be read; check the text")
    return { id: crypto.randomUUID(), title: name, text, lang: guessLang(text, settings.lang), langPicked: false, updated: Date.now() }
  } catch (e) {
    console.error(e)
    fail(e.code === 'ENOENT' ? "the file wasn't found"
      : e.code === 'EISDIR' ? "it's a folder, not a file"
      : e.code ? "another program is using it, or Goldfish isn't allowed to open it"
      : "Goldfish couldn't read it; the file may be damaged or password-protected")
  }
}

// ---------- IPC ----------

ipcMain.handle('settings', () => {
  const queued = notices ?? []
  notices = null
  return { settings, platform: process.platform, notices: queued }
})
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch }
  saveSettings()
  if ('hideFromCapture' in patch) for (const w of [win, bar]) w?.setContentProtection(settings.hideFromCapture)
  placeBar()
  if ('remote' in patch || 'remotePort' in patch) { stopRemote(); if (settings.remote) startRemote() }
  // The engine reloads on next use.
  if ('model' in patch || 'gpu' in patch || ('mode' in patch && settings.mode !== 'voice')) stopEngine('Switching speech model…')
  if ('model' in patch || 'gpu' in patch) gpuFailed = false
  return { settings, failed: 'keys' in patch && session ? registerKeys() : [] }
})

ipcMain.handle('displays', () => screen.getAllDisplays().map(d => ({ id: d.id, label: d.label || `${d.size.width}×${d.size.height}` })))

const deleted = new Set() // a late save must not bring a deleted script back
ipcMain.handle('library', () => library.scripts)
ipcMain.on('library:save', (_e, script) => {
  if (!isScript(script) || deleted.has(script.id)) return
  script.updated = Date.now()
  const i = library.scripts.findIndex(s => s.id === script.id)
  if (i < 0) library.scripts.unshift(script)
  else library.scripts[i] = script
  clearTimeout(libraryTimer)
  libraryTimer = setTimeout(saveLibrary, 400)
})
ipcMain.handle('library:delete', (_e, id) => {
  deleted.add(id)
  library.scripts = library.scripts.filter(s => s.id !== id)
  saveLibrary()
})
ipcMain.handle('library:import', async (_e, paths) => {
  if (!Array.isArray(paths) || !paths.length) {
    paths = (await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Scripts', extensions: ['txt', 'md', 'markdown', 'docx'] }],
    })).filePaths
  }
  const errors = [], added = []
  for (const file of paths) {
    const script = await importFile(String(file), errors)
    if (script) added.push(script)
  }
  if (added.length) { library.scripts.unshift(...added); saveLibrary() }
  return { added, errors }
})

ipcMain.handle('session:start', (_e, id) => startSession(id))
ipcMain.handle('session:stop', () => stopSession())

ipcMain.handle('models', () => Object.fromEntries(MODELS.map(m => [m, fs.existsSync(modelPath(m))])))
const downloads = new Map() // model name -> its download, so asking twice doesn't start it twice
ipcMain.handle('model:download', (_e, name) => {
  if (!downloads.has(name)) downloads.set(name, downloadModel(name).finally(() => downloads.delete(name)))
  return downloads.get(name)
})
async function downloadModel(name) {
  if (!MODELS.includes(name)) throw new Error(`Unknown model ${name}`)
  const file = modelPath(name), part = `${file}.part`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    const res = await net.fetch(MODEL_URL(name)) // Electron's fetch follows the system proxy
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0
    let got = 0, last = 0
    await pipeline(res.body, async function* (chunks) {
      for await (const chunk of chunks) {
        got += chunk.length
        if (Date.now() - last > 250) { last = Date.now(); win?.webContents.send('model:progress', { name, got, total }) }
        yield chunk
      }
    }, fs.createWriteStream(part))
    if (total && got !== total) throw new Error('Download incomplete, please try again.')
    fs.renameSync(part, file)
  } catch (e) {
    fs.rm(part, { force: true }, () => {})
    throw e
  }
}

// The bar asks for its script (and where to resume after a crash), then streams audio windows here for transcription.
ipcMain.handle('bar:init', () => ({
  script: session?.script, settings, top: barBounds().top, pos: barState.pos ?? 0,
  testAudio: process.env.GOLDFISH_TEST_AUDIO ? fs.readFileSync(process.env.GOLDFISH_TEST_AUDIO) : null,
}))
ipcMain.handle('engine:ready', () => ensureEngine())
ipcMain.handle('transcribe', async (_e, pcm, opts) => {
  await ensureEngine()
  // Only large-v3 knows Cantonese; on smaller models its token means "translate".
  if (opts?.language === 'yue' && !settings.model.startsWith('large-v3')) opts = { ...opts, language: 'zh' }
  return (await engineCall({ type: 'transcribe', pcm, opts })).text
})
ipcMain.on('bar:state', (_e, state) => {
  barState = state
  notify()
  broadcast({ type: 'state', ...state })
})

ipcMain.handle('remote', async () => {
  if (!settings.remote) return { enabled: false }
  const ips = lanAddresses()
  const [url, ...others] = (ips.length ? ips : ['localhost']).map(ip => `http://${ip}:${settings.remotePort}/?t=${token}`)
  return { enabled: true, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 360 }), error: remoteError, others }
})

ipcMain.handle('open-releases', () => shell.openExternal('https://github.com/TonyLikeDev/goldfish/releases/latest'))

// ---------- app lifecycle ----------

// The Mac build is ad-hoc signed and can't install updates itself, so it only says a new version is out.
// ponytail: notice-only on macOS until the build is signed; then drop the isMac branch so Macs update themselves.
async function checkUpdates() {
  const { autoUpdater } = (await import('electron-updater')).default
  if (!isMac) return autoUpdater.checkForUpdatesAndNotify()
  autoUpdater.autoDownload = false
  autoUpdater.on('update-available', ({ version }) =>
    notice({ kind: 'info', text: `Goldfish ${version} is available.`, action: { label: 'Download', id: 'open-releases' } }))
  await autoUpdater.checkForUpdates()
}

const showMain = () => { if (win?.isMinimized()) win.restore(); win?.show(); win?.focus() }
app.on('second-instance', showMain)
app.on('activate', showMain) // macOS: the Dock icon
// Goldfish's pages never navigate or open windows, so a stray link or dropped file can't either.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', e => e.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})
app.on('before-quit', flushLibrary)
app.on('will-quit', () => { flushLibrary(); globalShortcut.unregisterAll(); engine?.kill() })
app.whenReady().then(() => {
  // No default menu (its Reload and developer tools don't belong here); macOS needs Edit for copy and paste.
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, placeBar)
  createMain()
  if (settings.remote) startRemote()
  if (app.isPackaged) checkUpdates().catch(() => {})
})
