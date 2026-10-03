import { useEffect, useRef, useState } from 'react'
import { fragmentShader, vertexShader, FrameBudget } from './irisShader'
import './iris.css'

export type IrisState = 'idle' | 'listening' | 'thinking' | 'speaking'
type Props = { state: IrisState; readAmplitude?: () => number }
export default function IrisVisual({ state, readAmplitude }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputs = useRef({ state, readAmplitude })
  const [fallback, setFallback] = useState(false)
  useEffect(() => { inputs.current = { state, readAmplitude } }, [state, readAmplitude])
  useEffect(() => {
    const canvas = canvasRef.current!
    const gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false,
      depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power',
    })
    if (!gl) { queueMicrotask(() => setFallback(true)); return }
    let disposed = false
    let frame = 0
    let program: WebGLProgram | null = null
    let buffer: WebGLBuffer | null = null
    let simple = false
    let previous = 0
    let elapsed = 0
    let smoothedAmplitude = 0
    const weights = [0, 0, 0]
    let uniforms: Record<string, WebGLUniformLocation | null> = {}
    const budget = new FrameBudget()
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    function compile(type: number, source: string) {
      const shader = gl!.createShader(type)!
      gl!.shaderSource(shader, source); gl!.compileShader(shader)
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        gl!.deleteShader(shader); throw new Error('Iris shader compilation failed')
      }
      return shader
    }
    function setup() {
      const shaders: WebGLShader[] = []
      const next = gl!.createProgram()!
      try {
        shaders.push(compile(gl!.VERTEX_SHADER, vertexShader))
        shaders.push(compile(gl!.FRAGMENT_SHADER, fragmentShader(simple)))
        shaders.forEach(shader => gl!.attachShader(next, shader))
        gl!.linkProgram(next)
        if (!gl!.getProgramParameter(next, gl!.LINK_STATUS)) throw new Error('Iris shader linking failed')
      } catch (error) { gl!.deleteProgram(next); throw error }
      finally { shaders.forEach(shader => gl!.deleteShader(shader)) }
      if (program) gl!.deleteProgram(program)
      program = next
      gl!.useProgram(program)
      if (!buffer) {
        buffer = gl!.createBuffer()
        gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer)
        gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl!.STATIC_DRAW)
      } else gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer)
      const position = gl!.getAttribLocation(program, 'position')
      gl!.enableVertexAttribArray(position)
      gl!.vertexAttribPointer(position, 2, gl!.FLOAT, false, 0, 0)
      uniforms = Object.fromEntries(['resolution','time','state','amplitude','motion'].map(name => [name, gl!.getUniformLocation(program!, name)]))
      canvas.dataset.quality = simple ? 'simple' : 'full'
      resize()
    }
    function resize() {
      const size = Math.max(1, Math.round(Math.min(simple ? 280 : 512, canvas.clientWidth * Math.min(devicePixelRatio || 1, simple ? 1 : 1.5))))
      canvas.width = size; canvas.height = size
      gl!.viewport(0, 0, size, size)
    }
    function fail() { cancelAnimationFrame(frame); if (!disposed) setFallback(true) }
    function draw(now: number) {
      if (disposed || document.hidden || gl!.isContextLost()) return
      const delta = previous ? Math.min((now - previous) / 1000, 0.1) : 1 / 60
      previous = now; elapsed += delta
      const input = inputs.current
      const target = ['listening', 'thinking', 'speaking'].indexOf(input.state)
      const blend = 1 - Math.exp(-delta * 6)
      for (let i = 0; i < 3; i++) weights[i] += ((i === target ? 1 : 0) - weights[i]) * blend
      const raw = input.readAmplitude?.() ?? 0
      const amplitude = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
      smoothedAmplitude += (amplitude - smoothedAmplitude) * (1 - Math.exp(-delta * (amplitude > smoothedAmplitude ? 22 : 7)))
      gl!.uniform2f(uniforms.resolution, canvas.width, canvas.height)
      gl!.uniform1f(uniforms.time, elapsed)
      gl!.uniform3f(uniforms.state, weights[0], weights[1], weights[2])
      gl!.uniform1f(uniforms.amplitude, smoothedAmplitude)
      gl!.uniform1f(uniforms.motion, reduced.matches ? 0 : 1)
      gl!.drawArrays(gl!.TRIANGLES, 0, 3)
      if (!reduced.matches && budget.sample(now)) {
        if (simple) { fail(); return }
        simple = true; budget.reset()
        try { setup() } catch { fail(); return }
      }
      frame = requestAnimationFrame(draw)
    }
    function visibility() {
      cancelAnimationFrame(frame); previous = 0; budget.reset()
      if (!document.hidden) frame = requestAnimationFrame(draw)
    }
    function lost(event: Event) { event.preventDefault(); cancelAnimationFrame(frame); setFallback(true) }
    function restored() {
      if (disposed) return
      program = null; buffer = null; previous = 0; budget.reset()
      try { setup(); setFallback(false); visibility() } catch { fail() }
    }
    try { setup(); frame = requestAnimationFrame(draw) } catch { queueMicrotask(fail) }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    document.addEventListener('visibilitychange', visibility)
    canvas.addEventListener('webglcontextlost', lost)
    canvas.addEventListener('webglcontextrestored', restored)
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', restored)
      if (program) gl.deleteProgram(program)
      if (buffer) gl.deleteBuffer(buffer)
    }
  }, [])
  return <div className="iris-visual" data-state={state} data-renderer={fallback ? 'css' : 'webgl'} role="img" aria-label={`Iris ${state}`}>
    <canvas ref={canvasRef} className={fallback ? 'iris-canvas hidden-canvas' : 'iris-canvas'} aria-hidden="true" />
    {fallback && <div className="iris-simple" aria-hidden="true"><div /></div>}
  </div>
}
