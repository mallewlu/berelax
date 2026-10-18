// How hard a finger struck the screen. A phone screen does not report the
// speed of a tap (iPhone 11 has no pressure sensor), but the phone itself
// jolts when tapped: the accelerometer shows a short spike, larger for a
// firmer, faster tap. GarageBand reads piano-key velocity on iPhone the same
// way. Without motion data (desktop, a mouse, permission declined) every
// touch gets the same gentle strength.

export const GENTLE = 0.42 // the strength of a mouse click, or of any tap without motion data
const WINDOW_BEFORE = 40 // ms before the touch the spike may start
const WINDOW_AFTER = 90 // ms after it: the dent is re-scaled once this has passed
const BASELINE_MS = 600

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

// Spike size (m/s^2 above the hand's own tremor) -> touch strength 0.25..1.
export function strengthFromPeak(peak) {
  if (!(peak > 0)) return 0.25
  return clamp(0.25 + 0.3 * Math.log1p(peak / 0.35), 0.25, 1)
}

export function createTapSense({ signal } = {}) {
  const samples = [] // [time ms, |acceleration| m/s^2]
  let active = false
  let listening = false
  const lowPass = [0, 0, 0]
  const listenerOptions = signal ? { signal } : undefined

  function add(time, magnitude) {
    if (!Number.isFinite(time) || !Number.isFinite(magnitude)) return
    samples.push([time, magnitude])
    active = true
    while (samples.length && samples[0][0] < time - 2000) samples.shift()
  }

  function onMotion(event) {
    const a = event.acceleration
    if (a && a.x !== null && a.y !== null && a.z !== null) {
      add(event.timeStamp, Math.hypot(a.x, a.y, a.z))
      return
    }
    // Some devices give only acceleration with gravity: take out the slow part.
    const g = event.accelerationIncludingGravity
    if (!g || g.x === null) return
    const raw = [g.x, g.y, g.z]
    for (let i = 0; i < 3; i += 1) lowPass[i] += (raw[i] - lowPass[i]) * 0.1
    add(event.timeStamp, Math.hypot(raw[0] - lowPass[0], raw[1] - lowPass[1], raw[2] - lowPass[2]))
  }

  // Must run inside a user gesture on iOS (same "Motion & Orientation"
  // permission as the gyroscope: no second prompt once granted).
  function listen() {
    if (listening) return
    const Motion = window.DeviceMotionEvent
    if (!Motion) return
    listening = true
    if (typeof Motion.requestPermission === 'function') {
      Motion.requestPermission()
        .then((result) => {
          if (result === 'granted') window.addEventListener('devicemotion', onMotion, listenerOptions)
          else listening = false
        })
        .catch(() => {
          listening = false
        })
    } else {
      window.addEventListener('devicemotion', onMotion, listenerOptions)
    }
  }

  // The spike of a tap at time t0 (ms), above the tremor just before it.
  function peakAround(t0) {
    const before = samples.filter(([t]) => t >= t0 - BASELINE_MS && t < t0 - WINDOW_BEFORE).map(([, m]) => m)
    const around = samples.filter(([t]) => t >= t0 - WINDOW_BEFORE && t <= t0 + WINDOW_AFTER).map(([, m]) => m)
    if (!around.length) return null
    before.sort((a, b) => a - b)
    const baseline = before.length ? before[Math.floor(before.length / 2)] : 0
    return Math.max(0, Math.max(...around) - baseline)
  }

  // Strength of a tap at t0 once its window has passed; null without motion data.
  function measure(t0) {
    return new Promise((resolve) => {
      window.setTimeout(() => {
        const peak = active ? peakAround(t0) : null
        resolve(peak === null ? null : strengthFromPeak(peak))
      }, WINDOW_AFTER + 10)
    })
  }

  function dispose() {
    window.removeEventListener('devicemotion', onMotion)
    listening = false
    active = false
    samples.length = 0
  }

  return { listen, measure, peakAround, add, dispose, get active() { return active } }
}
