import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { applyGenomeLook, startFilm, tiltedUp } from './applyGenome.js'
import { createBody, drift, roomAir, softLimit, squashAt } from './bubbleBody.js'
import { createBud } from './budBubble.js'
import { createFilmFlow } from './filmFlow.js'
import { createFilmLut } from './filmLut.js'
import { vortexState } from './filmVortices.js'
import { createFlowMap } from './flowMap.js'
import { createGenome, newSeed, thicknessOnClock } from './genome.js'
import { createModalTouch } from './modalTouch.js'
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
  environment = '/bubble/env/ufuk.hdr',
  onFirstTouch,
  onError,
  layout = () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
} = {}) {
  const lifecycle = new AbortController()
  const listenerOptions = { signal: lifecycle.signal }
  let disposed = false
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  const gl = renderer.getContext()
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 50)
  camera.position.set(0, 0, BASE_DISTANCE)

  const filmLut = createFilmLut()
  const bubbleGeometry = new THREE.SphereGeometry(1, 256, 192)
  const bubbleMaterial = createZoomMaterial(null, filmLut)
  const bubble = new THREE.Mesh(bubbleGeometry, bubbleMaterial)
  scene.add(bubble)
  const uniforms = bubble.material.uniforms
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

  function surfaceDistance() {
    const rect = canvas.getBoundingClientRect()
    const ray = rayAt(rect.left + rect.width / 2, rect.top + rect.height / 2)
    const point = ray.intersectSphere(sphere, new THREE.Vector3())
    return point ? point.distanceTo(camera.position) : Math.max(camera.position.distanceTo(sphere.center) - 1, MIN_GAP)
  }

  const zoomFactor = () => SURFACE_GAP_AT_1X / surfaceDistance()
  const viewHeightAtSurface = () => 2 * surfaceDistance() * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))

  function keepOutside() {
    // Zoom-to-cursor moves the orbit target; never let the camera enter the film.
    const offset = camera.position.clone().sub(sphere.center)
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
    flowMap = createFlowMap(renderer)
  } catch (error) {
    onError?.(error)
    disposed = true
    lifecycle.abort()
    controls.dispose()
    environmentTexture?.dispose()
    filmLut.dispose()
    bubbleMaterial.dispose()
    bubbleGeometry.dispose()
    renderer.dispose()
    throw error
  }
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

  function birth(nextSeed = newSeed(), nextAgeSeconds = 0, nextOwnedAtSeconds = null) {
    genome = createGenome(nextSeed)
    ageSeconds = Math.max(0, Number(nextAgeSeconds) || 0)
    ownedAt = nextOwnedAtSeconds === null ? null : THREE.MathUtils.clamp(Number(nextOwnedAtSeconds) || 0, 0, ageSeconds)
    thickness = thicknessOnClock(genome, ageSeconds, ownedAt)
    lastMeanNm = thickness.meanNm
    applyGenomeLook(uniforms, genome)
    modal.setDamping(genome.damping)
    filmGrip = genome.grip
    for (const r of uniforms.uRipple.value) r.w = 0
    tiltedUp(genome, upTilted)
    film.clear()
    startFilm(flowMap, genome, thickness, upTilted)
    bud?.dispose()
    bud = createBud(bubble, genome, bubble.geometry)
    body = createBody(genome, thickness.meanNm)
    // Ripples run faster on a tauter film and die sooner in a more viscous one.
    uniforms.uRippleWave.value.set(Math.sqrt(body.constants.surfaceTension / 0.029), 1 / (0.8 + 0.6 * genome.birth.glycerin))
    bubble.quaternion.identity()
    spin.set(0, 0)
    airVelocity.set(0, 0, 0)
    return genome
  }
  birth(seed, initialAgeSeconds, initialOwnedAtSeconds)

  // ---------- Resolution governor: hold the frame budget by scaling pixels only ----------
  const maxScale = Math.min(window.devicePixelRatio || 1, 3)
  // Never so few pixels that a dense phone screen looks magnified and soft.
  const minScale = maxScale >= 2.5 ? 1.5 : maxScale >= 2 ? 1.25 : 1
  let renderScale = Math.min(maxScale, 2)
  let calmChecks = 0
  const intervals = []

  // The bubble fills this share of the free space's shorter side at 1x:
  // a little less on phones, where it would otherwise feel too close.
  const fillFor = (shortSide) => (shortSide < 500 ? 0.68 : 0.78)
  function resize() {
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
    if (intervals.length < 30) return
    const refresh = percentile(intervals, 0.1)
    refreshHz = 1000 / Math.max(refresh, 1)
    const p95 = percentile(intervals, 0.95)
    if (p95 > refresh * 1.5 && renderScale > minScale) {
      renderScale = Math.max(minScale, renderScale * 0.85)
      calmChecks = 0
      resize()
    } else if (p95 < refresh * 1.15 && renderScale < maxScale) {
      calmChecks += 1
      if (calmChecks >= 3) {
        renderScale = Math.min(maxScale, renderScale * 1.1)
        calmChecks = 0
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
    if (!disposed) animationFrame = requestAnimationFrame(frame)
  }
  function frame(now) {
    if (disposed) return
    if (paused || suspended) {
      previousFrame = now
      scheduleFrame()
      return
    }
    const dt = Math.min((now - previousFrame) / 1000, 0.05)
    if (now - previousFrame < 250) intervals.push(now - previousFrame)
    if (intervals.length > 180) intervals.shift()
    previousFrame = now

    controls.update()
    keepOutside()

    uniforms.uTime.value += dt
    ageRipples(dt)
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
    flowMap.step(dt, t, thickness.meanNm / lastMeanNm)
    lastMeanNm = thickness.meanNm
    uniforms.uFlow.value = flowMap.texture
    // Reflections are world-space; only device motion turns the surroundings.
    envRotation.makeRotationFromQuaternion(viewMotion.update(dt, t))
    uniforms.uEnvRotation.value.setFromMatrix4(envRotation)
    uniforms.uCameraPos.value.copy(camera.position)
    uniforms.uViewSize.value = viewHeightAtSurface()
    bud?.sync()

    if (timerExt && !pendingQuery) {
      pendingQuery = gl.createQuery()
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, pendingQuery)
      renderer.render(scene, camera)
      gl.endQuery(timerExt.TIME_ELAPSED_EXT)
    } else {
      renderer.render(scene, camera)
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
    cancelAnimationFrame(animationFrame)
    resizeObserver?.disconnect()
    controls.dispose()
    viewMotion.dispose()
    tapSense.dispose()
    bud?.dispose()
    flowMap.dispose()
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
    restore({ seed: nextSeed, ageSeconds: nextAge = 0, ownedAtSeconds: nextOwnedAt = null }) {
      return birth(nextSeed, nextAge, nextOwnedAt)
    },
    snapshot() {
      return { seed: genome.seed, ageSeconds, ownedAtSeconds: ownedAt }
    },
    dispose,
    // From now on the bubble ages over years (see genome.thicknessOnClock).
    own() {
      if (ownedAt === null) ownedAt = ageSeconds
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
      renderOnce() {
        renderer.render(scene, camera)
      },
      bubble,
      film: () => film,
      touchAt,
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
