import * as THREE from 'three'
import './bubble.css'
import { createBubblePhysics } from './physics.js'
import {
  MAX_BUBBLE_IMPACTS,
  createBubbleMaterial,
} from './shaders.js'

const canvas = document.querySelector('#bubble-canvas')
const status = document.querySelector('#status')
const fpsLabel = document.querySelector('#fps')
const qualityLabel = document.querySelector('#quality')
const intro = document.querySelector('.intro')

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance',
})
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.16

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100)
camera.position.set(0, 0.02, 4.45)

function createStudioEnvironment() {
  const palettes = [
    ['#d9efff', '#243141'],
    ['#ffd9eb', '#381e31'],
    ['#ddfff4', '#19342e'],
    ['#fff3cb', '#332c1d'],
    ['#b9cbff', '#20243a'],
    ['#f7fbff', '#1c2530'],
  ]

  const images = palettes.map(([highlight, shadow], index) => {
    const face = document.createElement('canvas')
    face.width = 256
    face.height = 256
    const context = face.getContext('2d')
    const x = index % 2 === 0 ? 70 : 186
    const gradient = context.createRadialGradient(x, 54, 4, 128, 128, 210)
    gradient.addColorStop(0, highlight)
    gradient.addColorStop(0.13, '#8aa0af')
    gradient.addColorStop(0.42, shadow)
    gradient.addColorStop(1, '#050608')
    context.fillStyle = gradient
    context.fillRect(0, 0, 256, 256)
    return face
  })

  const texture = new THREE.CubeTexture(images)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

const environment = createStudioEnvironment()
scene.environment = environment
const bubbleMaterial = createBubbleMaterial()

// Prototype comparison switch for the reflected "invisible room".
const ENV_MODES = { ufuk: 0, oda: 1, oda2: 2 }
const envName = new URLSearchParams(window.location.search).get('env')
const envMode = ENV_MODES[envName] ?? ENV_MODES.oda
bubbleMaterial.uniforms.uEnvMode.value = envMode
const geometry = new THREE.SphereGeometry(1, 160, 112)
const bubble = new THREE.Mesh(geometry, bubbleMaterial)
bubble.renderOrder = 2

// Three's physically based iridescent shell supplies a proven optical base;
// the custom shader above adds flowing film and local touch ripples on top.
const opticalShell = new THREE.Mesh(
  geometry,
  new THREE.MeshPhysicalMaterial({
    color: 0xdaf8ff,
    roughness: 0.08,
    metalness: 0,
    transmission: 0.99,
    thickness: 0.012,
    ior: 1.333,
    iridescence: 1,
    iridescenceIOR: 1.32,
    iridescenceThicknessRange: [110, 760],
    clearcoat: 0.38,
    clearcoatRoughness: 0.12,
    envMap: environment,
    envMapIntensity: 2.15,
    transparent: true,
    opacity: 0.075,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
  }),
)
opticalShell.scale.setScalar(1.004)
opticalShell.renderOrder = 1
opticalShell.visible = false
bubble.add(opticalShell)

const bubbleRig = new THREE.Group()
bubbleRig.add(bubble)
scene.add(bubbleRig)


const physics = createBubblePhysics({
  frequency: 5.6,
  dampingRatio: 0.42,
  instantIndent: 0.022,
  maxDeformation: 0.09,
})

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2(4, 4)
const targetCamera = new THREE.Vector2()
const targetPosition = new THREE.Vector2()
const localHit = new THREE.Vector3()
const birthStartedAt = performance.now()
let previousFrameAt = birthStartedAt
let pointerDown = false
let pointerId = null
let lastPointerX = 0
let lastPointerY = 0
let lastImpactAt = -Infinity
let nextImpact = 0
let interacted = false
let frameCount = 0
let fpsWindowStart = performance.now()
let quality = 'HIGH'

const impactVectors = bubbleMaterial.uniforms.uPointerImpacts.value
const impactAges = bubbleMaterial.uniforms.uImpactAges.value

function pointerToNdc(event) {
  const rect = canvas.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
}

function hitBubble(event, strength, force = false) {
  const now = performance.now()
  if (!force && now - lastImpactAt < 42) return false

  pointerToNdc(event)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObject(bubble, false)[0]
  if (!hit) return false

  localHit.copy(hit.point)
  bubble.worldToLocal(localHit)
  localHit.normalize()

  const slot = nextImpact % MAX_BUBBLE_IMPACTS
  impactVectors[slot].set(localHit.x, localHit.y, localHit.z, strength)
  impactAges[slot] = 0
  nextImpact += 1
  lastImpactAt = now
  physics.impulse(localHit, strength)

  if (!interacted) {
    interacted = true
    intro.classList.add('is-quiet')
    status.textContent = 'TEMAS ALGILANDI'
    window.setTimeout(() => {
      status.textContent = 'ZAR KARARLI'
    }, 900)
  }
  return true
}

canvas.addEventListener('pointerdown', (event) => {
  pointerDown = true
  pointerId = event.pointerId
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  canvas.setPointerCapture(event.pointerId)
  hitBubble(event, 0.76, true)
})

canvas.addEventListener('pointermove', (event) => {
  pointerToNdc(event)
  targetCamera.set(pointer.x * 0.09, pointer.y * 0.06)
  if (!pointerDown || event.pointerId !== pointerId) return

  const dx = event.clientX - lastPointerX
  const dy = event.clientY - lastPointerY
  const speed = Math.min(1, Math.hypot(dx, dy) / 34)
  targetPosition.x = THREE.MathUtils.clamp(targetPosition.x + dx * 0.0017, -0.16, 0.16)
  targetPosition.y = THREE.MathUtils.clamp(targetPosition.y - dy * 0.0017, -0.12, 0.12)
  hitBubble(event, 0.28 + speed * 0.42)
  lastPointerX = event.clientX
  lastPointerY = event.clientY
})

function releasePointer(event) {
  if (event.pointerId !== pointerId) return
  pointerDown = false
  pointerId = null
  targetPosition.multiplyScalar(0.32)
}

canvas.addEventListener('pointerup', releasePointer)
canvas.addEventListener('pointercancel', releasePointer)
canvas.addEventListener('contextmenu', (event) => event.preventDefault())

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  const compact = Math.min(width, height) < 700
  const pixelRatioCap = quality === 'HIGH' ? (compact ? 1.7 : 2) : 1.25
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap))
  renderer.setSize(width, height, false)
  camera.aspect = width / Math.max(height, 1)
  camera.updateProjectionMatrix()

  const portrait = height > width
  const scale = portrait ? 0.58 : 0.82
  bubbleRig.scale.setScalar(scale)
}

window.addEventListener('resize', resize)
resize()

function measurePerformance(now) {
  frameCount += 1
  const elapsed = now - fpsWindowStart
  if (elapsed < 1000) return

  const fps = Math.round((frameCount * 1000) / elapsed)
  fpsLabel.textContent = `${fps} FPS`
  frameCount = 0
  fpsWindowStart = now

  if (fps < 43 && quality === 'HIGH') {
    quality = 'BALANCED'
    qualityLabel.textContent = 'ADAPTIVE · BALANCED'
    bubbleMaterial.uniforms.uMicroWaveStrength.value = 0.014
    resize()
  }
}

function animate(now) {
  const delta = Math.min((now - previousFrameAt) / 1000, 0.05)
  const elapsed = (now - birthStartedAt) / 1000
  previousFrameAt = now
  const birthProgress = THREE.MathUtils.clamp((now - birthStartedAt) / 1350, 0, 1)
  const birthEase = 1 - Math.pow(1 - birthProgress, 4)
  const physicsState = physics.update(delta)

  for (let index = 0; index < MAX_BUBBLE_IMPACTS; index += 1) {
    impactAges[index] += delta
    if (impactAges[index] > 2.6) impactVectors[index].w = 0
  }

  bubbleMaterial.uniforms.uTime.value = elapsed
  bubbleMaterial.uniforms.uCameraPosition.value.copy(camera.position)

  camera.position.x = THREE.MathUtils.lerp(camera.position.x, targetCamera.x, 0.035)
  camera.position.y = THREE.MathUtils.lerp(camera.position.y, targetCamera.y + 0.02, 0.035)
  camera.lookAt(0, 0, 0)

  bubbleRig.position.x = THREE.MathUtils.lerp(bubbleRig.position.x, targetPosition.x, 0.075)
  bubbleRig.position.y = THREE.MathUtils.lerp(
    bubbleRig.position.y,
    targetPosition.y + Math.sin(elapsed * 0.7) * 0.015,
    0.075,
  )
  bubble.rotation.y = elapsed * 0.035
  bubble.rotation.z = Math.sin(elapsed * 0.31) * 0.02

  const response = Math.min(Math.abs(physicsState.amplitude) * 1.7, 0.045)
  const bornScale = 0.04 + birthEase * 0.96
  bubble.scale.set(
    bornScale * (1 + response * 0.55),
    bornScale * (1 - response),
    bornScale * (1 + response * 0.55),
  )

  if (birthProgress >= 1 && status.textContent === 'SABUN ZARI OLUŞUYOR') {
    status.textContent = 'ZAR KARARLI'
  }

  renderer.render(scene, camera)
  measurePerformance(now)
  requestAnimationFrame(animate)
}

requestAnimationFrame(animate)
