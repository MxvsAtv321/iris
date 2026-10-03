// No React updates or allocations in the per-frame sampling path.
export class AudioLevel {
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: AudioNode | null = null
  private stream: MediaStream | null = null
  private samples = new Float32Array(512)
  private generation = 0
  private boundaryAt = -Infinity
  private voiceActive = false
  private mediaSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
  private ensureContext() {
    if (!this.context) this.context = new AudioContext()
    return this.context
  }
  private connect(source: AudioNode, audible: boolean) {
    const ctx = this.ensureContext()
    this.source = source
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 512
    source.connect(this.analyser)
    if (audible) this.analyser.connect(ctx.destination)
  }

  async unlock() {
    const ctx = this.ensureContext()
    const resumed = ctx.resume()
    const silent = ctx.createBufferSource()
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
    silent.connect(ctx.destination)
    silent.start()
    await resumed
  }
  async playVoice(data: ArrayBuffer, signal: AbortSignal, started: () => void) {
    const ctx = this.ensureContext()
    const buffer = await ctx.decodeAudioData(data)
    if (signal.aborted) return
    this.stop()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    this.connect(source, true)
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort)
        if (this.source === source) this.stop()
        resolve()
      }
      const abort = () => { source.stop(); finish() }
      source.onended = finish
      signal.addEventListener('abort', abort, { once: true })
      try { source.start(); started() } catch (error) {
        signal.removeEventListener('abort', abort)
        this.stop()
        reject(error)
      }
    })
  }
  async startMic() {
    this.stop()
    const generation = this.generation
    try {
      const ctx = this.ensureContext()
      // Resume during the initiating tap, before the permission await.
      void ctx.resume().catch(() => {})
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
      this.connect(ctx.createMediaStreamSource(stream), false)
    } catch { /* Recognition and typed questions remain usable without visualization audio. */ }
  }
  // Call with the actual TTS <audio> element once the backend provides audio.
  // Cross-origin audio needs CORS headers and element.crossOrigin = 'anonymous'.
  async attachVoice(element: HTMLMediaElement) {
    this.stop()
    const ctx = this.ensureContext()
    let source = this.mediaSources.get(element)
    if (!source) { source = ctx.createMediaElementSource(element); this.mediaSources.set(element, source) }
    this.connect(source, true)
    await ctx.resume()
  }
  speechStart() { this.voiceActive = true; this.boundaryAt = performance.now() }
  speechBoundary() { this.boundaryAt = performance.now() }
  read = () => {
    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.samples)
      let energy = 0
      for (let i = 0; i < this.samples.length; i++) energy += this.samples[i] ** 2
      return Math.min(1, Math.max(0, Math.sqrt(energy / this.samples.length) - 0.008) * 7)
    }
    // SpeechSynthesis exposes timing, not PCM. This is an envelope, not measured volume.
    return this.voiceActive ? Math.exp(-(performance.now() - this.boundaryAt) / 180) * 0.65 : 0
  }
  stop() {
    this.generation++
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.source?.disconnect(); this.source = null
    this.analyser?.disconnect(); this.analyser = null
    this.voiceActive = false; this.boundaryAt = -Infinity
  }
  dispose() {
    this.stop()
    if (this.context) void this.context.close().catch(() => {})
    this.context = null
    this.mediaSources = new WeakMap()
  }
}
