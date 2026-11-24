import * as THREE from 'three'
import { MAX_BLOBS } from './filmFlow.js'
import { MAX_VORTICES } from './filmVortices.js'
import { FLOW_SAMPLE_GLSL, HASH_NOISE_GLSL } from './shader.js'

// The soap film's thickness, simulated on the GPU. Each texel (equirect over
// the bubble) holds the film thickness in nm (x) and a short-memory offset for
// fine detail (yzw). Every frame the thickness is advected semi-Lagrangially
// (as in real-time fluid solvers, Stam 1999) by
//  - ambient film flow: divergence-free curl noise on the sphere (Bridson et
//    al. 2007), the slow 2D turbulence always present in a bubble film;
//  - finger momentum and press outflow (filmFlow.js).
// Thickness is carried, never pulled back: what a finger spreads stays
// spread and mixes. Spreading flow thins the film (volume is conserved), and
// gravity slowly re-sorts it into bands, thin on top, thick at the bottom.
// The fine-detail offset forgets in ~1 s: small structure in a real film is
// constantly reborn, so it never stretches into straight streaks.

// Full resolution for the single bubble; smaller maps suit small views.
export const FLOW_WIDTH = 512
export const FLOW_HEIGHT = 256

const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;
  #define MAX_BLOBS ${MAX_BLOBS}
  #define MAX_VORTICES ${MAX_VORTICES}
  uniform highp usampler2D uPrev;
  uniform vec4 uBlobA[MAX_BLOBS]; // centre, radius
  uniform vec4 uBlobB[MAX_BLOBS]; // velocity, outflow speed
  uniform int uBlobCount;
  uniform float uDt;
  uniform float uTime;
  uniform float uAmbient;
  uniform float uRelaxFine;
  uniform vec2 uPhaseReset; // two-phase maps: 1 = that detail layer restarts this step
  uniform float uSettle;
  uniform vec3 uGravity;   // local up
  uniform float uTopNm;    // film thickness at the top / bottom after drainage
  uniform float uBottomNm;
  uniform float uSwirlNm;  // initial swirl amplitude
  uniform float uSwirlScale;
  uniform float uScaleRatio;
  uniform float uWarp;
  uniform float uProfile;   // drainage profile exponent (<1 sharp thin cap, >1 thin over most)
  uniform float uBands;     // horizontal band strength
  uniform float uBandCount;
  uniform float uBandWave;
  uniform float uLaminar;   // share of calm sideways flow vs marbled turbulence
  uniform float uSense;     // net rotation sense of the film
  uniform float uThin;      // evaporation this step (mean thickness ratio)
  uniform float uHeal;      // Marangoni refill of thin spots this step
  uniform vec4 uVortex[MAX_VORTICES]; // centre, radius
  uniform float uVortexSpin[MAX_VORTICES];
  uniform int uVortexCount;
  uniform float uPlumes;    // strength of rising thin-film plumes (0: none)
  uniform float uPlumeColumns;
  uniform uint uSeed;
  uniform bool uInit;
  in vec2 vUv;
  layout(location = 0) out highp uvec4 pc_fragColor; // float bits
  ${HASH_NOISE_GLSL}
  ${FLOW_SAMPLE_GLSL}

  vec3 dirFromUv(vec2 uv) {
    float lon = (uv.x - 0.5) * 6.283185307179586;
    float lat = (uv.y - 0.5) * 3.141592653589793;
    return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  }

  // Catmull-Rom (16 taps), clamped to the 4 nearest texels: little numerical
  // blur, no overshoot, so carried colours stay crisp for a long time.
  vec4 sampleSharp(usampler2D tex, vec2 uv) {
    ivec2 size = textureSize(tex, 0);
    vec2 st = uv * vec2(size) - 0.5;
    vec2 i = floor(st);
    vec2 f = st - i;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec4 sum = vec4(0.0);
    vec4 lo = vec4(1e9);
    vec4 hi = vec4(-1e9);
    int mask = size.x - 1;
    for (int y = 0; y < 4; y++) {
      int ty = clamp(int(i.y) - 1 + y, 0, size.y - 1);
      float wy = y == 0 ? w0.y : (y == 1 ? w1.y : (y == 2 ? w2.y : w3.y));
      for (int x = 0; x < 4; x++) {
        int tx = (int(i.x) - 1 + x) & mask;
        float wx = x == 0 ? w0.x : (x == 1 ? w1.x : (x == 2 ? w2.x : w3.x));
        vec4 t = flowTexel(tex, ivec2(tx, ty));
        sum += t * (wx * wy);
        if ((x == 1 || x == 2) && (y == 1 || y == 2)) {
          lo = min(lo, t);
          hi = max(hi, t);
        }
      }
    }
    return clamp(sum, lo, hi);
  }

  // Drained film: thin on top, thick at the bottom (along the local up).
  float drained(vec3 x) {
    float depth = (1.0 - dot(x, uGravity)) * 0.5;
    float h = mix(uTopNm, uBottomNm, pow(depth, uProfile));
    // Calm films stratify into horizontal bands, a little wavy.
    float wave = uBandWave * 0.08 * gnoise(x * 2.0, uSeed + 20u);
    return h * (1.0 + 0.22 * uBands * sin(6.2832 * uBandCount * (depth + wave)));
  }

  // Gradient noise with its analytic gradient (same function as gnoise).
  float gnoiseGrad(vec3 p, uint salt, out vec3 grad) {
    ivec3 i = ivec3(floor(p));
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    vec3 ga = gradientAt(i, salt);
    vec3 gb = gradientAt(i + ivec3(1, 0, 0), salt);
    vec3 gc = gradientAt(i + ivec3(0, 1, 0), salt);
    vec3 gd = gradientAt(i + ivec3(1, 1, 0), salt);
    vec3 ge = gradientAt(i + ivec3(0, 0, 1), salt);
    vec3 gf = gradientAt(i + ivec3(1, 0, 1), salt);
    vec3 gg = gradientAt(i + ivec3(0, 1, 1), salt);
    vec3 gh = gradientAt(i + ivec3(1, 1, 1), salt);
    float va = dot(ga, f);
    float vb = dot(gb, f - vec3(1, 0, 0));
    float vc = dot(gc, f - vec3(0, 1, 0));
    float vd = dot(gd, f - vec3(1, 1, 0));
    float ve = dot(ge, f - vec3(0, 0, 1));
    float vf = dot(gf, f - vec3(1, 0, 1));
    float vg = dot(gg, f - vec3(0, 1, 1));
    float vh = dot(gh, f - vec3(1, 1, 1));
    vec3 k = vec3(va - vb - vc + vd, va - vc - ve + vg, va - vb - ve + vf);
    float kxyz = -va + vb + vc - vd + ve - vf - vg + vh;
    grad = 1.6 * (ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga)
      + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf)
      + (-ga + gb + gc - gd + ge - gf - gg + gh) * u.x * u.y * u.z
      + du * (vec3(vb, vc, ve) - va + u.yzx * k + u.zxy * k.zxy + u.yzx * u.zxy * kxyz));
    return 1.6 * (va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va)
      + u.x * u.y * k.x + u.y * u.z * k.y + u.z * u.x * k.z + kxyz * u.x * u.y * u.z);
  }

  // Gradient of the film's stream function, analytic (one noise evaluation
  // per term instead of six central differences). The stream function is
  //  - marbled turbulence on two scales: 0.8 n(1.4 x + drift) + 0.16 n(1.4 r x + drift);
  //  - calm sideways currents that shear with height (zonal flow), plus a
  //    slight net turn of the whole film: 0.45 sin(3.1 h + ...) + 0.35 sense h;
  //    mixed with the turbulence by uLaminar, scaled by uAmbient;
  //  - convection plumes: alternating up and down columns in the lower film,
  //    periodic in longitude around the gravity axis.
  vec3 streamGrad(vec3 x) {
    float h = dot(x, uGravity);
    vec3 g1, g2;
    gnoiseGrad(x * 1.4 + vec3(0.0, uTime * 0.07, uTime * 0.03), uSeed + 300u, g1);
    gnoiseGrad(x * 1.4 * uScaleRatio + vec3(uTime * 0.13, 0.0, -uTime * 0.05), uSeed + 301u, g2);
    vec3 marble = 0.8 * 1.4 * g1 + 0.16 * 1.4 * uScaleRatio * g2;
    vec3 zonal = (0.45 * 3.1 * cos(3.1 * h + uTime * 0.11 + float(uSeed % 7u)) + uSense * 0.35) * uGravity;
    vec3 grad = mix(marble, zonal, uLaminar) * uAmbient;
    if (uPlumes > 0.0) {
      vec3 g = uGravity;
      vec3 e1 = normalize(cross(g, abs(g.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
      vec3 e2 = cross(g, e1);
      float a = dot(x, e1);
      float b = dot(x, e2);
      float lon = atan(b, a);
      vec3 dLon = (a * e2 - b * e1) / max(a * a + b * b, 1e-8);
      vec3 gw;
      float wobble = 1.4 * gnoiseGrad(x * 1.7 + vec3(0.0, uTime * 0.08, 0.0), uSeed + 310u, gw);
      gw *= 1.4 * 1.7;
      float t = clamp((h - 0.65) / -1.0, 0.0, 1.0);
      float s = t * t * (3.0 - 2.0 * t);
      float ds = (t > 0.0 && t < 1.0) ? -6.0 * t * (1.0 - t) : 0.0;
      float body = (1.0 - h * h) * s;
      float dBody = -2.0 * h * s + (1.0 - h * h) * ds;
      float columns = max(uPlumeColumns, 1.0);
      float phase = uPlumeColumns * lon + wobble + uTime * 0.05;
      float k = 0.09 * uPlumes / columns;
      grad += k * (sin(phase) * dBody * g + body * cos(phase) * (uPlumeColumns * dLon + gw));
    }
    return grad;
  }

  vec3 ambient(vec3 x) {
    vec3 g = streamGrad(x);
    // n x grad(psi): tangent and divergence-free on the sphere.
    vec3 v = cross(x, g);
    // Lasting Gaussian vortices (rare bubbles).
    for (int i = 0; i < MAX_VORTICES; i++) {
      if (i >= uVortexCount) break;
      vec3 o = x - uVortex[i].xyz;
      float q = dot(o, o) / (uVortex[i].w * uVortex[i].w);
      v += uVortexSpin[i] * exp(-q) * cross(uVortex[i].xyz, x);
    }
    return v;
  }

  vec3 blobs(vec3 x, out float div) {
    vec3 v = vec3(0.0);
    div = 0.0;
    for (int i = 0; i < MAX_BLOBS; i++) {
      if (i >= uBlobCount) break;
      vec4 a = uBlobA[i];
      vec4 b = uBlobB[i];
      vec3 o = x - a.xyz;
      float r = a.w;
      float q = dot(o, o) / (r * r);
      if (q > 9.0) continue;
      float g = exp(-q);
      vec3 ot = o - a.xyz * dot(o, a.xyz);
      float speed = length(b.xyz);
      if (speed > 1e-6) {
        // Momentum patch: incompressible dipole (film moves with the finger
        // in the core and returns around the sides).
        vec3 s = b.xyz / speed;
        vec3 e = cross(a.xyz, s);
        float px = dot(ot, s) / r;
        float py = dot(ot, e) / r;
        v += speed * g * (s * (1.0 - 2.0 * py * py) + e * (2.0 * px * py));
      }
      if (b.w != 0.0) {
        v += ot / r * b.w * g;
        div += b.w / r * g * (2.0 - 2.0 * q);
      }
    }
    return v - x * dot(v, x);
  }

  void main() {
    vec3 x = dirFromUv(vUv);
    if (uInit) {
      // A freshly settled bubble: drained bands broken up by large swirls.
      vec3 warp = vec3(
        gnoise(x * 1.5, uSeed + 1u),
        gnoise(x * 1.5 + vec3(5.2, 1.3, 0.0), uSeed + 2u),
        gnoise(x * 1.5 + vec3(0.0, 9.1, 2.7), uSeed + 3u)
      );
      vec3 w = x + warp * uWarp;
      float swirl = gnoise(w * uSwirlScale, uSeed + 10u) + 0.5 * gnoise(w * uSwirlScale * uScaleRatio, uSeed + 11u);
      swirl *= 1.0 - 0.6 * uBands; // banded films carry fewer swirls
      pc_fragColor = floatBitsToUint(vec4(max(20.0, drained(x) + swirl * uSwirlNm), 0.0, 0.0, 0.0));
      return;
    }
    float div;
    float divMid;
    // Midpoint back-trace: where was the film now at x one step ago?
    vec3 v1 = ambient(x) + blobs(x, div);
    vec3 mid = normalize(x - v1 * (0.5 * uDt));
    vec3 v2 = ambient(mid) + blobs(mid, divMid);
    vec3 from = normalize(x - v2 * uDt);
    vec2 fromUv = sphereUv(from);
    // Evaporation thins the whole film as the bubble ages.
    float thickness = sampleSharp(uPrev, fromUv).x * uThin;
    // Volume is conserved: where the film spreads it thins.
    thickness *= exp(-divMid * uDt);
    // Surface tension pulls film into a thinned spot (Marangoni): thin spots
    // refill from their surroundings within seconds; thick ones are left alone,
    // so what a finger spread stays spread.
    vec2 texel = 3.0 / vec2(textureSize(uPrev, 0));
    float around = 0.25 * uThin * (
      flowSample(uPrev, fromUv + vec2(texel.x, 0.0)).x + flowSample(uPrev, fromUv - vec2(texel.x, 0.0)).x +
      flowSample(uPrev, fromUv + vec2(0.0, texel.y)).x + flowSample(uPrev, fromUv - vec2(0.0, texel.y)).x
    );
    if (around > thickness) thickness = mix(thickness, around, uHeal);
    // Plumes lift thin film from the bottom of the bubble.
    if (uPlumes > 0.0) {
      vec3 up = uGravity - x * dot(x, uGravity);
      float rising = clamp(dot(v1, up) / 0.03, 0.0, 1.0);
      float bottom = smoothstep(-0.5, -0.85, dot(x, uGravity));
      thickness = mix(thickness, uTopNm * 1.3, 1.0 - exp(-uDt * 1.2 * uPlumes * rising * bottom));
    }
    // Gravity slowly re-sorts the film into bands.
    thickness = mix(thickness, drained(x), uSettle);
  #ifdef TWO_PHASE
    // Two detail layers carried by the flow, each restarted while unseen.
    vec3 offA, offB;
    phaseSample(uPrev, fromUv, offA, offB);
    vec3 a = uPhaseReset.x > 0.5 ? vec3(0.0) : normalize(from + offA) - x;
    vec3 b = uPhaseReset.y > 0.5 ? vec3(0.0) : normalize(from + offB) - x;
    pc_fragColor = uvec4(floatBitsToUint(clamp(thickness, 4.0, 2400.0)), packHalf2x16(a.xy), packHalf2x16(vec2(a.z, b.x)), packHalf2x16(b.yz));
  #else
    vec3 fineOrigin = normalize(from + flowSample(uPrev, fromUv).yzw);
    pc_fragColor = floatBitsToUint(vec4(clamp(thickness, 4.0, 2400.0), (fineOrigin - x) * uRelaxFine));
  #endif
  }
`

const vertexShader = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// twoPhase: yzw hold two advected detail layers instead of one relaxing
// offset (shader.js FLOW_TWO_PHASE); phaseWeights() gives their blend.
const PHASE_SECONDS = 2.5

export function createFlowMap(renderer, width = FLOW_WIDTH, height = FLOW_HEIGHT, { twoPhase = false } = {}) {
  // The samplers wrap longitude with a bit mask.
  if (width & (width - 1)) throw new Error('Flow map width must be a power of two')
  // Float32 bit patterns in an unsigned-integer target: renderable on every
  // WebGL2 device without extensions, and identical everywhere.
  const options = {
    type: THREE.UnsignedIntType,
    format: THREE.RGBAIntegerFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  }
  let read = new THREE.WebGLRenderTarget(width, height, options)
  let write = new THREE.WebGLRenderTarget(width, height, options)
  // Allocated as integer targets up front: a target sampled before it was
  // ever rendered to would be bound as a float placeholder (invalid draw).
  renderer.initRenderTarget(read)
  renderer.initRenderTarget(write)
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader: `${twoPhase ? '#define TWO_PHASE\n' : ''}${fragmentShader}`,
    uniforms: {
      uPrev: { value: null },
      uBlobA: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector4(0, 0, 1, 0.1)) },
      uBlobB: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uBlobCount: { value: 0 },
      uDt: { value: 0 },
      uTime: { value: 0 },
      uAmbient: { value: 0.07 },
      uRelaxFine: { value: 1 },
      uPhaseReset: { value: new THREE.Vector2(0, 0) },
      uSettle: { value: 0 },
      uGravity: { value: new THREE.Vector3(0, 1, 0) },
      uTopNm: { value: 180 },
      uBottomNm: { value: 900 },
      uSwirlNm: { value: 110 },
      uSwirlScale: { value: 2.2 },
      uScaleRatio: { value: 2 },
      uWarp: { value: 0.35 },
      uProfile: { value: 1 },
      uBands: { value: 0 },
      uBandCount: { value: 6 },
      uBandWave: { value: 0.5 },
      uLaminar: { value: 0 },
      uSense: { value: 0 },
      uThin: { value: 1 },
      uHeal: { value: 0 },
      uVortex: { value: Array.from({ length: MAX_VORTICES }, () => new THREE.Vector4(0, 1, 0, 0.2)) },
      uVortexSpin: { value: new Float32Array(MAX_VORTICES) },
      uVortexCount: { value: 0 },
      uPlumes: { value: 0 },
      uPlumeColumns: { value: 8 },
      uSeed: { value: 23 },
      uInit: { value: true },
    },
    depthTest: false,
    depthWrite: false,
  })
  const scene = new THREE.Scene()
  const camera = new THREE.Camera()
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  scene.add(quad)
  const u = material.uniforms

  function setThickness(genome, { topNm, bottomNm, meanNm }) {
    u.uTopNm.value = topNm
    u.uBottomNm.value = bottomNm
    u.uSwirlNm.value = genome.swirlFraction * meanNm
  }

  function pass() {
    u.uPrev.value = read.texture
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(write)
    renderer.render(scene, camera)
    renderer.setRenderTarget(previous)
    ;[read, write] = [write, read]
  }

  let healSeconds = 3
  // Layer A restarts at whole phases, B half a phase later; each is seen
  // with weight sin^2, zero at its restart.
  let phase = 0.25
  // A fresh film for this genome at the given thickness (also after a reset).
  function reset(genome, thickness) {
    if (genome) {
      u.uSeed.value = genome.patternSeed
      u.uSwirlScale.value = genome.swirlScale
      u.uScaleRatio.value = genome.scaleRatio
      u.uWarp.value = genome.warp
      u.uAmbient.value = genome.flowSpeed
      u.uProfile.value = genome.profile
      u.uBands.value = genome.bandStrength
      u.uBandCount.value = genome.bandCount
      u.uBandWave.value = genome.bandWaviness
      u.uLaminar.value = genome.laminar
      u.uSense.value = genome.swirlSense
      // Faint plumes stay invisible; from ~0.15 they show, a storm is rare.
      u.uPlumes.value = genome.plumes < 0.15 ? 0 : genome.plumes
      u.uPlumeColumns.value = genome.plumeColumns
      u.uVortexCount.value = Math.min(MAX_VORTICES, genome.vortices)
      healSeconds = genome.healSeconds
    }
    if (genome && thickness) setThickness(genome, thickness)
    u.uInit.value = true
    pass()
    u.uInit.value = false
  }
  reset()

  return {
    uniforms: u,
    precision: 'float32',
    get texture() {
      return read.texture
    },
    reset,
    setThickness,
    twoPhase,
    // Blend of the two detail layers now (twoPhase maps).
    phaseWeights(target) {
      const a = Math.sin(Math.PI * phase) ** 2
      return target.set(a, 1 - a)
    },
    setVortices(list) {
      u.uVortexCount.value = list.length
      list.forEach((vortex, i) => {
        u.uVortex.value[i].set(vortex.c[0], vortex.c[1], vortex.c[2], vortex.r)
        u.uVortexSpin.value[i] = vortex.spin
      })
    },
    // thin: ratio of the mean thickness now to one step ago (evaporation).
    step(dt, time, thin = 1) {
      u.uDt.value = dt
      u.uTime.value = time
      u.uThin.value = thin
      u.uHeal.value = 1 - Math.exp(-dt / healSeconds)
      u.uRelaxFine.value = Math.exp(-dt / 1.2)
      const next = phase + dt / PHASE_SECONDS
      u.uPhaseReset.value.set(Math.floor(next) > Math.floor(phase) ? 1 : 0, Math.floor(next + 0.5) > Math.floor(phase + 0.5) ? 1 : 0)
      phase = next % 1
      u.uSettle.value = 1 - Math.exp(-dt / 40) // gravity re-sorts over ~40 s
      pass()
    },
    // Test hook: the current film (x = thickness nm, yzw = fine offset).
    // The same copy without stalling the frame: a pixel-pack buffer and a
    // fence, resolved a frame or two later.
    async readFilmAsync() {
      const pixels = new Uint32Array(width * height * 4)
      await renderer.readRenderTargetPixelsAsync(read, 0, 0, width, height, pixels)
      return new Float32Array(pixels.buffer)
    },
    async captureState() {
      const pixels = new Uint32Array(width * height * 4)
      const savedPhase = phase
      const gravity = u.uGravity.value.toArray()
      await renderer.readRenderTargetPixelsAsync(read, 0, 0, width, height, pixels)
      return { version: 1, width, height, twoPhase, phase: savedPhase, gravity, pixels }
    },
    restoreState(state) {
      if (!state || state.version !== 1 || state.width !== width || state.height !== height || state.twoPhase !== twoPhase || !(state.pixels instanceof Uint32Array) || state.pixels.length !== width * height * 4 || !Number.isFinite(state.phase) || state.phase < 0 || state.phase >= 1 || !Array.isArray(state.gravity) || state.gravity.length !== 3 || !state.gravity.every(Number.isFinite)) throw new Error('Invalid film state')
      const source = new THREE.DataTexture(state.pixels, width, height, THREE.RGBAIntegerFormat, THREE.UnsignedIntType)
      source.needsUpdate = true
      renderer.copyTextureToTexture(source, read.texture)
      source.dispose()
      phase = state.phase
      u.uGravity.value.fromArray(state.gravity).normalize()
    },
    readFilm() {
      const pixels = new Uint32Array(width * height * 4)
      renderer.readRenderTargetPixels(read, 0, 0, width, height, pixels)
      return new Float32Array(pixels.buffer)
    },
    dispose() {
      read.dispose()
      write.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}
