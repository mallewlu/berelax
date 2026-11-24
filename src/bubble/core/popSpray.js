import * as THREE from 'three'

// The droplets a popping film throws off: the retreating rim of the hole
// sheds tiny drops as it sweeps over the bubble. Each drop leaves the film
// when the rim reaches it, flies on along the rim's travel and outward,
// falls a little and fades. All motion is computed on the GPU from one time
// uniform, so the spray costs one draw for a second and nothing afterwards.

const COUNT = 1400
const MAX_LIFE = 1.25 // s
const GRAVITY = new THREE.Vector3(0, -1.25, 0) // world units / s^2 (radius 1)

const vertexShader = /* glsl */ `
  uniform float uAge;      // s since the pop began
  uniform float uPixels;   // drawing-buffer pixels per world unit at distance 1
  attribute vec3 aStart;
  attribute vec3 aVelocity;
  attribute float aRelease;
  attribute float aSize;
  attribute float aLife;
  attribute float aDrag;
  attribute float aTwinkle;
  attribute vec3 aColour;
  varying float vFade;
  varying float vTwinkle;
  varying vec3 vColour;
  void main() {
    float t = uAge - aRelease;
    vFade = t < 0.0 || t > aLife ? 0.0 : 1.0 - t / aLife;
    vTwinkle = aTwinkle;
    vColour = aColour;
    vec3 g = vec3(${GRAVITY.x.toFixed(2)}, ${GRAVITY.y.toFixed(2)}, ${GRAVITY.z.toFixed(2)});
    float liveT = max(t, 0.0);
    float drag = 1.0 - exp(-liveT / aDrag);
    // Linear drag: fast at release, then carried and slowed by the air.
    vec3 world = aStart + aVelocity * aDrag * drag
      + g * (aDrag * liveT - aDrag * aDrag * drag);
    vec4 view = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = vFade > 0.0 ? max(1.0, aSize * uPixels / -view.z * (0.35 + 0.65 * vFade)) : 0.0;
  }
`

const fragmentShader = /* glsl */ `
  varying float vFade;
  varying float vTwinkle;
  varying vec3 vColour;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float sparkle = 0.72 + 0.28 * sin(vTwinkle + vFade * 18.0);
    float a = smoothstep(1.0, 0.35, d) * vFade * vFade * sparkle;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColour * a, a);
  }
`

export function createPopSpray(scene) {
  const geometry = new THREE.BufferGeometry()
  const start = new Float32Array(COUNT * 3)
  const velocity = new Float32Array(COUNT * 3)
  const release = new Float32Array(COUNT)
  const size = new Float32Array(COUNT)
  const life = new Float32Array(COUNT)
  const drag = new Float32Array(COUNT)
  const twinkle = new Float32Array(COUNT)
  const colour = new Float32Array(COUNT * 3)
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
  geometry.setAttribute('aStart', new THREE.BufferAttribute(start, 3))
  geometry.setAttribute('aVelocity', new THREE.BufferAttribute(velocity, 3))
  geometry.setAttribute('aRelease', new THREE.BufferAttribute(release, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  geometry.setAttribute('aLife', new THREE.BufferAttribute(life, 1))
  geometry.setAttribute('aDrag', new THREE.BufferAttribute(drag, 1))
  geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1))
  geometry.setAttribute('aColour', new THREE.BufferAttribute(colour, 3))
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { uAge: { value: 99 }, uPixels: { value: 1 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  })
  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  points.visible = false
  scene.add(points)

  const local = new THREE.Vector3()
  const away = new THREE.Vector3()
  const world = new THREE.Vector3()
  const dropColour = new THREE.Color()
  const normalMatrix = new THREE.Matrix3()
  let age = 99

  return {
    // origin: local unit vector of the rupture; releaseAt(angle) -> s when the
    // rim passes that angle; mesh: the bubble (its world matrix at the pop).
    start(mesh, origin, releaseAt, seed = 1, filmNm = 400, random = null) {
      mesh.updateMatrixWorld()
      normalMatrix.getNormalMatrix(mesh.matrixWorld)
      const scale = mesh.getWorldScale(world).x
      let randomState = (Number(seed) >>> 0) || 1
      const dropScale = THREE.MathUtils.clamp(Math.sqrt(Math.max(20, Number(filmNm) || 400) / 400), 0.45, 1.65)
      const next = random || (() => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
        return randomState / 4294967296
      })
      for (let i = 0; i < COUNT; i++) {
        // Uniform on the sphere.
        const z = next() * 2 - 1
        const a = next() * Math.PI * 2
        const ring = Math.sqrt(1 - z * z)
        local.set(ring * Math.cos(a), ring * Math.sin(a), z)
        const angle = Math.acos(THREE.MathUtils.clamp(local.dot(origin), -1, 1))
        release[i] = releaseAt(angle)
        // The rim travels away from the rupture point along the surface.
        away.copy(local).multiplyScalar(local.dot(origin)).sub(origin).negate()
        if (away.lengthSq() < 1e-6) away.set(1, 0, 0)
        away.normalize()
        world.copy(local).applyMatrix4(mesh.matrixWorld)
        start.set([world.x, world.y, world.z], i * 3)
        const along = 0.45 + 0.75 * next()
        const out = 0.08 + 0.28 * next()
        world.copy(away).multiplyScalar(along).addScaledVector(local, out).applyMatrix3(normalMatrix).multiplyScalar(scale)
        velocity.set([world.x, world.y, world.z], i * 3)
        // Almost all drops are pinpoints; a few larger ones reveal the film.
        size[i] = (0.0018 + 0.012 * next() ** 7) * dropScale
        life[i] = 0.28 + (MAX_LIFE - 0.28) * next()
        drag[i] = 0.08 + 0.24 * next()
        twinkle[i] = next() * Math.PI * 2
        // Clear water: a drop only catches the surrounding light, so it is a
        // near-neutral glint (a faint tint at most), never a coloured dot.
        dropColour.setHSL(next(), 0.06 * next(), 0.72 + 0.2 * next())
        colour.set([dropColour.r, dropColour.g, dropColour.b], i * 3)
      }
      for (const name of ['aStart', 'aVelocity', 'aRelease', 'aSize', 'aLife', 'aDrag', 'aTwinkle', 'aColour']) geometry.attributes[name].needsUpdate = true
      age = 0
      points.visible = true
    },
    // dt in s; pixels: drawing-buffer pixels per world unit at distance 1.
    update(dt, pixels) {
      if (!points.visible) return
      age += dt
      material.uniforms.uAge.value = age
      material.uniforms.uPixels.value = pixels
      if (age > MAX_LIFE + 0.2) points.visible = false
    },
    get active() {
      return points.visible
    },
    // Compiles the drops' shader ahead of the first pop: phones otherwise
    // compile it on that frame and stall 100-500 ms (Ar-Ge round 2).
    warm(renderer, camera) {
      const shown = points.visible
      points.visible = true
      renderer.compile(scene, camera)
      points.visible = shown
    },
    dispose() {
      scene.remove(points)
      geometry.dispose()
      material.dispose()
    },
  }
}
