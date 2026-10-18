// Lasting vortices on the film, as seen on heated soap bubbles (Kellay et al.,
// PRL 2008): Gaussian vortices that wander slowly, trace small loops
// (trochoidal motion) and swell and fade in strength. A twin pair orbits its
// common centre in the sense it spins. Positions are a pure function of time,
// so every device shows the same vortex at the same moment.

export const MAX_VORTICES = 2

function fromLatLon(lat, lon) {
  const c = Math.cos(lat)
  return [c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon)]
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

// Rotate v about unit axis k by angle (Rodrigues).
function rotate(v, k, angle) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const kv = cross(k, v)
  const d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c)
  return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * d)
}

// [{ c: unit centre, r: radius, spin: rad/s }] for a genome at time t (s).
export function vortexState(genome, time) {
  const count = Math.min(MAX_VORTICES, genome.vortices | 0)
  if (!count) return []
  const t = Number.isFinite(time) ? time : 0
  // Slow wandering of the (pair) centre plus a small trochoidal loop.
  const lat = Math.asin(Math.max(-0.9, Math.min(0.9, genome.vortexLatitude))) + 0.12 * Math.sin(t * 0.07 + 1.3)
  const lon = genome.vortexLongitude + 0.35 * Math.sin(t * 0.045) + 0.004 * t * Math.sign(genome.vortexSpin)
  let centre = fromLatLon(lat, lon)
  const east = normalize(cross([0, 1, 0], centre))
  const north = cross(centre, east)
  const loop = 0.035
  const phase = t * 0.8 * Math.sign(genome.vortexSpin)
  centre = normalize(centre.map((x, i) => x + loop * (Math.cos(phase) * east[i] + Math.sin(phase) * north[i])))
  // Intensity swells and fades (intensification phases).
  const spin = genome.vortexSpin * (0.8 + 0.25 * Math.sin(t * 0.09 + genome.vortexLongitude))
  if (count === 1) return [{ c: centre, r: genome.vortexRadius, spin }]
  // Twin: two co-rotating vortices orbiting their common centre.
  const r = genome.vortexRadius * 0.8
  const offset = east.map((x) => x * r * 1.1)
  const angle = t * 0.15 * Math.sign(genome.vortexSpin)
  const a = rotate(offset, centre, angle)
  return [
    { c: normalize(centre.map((x, i) => x + a[i])), r, spin },
    { c: normalize(centre.map((x, i) => x - a[i])), r, spin },
  ]
}
