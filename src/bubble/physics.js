const DEFAULTS = Object.freeze({
  frequency: 4.8,
  dampingRatio: 0.3,
  impulseVelocity: 1.35,
  instantIndent: 0.028,
  maxDeformation: 0.16,
  directionMemory: 0.35,
  rippleSpeed: 15,
  sleepThreshold: 0.0001,
  maxDeltaTime: 1 / 20,
  maxStep: 1 / 120,
})

const EPSILON = 1e-8

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function normaliseInto(target, source) {
  const x = Number(source?.x ?? source?.[0] ?? 0)
  const y = Number(source?.y ?? source?.[1] ?? 0)
  const z = Number(source?.z ?? source?.[2] ?? 0)
  const length = Math.hypot(x, y, z)

  if (!Number.isFinite(length) || length < EPSILON) return false

  target[0] = x / length
  target[1] = y / length
  target[2] = z / length
  return true
}

/**
 * Lightweight, allocation-free bubble deformation model.
 *
 * It models the dominant soft-body response as a damped spring. The shader is
 * responsible for turning the scalar displacement into a local dent/ripple
 * around `direction`; this keeps pointer interaction cheap on mobile devices.
 */
export class BubblePhysics {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options }
    this.direction = new Float32Array([0, 0, 1])
    this._nextDirection = new Float32Array(3)
    this.displacement = 0
    this.velocity = 0
    this.ripplePhase = 0
    this.energy = 0

    // Three.js-compatible uniform wrappers. Their identity remains stable so a
    // material can retain this object for the complete lifetime of the bubble.
    this.uniforms = {
      uImpactDirection: { value: this.direction },
      uImpactAmplitude: { value: 0 },
      uImpactVelocity: { value: 0 },
      uRipplePhase: { value: 0 },
      uImpactEnergy: { value: 0 },
    }
    this.state = {
      direction: this.direction,
      amplitude: 0,
      velocity: 0,
      ripplePhase: 0,
      energy: 0,
      active: false,
    }
  }

  /**
   * Apply a pointer/touch hit in bubble-local space.
   * @param {{x:number,y:number,z:number}|ArrayLike<number>} hitDirection
   * @param {number} strength A normalised 0..1 interaction strength.
   * @returns {boolean} False when the direction is invalid or strength is zero.
   */
  impulse(hitDirection, strength = 1) {
    const amount = clamp(Number(strength) || 0, 0, 1)
    if (amount === 0 || !normaliseInto(this._nextDirection, hitDirection)) {
      return false
    }

    const existingWeight = Math.min(
      this.options.directionMemory,
      Math.abs(this.displacement) + Math.abs(this.velocity) * 0.08,
    )

    this.direction[0] =
      this.direction[0] * existingWeight + this._nextDirection[0] * amount
    this.direction[1] =
      this.direction[1] * existingWeight + this._nextDirection[1] * amount
    this.direction[2] =
      this.direction[2] * existingWeight + this._nextDirection[2] * amount
    normaliseInto(this.direction, this.direction)

    // A small immediate dent removes the one-frame delay that a velocity-only
    // impulse would produce. Negative displacement means inward deformation.
    this.displacement = Math.max(
      -this.options.maxDeformation,
      this.displacement - this.options.instantIndent * amount,
    )
    this.velocity -= this.options.impulseVelocity * amount
    this.ripplePhase = 0
    const angularFrequency = Math.PI * 2 * this.options.frequency
    this.energy =
      Math.abs(this.displacement) +
      Math.abs(this.velocity) / Math.max(angularFrequency, EPSILON)
    this._syncOutput()
    return true
  }

  /** Advance the analytical approximation by `dt` seconds. */
  update(dt) {
    const frameDt = clamp(Number(dt) || 0, 0, this.options.maxDeltaTime)
    let remaining = frameDt
    const angularFrequency = Math.PI * 2 * this.options.frequency
    const spring = angularFrequency * angularFrequency
    const damping = 2 * this.options.dampingRatio * angularFrequency

    // Small fixed upper bound keeps the semi-implicit integration stable after
    // frame drops while normal 60/120 Hz frames cost only one or two iterations.
    while (remaining > EPSILON) {
      const step = Math.min(remaining, this.options.maxStep)
      const acceleration =
        -spring * this.displacement - damping * this.velocity
      this.velocity += acceleration * step
      this.displacement += this.velocity * step
      this.displacement = clamp(
        this.displacement,
        -this.options.maxDeformation,
        this.options.maxDeformation,
      )
      remaining -= step
    }

    this.ripplePhase =
      (this.ripplePhase + frameDt * this.options.rippleSpeed) %
      (Math.PI * 2)

    this.energy =
      Math.abs(this.displacement) +
      Math.abs(this.velocity) / Math.max(angularFrequency, EPSILON)

    if (this.energy < this.options.sleepThreshold) {
      this.displacement = 0
      this.velocity = 0
      this.energy = 0
    }

    this._syncOutput()
    return this.getState()
  }

  _syncOutput() {
    this.uniforms.uImpactAmplitude.value = this.displacement
    this.uniforms.uImpactVelocity.value = this.velocity
    this.uniforms.uRipplePhase.value = this.ripplePhase
    this.uniforms.uImpactEnergy.value = this.energy
    this.state.amplitude = this.displacement
    this.state.velocity = this.velocity
    this.state.ripplePhase = this.ripplePhase
    this.state.energy = this.energy
    this.state.active = this.energy >= this.options.sleepThreshold
  }

  /** Returns the stable Three.js-compatible uniform map. */
  getUniforms() {
    return this.uniforms
  }

  /** Returns a stable live view; `direction` is intentionally not copied. */
  getState() {
    return this.state
  }

  reset() {
    this.direction[0] = 0
    this.direction[1] = 0
    this.direction[2] = 1
    this.displacement = 0
    this.velocity = 0
    this.ripplePhase = 0
    this.energy = 0
    this._syncOutput()
  }
}

export function createBubblePhysics(options) {
  return new BubblePhysics(options)
}

