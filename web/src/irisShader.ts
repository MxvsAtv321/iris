export const vertexShader = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`

// One pass: polar-domain fibers, periodic angular noise, and analytic bloom.
// The low-quality variant removes two noise octaves and the fine fiber layer.
export function fragmentShader(simple: boolean) {
  return `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 resolution;
uniform float time;
uniform vec3 state;
uniform float amplitude;
uniform float motion;
const float TAU = 6.2831853;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.,0.)), f.x),
             mix(hash(i + vec2(0.,1.)), hash(i + vec2(1.,1.)), f.x), f.y);
}
float fbm(vec2 p) {
  float n = 0.5 * noise(p);
  p = p * 2.03 + 7.1;
  n += 0.25 * noise(p);
  ${simple ? '' : 'p = p * 2.01 + 3.7; n += 0.125 * noise(p); p = p * 2.02 + 2.1; n += 0.0625 * noise(p);'}
  return n;
}
void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - resolution) / min(resolution.x, resolution.y);
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float listen = state.x, think = state.y, speak = state.z;
  float volume = amplitude * motion;
  float t = time * motion;
  float pupil = 0.245 + listen * (0.048 + volume * 0.055) - think * 0.058;
  float outer = 0.72 + speak * (0.025 + volume * 0.08);
  float ripple = listen * volume * 0.018 * sin(r * 45.0 - t * 8.0 + a * 3.0);
  float radial = r + ripple;
  float twist = a + (1.0 - radial) * (0.8 + think * 2.2) - t * (0.025 + think * 0.3);
  vec2 polar = vec2(cos(twist), sin(twist));
  float n = fbm(polar * 6.0 + vec2(radial * 4.0 - t * 0.09, radial * 2.0));
  float warp = n * 5.0 + sin(radial * 17.0 - t * 0.45) * (0.16 + volume * 0.16);
  float fiber1 = pow(0.5 + 0.5 * sin(twist * 89.0 + warp * 2.0 + radial * 12.0), 8.0);
  float fiber2 = pow(0.5 + 0.5 * sin(twist * 137.0 - warp * 1.5 + radial * 21.0), 10.0);
  float fine = ${simple ? '0.0' : 'pow(0.5 + 0.5 * sin(twist * 211.0 + warp * 3.0), 12.0)'};
  float envelope = smoothstep(pupil, pupil + 0.085, radial) * (1.0 - smoothstep(outer - 0.19, outer, radial));
  float strands = (fiber1 * 0.7 + fiber2 * 0.5 + fine * 0.25) * (0.4 + n);
  float innerLight = exp(-pow((radial - pupil - 0.09) / 0.075, 2.0));
  float halo = exp(-pow((r - outer + 0.14) / 0.2, 2.0));
  float hue = 0.5 + 0.5 * sin(a * 2.0 + n * 3.0 + t * 0.12);
  vec3 color = mix(vec3(0.19,0.10,0.85), vec3(0.63,0.28,1.0), hue);
  color = mix(color, vec3(0.4,0.58,1.0), 0.2 * (0.5 + 0.5 * sin(a * 3.0 - r * 12.0 + t * 0.15)));
  float energy = 1.0 + speak * volume * 1.3;
  vec3 light = color * envelope * (strands * 2.0 + 0.12 + innerLight * 0.28) * energy;
  light += vec3(0.42,0.22,0.92) * halo * 0.13 * energy;
  light += vec3(0.7,0.58,1.0) * innerLight * envelope * strands * 0.45;
  // Sparse points at the outer fiber tips, using a periodic angular signal.
  float tips = pow(0.5 + 0.5 * sin(a * 173.0 + sin(a * 29.0)), 40.0);
  light += vec3(0.56,0.45,1.0) * tips * exp(-pow((r - outer + 0.045) / 0.014, 2.0)) * 0.55;
  light *= smoothstep(pupil - 0.015, pupil + 0.025, r);
  float alpha = clamp(max(light.r, max(light.g, light.b)), 0.0, 1.0);
  float pupilMask = 1.0 - smoothstep(pupil - 0.025, pupil + 0.025, r); gl_FragColor = vec4(light + vec3(0.012, 0.008, 0.028) * pupilMask, max(alpha, pupilMask));
}
`
}

export class FrameBudget {
  private start = 0
  private frames = 0
  private slowWindows = 0
  reset() { this.start = 0; this.frames = 0; this.slowWindows = 0 }
  sample(now: number): boolean {
    if (!this.start) { this.start = now; return false }
    this.frames++
    const elapsed = now - this.start
    if (elapsed < 1200) return false
    const fps = this.frames * 1000 / elapsed
    this.slowWindows = fps < 30 ? this.slowWindows + 1 : 0
    this.start = now; this.frames = 0
    return this.slowWindows >= 2
  }
}
