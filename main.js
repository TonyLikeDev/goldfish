import { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, utilityProcess, systemPreferences } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import mammoth from 'mammoth'
import QRCode from 'qrcode'
import { mdToText, guessLang } from './src/script.js'

const dir = import.meta.dirname
const preload = path.join(dir, 'preload.cjs')
const isMac = process.platform === 'darwin'
if (!app.requestSingleInstanceLock()) app.quit()

// ---------- storage: JSON files in the user data folder ----------

const dataFile = name => path.join(app.getPath('userData'), name)
function load(name, fallback) {
  const file = dataFile(name)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    // Keep a damaged file aside rather than overwriting it on the next save.
    if (e.code !== 'ENOENT') fs.renameSync(file, `${file}.broken-${Date.now()}`)
    return fallback
  }
}
function save(name, data) {
  const file = dataFile(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data))
  fs.renameSync(`${file}.tmp`, file)
}

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
const saved = load('settings.json', {})
let settings = { ...DEFAULTS, ...saved, keys: { ...DEFAULTS.keys, ...saved.keys } }

const mod = isMac ? 'Command' : 'Control'
let library = load('library.json', null) ?? { scripts: [{
  id: crypto.randomUUID(), title: 'Welcome to Goldfish', lang: 'en', updated: Date.now(),
  text: `Welcome to Goldfish! This is your teleprompter. Press Start and read this text out loud. Goldfish listens to your voice and highlights each word as you say it, so you never lose your place.

The bar sits right under your webcam, so you keep eye contact with your audience. It stays hidden from screen sharing and screen recordings.

Scroll the bar with your mouse or trackpad to jump ahead or back. Press ${mod} Shift Space to pause, and ${mod} Shift Up or Down to move one line.

Paste your own script here, or import a Word, text or Markdown file. Good luck with your presentation!`,
}] }

// ---------- windows ----------

let win = null, bar = null, session = null, barState = {}

function createMain() {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 760, minHeight: 480, title: 'Goldfish', autoHideMenuBar: true,
    backgroundColor: '#16161a', webPreferences: { preload },
  })
  win.loadFile(path.join(dir, 'src/index.html'))
  win.on('closed', () => { win = null; app.quit() })
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
  session = { script: { ...script } }
  barState = { pos: 0, total: 0, playing: true }
  engineFailures = 0
  openBar()
  const failed = registerKeys()
  notify()
  broadcast(remoteScript())
  return failed.length ? { warning: `These shortcuts are used by another app: ${failed.join(', ')}` } : {}
}

function stopSession() {
  if (!session) return
  session = null
  globalShortcut.unregisterAll()
  stopEngine()
  if (bar && !bar.isDestroyed()) bar.destroy()
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

const MODELS = ['large-v3-turbo-q5_0', 'small-q5_1', 'base-q5_1']
const MODEL_URL = name => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`
const modelPath = name => path.join(app.getPath('userData'), 'models', `ggml-${name}.bin`)
let engine = null, engineReady = null, engineFailures = 0, gpuFailed = false, seq = 0
const pending = new Map()

// Starts the engine once; a failed start is retried on the next call.
const ensureEngine = () => engineReady ??= startEngine().catch(e => { engineReady = null; throw e })

function engineCall(msg) {
  return new Promise((resolve, reject) => {
    if (!engine) return reject(new Error('Speech engine stopped'))
    const id = ++seq
    pending.set(id, { resolve, reject })
    engine.postMessage({ ...msg, id })
  })
}

async function startEngine() {
  if (engineFailures >= 3) throw new Error('The speech engine keeps crashing. Try a smaller model or turn off GPU in Settings.')
  const file = modelPath(settings.model)
  if (!fs.existsSync(file)) throw new Error('Speech model not downloaded. Open Settings to download it.')
  // Windows needs the Vulkan build for GPU; macOS (Metal) and CPU use the default build.
  const variant = !isMac && settings.gpu && !gpuFailed ? 'vulkan' : 'default'
  const proc = engine = utilityProcess.fork(path.join(dir, 'whisper.js'), [], { serviceName: 'Goldfish Speech' })
  proc.on('message', m => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.reject(new Error(m.error)) : p.resolve(m)
  })
  proc.on('exit', code => {
    if (engine !== proc) return
    engine = engineReady = null
    for (const p of pending.values()) p.reject(new Error('Speech engine stopped'))
    pending.clear()
    if (code) {
      engineFailures++
      if (variant === 'vulkan') gpuFailed = true // GPU trouble: fall back to CPU on restart
    }
  })
  try {
    await engineCall({ type: 'load', model: file, gpu: settings.gpu, variant })
  } catch (e) {
    if (engine === proc) engine = null
    proc.kill()
    if (variant !== 'vulkan') throw e
    gpuFailed = true
    return startEngine()
  }
}

function stopEngine() {
  const proc = engine
  engine = engineReady = null
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

function startRemote() {
  remoteError = ''
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local')
    const reply = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
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
  server.on('error', e => { remoteError = e.code === 'EADDRINUSE' ? `Port ${settings.remotePort} is busy, pick another one.` : e.message; server = null })
  server.listen(settings.remotePort, '0.0.0.0')
}

function stopRemote() {
  for (const res of clients) res.end()
  clients.clear()
  server?.close()
  server = null
}

// Prefer typical home/office LAN addresses over virtual adapters (WSL, Docker, VPNs).
function lanAddress() {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address)
  return ips.find(ip => ip.startsWith('192.168.')) ?? ips.find(ip => ip.startsWith('10.')) ?? ips[0] ?? 'localhost'
}

// ---------- IPC ----------

ipcMain.handle('settings', () => ({ settings, platform: process.platform }))
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch }
  save('settings.json', settings)
  if (bar) {
    if ('hideFromCapture' in patch) bar.setContentProtection(settings.hideFromCapture)
    const { top, ...bounds } = barBounds()
    bar.setBounds(bounds)
    bar.webContents.send('settings', { settings, top })
  }
  if ('remote' in patch || 'remotePort' in patch) { stopRemote(); if (settings.remote) startRemote() }
  if ('model' in patch || 'gpu' in patch) { stopEngine(); gpuFailed = false } // reloads on next use
  return { settings, failed: 'keys' in patch && session ? registerKeys() : [] }
})

ipcMain.handle('displays', () => screen.getAllDisplays().map(d => ({ id: d.id, label: d.label || `${d.size.width}×${d.size.height}` })))

ipcMain.handle('library', () => library.scripts)
ipcMain.handle('library:save', (_e, script) => {
  const i = library.scripts.findIndex(s => s.id === script.id)
  script.updated = Date.now()
  if (i < 0) library.scripts.unshift(script)
  else library.scripts[i] = script
  save('library.json', library)
})
ipcMain.handle('library:delete', (_e, id) => {
  library.scripts = library.scripts.filter(s => s.id !== id)
  save('library.json', library)
})
ipcMain.handle('library:import', async (_e, paths) => {
  if (!paths?.length) {
    paths = (await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Scripts', extensions: ['txt', 'md', 'markdown', 'docx'] }],
    })).filePaths
  }
  const added = []
  for (const file of paths) {
    const ext = path.extname(file).toLowerCase()
    let text
    if (ext === '.docx') text = (await mammoth.extractRawText({ path: file })).value
    else {
      text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
      if (ext === '.md' || ext === '.markdown') text = mdToText(text)
    }
    text = text.trim()
    added.push({ id: crypto.randomUUID(), title: path.basename(file, ext), text, lang: guessLang(text, settings.lang), updated: Date.now() })
  }
  library.scripts.unshift(...added)
  save('library.json', library)
  return added
})

ipcMain.handle('session:start', (_e, id) => startSession(id))
ipcMain.handle('session:stop', () => stopSession())

ipcMain.handle('models', () => Object.fromEntries(MODELS.map(m => [m, fs.existsSync(modelPath(m))])))
let downloading = null
ipcMain.handle('model:download', (_e, name) => downloading ??= (async () => {
  if (!MODELS.includes(name)) throw new Error(`Unknown model ${name}`)
  const file = modelPath(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const res = await fetch(MODEL_URL(name))
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0, last = 0
  await pipeline(res.body, async function* (chunks) {
    for await (const chunk of chunks) {
      got += chunk.length
      if (Date.now() - last > 250) { last = Date.now(); win?.webContents.send('model:progress', { name, got, total }) }
      yield chunk
    }
  }, fs.createWriteStream(`${file}.part`))
  if (total && got !== total) throw new Error('Download incomplete, please try again.')
  fs.renameSync(`${file}.part`, file)
})().finally(() => { downloading = null }))

// The bar asks for its script, then streams audio windows here for transcription.
ipcMain.handle('bar:init', () => ({
  script: session?.script, settings, top: barBounds().top,
  testAudio: process.env.GOLDFISH_TEST_AUDIO ? fs.readFileSync(process.env.GOLDFISH_TEST_AUDIO) : null,
}))
ipcMain.handle('engine:ready', () => ensureEngine())
ipcMain.handle('transcribe', async (_e, pcm, opts) => {
  await ensureEngine()
  return (await engineCall({ type: 'transcribe', pcm, opts })).text
})
ipcMain.on('bar:state', (_e, state) => {
  barState = state
  notify()
  broadcast({ type: 'state', ...state })
})

ipcMain.handle('remote', async () => {
  if (!settings.remote) return { enabled: false }
  const url = `http://${lanAddress()}:${settings.remotePort}/?t=${token}`
  return { enabled: true, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 360 }), error: remoteError }
})

// ---------- app lifecycle ----------

app.on('second-instance', () => { win?.show(); win?.focus() })
app.on('will-quit', () => { globalShortcut.unregisterAll(); engine?.kill() })
app.whenReady().then(() => {
  createMain()
  if (settings.remote) startRemote()
  if (app.isPackaged) import('electron-updater').then(m => m.default.autoUpdater.checkForUpdatesAndNotify()).catch(() => {})
})
