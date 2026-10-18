// Film flow: the soap film is a thin liquid sheet, so a touch sets it moving
// instead of stamping a shape into it. A finger leaves short-lived momentum
// blobs (velocity that glides on, spreads and dies out in about a second);
// a press is a brief outflow that thins the film under the finger. A GPU pass
// advects a flow map (where each bit of film came from, plus a thickness
// factor) on the sphere every frame, the standard semi-Lagrangian method of
// real-time fluid solvers. The pattern therefore drifts, curls and settles
// like the rest of the film, at the same smoothness at every zoom.

export const MAX_BLOBS = 48
const TAU = 0.6 // s, film momentum decay (air drag and film viscosity)
const SOURCE_TAU = 0.18 // s, outflow after a press
const SPREAD = 1.2 // r^2 grows by SPREAD * r0^2 per second (viscous spreading)
const MAX_SPEED = 6 // local units per second

const finite = (x) => (Number.isFinite(x) ? x : 0)

function hash01(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function tangent(v, n) {
  const d = v[0] * n[0] + v[1] * n[1] + v[2] * n[2]
  return [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]]
}

// Strength of a blob over its life: momentum decays and spreads out.
export function blobFactor(age, tau) {
  return Math.exp(-age / tau) / (1 + SPREAD * age)
}

// Integral of blobFactor over the blob's life (displacement per unit speed).
function integral(tau) {
  let sum = 0
  for (let t = 0; t < tau * 12; t += 0.002) sum += blobFactor(t, tau) * 0.002
  return sum
}
export const IMPULSE_REACH = integral(TAU)
export const SOURCE_REACH = integral(SOURCE_TAU)

export function createFilmFlow() {
  const blobs = []
  let serial = 0

  function add(blob) {
    blobs.push(blob)
    if (blobs.length > MAX_BLOBS) {
      // Drop the weakest: it has almost no velocity left, so nothing jumps.
      let weakest = 0
      for (let i = 1; i < blobs.length; i += 1) {
        if (strength(blobs[i]) < strength(blobs[weakest])) weakest = i
      }
      blobs.splice(weakest, 1)
    }
    return blob
  }

  function strength(b) {
    return b.held ? 1 : blobFactor(b.age, b.kind === 0 ? TAU : SOURCE_TAU)
  }

  // Momentum left by a moving finger: `displacement` is how far (local units)
  // the film at the blob centre travels in total along `direction`.
  function impulse(center, direction, displacement, radius) {
    const c = normalize(center)
    const t = tangent(direction, c)
    const l = Math.hypot(t[0], t[1], t[2])
    if (l < 1e-9 || !(displacement > 0)) return null
    const speed = Math.min(MAX_SPEED, displacement / IMPULSE_REACH)
    return add({ kind: 0, c, u: t.map((x) => (x / l) * speed), r0: radius, age: 0, held: false })
  }

  // A finger on the film: a momentum patch that travels with the finger, so
  // the film under it is carried along the whole path (a wet fingertip drags
  // the film; only slowly does the film slip out from under it).
  function grab(center, radius) {
    return add({ kind: 0, c: normalize(center), u: [0, 0, 0], target: [0, 0, 0], r0: radius, age: 0, held: true, grab: true })
  }

  function drive(blob, center, velocity) {
    if (!blob || !blob.held) return
    blob.c = normalize(center)
    const t = tangent(velocity.map(finite), blob.c)
    const speed = Math.hypot(t[0], t[1], t[2])
    const k = speed > MAX_SPEED ? MAX_SPEED / speed : 1
    blob.target = t.map((x) => x * k)
    blob.sinceDrive = 0
  }

  // A press: outflow that pushes film out of a fingertip-sized patch. While
  // the finger stays, a weak seep keeps thinning it. Each press differs a
  // little (size, depth, a slight sideways lean).
  function press(center, radius, depth = 1) {
    serial += 1
    const c = normalize(center)
    const r = radius * (0.8 + 0.4 * hash01(serial))
    const rimShift = (0.12 + 0.08 * hash01(serial + 3)) * depth * r
    const lean = tangent([hash01(serial + 5) - 0.5, hash01(serial + 9) - 0.5, hash01(serial + 13) - 0.5], c)
    const source = add({ kind: 1, c, s: rimShift / (0.43 * SOURCE_REACH), r0: r, age: 0, held: true })
    impulse(c, lean, rimShift * 0.35, r * 1.3)
    return source
  }

  function release(blob) {
    if (blob && blob.held) {
      blob.held = false
      blob.age = 0 // a released grab glides on and dies out like any momentum
      if (blob.kind === 1) blob.s *= 0.35 // the remaining outflow fades once the finger lifts
    }
  }

  function update(dt) {
    const step = Math.min(Math.max(finite(dt), 0), 0.1)
    for (const b of blobs) {
      if (b.held && b.grab) {
        // Film under the finger follows it within ~30 ms; a finger that stops
        // (no new movement) stops the film too.
        const follow = 1 - Math.exp(-step / 0.03)
        b.u = tangent(b.u.map((x, i) => x + (b.target[i] - x) * follow), b.c)
        b.sinceDrive = (b.sinceDrive || 0) + step
        if (b.sinceDrive > 0.05) b.target = b.target.map((x) => x * Math.exp(-step / 0.04))
        continue
      }
      if (b.held) {
        // A resting finger keeps a weak seep going.
        b.s *= Math.exp(-step / 0.4)
        b.s = Math.max(b.s, 0)
        continue
      }
      b.age += step
      if (b.kind === 0) {
        // The moving patch glides along its own flow, staying on the sphere.
        const k = 0.5 * strength(b) * step
        b.c = normalize([b.c[0] + b.u[0] * k, b.c[1] + b.u[1] * k, b.c[2] + b.u[2] * k])
        const t = tangent(b.u, b.c)
        const speed = Math.hypot(...b.u)
        const l = Math.hypot(...t) || 1
        b.u = t.map((x) => (x / l) * speed)
      }
    }
    for (let i = blobs.length - 1; i >= 0; i -= 1) {
      if (!blobs[i].held && strength(blobs[i]) < 0.01) blobs.splice(i, 1)
    }
  }

  // Uniform packing: A = (centre, radius now), B = (velocity, outflow speed).
  function write(a, b) {
    for (let i = 0; i < MAX_BLOBS; i += 1) {
      const blob = blobs[i]
      if (!blob) {
        b[i].set(0, 0, 0, 0)
        continue
      }
      const f = strength(blob)
      const r = blob.r0 * Math.sqrt(1 + SPREAD * (blob.held ? 0 : blob.age))
      a[i].set(blob.c[0], blob.c[1], blob.c[2], r)
      if (blob.kind === 0) b[i].set(blob.u[0] * f, blob.u[1] * f, blob.u[2] * f, 0)
      else b[i].set(0, 0, 0, blob.s * f)
    }
    return blobs.length
  }

  function clear() {
    blobs.length = 0
  }

  return { blobs, impulse, grab, drive, press, release, update, write, clear, strength }
}
