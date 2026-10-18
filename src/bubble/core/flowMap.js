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
  uniform sampler2D uPrev;
  uniform vec4 uBlobA[MAX_BLOBS]; // centre, radius
  uniform vec4 uBlobB[MAX_BLOBS]; // velocity, outflow speed
  uniform int uBlobCount;
  uniform float uDt;
  uniform float uTime;
  uniform float uAmbient;
  uniform float uRelaxFine;
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
  layout(location = 0) out highp vec4 pc_fragColor;
  ${HASH_NOISE_GLSL}
  ${FLOW_SAMPLE_GLSL}

  vec3 dirFromUv(vec2 uv) {
    float lon = (uv.x - 0.5) * 6.283185307179586;
    float lat = (uv.y - 0.5) * 3.141592653589793;
    return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  }

  // Catmull-Rom (16 taps), clamped to the 4 nearest texels: little numerical
  // blur, no overshoot, so carried colours stay crisp for a long time.
  vec4 sampleSharp(sampler2D tex, vec2 uv) {
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
    for (int y = 0; y < 4; y++) {
      int ty = clamp(int(i.y) - 1 + y, 0, size.y - 1);
      float wy = y == 0 ? w0.y : (y == 1 ? w1.y : (y == 2 ? w2.y : w3.y));
      for (int x = 0; x < 4; x++) {
        int tx = ((int(i.x) - 1 + x) % size.x + size.x) % size.x;
        float wx = x == 0 ? w0.x : (x == 1 ? w1.x : (x == 2 ? w2.x : w3.x));
        vec4 t = texelFetch(tex, ivec2(tx, ty), 0);
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

  // Convection plumes: alternating up and down columns in the lower film
  // (a stream function periodic in longitude around the gravity axis).
  float plume(vec3 x) {
    if (uPlumes <= 0.0) return 0.0;
    vec3 g = uGravity;
    vec3 e1 = normalize(cross(g, abs(g.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
    vec3 e2 = cross(g, e1);
    float h = dot(x, g);
    float lon = atan(dot(x, e2), dot(x, e1));
    float wobble = 1.4 * gnoise(x * 1.7 + vec3(0.0, uTime * 0.08, 0.0), uSeed + 310u);
    float body = (1.0 - h * h) * smoothstep(0.65, -0.35, h);
    return 0.09 * uPlumes * body * sin(uPlumeColumns * lon + wobble + uTime * 0.05) / max(uPlumeColumns, 1.0);
  }

  float stream(vec3 x) {
    float h = dot(x, uGravity);
    // Marbled turbulence on two scales...
    float marble = 0.8 * gnoise(x * 1.4 + vec3(0.0, uTime * 0.07, uTime * 0.03), uSeed + 300u)
                 + 0.16 * gnoise(x * 1.4 * uScaleRatio + vec3(uTime * 0.13, 0.0, -uTime * 0.05), uSeed + 301u);
    // ...and calm sideways currents that shear with height (zonal flow),
    // plus a slight net turn of the whole film.
    float zonal = 0.45 * sin(3.1 * h + uTime * 0.11 + float(uSeed % 7u)) + uSense * 0.35 * h;
    return mix(marble, zonal, uLaminar) * uAmbient + plume(x);
  }

  vec3 ambient(vec3 x) {
    const float E = 0.01;
    vec3 g = vec3(
      stream(x + vec3(E, 0.0, 0.0)) - stream(x - vec3(E, 0.0, 0.0)),
      stream(x + vec3(0.0, E, 0.0)) - stream(x - vec3(0.0, E, 0.0)),
      stream(x + vec3(0.0, 0.0, E)) - stream(x - vec3(0.0, 0.0, E))
    ) / (2.0 * E);
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
      pc_fragColor = vec4(max(20.0, drained(x) + swirl * uSwirlNm), 0.0, 0.0, 0.0);
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
    vec3 fineOrigin = normalize(from + flowSample(uPrev, fromUv).yzw);
    pc_fragColor = vec4(clamp(thickness, 4.0, 2400.0), (fineOrigin - x) * uRelaxFine);
  }
`

const vertexShader = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

function canRenderType(renderer, type) {
  const previous = renderer.getRenderTarget()
  const probe = new THREE.WebGLRenderTarget(2, 2, {
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  })
  try {
    renderer.setRenderTarget(probe)
    return renderer.getContext().checkFramebufferStatus(renderer.getContext().FRAMEBUFFER) === renderer.getContext().FRAMEBUFFER_COMPLETE
  } catch {
    return false
  } finally {
    renderer.setRenderTarget(previous)
    probe.dispose()
  }
}

export function selectFlowTargetType(renderer) {
  if (canRenderType(renderer, THREE.FloatType)) return THREE.FloatType
  if (canRenderType(renderer, THREE.HalfFloatType)) return THREE.HalfFloatType
  return null
}

export function createFlowMap(renderer, width = FLOW_WIDTH, height = FLOW_HEIGHT) {
  const targetType = selectFlowTargetType(renderer)
  if (targetType === null) throw new Error('Bubble film flow requires a float or half-float render target')
  const options = {
    type: targetType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  }
  let read = new THREE.WebGLRenderTarget(width, height, options)
  let write = new THREE.WebGLRenderTarget(width, height, options)
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms: {
      uPrev: { value: null },
      uBlobA: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector4(0, 0, 1, 0.1)) },
      uBlobB: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uBlobCount: { value: 0 },
      uDt: { value: 0 },
      uTime: { value: 0 },
      uAmbient: { value: 0.07 },
      uRelaxFine: { value: 1 },
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
    precision: targetType === THREE.FloatType ? 'float32' : 'float16',
    get texture() {
      return read.texture
    },
    reset,
    setThickness,
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
      u.uSettle.value = 1 - Math.exp(-dt / 40) // gravity re-sorts over ~40 s
      pass()
    },
    dispose() {
      read.dispose()
      write.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}
