import * as THREE from 'three'

// Viewer motion for the reflected surroundings.
// The device-orientation to quaternion steps (Euler 'YXZ' from beta/alpha/
// -gamma, -90deg X camera fix, screen-angle compensation) follow three.js'
// former DeviceOrientationControls (MIT licence, three.js authors); smoothing,
// re-centring and fallback are BeRelax additions. Desktop has no pointer
// look on purpose: every platform moves the light the same way.
// Phones: device orientation -> quaternion (W3C intrinsic Z-X'-Y''), screen
// angle compensation, relative to a slowly re-centred base, softened and
// limited. No sensor (desktop, or permission denied): a calm automatic drift.
// The result is the rotation that maps camera-space directions to world space.

const DEG = Math.PI / 180
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const CAMERA_UP_FIX = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2) // -90deg about X

const GAIN = 0.6 // fraction of the real device rotation applied to the light
const MAX_ANGLE = 0.8 // radians, soft limit of the effective rotation
const SMOOTH_TAU = 0.11 // seconds
const RECENTER_TAU = 25 // seconds, while the phone is being moved
const RECENTER_TAU_STILL = 4 // seconds, once the phone rests
const STILL_RATE = 1 * DEG // rad/s below which the phone counts as resting
const GYRO_TIMEOUT = 1200 // ms without events -> fall back to automatic drift

export function createViewMotion({ signal } = {}) {
  const state = {
    status: !('ontouchstart' in window)
      ? 'bu cihazda yok · doğal kayma'
      : window.isSecureContext
        ? 'dokunmayı bekliyor'
        : 'güvensiz bağlantı (https değil)',
    sample: '',
  }
  const euler = new THREE.Euler()
  const screenFix = new THREE.Quaternion()
  const device = new THREE.Quaternion()
  const base = new THREE.Quaternion()
  let hasBase = false
  const relative = new THREE.Quaternion()
  const previousDevice = new THREE.Quaternion()
  let stillFor = 0
  let lastEventAt = -Infinity
  let requested = false

  const target = new THREE.Quaternion()
  const smoothed = new THREE.Quaternion()
  const auto = new THREE.Quaternion()
  const tmp = new THREE.Quaternion()
  let gyroWeight = 0
  const listenerOptions = signal ? { signal } : undefined

  function screenAngle() {
    const angle = screen.orientation?.angle ?? window.orientation ?? 0
    return angle * DEG
  }

  function onOrientation(event) {
    if (event.alpha === null && event.beta === null) {
      state.status = 'olay geliyor ama değer yok'
      return
    }
    lastEventAt = performance.now()
    state.status = 'aktif'
    state.sample = ` β${(event.beta ?? 0).toFixed(0)} γ${(event.gamma ?? 0).toFixed(0)}`
    euler.set((event.beta ?? 0) * DEG, (event.alpha ?? 0) * DEG, -(event.gamma ?? 0) * DEG, 'YXZ')
    device.setFromEuler(euler).multiply(CAMERA_UP_FIX).multiply(screenFix.setFromAxisAngle(Z_AXIS, -screenAngle()))
    if (!hasBase) {
      base.copy(device)
      previousDevice.copy(device)
      hasBase = true
    }
  }

  function resetBase() {
    hasBase = false
  }

  // Must run synchronously inside touchend/click (iOS transient activation).
  function request() {
    if (requested) return
    const Orientation = window.DeviceOrientationEvent
    if (!Orientation) {
      state.status = 'tarayıcı desteklemiyor'
      return
    }
    if (typeof Orientation.requestPermission === 'function') {
      state.status = 'izin soruldu'
      Orientation.requestPermission()
        .then((result) => {
          if (result === 'granted') {
            requested = true
            state.status = 'izin verildi, veri bekleniyor'
            window.addEventListener('deviceorientation', onOrientation, listenerOptions)
          } else {
            state.status = `izin: ${result}`
          }
        })
        .catch((error) => {
          state.status = `izin hatası: ${error?.name || error}`
        })
    } else {
      requested = true
      state.status = 'dinleniyor'
      window.addEventListener('deviceorientation', onOrientation, listenerOptions)
    }
  }

  function onVisibility() {
    if (!document.hidden) resetBase()
  }
  window.addEventListener('orientationchange', resetBase, listenerOptions)
  screen.orientation?.addEventListener?.('change', resetBase, listenerOptions)
  document.addEventListener('visibilitychange', onVisibility, listenerOptions)

  function limit(q) {
    // Apply gain and a soft angle limit to a rotation.
    let angle = 2 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1))
    if (angle > Math.PI) angle -= 2 * Math.PI
    const s = Math.sqrt(Math.max(1e-12, 1 - q.w * q.w))
    const axis = new THREE.Vector3(q.x / s, q.y / s, q.z / s)
    const scaled = MAX_ANGLE * Math.tanh((angle * GAIN) / MAX_ANGLE)
    return q.setFromAxisAngle(axis, scaled)
  }

  function update(dt, time) {
    const now = performance.now()
    const gyroLive = now - lastEventAt < GYRO_TIMEOUT
    if (!gyroLive && state.status === 'aktif') state.status = 'veri kesildi, otomatik hareket'

    if (gyroLive && hasBase) {
      // Resting detection from the change in device orientation.
      const rate = previousDevice.angleTo(device) / Math.max(dt, 1e-3)
      previousDevice.copy(device)
      stillFor = rate < STILL_RATE ? stillFor + dt : 0
      // Slowly re-centre so drift and a new holding posture fade away.
      const tau = stillFor > 4 ? RECENTER_TAU_STILL : RECENTER_TAU
      base.slerp(device, 1 - Math.exp(-dt / tau))
      relative.copy(base).invert().multiply(device)
      limit(relative)
    }

    // Calm automatic drift when no sensor drives the view.
    euler.set(Math.sin(time * 0.17) * 6 * DEG, Math.sin(time * 0.11 + 1.3) * 10 * DEG, 0, 'YXZ')
    auto.setFromEuler(euler)

    gyroWeight += ((gyroLive ? 1 : 0) - gyroWeight) * (1 - Math.exp(-dt / 0.5))
    target.copy(auto)
    tmp.copy(target).slerp(relative, gyroWeight)
    if (smoothed.dot(tmp) < 0) tmp.set(-tmp.x, -tmp.y, -tmp.z, -tmp.w)
    smoothed.slerp(tmp, 1 - Math.exp(-dt / SMOOTH_TAU))
    return smoothed
  }

  function dispose() {
    window.removeEventListener('deviceorientation', onOrientation)
    window.removeEventListener('orientationchange', resetBase)
    screen.orientation?.removeEventListener?.('change', resetBase)
    document.removeEventListener('visibilitychange', onVisibility)
  }

  return { state, request, update, dispose }
}
