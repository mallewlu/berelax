// Puts a genome's look into a bubble material and its film simulation, so
// the lab and the variety page draw a given seed identically.

export function applyGenomeLook(uniforms, genome) {
  uniforms.uSeed.value = genome.patternSeed
  uniforms.uDetail.value = genome.detail
  uniforms.uBreath.value = genome.breathing
  uniforms.uGrain.value = genome.grain
  uniforms.uOctaveDecay.value = genome.octaveDecay
  uniforms.uCrisp.value = genome.crispness
  uniforms.uFibre.value.set(Math.cos(genome.fibreAngle), 0.35, Math.sin(genome.fibreAngle)).normalize()
  uniforms.uBlack.value.set(genome.blackOnsetNm, genome.spotScale, genome.spotEdge, genome.spotDensity)
  uniforms.uEarlyBlack.value = genome.earlyBlack ? 1 : 0
}

// The genome's local "up": air currents tilt the drainage axis a little.
export function tiltedUp(genome, target) {
  const { tilt, tiltAzimuth } = genome
  return target.set(Math.sin(tilt) * Math.cos(tiltAzimuth), Math.cos(tilt), Math.sin(tilt) * Math.sin(tiltAzimuth)).normalize()
}

// A fresh film for the genome at its current thickness.
export function startFilm(flowMap, genome, thickness, up) {
  flowMap.uniforms.uGravity.value.copy(up)
  flowMap.reset(genome, thickness)
}
