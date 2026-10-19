import { tokenize, locate } from './script.js'

const api = window.goldfish
const $ = id => document.getElementById(id)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const RATE = 16000, RING = RATE * 8, WINDOW = RATE * 6 // mic buffer, and the audio Whisper hears each time

let { script, settings, top, testAudio } = await api.invoke('bar:init')
let idx, spans = [], wordPart = [], pos = 0, playing = true, shown = -1, status = ''

// ---------- display ----------

function applyStyle() {
  const s = document.documentElement.style
  s.setProperty('--font', `${settings.fontSize}px`)
  s.setProperty('--hl', settings.highlight)
  s.setProperty('--top', `${top}px`)
  shown = -1
}

function render() {
  idx = tokenize(script.text, script.lang)
  const frag = document.createDocumentFragment()
  idx.parts.forEach((p, i) => {
    if (p.w < 0) return (spans.at(-1) ?? frag).append(p.text) // punctuation dims with its word
    const s = document.createElement('span')
    s.textContent = p.text
    spans.push(s)
    wordPart.push(i)
    frag.append(s)
  })
  $('text').replaceChildren(frag)
}

let painted = ''
function paint() {
  const cur = Math.min(Math.floor(pos), spans.length)
  if (cur !== shown) {
    // Re-class only the words between the old and the new position.
    const [a, b] = shown < 0 ? [0, spans.length] : [Math.min(cur, shown), Math.min(Math.max(cur, shown) + 1, spans.length)]
    for (let i = a; i < b; i++) spans[i].className = i < cur ? 'read' : i === cur ? 'cur' : ''
    shown = cur
    const el = spans[Math.min(cur, spans.length - 1)]
    if (el) $('text').style.transform = `translateY(${-el.offsetTop}px)` // current line at the top
  }
  const dot = !playing ? 'paused' : speaking() ? 'on' : ''
  const width = `${spans.length ? (Math.min(pos / spans.length, 1) * 100).toFixed(1) : 0}%`
  const next = `${dot}|${width}|${status}`
  if (next === painted) return
  painted = next
  $('dot').className = dot
  $('progress').style.width = width
  $('status').textContent = status
  document.body.classList.toggle('paused', !playing)
}

// First word of the next (dir 1) or previous (dir -1) line.
function lineStart(dir) {
  if (!spans.length) return 0
  const y = i => spans[i].offsetTop
  let i = Math.min(Math.floor(pos), spans.length - 1)
  const lineY = y(i)
  if (dir > 0) {
    while (i < spans.length && y(i) <= lineY) i++
    return i
  }
  while (i > 0 && y(i - 1) >= lineY) i--
  if (i === 0) return 0
  const prevY = y(i - 1)
  while (i > 0 && y(i - 1) >= prevY) i--
  return i
}

const history = [[0, 0]] // [sample, word] at every move, so prompts can end before the audio window
function moveTo(p) {
  pos = Math.max(0, Math.min(p, spans.length))
  history.push([total, Math.floor(pos)])
  if (history.length > 500) history.shift()
}

// A move by hand: audio heard so far was read at the old place, so listen() stops sending it.
function jumpTo(p) {
  heardFrom = total
  moveTo(p)
}

api.on('cmd', name => {
  if (name === 'toggle') playing = !playing
  else if (name === 'back' || name === 'forward') jumpTo(lineStart(name === 'back' ? -1 : 1))
  else if (name === 'faster' || name === 'slower') {
    settings.speed = Math.min(8, Math.max(0.5, settings.speed + (name === 'faster' ? 0.25 : -0.25)))
    api.invoke('settings:set', { speed: settings.speed })
  }
})
api.on('settings', s => { ({ settings, top } = s); applyStyle() })

let wheel = 0
addEventListener('wheel', e => {
  wheel += e.deltaY
  if (Math.abs(wheel) < 50) return
  jumpTo(lineStart(Math.sign(wheel)))
  wheel = 0
}, { passive: true })

// ---------- microphone and voice activity ----------

const ring = new Float32Array(RING)
let total = 0, floor = 0.003, lastVoice = -Infinity, heardFrom = 0
const speaking = () => total - lastVoice < RATE * 0.4

function onChunk(c) {
  let sum = 0
  for (let i = 0; i < c.length; i++) {
    ring[(total + i) % RING] = c[i]
    sum += c[i] * c[i]
  }
  total += c.length
  const rms = Math.sqrt(sum / c.length)
  if (rms > Math.max(floor * (6 - 4 * settings.sensitivity), 0.004)) lastVoice = total
  // Noise floor drops fast and creeps up only with non-speech sound.
  // ponytail: energy VAD; swap in Silero VAD (whisper.node has it) if noisy rooms trip it.
  else floor = rms < floor ? floor * 0.7 + rms * 0.3 : floor * 0.98 + rms * 0.02
}

async function startAudio() {
  const ctx = new AudioContext({ sampleRate: RATE })
  await ctx.audioWorklet.addModule('mic-worklet.js')
  const node = new AudioWorkletNode(ctx, 'mic')
  node.port.onmessage = e => onChunk(e.data)
  node.connect(ctx.destination) // keeps the graph running; the worklet outputs silence
  if (testAudio) { // GOLDFISH_TEST_AUDIO=file.wav plays a recording instead of the mic
    const src = ctx.createBufferSource()
    src.buffer = await ctx.decodeAudioData(testAudio.buffer.slice(testAudio.byteOffset, testAudio.byteOffset + testAudio.byteLength))
    src.connect(node)
    src.start()
    return
  }
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: settings.mic ? { ...audio, deviceId: { exact: settings.mic } } : audio })
    .catch(() => navigator.mediaDevices.getUserMedia({ audio })) // chosen mic unplugged: use the default one
  ctx.createMediaStreamSource(stream).connect(node)
}

// ---------- follow my voice: transcribe the last few seconds, find them in the script ----------

function promptBefore(sample) {
  let p = 0
  for (const [s, w] of history) if (s <= sample) p = w
  return p ? idx.parts.slice(wordPart[Math.max(0, p - 30)], wordPart[p - 1] + 1).map(x => x.text).join('') : ''
}

const cleanError = e => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function listen() {
  if (settings.mode === 'voice') {
    status = 'Preparing speech engine…'
    await api.invoke('engine:ready').then(() => { status = '' }, e => { status = cleanError(e) })
  }
  let lastSent = 0
  for (;;) {
    await sleep(100)
    if (settings.mode !== 'voice' || !playing || pos >= spans.length) continue
    if (total - lastVoice > RATE || total - lastSent < RATE / 4) continue // only while talking, only with new audio
    const start = Math.max(total - WINDOW, heardFrom), n = total - start
    if (n < RATE) continue // too short to hold the few words locate() needs, e.g. just after a move
    const pcm = new Int16Array(n)
    for (let i = 0; i < n; i++) pcm[i] = Math.max(-1, Math.min(1, ring[(start + i) % RING])) * 32767
    lastSent = total
    try {
      // The prompt is script text read before this audio window: it helps spelling and language
      // without making Whisper skip words it thinks it already heard.
      const text = await api.invoke('transcribe', pcm.buffer, { language: script.lang, prompt: promptBefore(start) })
      const next = locate(idx, text, Math.floor(pos))
      // heardFrom > start: moved by hand while this was transcribing, so the result is stale.
      if (next > 0 && heardFrom <= start && settings.mode === 'voice' && playing) moveTo(next)
      status = ''
    } catch (e) {
      status = cleanError(e)
      await sleep(2000)
    }
  }
}

// ---------- scroll while I talk, painting, reporting ----------

let last = performance.now()
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  if (settings.mode === 'talk' && playing && speaking()) pos = Math.min(pos + settings.speed * dt, spans.length)
  paint()
  requestAnimationFrame(frame)
}

setInterval(() => api.send('bar:state', { pos: Math.floor(pos), total: spans.length, playing, speaking: speaking() }), 200)
applyStyle()
render()
requestAnimationFrame(frame)
startAudio().catch(e => { status = `Microphone unavailable: ${e.message}` })
listen()
