// Speech engine, run by main.js as an Electron utility process. Messages in: load, transcribe.
import { initWhisper } from '@fugood/whisper.node'

let ctx

process.parentPort.on('message', async ({ data: m }) => {
  try {
    if (m.type === 'load') {
      ctx = await initWhisper({ filePath: m.model, useGpu: m.gpu }, m.variant)
      // The first run compiles GPU shaders (~10 s on Metal at every launch, up to ~20 s on Vulkan): do it now, not mid-talk.
      await ctx.transcribeData(new ArrayBuffer(32000), { language: 'en' }).promise
      process.parentPort.postMessage({ id: m.id })
    } else {
      const { result } = await ctx.transcribeData(m.pcm, { temperature: 0, ...m.opts }).promise
      process.parentPort.postMessage({ id: m.id, text: result })
    }
  } catch (e) {
    process.parentPort.postMessage({ id: m.id, error: e?.message ?? String(e) })
  }
})
