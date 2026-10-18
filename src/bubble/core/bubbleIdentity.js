// Stable, versioned identity for a Bubble. The seed is only one part of the
// contract: once a Bubble can be owned, later genome or renderer changes must
// not silently turn it into a different individual.

export const BUBBLE_STATE_VERSION = 1
export const GENOME_VERSION = 1
export const RENDER_VERSION = 1

const finiteTime = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

export function createBubbleIdentity({ seed, birthAtMs = Date.now(), ownedAtMs = null } = {}) {
  if (typeof seed !== 'string' || !seed.length) throw new TypeError('Bubble identity requires a seed')
  const birth = finiteTime(birthAtMs, Date.now())
  const owned = ownedAtMs === null ? null : Math.max(birth, finiteTime(ownedAtMs, birth))
  return Object.freeze({
    stateVersion: BUBBLE_STATE_VERSION,
    genomeVersion: GENOME_VERSION,
    renderVersion: RENDER_VERSION,
    seed,
    birthAtMs: birth,
    ownedAtMs: owned,
  })
}

export function bubbleClock(identity, nowMs = Date.now()) {
  const now = Math.max(identity.birthAtMs, finiteTime(nowMs, identity.birthAtMs))
  return {
    ageSeconds: (now - identity.birthAtMs) / 1000,
    ownedAtSeconds: identity.ownedAtMs === null ? null : (identity.ownedAtMs - identity.birthAtMs) / 1000,
  }
}

export function serializeBubbleIdentity(identity) {
  return JSON.stringify(createBubbleIdentity(identity))
}

export function parseBubbleIdentity(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || parsed.stateVersion !== BUBBLE_STATE_VERSION) return null
    if (parsed.genomeVersion !== GENOME_VERSION || parsed.renderVersion !== RENDER_VERSION) return null
    return createBubbleIdentity(parsed)
  } catch {
    return null
  }
}

export function ownBubble(identity, ownedAtMs = Date.now()) {
  if (identity.ownedAtMs !== null) return identity
  return createBubbleIdentity({ ...identity, ownedAtMs })
}
