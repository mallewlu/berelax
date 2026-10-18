// Touch response as damped spherical-harmonic surface modes (l = 2..5).
// A real soap bubble rings fast (10-60 Hz) and briefly; it never wobbles like
// jelly. Each touch writes an immediate static dent into the modes (visible
// on the first frame), then every mode relaxes with an exact, unconditionally
// stable damped-oscillator step (no integration blow-up at any frame rate).

export const MODE_SLOTS = 3
export const MODES = [
  { l: 2, hz: 14, zeta: 0.45 },
  { l: 3, hz: 27, zeta: 0.5 },
  { l: 4, hz: 41, zeta: 0.6 },
  { l: 5, hz: 57, zeta: 0.7 },
]

const FOOTPRINT = 0.2 // fingertip width on the bubble, radians
const MAX_TOTAL = 0.05 // radius fraction, soft limit of the summed modes

function modeWeight(l) {
  return Math.exp((-l * (l + 1) * FOOTPRINT * FOOTPRINT) / 2) / Math.sqrt(l + 1)
}

const WEIGHTS = MODES.map((mode) => modeWeight(mode.l))
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0)

// Exact step of x'' + 2 z w x' + w^2 x = 0 over dt (underdamped, z < 1).
export function stepMode(x, v, omega, zeta, dt) {
  const wd = omega * Math.sqrt(1 - zeta * zeta)
  const decay = Math.exp(-zeta * omega * dt)
  const c = Math.cos(wd * dt)
  const s = Math.sin(wd * dt)
  return [
    decay * (x * c + ((v + zeta * omega * x) / wd) * s),
    decay * (v * c - ((omega * omega * x + zeta * omega * v) / wd) * s),
  ]
}

export function createModalTouch() {
  const slots = Array.from({ length: MODE_SLOTS }, () => ({
    axis: [0, 0, 1],
    x: new Float32Array(MODES.length),
    v: new Float32Array(MODES.length),
    rest: null, // while a finger stays on the film the dent is its rest shape
  }))
  let next = 0
  let dampingScale = 1 // genome: glycerin-rich films ring less

  return {
    slots,
    setDamping(scale) {
      dampingScale = Number.isFinite(scale) ? Math.min(1.6, Math.max(0.6, scale)) : 1
    },
    // strength 0..1. Inward dent along `axis` (unit vector, bubble space).
    // With hold, the finger keeps the dent in place until release(slot); the
    // dent follows the finger (moveTo) and rings back only once it lifts.
    touch(axis, strength, hold = false) {
      const slot = slots[next % MODE_SLOTS]
      next += 1
      const s = Math.max(0, Math.min(1, strength))
      // Soft saturation keeps even a hard tap within MAX_TOTAL of the radius.
      const amplitude = MAX_TOTAL * Math.tanh(s * 0.9)
      slot.axis = [axis[0], axis[1], axis[2]]
      for (let i = 0; i < MODES.length; i += 1) {
        slot.x[i] = (-amplitude * WEIGHTS[i]) / WEIGHT_SUM
        slot.v[i] = 0
      }
      slot.rest = hold ? Float32Array.from(slot.x) : null
      return slot
    },
    // Re-scale a touch once its true strength is known (a phone measures
    // the tap's jolt ~0.1 s after the first frame), within the same limit.
    scale(slot, factor) {
      if (!slot || !Number.isFinite(factor)) return
      const total = Math.abs(slot.x.reduce((sum, value) => sum + value, 0))
      const k = Math.max(0, Math.min(factor, total > 0 ? MAX_TOTAL / total : factor))
      for (let i = 0; i < MODES.length; i += 1) {
        slot.x[i] *= k
        slot.v[i] *= k
        if (slot.rest) slot.rest[i] *= k
      }
    },
    moveTo(slot, axis) {
      if (slot && slot.rest) slot.axis = [axis[0], axis[1], axis[2]]
    },
    release(slot) {
      if (slot) slot.rest = null
    },
    update(dt) {
      // Ignore broken frame times; cap long stalls (tab switches).
      const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0
      for (const slot of slots) {
        for (let i = 0; i < MODES.length; i += 1) {
          const omega = 2 * Math.PI * MODES[i].hz
          const rest = slot.rest ? slot.rest[i] : 0
          const zeta = Math.min(0.95, MODES[i].zeta * dampingScale)
          const [x, v] = stepMode(slot.x[i] - rest, slot.v[i], omega, zeta, step)
          const settled = Math.abs(x) < 1e-7 && Math.abs(v) < 1e-5
          slot.x[i] = settled ? rest : x + rest
          slot.v[i] = settled ? 0 : v
        }
      }
    },
    // What the screen should show of a slot. A display refreshing at
    // refreshHz cannot show ringing above half that rate: it would alias into
    // a slow, jelly-like wobble (57 Hz on a 60 Hz phone looks like 3 Hz). So
    // the ringing of each mode fades out toward the display's limit; the
    // resting dent of a held finger is always shown in full.
    displayed(slot, refreshHz = 60) {
      const nyquist = Math.max(1, refreshHz) / 2
      return MODES.map((mode, i) => {
        const rest = slot.rest ? slot.rest[i] : 0
        const ratio = mode.hz / nyquist
        const keep = Math.max(0, 1 - ratio * ratio)
        return rest + (slot.x[i] - rest) * keep
      })
    },
    // Radial displacement (radius fraction) along the touch axis, for tests.
    displacementAtPole(slot) {
      return slot.x.reduce((sum, value) => sum + value, 0)
    },
  }
}
