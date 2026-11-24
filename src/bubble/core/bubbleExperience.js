import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { createLightGround } from './lightGround.js'
import { applyGenomeLook, startFilm, tiltedUp } from './applyGenome.js'
import { createBody, drift, roomAir, softLimit, squashAt } from './bubbleBody.js'
import { createBreathMap } from './breathMap.js'
import { createBud } from './budBubble.js'
import { createDetailBake, createFullDetailBake } from './detailBake.js'
import { createFilmFlow } from './filmFlow.js'
import { createFilmLut } from './filmLut.js'
import { vortexState } from './filmVortices.js'
import { FLOW_HEIGHT, FLOW_WIDTH, createFlowMap } from './flowMap.js'
import { createGenome, firstSeenSeconds, newSeed, thicknessOnClock } from './genome.js'
import { createModalTouch } from './modalTouch.js'
import { createPopSpray } from './popSpray.js'
import { ruptureDurationSeconds, weakestFilmPoint } from './ruptureOrigin.js'
import { GENTLE, createTapSense } from './tapStrength.js'
import { MAX_RIPPLES, createZoomMaterial } from './shader.js'
import { createViewMotion } from './viewMotion.js'

// The single bubble core: one photoreal soap bubble in a canvas, the same on
// every page and device. It owns rendering (Blender-baked horizon, thin-film
// LUT, layered film detail), the film simulation, touch, the body physics,
// device motion, the genome and the ageing clock. Pages add only their own
// interface (the product page, the lab's measuring tools).
//
// Camera input uses three.js OrbitControls (MIT): zoom to cursor, pinch,
// pan and damping on all devices.

export const MAX_ZOOM = 4.1 // closer views add nothing a viewer can read
const BASE_DISTANCE = 4.45
const SURFACE_GAP_AT_1X = BASE_DISTANCE - 1
const MIN_GAP = SURFACE_GAP_AT_1X / MAX_ZOOM
// Two gestures, the same for mouse and touch:
//  - touch and drag at once: TURN. The bubble follows the finger one to one,
//    so the pattern turns rigidly by the same angle (the point under the
//    finger stays under it) and keeps spinning when let go.
//  - touch, rest a moment, then drag: STIR. The finger has dipped into the
//    film and drags it along; the bubble itself turns only a little.
const HOLD_TO_STIR = 350 // ms of resting before a drag stirs instead of turns
const START_DRAG_PX = 6 // movement that starts a gesture
const TURN_WHILE_STIRRING = 0.12 // share of the finger's arc that turns the bubble when stirring
const SPIN_DECAY = 2 // s: air slows a spinning bubble
const AIR_SHARE = 0.2 // finger speed -> air speed carried to the bubble

// A measured fast-frame interval (ms) snapped to the display it comes from:
// 120, 90 or 60 Hz, or 30 Hz (iOS low power mode). Anything between 60 and
// ~36 fps is a 60 Hz screen that is not keeping up.
export function displayInterval(ms) {
  if (ms < 9.7) return 1000 / 120
  if (ms < 12.5) return 1000 / 90
  if (ms < 28) return 1000 / 60
  return 1000 / 30
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

// layout(): the page's own interface as insets in CSS px ({ top, right,
// bottom, left }); the bubble is centred and sized in the space left free, so
// text and buttons never sit on it, on any screen or orientation.
export function createBubbleExperience({
  canvas,
  seed = newSeed(),
  initialAgeSeconds = 0,
  initialOwnedAtSeconds = null,
  // 512×256: on the bubble the same as the 2048 original (PSNR ≥ 67 dB,
  // Ar-Ge/ortam-2026-10-26.md), 34 KB instead of 253 KB gzipped (Lu, 2026-10-26).
  environment = '/bubble/env/ufuk-512.hdr',
  onFirstTouch,
  onError,
  layout = () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  bakeDetail = true, // or a cube face size; false: always the live path
  antialias = true,
  // Comparison page (bubble-compare.html): 'live' (as is), 'off' (no fine
  // detail: flow and colours only), 'baked' (all detail drawn at birth) or
  // 'lean' (the new engine: 'baked' plus cheaper shading and mesh) or 'flow'
  // ('lean' with the fine detail travelling with the film).
  detailMode = 'live',
  // true: no animation loop of its own; the page calls step(now) each frame,
  // so several bubbles advance on one clock.
  driven = false,
  // Lab only: the bubble with the lights on, on a light ground (lightGround.js).
  light = false,
} = {}) {
  const lifecycle = new AbortController()
  const listenerOptions = { signal: lifecycle.signal }
  let disposed = false
  const renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha: true })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  const gl = renderer.getContext()
  let timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 50)
  camera.position.set(0, 0, BASE_DISTANCE)

  const filmLut = createFilmLut()
  // The new engine's sphere: the shape is smooth (low-order breathing and
  // touch modes), so a quarter of the vertices keeps the outline round.
  const leanEngine = detailMode === 'lean' || detailMode === 'flow'
  const twoPhase = detailMode === 'flow' || detailMode === 'flow-full'
  const wantsFullBake = detailMode === 'baked' || leanEngine || detailMode === 'flow-full'
  const canFullBake = Boolean(gl.getExtension('EXT_color_buffer_float'))
  const BUBBLE_SEGMENTS = leanEngine ? [128, 96] : [256, 192]
  const bubbleGeometry = new THREE.SphereGeometry(1, ...BUBBLE_SEGMENTS)
  const bubbleMaterial = createZoomMaterial(null, filmLut, { fullDetail: wantsFullBake && canFullBake, lean: leanEngine, twoPhase })
  const bubble = new THREE.Mesh(bubbleGeometry, bubbleMaterial)
  scene.add(bubble)
  const spray = createPopSpray(scene)
  const uniforms = bubble.material.uniforms
  const darkEnvIntensity = uniforms.uEnvIntensity.value
  let lightGround = null
  function setLight(on) {
    if (Boolean(on) === Boolean(lightGround)) return
    if (on) lightGround = createLightGround(renderer)
    else {
      lightGround.dispose()
      lightGround = null
    }
    // The light pass applies the room's brightness itself (linear target).
    uniforms.uEnvIntensity.value = on ? 1 : darkEnvIntensity
  }
  setLight(light)
  const draw = () => (lightGround ? lightGround.render(scene, camera) : renderer.render(scene, camera))
  // Touch devices get the smaller detail maps (memory); finer octaves are
  // computed live either way, so the picture is the same.
  const bakeSize = typeof bakeDetail === 'number' ? bakeDetail : matchMedia('(pointer: coarse)').matches ? 512 : 1024
  let detailBake = bakeDetail ? createDetailBake(renderer, bakeSize) : null
  const fullBakeSize = matchMedia('(pointer: coarse)').matches ? 1024 : 2048
  let fullBake = wantsFullBake && canFullBake ? createFullDetailBake(renderer, fullBakeSize) : null
  if (detailMode === 'off') uniforms.uOctaveCap.value = 0
  let ready = false
  let environmentTexture = null
  new HDRLoader().load(
    environment,
    (texture) => {
      if (disposed) {
        texture.dispose()
        return
      }
      texture.minFilter = THREE.LinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.generateMipmaps = false
      environmentTexture = texture
      uniforms.uEnv.value = texture
      spray.warm(renderer, camera)
      ready = true
    },
    undefined,
    (error) => onError?.(error),
  )

  // ---------- Camera controls (proven library instead of hand-written gestures) ----------
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.zoomToCursor = true
  controls.screenSpacePanning = true
  controls.minDistance = 1 + MIN_GAP
  controls.maxDistance = 1 + SURFACE_GAP_AT_1X / 0.6
  controls.zoomSpeed = 1.1
  // The camera never orbits: walking around the bubble would swing the light.
  // One finger turns the bubble itself (below); two fingers zoom and pan.
  controls.enableRotate = false
  controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN }
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }

  // ---------- Geometry helpers ----------
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1)
  const unitSphere = new THREE.Sphere(new THREE.Vector3(), 1)
  const raycaster = new THREE.Raycaster()

  function rayAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    return raycaster.ray.clone()
  }

  // Runs a few times per frame: the canvas centre is always NDC (0, 0), so no
  // layout read and no new objects are needed.
  const centreNdc = new THREE.Vector2(0, 0)
  const centreHit = new THREE.Vector3()
  function surfaceDistance() {
    raycaster.setFromCamera(centreNdc, camera)
    const point = raycaster.ray.intersectSphere(sphere, centreHit)
    return point ? point.distanceTo(camera.position) : Math.max(camera.position.distanceTo(sphere.center) - 1, MIN_GAP)
  }

  const zoomFactor = () => SURFACE_GAP_AT_1X / surfaceDistance()
  const viewHeightAtSurface = () => 2 * surfaceDistance() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))

  const cameraOffset = new THREE.Vector3()
  function keepOutside() {
    // Zoom-to-cursor moves the orbit target; never let the camera enter the film.
    const offset = cameraOffset.copy(camera.position).sub(sphere.center)
    const length = offset.length()
    if (length < 1 + MIN_GAP) camera.position.copy(sphere.center).addScaledVector(offset, (1 + MIN_GAP) / length)
    camera.near = Math.max(1e-5, surfaceDistance() * 0.05)
    camera.updateProjectionMatrix()
  }

  // ---------- Touch: surface modes, film flow ----------
  const modal = createModalTouch()
  // Only the ringing this display can show (see modalTouch.displayed).
  let refreshHz = 60
  function syncModes() {
    modal.slots.forEach((slot, i) => {
      const shown = modal.displayed(slot, refreshHz)
      uniforms.uModeAxis.value[i].set(slot.axis[0], slot.axis[1], slot.axis[2])
      uniforms.uModeAmp.value[i].set(shown[0], shown[1], shown[2], shown[3])
    })
  }

  function localHit(clientX, clientY) {
    bubble.updateMatrixWorld()
    const inverse = new THREE.Matrix4().copy(bubble.matrixWorld).invert()
    const local = rayAt(clientX, clientY).applyMatrix4(inverse)
    const point = local.intersectSphere(unitSphere, new THREE.Vector3())
    return point ? point.normalize() : null
  }

  // A finger on the film: the dent appears on the same frame, stays while the
  // finger rests (and follows it), and rings back once the finger lifts.
  function touchAt(clientX, clientY, strength, hold = false) {
    const dir = localHit(clientX, clientY)
    if (!dir) return null
    const slot = modal.touch([dir.x, dir.y, dir.z], strength, hold)
    syncModes() // the dent is in the uniforms before this frame renders
    return { dir, slot }
  }

  // ---------- Ripples: capillary wave trains from a finger (shader.ripples) ----------
  let nextRipple = 0
  function ripple(dir, strength) {
    const i = nextRipple % MAX_RIPPLES
    nextRipple += 1
    uniforms.uRipple.value[i].set(dir.x, dir.y, dir.z, Math.min(1, Math.max(0, strength)))
    uniforms.uRippleAge.value[i] = 0
    return i
  }

  // ---------- Touch strength: gentle for a mouse, the tap's jolt for a finger ----------
  const tapSense = createTapSense({ signal: lifecycle.signal })
  let tapScale = 1 // strength of the current touch relative to GENTLE
  function initialStrength(event) {
    if (event.pointerType === 'pen' && event.pressure > 0) return 0.25 + 0.75 * event.pressure
    return GENTLE
  }
  function ageRipples(dt) {
    for (let i = 0; i < MAX_RIPPLES; i += 1) {
      uniforms.uRippleAge.value[i] += dt
      if (uniforms.uRippleAge.value[i] > 3) uniforms.uRipple.value[i].w = 0
    }
  }
  let lastRippleAt = 0

  // A soap film is a liquid: a finger drags the film (filmFlow) and the air
  // around it, and turns the bubble only a little. Mouse and touch share this.
  const film = createFilmFlow()
  let flowMap
  try {
    flowMap = createFlowMap(renderer, FLOW_WIDTH, FLOW_HEIGHT, { twoPhase })
  } catch (error) {
    onError?.(error)
    disposed = true
    lifecycle.abort()
    controls.dispose()
    spray.dispose()
    environmentTexture?.dispose()
    lightGround?.dispose()
    filmLut.dispose()
    detailBake?.dispose()
    fullBake?.dispose()
    bubbleMaterial.dispose()
    bubbleGeometry.dispose()
    renderer.dispose()
    throw error
  }
  let breathMap = createBreathMap(renderer, bubbleGeometry, BUBBLE_SEGMENTS[0] + 1)
  uniforms.uFlow.value = flowMap.texture
  let filmGrip = 0.85
  const activePointers = new Set()
  const spin = new THREE.Vector2() // finger-given spin, rad/s about camera-space axes
  let lastMoveAt = 0
  let lastTurn = null
  let gesture = null // { mode: 'pending' | 'turn' | 'stir', downAt, x, y }
  let dragFrom = null
  let held = null // { slot, source, grab, origin }
  let lastHit = null
  let touched = false
  const airVelocity = new THREE.Vector3() // air a finger stirred, scene units/s
  const spinQuat = new THREE.Quaternion()
  const spinAxis = new THREE.Vector3()
  const cameraRight = new THREE.Vector3()
  const cameraUp = new THREE.Vector3()

  // The patch of film a finger moves, in bubble radii: its real contact on
  // screen (touch screens report it; ~40 px otherwise, 32 px for a mouse),
  // widened by the film it drags along, over the bubble's size on screen.
  let contactPx = 16
  const fingerRadius = () => THREE.MathUtils.clamp((contactPx * 1.6 * viewHeightAtSurface()) / Math.max(1, canvas.clientHeight), 0.05, 0.4)

  function releaseHeld() {
    gesture = null
    if (!held) return
    // The film springs back as the finger lifts: a second, softer ripple.
    if (lastHit) ripple(lastHit, Math.min(1, 0.5 * GENTLE * tapScale * genome.dent))
    modal.release(held.slot)
    film.release(held.source)
    film.release(held.grab)
    held = null
  }

  function turnBubble(ax, ay) {
    const angle = Math.hypot(ax, ay)
    if (angle < 1e-7) return
    // Rotate about the camera-space axis perpendicular to the drag.
    spinAxis.set(ay, ax, 0).normalize().applyQuaternion(camera.quaternion)
    spinQuat.setFromAxisAngle(spinAxis, angle)
    bubble.quaternion.premultiply(spinQuat)
  }

  canvas.addEventListener('pointerdown', (event) => {
    activePointers.add(event.pointerId)
    if (activePointers.size === 1 && event.button === 0) {
      const strength = initialStrength(event)
      tapScale = strength / GENTLE
      const hit = touchAt(event.clientX, event.clientY, strength * genome.dent, true)
      dragFrom = { x: event.clientX, y: event.clientY, t: event.timeStamp }
      gesture = { mode: 'pending', downAt: event.timeStamp, x: event.clientX, y: event.clientY }
      spin.set(0, 0)
      contactPx = event.pointerType === 'mouse' ? 16 : Math.max(20, Math.max(event.width || 0, event.height || 0) / 2)
      if (hit) {
        const at = [hit.dir.x, hit.dir.y, hit.dir.z]
        held = { slot: hit.slot, source: film.press(at, fingerRadius(), 1), grab: film.grab(at, fingerRadius()), origin: hit.dir }
        lastHit = hit.dir
        const rippleIndex = ripple(hit.dir, 1.1 * strength * genome.dent)
        lastRippleAt = event.timeStamp
        // A finger: the dent appears at once, gently; ~0.1 s later the
        // accelerometer tells how hard the tap was and both are re-scaled.
        if (event.pointerType === 'touch') {
          const slot = hit.slot
          const age = () => uniforms.uRippleAge.value[rippleIndex]
          tapSense.measure(event.timeStamp).then((measured) => {
            if (measured === null) return
            const k = measured / GENTLE
            tapScale = k
            modal.scale(slot, k)
            if (age() < 0.3) uniforms.uRipple.value[rippleIndex].w = Math.min(1, uniforms.uRipple.value[rippleIndex].w * k)
          })
        }
        if (!touched) {
          touched = true
          onFirstTouch?.()
        }
      }
    } else {
      dragFrom = null // a second finger means pinch
      releaseHeld()
      lastHit = null
    }
  }, listenerOptions)
  canvas.addEventListener('pointermove', (event) => {
    if (!dragFrom || activePointers.size !== 1) return
    const dx = event.clientX - dragFrom.x
    const dy = event.clientY - dragFrom.y
    const eventDt = Math.max((event.timeStamp - dragFrom.t) / 1000, 1 / 240)
    dragFrom = { x: event.clientX, y: event.clientY, t: event.timeStamp }
    const k = viewHeightAtSurface() / canvas.clientHeight
    // Which gesture: a drag straight away turns, a drag after resting stirs.
    if (gesture?.mode === 'pending') {
      if (event.timeStamp - gesture.downAt >= HOLD_TO_STIR) gesture.mode = 'stir'
      else if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > START_DRAG_PX) {
        gesture.mode = 'turn'
        // Catch up the few pixels moved before the gesture was known, so the
        // turn matches the finger from the very first touch point.
        turnBubble((event.clientX - gesture.x - dx) * k, (event.clientY - gesture.y - dy) * k)
        // Turning: the finger does not slide over the film, so it neither
        // drags nor keeps pressing it.
        if (held) {
          film.release(held.grab)
          film.release(held.source)
          held.grab = null
          held.source = null
        }
      }
    }
    const turning = gesture?.mode === 'turn'
    const stirring = gesture?.mode === 'stir'
    const dir = localHit(event.clientX, event.clientY)
    if (held && dir) modal.moveTo(held.slot, [dir.x, dir.y, dir.z])
    // Stirring: the film under the finger is carried with it.
    if (stirring && dir && lastHit && held?.grab) {
      const velocity = dir.clone().sub(lastHit).multiplyScalar(filmGrip / eventDt)
      film.drive(held.grab, [dir.x, dir.y, dir.z], [velocity.x, velocity.y, velocity.z])
      if (held.source && dir.distanceTo(held.origin) > fingerRadius() * 0.3) {
        film.release(held.source) // a sliding finger no longer presses one spot (jitter is ignored)
        held.source = null
      }
    }
    // A finger sliding through the film leaves a wake of small ripples.
    if (stirring && dir && held && event.timeStamp - lastRippleAt > 80) {
      const speed = Math.hypot(dx, dy) * k / eventDt // bubble radii per second
      if (speed > 0.15) {
        ripple(dir, Math.min(0.55, 0.12 + speed * 0.12))
        lastRippleAt = event.timeStamp
      }
    }
    lastHit = dir
    // Turn by the finger's arc (all of it when turning, a little when
    // stirring); the same, per second, is the spin kept when let go.
    const share = turning ? 1 : stirring ? TURN_WHILE_STIRRING : 0
    turnBubble(dx * k * share, dy * k * share)
    lastTurn = { mode: gesture?.mode, share, arc: Math.hypot(dx, dy) * k, eventDt }
    spin.lerp(new THREE.Vector2((dx * k * share) / eventDt, (dy * k * share) / eventDt), 0.5)
    if (spin.length() > 2.5) spin.setLength(2.5) // a hard flick: brisk, never frantic
    lastMoveAt = event.timeStamp
    // The finger drags air; the bubble rides it.
    cameraRight.setFromMatrixColumn(camera.matrixWorld, 0)
    cameraUp.setFromMatrixColumn(camera.matrixWorld, 1)
    const air = new THREE.Vector3()
      .addScaledVector(cameraRight, (dx * k) / eventDt)
      .addScaledVector(cameraUp, (-dy * k) / eventDt)
      .multiplyScalar(turning ? AIR_SHARE * 0.3 : AIR_SHARE)
    airVelocity.lerp(air, 0.5)
  }, listenerOptions)
  function endPointer(event) {
    activePointers.delete(event.pointerId)
    if (activePointers.size === 0) {
      dragFrom = null
      releaseHeld() // uses lastHit for the lift ripple
      lastHit = null
    }
  }
  canvas.addEventListener('pointerup', endPointer, listenerOptions)
  canvas.addEventListener('pointercancel', endPointer, listenerOptions)
  // Safari's own page pinch would fight the canvas gesture.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false, signal: lifecycle.signal })
  }

  // ---------- Viewer motion: only real device motion moves the light ----------
  const viewMotion = createViewMotion({ signal: lifecycle.signal })
  // iOS accepts the permission prompt only from touchend, not touchstart.
  canvas.addEventListener('touchend', () => {
    viewMotion.request()
    tapSense.listen() // same permission; tap strength from the next tap on
  }, listenerOptions)
  const envRotation = new THREE.Matrix4()

  // ---------- Genome, ageing clock and body ----------
  let genome = null
  let bud = null // attached baby bubble (rare)
  let body = null // the bubble as a physical body (bubbleBody.js)
  let ageSpeed = 1
  let ageSeconds = 0
  let ownedAt = null
  let lastMeanNm = 1
  let thickness = null
  const upTilted = new THREE.Vector3(0, 1, 0)
  const ownAxis = new THREE.Vector3()

  // Frame-time watch (resolution governor below); a birth restarts it.
  let slowFrames = 0
  let settledFrames = 0
  // ---------- Pop and bloom ----------
  // A pop starts at the live film's weakest region. Once nucleated, a soap
  // film retracts at nearly constant Taylor-Culick speed; the visible event is
  // deliberately only a few frames long rather than a slow animation.
  // A bloom grows a newborn bubble from a point with a soft overshoot.
  const MIN_POP_SECONDS = 0.045
  const POP_SWEEP = Math.PI + 0.35 // past the far side, so the rim leaves too
  const BLOOM_SECONDS = 1.8
  let popping = null // { t, resolve }
  let pendingPop = null // a pop waiting for its film copy
  let blooming = null // { t, seconds, from }
  const popOrigin = new THREE.Vector3()
  const popTurn = new THREE.Quaternion()
  function stepPopAndBloom(dt) {
    if (popping) {
      popping.t += dt
      const p = Math.min(1, popping.t / popping.seconds)
      uniforms.uPop.value.w = p < 1 ? POP_SWEEP * p : 10
      if (p >= 1 && popping.resolve) {
        popping.resolve()
        popping.resolve = null
      }
    }
    if (blooming) {
      blooming.t += dt
      const p = Math.min(1, blooming.t / blooming.seconds)
      const q = p - 1
      const grown = 1 + 2.2 * q * q * q + 1.2 * q * q
      bubble.scale.setScalar(p < 1 ? Math.max(1e-3, blooming.from + (1 - blooming.from) * grown) : 1)
      if (p >= 1) blooming = null
    }
    spray.update(dt, renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))))
  }

  // keepPose: the new bubble takes the old one's place as it is (turn, spin,
  // drift), so a sequence of bubbles reads as one calm motion.
  function birth(nextSeed = newSeed(), nextAgeSeconds = 0, nextOwnedAtSeconds = null, { keepPose = false } = {}) {
    genome = createGenome(nextSeed)
    // Seen from the moment its upper part shows colour (genome.js).
    ageSeconds = Math.max(firstSeenSeconds(genome), Number(nextAgeSeconds) || 0)
    ownedAt = nextOwnedAtSeconds === null ? null : THREE.MathUtils.clamp(Number(nextOwnedAtSeconds) || 0, 0, ageSeconds)
    thickness = thicknessOnClock(genome, ageSeconds, ownedAt)
    lastMeanNm = thickness.meanNm
    applyGenomeLook(uniforms, genome)
    detailBake?.start(uniforms)
    fullBake?.start(uniforms)
    settledFrames = 0
    modal.setDamping(genome.damping)
    filmGrip = genome.grip
    for (const r of uniforms.uRipple.value) r.w = 0
    tiltedUp(genome, upTilted)
    film.clear()
    startFilm(flowMap, genome, thickness, upTilted)
    bud?.dispose()
    bud = createBud(bubble, genome, bubble.geometry, { twoPhase })
    body = createBody(genome, thickness.meanNm)
    // Ripples run faster on a tauter film and die sooner in a more viscous one.
    uniforms.uRippleWave.value.set(Math.sqrt(body.constants.surfaceTension / 0.029), 1 / (0.8 + 0.6 * genome.birth.glycerin))
    popping = null
    uniforms.uPop.value.w = -1
    if (!keepPose) {
      bubble.quaternion.identity()
      spin.set(0, 0)
      airVelocity.set(0, 0, 0)
    }
    return genome
  }
  birth(seed, initialAgeSeconds, initialOwnedAtSeconds)

  // ---------- Resolution governor: hold the frame budget by scaling pixels only ----------
  let maxScale = Math.min(window.devicePixelRatio || 1, 3)
  // Never so few pixels that a dense phone screen looks magnified and soft.
  let minScale = maxScale >= 2.5 ? 1.5 : maxScale >= 2 ? 1.25 : 1
  // Device simulation (lab): a slower GPU (extra offscreen draws per frame)
  // and another screen density / refresh rate.
  let simLoad = 1
  let simHz = 0
  let simTarget = null
  let simLast = 0
  let simExpiry = 0
  let renderScale = maxScale // native density; the governor steps down only if needed
  let calmChecks = 0
  // A step up on probation, and the scale that last failed (kept for a while).
  let trialFrom = null
  let trialChecks = 0
  let ceiling = Infinity
  let ceilingUntil = 0
  let heldScale = false // test hook: measurements at a fixed resolution
  const intervals = []

  // The bubble fills this share of the free space's shorter side at 1x:
  // a little less on phones, where it would otherwise feel too close.
  const fillFor = (shortSide) => (shortSide < 500 ? 0.68 : 0.78)
  function resize() {
    if (disposed) return // the delayed orientation check can land after dispose
    const width = Math.max(1, canvas.clientWidth || window.innerWidth)
    const height = Math.max(1, canvas.clientHeight || window.innerHeight)
    // Only touch the canvas when its size really changed (re-setting it
    // clears the picture).
    if (renderer.getPixelRatio() !== renderScale) renderer.setPixelRatio(renderScale)
    const current = renderer.getSize(new THREE.Vector2())
    if (current.x !== width || current.y !== height) renderer.setSize(width, height, false)
    camera.aspect = width / height
    // Free space left by the page's interface (never less than a third).
    const inset = layout() || {}
    const left = THREE.MathUtils.clamp(inset.left || 0, 0, width * 0.66)
    const right = THREE.MathUtils.clamp(inset.right || 0, 0, width * 0.66 - left)
    const top = THREE.MathUtils.clamp(inset.top || 0, 0, height * 0.66)
    const bottom = THREE.MathUtils.clamp(inset.bottom || 0, 0, height * 0.66 - top)
    const freeWidth = width - left - right
    const freeHeight = height - top - bottom
    // Field of view so the bubble spans FILL of the free space's shorter side.
    const bubbleHalfAngle = Math.asin(1 / BASE_DISTANCE)
    const fill = fillFor(Math.min(width, height))
    const halfFov = Math.atan((height * Math.tan(bubbleHalfAngle)) / (fill * Math.min(freeWidth, freeHeight)))
    camera.fov = THREE.MathUtils.radToDeg(2 * halfFov)
    // Shift the picture so the bubble sits in the middle of the free space.
    const shiftX = width / 2 - (left + freeWidth / 2)
    const shiftY = height / 2 - (top + freeHeight / 2)
    if (Math.abs(shiftX) > 0.5 || Math.abs(shiftY) > 0.5) camera.setViewOffset(width, height, shiftX, shiftY, width, height)
    else camera.clearViewOffset()
    keepOutside()
  }
  // Phones report size changes late (rotation, Safari's bars): follow the
  // canvas itself, the visual viewport and a delayed check after rotation.
  window.addEventListener('resize', resize, listenerOptions)
  window.visualViewport?.addEventListener('resize', resize, listenerOptions)
  window.addEventListener('orientationchange', () => window.setTimeout(resize, 250), listenerOptions)
  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(() => resize()) : null
  resizeObserver?.observe(canvas)
  resize()
  controls.saveState()

  const qualityInterval = window.setInterval(() => {
    if (heldScale || intervals.length < 30) return
    // The display's frame interval: the fastest tenth of the frames, snapped
    // to a real display rate (120/90/60 Hz, or 30 Hz in iOS low power mode).
    // A phone drawing a steady 50 fps on a 60 Hz screen was taken for a
    // 50 Hz screen and never helped (Ar-Ge round 2).
    const refresh = displayInterval(percentile(intervals, 0.1))
    refreshHz = 1000 / Math.max(refresh, 1)
    // Judged on about the last second, so a change is seen within a second.
    const recent = intervals.slice(-Math.max(30, Math.round(1000 / refresh)))
    const p50 = percentile(recent, 0.5)
    const p95 = percentile(recent, 0.95)
    // A median frame past the budget is a steady loss of frames (for example
    // 48 fps on a 60 Hz screen while the film is stirred), not a hitch: step
    // down at once by what the pixels cost (about scale squared).
    const steady = p50 > refresh * 1.1
    const now = performance.now()
    if (trialFrom !== null) trialChecks += 1
    if ((steady || p95 > refresh * 1.5) && renderScale > minScale) {
      if (trialFrom !== null && trialChecks <= 2) {
        // A step up that does not fit: back to the scale that did, and do
        // not try this high again for a while (no saw-tooth drift down).
        ceiling = renderScale
        ceilingUntil = now + 15000
        renderScale = trialFrom
      } else {
        const factor = steady ? Math.min(0.9, 0.95 * Math.sqrt(refresh / p50)) : 0.85
        renderScale = Math.max(minScale, renderScale * factor)
      }
      trialFrom = null
      calmChecks = 0
      // The new scale is judged on its own frames.
      intervals.length = 0
      resize()
    } else if (p95 < refresh * 1.15 && renderScale < maxScale) {
      if (trialChecks > 2) trialFrom = null
      calmChecks += 1
      const top = now < ceilingUntil ? Math.min(maxScale, ceiling * 0.97) : maxScale
      if (calmChecks >= 3 && renderScale < top) {
        trialFrom = renderScale
        trialChecks = 0
        renderScale = Math.min(top, renderScale * 1.1)
        calmChecks = 0
        intervals.length = 0
        resize()
      }
    } else {
      calmChecks = 0
    }
  }, 1000)

  // ---------- Loop ----------
  let gpuMs = null
  let pendingQuery = null
  let previousFrame = performance.now()
  const gravityTarget = new THREE.Vector3()
  const inverseTurn = new THREE.Quaternion()
  const bodyOffset = new THREE.Vector3()
  const relativeAir = new THREE.Vector3()
  const squashAxis = new THREE.Vector3()

  let paused = false // test hook: hold the world still (filmstrips)
  let suspended = document.hidden
  let animationFrame = 0
  document.addEventListener('visibilitychange', () => {
    suspended = document.hidden
    previousFrame = performance.now()
  }, listenerOptions)
  const scheduleFrame = () => {
    if (!disposed && !contextLost && !driven) animationFrame = requestAnimationFrame(frame)
  }
  // The GPU can drop the context (driver reset, memory pressure, many tabs).
  // On restore three.js re-uploads geometry, the LUT and the horizon from their
  // CPU copies; the film simulation lives only in render targets, so it is
  // rebuilt (float support re-probed) and reseeded from the same genome.
  let contextLost = false
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault() // without this the browser never restores it
    contextLost = true
    cancelAnimationFrame(animationFrame)
    pendingQuery = null // belongs to the lost context
  }, listenerOptions)
  // Registered after the renderer's own handler, so three.js is ready here.
  canvas.addEventListener('webglcontextrestored', () => {
    if (disposed) return
    timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    const gravity = flowMap.uniforms.uGravity.value.clone()
    try {
      // The old flow map is not disposed: its GL objects died with the
      // context and deleting them would only log errors; GC takes the rest.
      flowMap = createFlowMap(renderer, FLOW_WIDTH, FLOW_HEIGHT, { twoPhase })
    } catch (error) {
      onError?.(error)
      return
    }
    breathMap = createBreathMap(renderer, bubbleGeometry, BUBBLE_SEGMENTS[0] + 1)
    // Same drainage axis as before the loss, so a turned bubble stays consistent.
    startFilm(flowMap, genome, thickness, gravity)
    uniforms.uFlow.value = flowMap.texture
    // The detail maps died with the context too: bake them again (the live
    // path draws meanwhile).
    if (detailBake) {
      detailBake = createDetailBake(renderer, bakeSize)
      detailBake?.start(uniforms)
    }
    if (fullBake) {
      fullBake = createFullDetailBake(renderer, fullBakeSize)
      fullBake?.start(uniforms)
    }
    settledFrames = 0
    contextLost = false
    previousFrame = performance.now()
    scheduleFrame()
  }, listenerOptions)
  function frame(now) {
    if (disposed) return
    if (paused || suspended) {
      previousFrame = now
      scheduleFrame()
      return
    }
    if (simHz && now - simLast < 1000 / simHz - 2) {
      scheduleFrame()
      return
    }
    simLast = now
    const dt = Math.min((now - previousFrame) / 1000, 0.05)
    // Very slow frames count too (clamped), or a device that can barely draw
    // would never collect enough samples to be helped; a run of them drops
    // straight to the floor instead of stepping down once a second.
    const interval = Math.min(now - previousFrame, 1000)
    intervals.push(interval)
    if (intervals.length > 180) intervals.shift()
    // (Not during the first second: shader compiles and loading stall those.)
    settledFrames += 1
    // (Nor while a new bubble's detail is being baked.)
    slowFrames = interval > 100 && settledFrames > 60 && !detailBake?.busy ? slowFrames + 1 : 0
    if (slowFrames >= 3 && !heldScale && renderScale > minScale) {
      renderScale = minScale
      slowFrames = 0
      resize()
    }
    previousFrame = now

    controls.update()
    keepOutside()

    uniforms.uTime.value += dt
    ageRipples(dt)
    stepPopAndBloom(dt)
    modal.update(dt)
    syncModes()
    const t = uniforms.uTime.value
    // The bubble as a body in air (bubbleBody.js): film weight, air inertia
    // and drag, wake sway, hovering in a warm column that eases it back to
    // the middle. Still room air drifts it softly; a finger stirs the air.
    airVelocity.multiplyScalar(Math.exp(-dt / 0.3))
    const metres = body.constants.radius
    body.update(dt, lastMeanNm, (age) => {
      const air = roomAir(genome, age)
      return [air[0] + airVelocity.x * metres, air[1] + airVelocity.y * metres, air[2] + airVelocity.z * metres]
    })
    const p = body.position
    softLimit(bodyOffset.set(p[0], p[1] - body.restHeight, p[2]).divideScalar(metres), 0.4)
    const zoomNow = SURFACE_GAP_AT_1X / Math.max(camera.position.length() - 1, MIN_GAP)
    const floatShare = 1 - 0.7 * THREE.MathUtils.smoothstep(zoomNow, 1.5, MAX_ZOOM)
    bubble.position.copy(bodyOffset).multiplyScalar(floatShare)
    sphere.center.copy(bubble.position)
    // Oncoming air flattens it a little (more for heavy, fast-falling films).
    relativeAir.fromArray(body.relative)
    const flow = relativeAir.length()
    squashAxis.copy(relativeAir).normalize().applyQuaternion(inverseTurn.copy(bubble.quaternion).invert())
    uniforms.uSquash.value.set(squashAxis.x, squashAxis.y, squashAxis.z, flow > 1e-6 ? squashAt(body.constants, flow) : 0)
    // Spin given by a push keeps turning the bubble after release and the air
    // slows it over a couple of seconds. A finger resting on it holds it.
    if (!dragFrom) {
      turnBubble(spin.x * dt, spin.y * dt)
      spin.multiplyScalar(Math.exp(-dt / SPIN_DECAY))
    } else if (now - lastMoveAt > 80) {
      spin.multiplyScalar(Math.exp(-dt / 0.08))
    }
    // Its own turn: about the genome's axis, at its speed and direction; the
    // axis wobbles a little (precession) for some bubbles.
    const wobble = genome.spinWobble
    ownAxis
      .set(
        genome.spinAxis[0] + wobble * Math.sin(t * 0.07),
        genome.spinAxis[1],
        genome.spinAxis[2] + wobble * Math.cos(t * 0.05),
      )
      .normalize()
    spinQuat.setFromAxisAngle(ownAxis, genome.spinRate * dt)
    bubble.quaternion.premultiply(spinQuat)
    // Air shear adds a faint uneven turn.
    turnBubble(dt * 0.004 * drift(t * 0.08, 6), dt * 0.004 * drift(t * 0.07, 7))
    // Gravity drains the film toward world down. After a turn the film needs
    // seconds to re-drain, so the drainage axis follows the rotation slowly.
    gravityTarget.copy(upTilted).applyQuaternion(inverseTurn.copy(bubble.quaternion).invert())
    flowMap.uniforms.uGravity.value.lerp(gravityTarget, 1 - Math.exp(-dt / 6)).normalize()
    film.update(dt)
    flowMap.uniforms.uBlobCount.value = film.write(flowMap.uniforms.uBlobA.value, flowMap.uniforms.uBlobB.value)
    // Ageing: the film thins (h ~ t^-1/2); the simulation thins what it carries.
    ageSeconds += dt * ageSpeed
    thickness = thicknessOnClock(genome, ageSeconds, ownedAt)
    flowMap.setVortices(vortexState(genome, t))
    flowMap.setThickness(genome, thickness)
    // GPU time covers the film simulation and the bubble together.
    const timing = timerExt && !pendingQuery
    if (timing) {
      pendingQuery = gl.createQuery()
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, pendingQuery)
    }
    flowMap.step(dt, t, thickness.meanNm / lastMeanNm)
    if (twoPhase) flowMap.phaseWeights(uniforms.uPhaseW.value)
    detailBake?.tick()
    fullBake?.tick()
    lastMeanNm = thickness.meanNm
    uniforms.uFlow.value = flowMap.texture
    // Reflections are world-space; only device motion turns the surroundings.
    envRotation.makeRotationFromQuaternion(viewMotion.update(dt, t))
    uniforms.uEnvRotation.value.setFromMatrix4(envRotation)
    uniforms.uCameraPos.value.copy(camera.position)
    uniforms.uViewSize.value = viewHeightAtSurface()
    bud?.sync()

    if (uniforms.uBreath.value > 0) breathMap.update(uniforms)
    else uniforms.uBreathBaked.value = false
    if (timing) {
      draw()
      gl.endQuery(timerExt.TIME_ELAPSED_EXT)
    } else {
      draw()
    }
    if (simLoad > 1) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      if (!simTarget || simTarget.width !== size.x || simTarget.height !== size.y) {
        simTarget?.dispose()
        simTarget = new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: false })
      }
      const previous = renderer.getRenderTarget()
      renderer.setRenderTarget(simTarget)
      for (let i = 1; i < simLoad; i++) renderer.render(scene, camera)
      renderer.setRenderTarget(previous)
    }
    if (pendingQuery && gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) gpuMs = gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT) / 1e6
      gl.deleteQuery(pendingQuery)
      pendingQuery = null
    }
    scheduleFrame()
  }
  scheduleFrame()

  function activeOctaves() {
    const footprint = viewHeightAtSurface() / (canvas.clientHeight * renderer.getPixelRatio())
    let f = genome.grain
    let n = 0
    while (n < 14 && f * footprint <= 0.5) {
      f *= 2.07
      n += 1
    }
    return n
  }

  function dispose() {
    if (disposed) return
    disposed = true
    ready = false
    lifecycle.abort()
    window.clearInterval(qualityInterval)
    window.clearTimeout(simExpiry)
    simTarget?.dispose()
    cancelAnimationFrame(animationFrame)
    resizeObserver?.disconnect()
    controls.dispose()
    viewMotion.dispose()
    tapSense.dispose()
    bud?.dispose()
    flowMap.dispose()
    breathMap.dispose()
    detailBake?.dispose()
    fullBake?.dispose()
    environmentTexture?.dispose()
    filmLut.dispose()
    bubbleMaterial.dispose()
    bubbleGeometry.dispose()
    if (pendingQuery) gl.deleteQuery(pendingQuery)
    pendingQuery = null
    renderer.dispose()
    activePointers.clear()
  }

  return {
    get ready() {
      return ready
    },
    // Lab only: lights on (light ground) or off.
    setLight,
    get light() {
      return Boolean(lightGround)
    },
    // driven: advances one frame at the page's clock.
    step(now = performance.now()) {
      if (driven && !disposed && !contextLost) frame(now)
    },
    get genome() {
      return genome
    },
    get body() {
      return body
    },
    get ageSeconds() {
      return ageSeconds
    },
    set ageSeconds(seconds) {
      ageSeconds = Math.max(0, Number(seconds) || 0)
    },
    get ownedAt() {
      return ownedAt
    },
    get thickness() {
      return thickness
    },
    birth,
    // Bursts the bubble; resolves when the film is gone. Without an explicit
    // world-space `at`, rupture nucleates in the weakest region of the current
    // GPU thickness map, so every bubble fails from its own lived pattern.
    pop({ at, seconds } = {}) {
      if (popping) return Promise.resolve()
      const naturalSeconds = ruptureDurationSeconds(genome.radius, thickness.meanNm)
      const requestedSeconds = Number(seconds)
      const popSeconds = Number.isFinite(requestedSeconds)
        ? THREE.MathUtils.clamp(requestedSeconds, MIN_POP_SECONDS, 5)
        : naturalSeconds
      const begin = (weakness) => {
        const dir = popOrigin
        uniforms.uPop.value.set(dir.x, dir.y, dir.z, 0)
        spray.start(bubble, dir, (angle) => popSeconds * Math.min(angle, POP_SWEEP) / POP_SWEEP, genome.patternSeed, thickness.meanNm)
        return new Promise((resolve) => {
          popping = { t: 0, seconds: popSeconds, resolve, weakness }
        })
      }
      if (at) {
        popOrigin.copy(at).normalize().applyQuaternion(popTurn.copy(bubble.quaternion).invert())
        return begin(null)
      }
      // The film is copied without stalling a frame; the tear starts a frame
      // or two later at its weakest region (or at the drained top if the copy
      // fails, for example on a lost context).
      if (!pendingPop) {
        pendingPop = flowMap
          .readFilmAsync()
          .then((film) => weakestFilmPoint(film, FLOW_WIDTH, FLOW_HEIGHT))
          .catch(() => null)
          .then((weakness) => {
            pendingPop = null
            if (weakness) popOrigin.fromArray(weakness.direction)
            else popOrigin.set(0, 1, 0).applyQuaternion(popTurn.copy(bubble.quaternion).invert())
            return begin(weakness)
          })
      }
      return pendingPop
    },
    // Grows the current bubble in (call right after birth): from a point by
    // default, or a short swell from a smaller size.
    bloom(seconds = BLOOM_SECONDS, from = 1e-3) {
      blooming = { t: 0, seconds, from }
      bubble.scale.setScalar(from)
    },
    restore({ seed: nextSeed, ageSeconds: nextAge = 0, ownedAtSeconds: nextOwnedAt = null }) {
      return birth(nextSeed, nextAge, nextOwnedAt)
    },
    snapshot() {
      return { seed: genome.seed, ageSeconds, ownedAtSeconds: ownedAt }
    },
    // Captures the current GPU film as well as the seed and clock. The caller
    // must persist the Uint32Array losslessly; this does not create ownership.
    async captureFilmState() {
      const state = { version: 1, seed: genome.seed, ageSeconds, ownedAtSeconds: ownedAt,
        time: uniforms.uTime.value, rotation: bubble.quaternion.toArray() }
      // Freeze stepping while the GPU readback is pending, so the captured
      // clock, pose and film refer to the same frame.
      const wasPaused = paused
      paused = true
      try {
        state.film = await flowMap.captureState()
        return state
      } finally {
        previousFrame = performance.now()
        paused = wasPaused
      }
    },
    restoreFilmState(state) {
      if (!state || state.version !== 1 || typeof state.seed !== 'string' || !state.seed.length || !Number.isFinite(state.ageSeconds) || state.ageSeconds < 0 || (state.ownedAtSeconds !== null && (!Number.isFinite(state.ownedAtSeconds) || state.ownedAtSeconds < 0 || state.ownedAtSeconds > state.ageSeconds)) || !Number.isFinite(state.time) || !Array.isArray(state.rotation) || state.rotation.length !== 4 || !state.rotation.every(Number.isFinite)) throw new Error('Invalid bubble state')
      birth(state.seed, state.ageSeconds, state.ownedAtSeconds)
      flowMap.restoreState(state.film)
      bubble.quaternion.fromArray(state.rotation).normalize()
      uniforms.uTime.value = state.time
      uniforms.uFlow.value = flowMap.texture
    },
    dispose,
    // From now on the bubble ages over years (see genome.thicknessOnClock).
    own() {
      if (ownedAt === null) ownedAt = ageSeconds
    },
    // Product ownership freezes the film age; lab's own() keeps its old clock.
    ownFrozen() {
      if (ownedAt === null) ownedAt = ageSeconds
      ageSpeed = 0
      return { seed: genome.seed, ageSeconds, ownedAtSeconds: ownedAt }
    },
    setAgeSpeed(speed) {
      ageSpeed = Math.max(0, Number(speed) || 0)
    },
    reset() {
      controls.reset()
      birth(genome.seed)
    },
    // Call when the page's interface changes size (fonts loaded, HUD grew).
    refit: resize,
    toggleDetail() {
      uniforms.uDetail.value = uniforms.uDetail.value > 0 ? 0 : genome.detail
    },
    // Live measurements for HUDs and quality labels.
    stats() {
      const p50 = percentile(intervals, 0.5)
      const p95 = percentile(intervals, 0.95)
      return {
        fps: 1000 / Math.max(p50, 1),
        p95,
        gpuMs,
        zoom: zoomFactor(),
        octaves: activeOctaves(),
        renderScale,
        maxScale,
        flowPrecision: flowMap.precision,
        gyro: `${viewMotion.state.status}${viewMotion.state.sample}`,
        tapStrength: GENTLE * tapScale,
        tapSensed: tapSense.active,
        squash: uniforms.uSquash.value.w,
        topNm: flowMap.uniforms.uTopNm.value,
        bottomNm: flowMap.uniforms.uBottomNm.value,
      }
    },
    // Test hooks.
    debug: {
      get lastTurn() {
        return lastTurn
      },
      uniforms,
      renderer,
      pause(on) {
        paused = Boolean(on)
      },
      // Starts the governor from a measured scale (it keeps adjusting).
      startScale(scale) {
        heldScale = false
        renderScale = THREE.MathUtils.clamp(scale, minScale, maxScale)
        intervals.length = 0
        calmChecks = 0
        trialFrom = null
        ceiling = Infinity
        ceilingUntil = 0
        resize()
        return renderScale
      },
      holdScale(scale) {
        heldScale = scale > 0
        if (heldScale) renderScale = scale
        resize()
        return renderScale
      },
      flowMap: () => flowMap,
      // Same-state shot for identity tests: view uniforms from the current
      // camera, still surroundings, no squash.
      prepareShot(time) {
        uniforms.uTime.value = time
        uniforms.uFlow.value = flowMap.texture
        uniforms.uCameraPos.value.copy(camera.position)
        uniforms.uViewSize.value = viewHeightAtSurface()
        uniforms.uEnvRotation.value.identity()
        uniforms.uSquash.value.w = 0
        if (uniforms.uBreath.value > 0) breathMap.update(uniforms)
      },
      bakeNow() {
        while (detailBake?.busy) detailBake.tick(6)
        while (fullBake?.busy) fullBake.tick()
      },
      fullBakeOctaves: () => fullBake?.count ?? null,
      setBaked(on) {
        if (detailBake) uniforms.uBaked.value = on ? 1 : 0
        return uniforms.uBaked.value
      },

      simulate({ dpr = window.devicePixelRatio || 1, load = 1, hz = 0 } = {}) {
        maxScale = Math.min(dpr, 3)
        minScale = maxScale >= 2.5 ? 1.5 : maxScale >= 2 ? 1.25 : 1
        renderScale = maxScale
        simLoad = Math.max(1, Math.round(load))
        simHz = hz
        // Safety: a simulated load never outlives a measurement (it heats
        // the machine); it switches itself off after 30 s.
        window.clearTimeout(simExpiry)
        if (simLoad > 1 || simHz) {
          simExpiry = window.setTimeout(() => {
            simLoad = 1
            simHz = 0
          }, 30000)
        }
        intervals.length = 0
        calmChecks = 0
        trialFrom = null
        ceiling = Infinity
        ceilingUntil = 0
        resize()
      },
      renderOnce() {
        draw()
      },
      bubble,
      film: () => film,
      touchAt,
      // Turns the bubble by small angles (rad, camera-space axes), as a finger would.
      turn(dx, dy) {
        turnBubble(dx, dy)
      },
      // The bubble's outline on the page: centre and radius in CSS px.
      screenCircle() {
        const rect = canvas.getBoundingClientRect()
        const toPage = (v) => [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height]
        const [x, y] = toPage(cameraOffset.copy(bubble.position).project(camera))
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
        const [ex] = toPage(cameraOffset.copy(bubble.position).addScaledVector(right, bubble.scale.x).project(camera))
        return { x, y, r: Math.abs(ex - x) }
      },
      // Zoom along the current view direction (keeps the bubble's turn).
      setZoom(zoom) {
        controls.target.set(0, 0, 0)
        camera.position.setLength(1 + SURFACE_GAP_AT_1X / zoom)
        controls.update()
        keepOutside()
        return zoomFactor()
      },
      zoomTo(zoom, yaw = 0.35, pitch = 0.45) {
        bubble.rotation.set(pitch, yaw, 0)
        controls.target.set(0, 0, 0)
        camera.position.set(0, 0, 1 + SURFACE_GAP_AT_1X / zoom)
        camera.lookAt(0, 0, 0)
        controls.update()
        keepOutside()
        return zoomFactor()
      },
    },
  }
}
