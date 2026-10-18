// The bubble as a physical body in air (SI units inside, scene units out).
//
// Weight comes from the film: the air inside is balanced by the air outside
// (Archimedes) except for its warmth and the tiny Laplace overpressure 4σ/R,
// so a thicker film is a heavier bubble. Inertia, though, is mostly air:
// the air inside plus the added mass of the air it must push aside (½ρV),
// which is why a bubble starts and stops so softly.
// Drag follows the Schiller–Naumann law (smooth from Stokes to Re ~ 1000).
// Its wake sheds vortices (Strouhal ≈ 0.2), swaying the path; the flow
// flattens it slightly (Taylor deformation, ε ≈ 9/64·We). Breath-warm air
// would lift a fresh bubble, but it cools within a second or two, before the
// bubble leaves the wand and settles; the body starts out cooled.
//
// The bubble must stay in view, so it hovers in a gentle column of rising
// warm air that just carries its birth weight (as bubbles hover over a warm
// current or a layer of heavier gas). A rising column draws air in from the
// sides (entrainment), which eases the bubble back toward its axis, so it
// wanders softly around one place instead of drifting off. Weight shows in
// how fast it settles back after a push, how fast it sways, how flat it gets
// and how much the air tosses it.

export const AIR_DENSITY = 1.204 // kg/m^3 at 20 °C
export const AIR_VISCOSITY = 1.81e-5 // Pa s
export const GRAVITY = 9.81
const AIR_PRESSURE = 101325
const AMBIENT_K = 293.15
const UPDRAFT_SCALE = 0.2 // m: how fast the carrying updraft fades with height
const INFLOW_RATE = 1.6 // 1/s: side inflow speed per metre off the column axis
const STROUHAL = 0.2
const LIFT_COEFFICIENT = 0.004 // side force of the shed vortices: barely a tremor
const SUBSTEP = 1 / 240

const finite = (x, fallback = 0) => (Number.isFinite(x) ? x : fallback)

// Smooth, non-repeating 1D gradient noise in [-1, 1]: room-air gusts.
export function drift(x, salt) {
  const i = Math.floor(x)
  const f = x - i
  const grad = (n) => {
    const s = Math.sin((n + salt * 57.3) * 12.9898) * 43758.5453
    return (s - Math.floor(s)) * 2 - 1
  }
  const u = f * f * (3 - 2 * f)
  return 2 * ((1 - u) * grad(i) * f + u * grad(i + 1) * (f - 1))
}

// Drag force magnitude on a sphere at relative speed v (Schiller–Naumann).
export function dragForce(v, radius) {
  const speed = Math.abs(v)
  if (speed < 1e-9) return 0
  const re = (AIR_DENSITY * speed * 2 * radius) / AIR_VISCOSITY
  const cd = (24 / re) * (1 + 0.15 * re ** 0.687)
  return 0.5 * AIR_DENSITY * cd * Math.PI * radius * radius * speed * speed
}

// Speed at which drag equals a force (bisection; drag rises monotonically).
export function speedForForce(force, radius) {
  if (!(force > 0)) return 0
  let lo = 0
  let hi = 50
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2
    if (dragForce(mid, radius) < force) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// Physical constants of one bubble from its genome.
export function bodyConstants(genome) {
  const radius = 0.025 * genome.radius // m: 1.75 to 3.25 cm
  const glycerin = genome.birth.glycerin
  return {
    radius,
    volume: (4 / 3) * Math.PI * radius ** 3,
    area: 4 * Math.PI * radius * radius,
    liquidDensity: 1000 + 130 * glycerin, // glycerin is denser than water
    surfaceTension: 0.035 - 0.012 * genome.birth.surfactant, // N/m
    warmK: 14 * genome.birth.thermal, // breath warmth at birth
    // Inner air cools through the thin film by convection: τ ≈ ρ c_p R / (3 h),
    // h ≈ 10 W/m²K, about a second or two (bigger bubbles cool slower).
    coolSeconds: (AIR_DENSITY * 1005 * radius) / (3 * 10),
  }
}

// Mass, weight and flow numbers at a given film thickness and inner warmth.
export function bodyState(constants, meanNm, warmK = 0) {
  const { radius, volume, area, liquidDensity, surfaceTension } = constants
  const filmMass = liquidDensity * area * Math.max(0, meanNm) * 1e-9
  const overpressure = (4 * surfaceTension) / radius // two surfaces
  const innerDensity = AIR_DENSITY * (1 + overpressure / AIR_PRESSURE) * (AMBIENT_K / (AMBIENT_K + warmK))
  const innerMass = innerDensity * volume
  const addedMass = 0.5 * AIR_DENSITY * volume
  const weight = (filmMass + innerMass - AIR_DENSITY * volume) * GRAVITY // net of buoyancy
  const terminal = speedForForce(Math.max(weight, 0), radius)
  const weber = (AIR_DENSITY * terminal * terminal * 2 * radius) / (2 * surfaceTension)
  return {
    filmMass,
    inertia: filmMass + innerMass + addedMass,
    weight,
    terminal,
    reynolds: (AIR_DENSITY * terminal * 2 * radius) / AIR_VISCOSITY,
    swayHz: (STROUHAL * terminal) / (2 * radius),
    squash: Math.min(0.06, (9 / 64) * weber),
  }
}

// Flattening at a relative air speed (Taylor: ε ≈ 9/64 We, We with 2σ).
export function squashAt(constants, speed) {
  const weber = (AIR_DENSITY * speed * speed * 2 * constants.radius) / (2 * constants.surfaceTension)
  return Math.min(0.06, (9 / 64) * weber)
}

// A live body: integrates position and velocity (m, m/s) in a world with
// gravity along -y. air(t) gives the gust velocity [x, y, z] in m/s.
export function createBody(genome, meanNm) {
  const constants = bodyConstants(genome)
  const birth = bodyState(constants, meanNm, 0)
  // The carrying updraft: at y = 0 it holds the bubble at its present weight,
  // so a thinning (lighter) film never sends it drifting up, at any speed of
  // the ageing clock.
  let updraft = birth.terminal
  const position = [0, 0, 0]
  const velocity = [0, 0, 0]
  const relative = [0, 0, 0]
  let age = 0
  let swayPhase = 0
  let current = birth
  let lastFilm = Number.isFinite(meanNm) ? meanNm : 500

  function step(dt, film, air) {
    age += dt
    current = bodyState(constants, film, 0)
    updraft = current.terminal
    // Capped so a bubble pushed far down is not shot back up.
    const lift = updraft * Math.min(3, Math.exp(-position[1] / UPDRAFT_SCALE))
    const wind = [finite(air[0]) - INFLOW_RATE * position[0], finite(air[1]) + lift, finite(air[2]) - INFLOW_RATE * position[2]]
    for (let i = 0; i < 3; i += 1) relative[i] = wind[i] - velocity[i]
    const speed = Math.hypot(relative[0], relative[1], relative[2])
    const drag = dragForce(speed, constants.radius)
    // Wake vortices push sideways at the shedding frequency, in a slowly
    // turning direction (bubbles trace gentle zigzags and spirals).
    swayPhase += 2 * Math.PI * ((STROUHAL * speed) / (2 * constants.radius)) * dt
    const side = 0.5 * AIR_DENSITY * Math.PI * constants.radius ** 2 * speed * speed * LIFT_COEFFICIENT * Math.sin(swayPhase)
    const turn = age * 0.21
    const force = [
      (speed > 0 ? (drag * relative[0]) / speed : 0) + side * Math.cos(turn),
      (speed > 0 ? (drag * relative[1]) / speed : 0) - current.weight,
      (speed > 0 ? (drag * relative[2]) / speed : 0) + side * Math.sin(turn),
    ]
    for (let i = 0; i < 3; i += 1) {
      velocity[i] += (force[i] / current.inertia) * dt
      position[i] += velocity[i] * dt
    }
  }

  return {
    constants,
    position,
    velocity,
    relative,
    get state() {
      return current
    },
    // Height where the column carries the bubble's present (cooled) weight.
    // As the film thins the bubble gets lighter and this rises slowly; the
    // view centres on it, so only the floating motion itself shows.
    get restHeight() {
      const cool = bodyState(constants, lastFilm, 0)
      const needed = speedForForce(Math.max(cool.weight, 1e-12), constants.radius)
      return -UPDRAFT_SCALE * Math.log(Math.max(needed, 1e-9) / Math.max(updraft, 1e-9))
    },
    // Advance by dt seconds at film thickness meanNm with gusts air(t).
    update(dt, film, air = () => [0, 0, 0]) {
      if (Number.isFinite(film) && film >= 0) lastFilm = film
      let left = Math.min(Math.max(finite(dt), 0), 0.1)
      while (left > 1e-9) {
        const h = Math.min(SUBSTEP, left)
        step(h, lastFilm, air(age))
        left -= h
      }
    },
    // A push: a velocity change in m/s (a finger moves the air around it).
    push(dv) {
      for (let i = 0; i < 3; i += 1) velocity[i] += finite(dv[i])
    },
  }
}

// Still room air: very slow, smooth gusts of a few mm/s (10-25 s), scaled by
// the genome's draft. Returns air velocity in m/s at body age (s).
export function roomAir(genome, age, salt = 0) {
  const gust = 0.003 * genome.floatAmount
  const a = age * genome.floatTempo + salt
  return [
    gust * (drift(a * 0.06, 1) + 0.25 * drift(a * 0.15, 2)),
    gust * 0.85 * (drift(a * 0.055, 3) + 0.25 * drift(a * 0.15, 4)),
    gust * 0.5 * drift(a * 0.05, 5),
  ]
}

// Soft limit for showing the body's offset (in bubble radii) on screen.
export function softLimit(vector, limit) {
  const length = Math.hypot(vector.x, vector.y, vector.z)
  if (length > 1e-9) vector.multiplyScalar((limit * Math.tanh(length / limit)) / length)
  return vector
}
