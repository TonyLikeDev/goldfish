// Collects microphone samples into 100 ms chunks (at the 16 kHz context rate) for the bar.
registerProcessor('mic', class extends AudioWorkletProcessor {
  buf = new Float32Array(1600)
  n = 0

  process([input]) {
    const ch = input[0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf)
          this.buf = new Float32Array(1600)
          this.n = 0
        }
      }
    }
    return true
  }
})
