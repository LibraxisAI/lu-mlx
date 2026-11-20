// Microphone capture for the voice session (src/api/voice-media.ts).
//
// This file is loaded with audioWorklet.addModule() from the app's own origin.
// It is a plain file on purpose: the app's Content-Security-Policy allows
// scripts from 'self' only, and a worklet built from a blob: URL is refused.
//
// It does one thing: hand the microphone signal to the page in blocks of
// 20 ms. Resampling and encoding happen in the page, where they are tested.

class LuVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    // `sampleRate` is a global of the worklet scope: the rate of the context.
    this.size = Math.max(128, Math.round(sampleRate / 50))
    this.block = new Float32Array(this.size)
    this.used = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const take = Math.min(this.size - this.used, channel.length - offset)
      this.block.set(channel.subarray(offset, offset + take), this.used)
      this.used += take
      offset += take
      if (this.used === this.size) {
        this.port.postMessage(this.block, [this.block.buffer])
        this.block = new Float32Array(this.size)
        this.used = 0
      }
    }
    return true
  }
}

registerProcessor('lu-voice-capture', LuVoiceCapture)
