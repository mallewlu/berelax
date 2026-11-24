import * as THREE from 'three'
import { BAKED_OCTAVES, HASH_NOISE_GLSL } from './shader.js'

// The bubble's view-independent fine texture, computed once per bubble into
// cube maps over the film (material) coordinates: the coarse octaves of the
// detail cascade, the black-spot noise and the warp chain the live octaves
// continue from. Every frame then reads them instead of
// recomputing those noise calls per pixel. The maps are read like the live
// noise is evaluated (one bilinear sample, no mipmaps), only octaves sampled
// finely enough are baked, and the warp chain is kept in full float, so the
// picture matches the live path. The bake is spread over a few frames (a face
// at a time) and the shader uses the live path until it is complete, so a new
// bubble never stalls a frame. Devices without float32 filtering keep the
// live path.

// Fixed irrational rotation between octaves; must match shader.js.
const OCTAVE_ROTATION = new THREE.Matrix3().set(0.0, -0.8, -0.6, 0.8, 0.36, -0.48, 0.6, -0.48, 0.64)
const CALM_STRETCH = 0.7
const OCTAVE_STEP = 2.07
// An octave (or the spot noise) is baked when the coarsest part of a cube
// face (its centre, size/2 texels per radian) holds >= 8 texels per cycle of
// it after the fibre stretch (x1.7); finer ones stay live.
const SIZE_PER_FREQ = 2 * 8 * 1.7

const bakeFragment = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform int uFace;
  uniform float uSize;
  uniform int uPart;
  uniform int uCount;
  uniform uint uSeed;
  uniform float uGrain;
  uniform vec3 uFibre;
  uniform float uSpotScale;
  out vec4 outColor;
  ${HASH_NOISE_GLSL}
  const mat3 OCTAVE_ROTATION = mat3(
     0.00,  0.80,  0.60,
    -0.80,  0.36, -0.48,
    -0.60, -0.48,  0.64
  );
  // GL cube-map face layout (+X, -X, +Y, -Y, +Z, -Z).
  vec3 faceDir(vec2 st) {
    if (uFace == 0) return vec3(1.0, -st.y, -st.x);
    if (uFace == 1) return vec3(-1.0, -st.y, st.x);
    if (uFace == 2) return vec3(st.x, 1.0, st.y);
    if (uFace == 3) return vec3(st.x, -1.0, -st.y);
    if (uFace == 4) return vec3(st.x, -st.y, 1.0);
    return vec3(-st.x, -st.y, -1.0);
  }
  void main() {
    vec3 y = normalize(faceDir(gl_FragCoord.xy / uSize * 2.0 - 1.0));
    vec3 warp = vec3(
      gnoise(y * 1.5, uSeed + 1u),
      gnoise(y * 1.5 + vec3(5.2, 1.3, 0.0), uSeed + 2u),
      gnoise(y * 1.5 + vec3(0.0, 9.1, 2.7), uSeed + 3u)
    ) * 0.35;
    vec3 dw = y + warp;
    float spot = uSpotScale > 0.0 ? gnoise(dw * uSpotScale, uSeed + 90u) : 0.0;
    dw += uFibre * dot(dw, uFibre) * ${CALM_STRETCH.toFixed(2)};
    // The stretched warp part of the chain, carried on by the live octaves.
    vec3 carried = dw - y - uFibre * dot(y, uFibre) * ${CALM_STRETCH.toFixed(2)};
    float freq = uGrain;
    vec4 n4 = vec4(0.0);
    for (int o = 0; o < ${BAKED_OCTAVES}; o++) {
      if (o >= uCount) break;
      float n = gnoise(dw * freq, uSeed + 40u + uint(o));
      n4[o] = n;
      float a = float(o) * 2.39996;
      vec3 step = vec3(cos(a), sin(a * 1.31), sin(a)) * n * (0.9 / freq);
      dw = OCTAVE_ROTATION * dw + step;
      carried = OCTAVE_ROTATION * carried + step;
      freq *= ${OCTAVE_STEP};
    }
    outColor = uPart == 0 ? n4 : vec4(carried, spot);
  }
`

// size: cube face texels.
// Returns null where the bake cannot match the live path (no float32
// render targets or filtering).
export function createDetailBake(renderer, size = 512) {
  const gl = renderer.getContext()
  if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('OES_texture_float_linear')) return null
  const options = (type) => ({
    type,
    format: THREE.RGBAFormat,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  })
  // Octave noise in half float is far below a visible step; the warp chain
  // feeds the finest live octaves and needs full float.
  const targets = [new THREE.WebGLCubeRenderTarget(size, options(THREE.HalfFloatType)), new THREE.WebGLCubeRenderTarget(size, options(THREE.FloatType))]
  for (const target of targets) renderer.initRenderTarget(target)
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      in vec3 position;
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: bakeFragment,
    uniforms: {
      uFace: { value: 0 },
      uSize: { value: size },
      uPart: { value: 0 },
      uCount: { value: BAKED_OCTAVES },
      uSeed: { value: 0 },
      uGrain: { value: 14 },
      uFibre: { value: new THREE.Vector3(1, 0, 0) },
      uSpotScale: { value: 46 },
    },
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.Camera()
  const stretch = new THREE.Matrix3()
  let look = null
  let next = 0 // next (map, face) job
  const JOBS = targets.length * 6

  // Starts baking for the material's current genome look; until done the
  // material draws the live path.
  function start(materialUniforms) {
    look = materialUniforms
    const u = material.uniforms
    u.uSeed.value = look.uSeed.value
    u.uGrain.value = look.uGrain.value
    u.uFibre.value.copy(look.uFibre.value)
    // Coarse enough octaves only: each needs TEXELS_PER_CYCLE texels per cycle.
    let count = 0
    let freq = look.uGrain.value
    while (count < BAKED_OCTAVES && freq * SIZE_PER_FREQ <= size) {
      count += 1
      freq *= OCTAVE_STEP
    }
    u.uCount.value = count
    const spotBaked = look.uBlack.value.y * SIZE_PER_FREQ <= size
    u.uSpotScale.value = spotBaked ? look.uBlack.value.y : 0
    look.uBaked.value = 0
    look.uBakedCount.value = count
    look.uSpotBaked.value = spotBaked ? 1 : 0
    next = 0
  }

  let failed = false
  // Bakes up to `jobs` cube faces; returns true once the bake is in use.
  function tick(jobs = 2) {
    if (failed) return false
    if (!look || next >= JOBS) return next >= JOBS
    const u = material.uniforms
    const previous = renderer.getRenderTarget()
    for (let done = 0; done < jobs && next < JOBS; done++, next++) {
      const part = Math.floor(next / 6)
      const face = next % 6
      u.uPart.value = part
      u.uFace.value = face
      renderer.setRenderTarget(targets[part], face)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        failed = true // never use an incomplete map: the live path stays
        renderer.setRenderTarget(previous)
        return false
      }
      renderer.render(scene, camera)
    }
    renderer.setRenderTarget(previous)
    if (next < JOBS) return false
    // R^count * S maps the film position to the live octaves' start.
    const f = look.uFibre.value
    const k = CALM_STRETCH
    stretch.set(
      1 + k * f.x * f.x, k * f.x * f.y, k * f.x * f.z,
      k * f.y * f.x, 1 + k * f.y * f.y, k * f.y * f.z,
      k * f.z * f.x, k * f.z * f.y, 1 + k * f.z * f.z,
    )
    const carry = look.uDetailCarry.value.identity()
    for (let i = 0; i < u.uCount.value; i++) carry.premultiply(OCTAVE_ROTATION)
    carry.multiply(stretch)
    look.uDetailA.value = targets[0].texture
    look.uDetailB.value = targets[1].texture
    look.uBaked.value = 1
    return true
  }

  function dispose() {
    for (const t of targets) t.dispose()
    material.dispose()
    quad.geometry.dispose()
  }

  return {
    start,
    tick,
    dispose,
    // Still filling the maps (frames are a little heavier meanwhile).
    get busy() {
      return Boolean(look) && !failed && next < JOBS
    },
  }
}

// Comparison prototype (bubble-compare.html): the whole detail cascade, not
// only its coarse octaves, drawn once at birth into one mipmapped cube map
// over the film coordinates. The shader then reads one sample per pixel
// (FULL_DETAIL_BAKE) and the mipmaps fade octaves too fine for the view,
// where the live path fades them by hand. Differences from the live path:
// filaments keep the genome's direction (no live alignment to the film's
// gradient), the per-zoom lift of octaves is the one at birth, and the map's
// resolution bounds how fine the detail gets at close zoom.
const FULL_TEXELS_PER_CYCLE = 3

const fullBakeFragment = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform int uFace;
  uniform float uSize;
  uniform int uCount;
  uniform uint uSeed;
  uniform float uGrain;
  uniform vec3 uFibre;
  uniform float uCrisp;
  uniform float uOctaveDecay;
  uniform float uViewSize;
  out vec4 outColor;
  ${HASH_NOISE_GLSL}
  const mat3 OCTAVE_ROTATION = mat3(
     0.00,  0.80,  0.60,
    -0.80,  0.36, -0.48,
    -0.60, -0.48,  0.64
  );
  vec3 faceDir(vec2 st) {
    if (uFace == 0) return vec3(1.0, -st.y, -st.x);
    if (uFace == 1) return vec3(-1.0, -st.y, st.x);
    if (uFace == 2) return vec3(st.x, 1.0, st.y);
    if (uFace == 3) return vec3(st.x, -1.0, -st.y);
    if (uFace == 4) return vec3(st.x, -st.y, 1.0);
    return vec3(-st.x, -st.y, -1.0);
  }
  float crisp(float n) {
    return clamp(n / (abs(n) + uCrisp), -1.0, 1.0);
  }
  void main() {
    vec3 y = normalize(faceDir(gl_FragCoord.xy / uSize * 2.0 - 1.0));
    vec3 warp = vec3(
      gnoise(y * 1.5, uSeed + 1u),
      gnoise(y * 1.5 + vec3(5.2, 1.3, 0.0), uSeed + 2u),
      gnoise(y * 1.5 + vec3(0.0, 9.1, 2.7), uSeed + 3u)
    ) * 0.35;
    vec3 dw = y + warp;
    dw += uFibre * dot(dw, uFibre) * ${CALM_STRETCH.toFixed(2)};
    float freq = uGrain;
    float amp = 16.0;
    float detail = 0.0;
    for (int o = 0; o < 14; o++) {
      if (o >= uCount) break;
      float n = gnoise(dw * freq, uSeed + 40u + uint(o));
      float scaleRatio = log2((1.0 / freq) / (uViewSize / 12.0));
      float boost = exp(-scaleRatio * scaleRatio * 0.5);
      detail += crisp(n) * (amp + 30.0 * boost);
      float a = float(o) * 2.39996;
      dw = OCTAVE_ROTATION * dw + vec3(cos(a), sin(a * 1.31), sin(a)) * n * (0.9 / freq);
      freq *= ${OCTAVE_STEP};
      amp *= uOctaveDecay;
    }
    outColor = vec4(detail, 0.0, 0.0, 1.0);
  }
`

// size: cube face texels (one half-float channel, with mipmaps).
export function createFullDetailBake(renderer, size = 1024) {
  const gl = renderer.getContext()
  if (!gl.getExtension('EXT_color_buffer_float')) return null
  const target = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    format: THREE.RedFormat,
    generateMipmaps: false,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  })
  renderer.initRenderTarget(target)
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      in vec3 position;
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: fullBakeFragment,
    uniforms: {
      uFace: { value: 0 },
      uSize: { value: size },
      uCount: { value: 0 },
      uSeed: { value: 0 },
      uGrain: { value: 14 },
      uFibre: { value: new THREE.Vector3(1, 0, 0) },
      uCrisp: { value: 0.18 },
      uOctaveDecay: { value: 0.88 },
      uViewSize: { value: 2.4 },
    },
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const camera = new THREE.Camera()
  let look = null
  let next = 6

  function start(materialUniforms) {
    look = materialUniforms
    const u = material.uniforms
    u.uSeed.value = look.uSeed.value
    u.uGrain.value = look.uGrain.value
    u.uFibre.value.copy(look.uFibre.value)
    u.uCrisp.value = look.uCrisp.value
    u.uOctaveDecay.value = look.uOctaveDecay.value
    u.uViewSize.value = look.uViewSize.value
    // Octaves the map can hold: FULL_TEXELS_PER_CYCLE texels per cycle at a
    // face's centre after the fibre stretch; finer ones would only alias.
    let count = 0
    let freq = look.uGrain.value
    while (count < Math.min(14, look.uOctaveCap.value) && freq * 2 * FULL_TEXELS_PER_CYCLE * 1.7 <= size) {
      count += 1
      freq *= OCTAVE_STEP
    }
    u.uCount.value = count
    look.uFullReady.value = 0
    next = 0
  }

  // One face per call; returns true once the map is in use.
  function tick() {
    if (!look || next >= 6) return next >= 6
    const previous = renderer.getRenderTarget()
    material.uniforms.uFace.value = next
    renderer.setRenderTarget(target, next)
    renderer.render(scene, camera)
    renderer.setRenderTarget(previous)
    next += 1
    if (next < 6) return false
    const texture = target.texture
    renderer.state.bindTexture(gl.TEXTURE_CUBE_MAP, renderer.properties.get(texture).__webglTexture)
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP)
    renderer.state.unbindTexture()
    look.uDetailFull.value = texture
    look.uFullReady.value = 1
    return true
  }

  return {
    start,
    tick,
    get busy() {
      return Boolean(look) && next < 6
    },
    get count() {
      return material.uniforms.uCount.value
    },
    dispose() {
      target.dispose()
      material.dispose()
      quad.geometry.dispose()
    },
  }
}
