// Find the weakest *region* of the live film, not a single noisy texel.
// The flow map is RGBA-interleaved and stores thickness in its first channel.
// Longitude wraps; the two pole rows are skipped because every longitude
// represents almost the same physical point there.
export function weakestFilmPoint(film, width, height, stride = 2) {
  if (!film || film.length < width * height * 4) throw new Error('Film map is incomplete')
  if (width < 4 || height < 4) throw new Error('Film map is too small')

  const thicknessAt = (x, y) => {
    const wrappedX = ((x % width) + width) % width
    const clampedY = Math.max(0, Math.min(height - 1, y))
    return film[(clampedY * width + wrappedX) * 4]
  }

  let bestX = 0
  let bestY = 1
  let bestNm = Infinity
  const step = Math.max(1, Math.floor(stride))
  for (let y = 1; y < height - 1; y += step) {
    // Neighbouring texels are closer together near the poles. Stretch the
    // horizontal kernel there so the score covers a comparable surface patch.
    const latitude = ((y + 0.5) / height - 0.5) * Math.PI
    const dx = Math.max(1, Math.round(1 / Math.max(0.2, Math.cos(latitude))))
    for (let x = 0; x < width; x += step) {
      const centre = thicknessAt(x, y)
      const localNm = (
        centre * 4 +
        thicknessAt(x - dx, y) + thicknessAt(x + dx, y) +
        thicknessAt(x, y - 1) + thicknessAt(x, y + 1)
      ) / 8
      if (Number.isFinite(localNm) && localNm < bestNm) {
        bestNm = localNm
        bestX = x
        bestY = y
      }
    }
  }

  const u = (bestX + 0.5) / width
  const v = (bestY + 0.5) / height
  const longitude = (u - 0.5) * Math.PI * 2
  const latitude = (v - 0.5) * Math.PI
  const cosLatitude = Math.cos(latitude)
  return {
    direction: [cosLatitude * Math.sin(longitude), Math.sin(latitude), cosLatitude * Math.cos(longitude)],
    thicknessNm: bestNm,
    texel: [bestX, bestY],
  }
}

// Taylor-Culick: rim speed is proportional to 1 / sqrt(film thickness), so
// the time needed to clear a spherical film scales as radius * sqrt(thickness).
// 70 ms at the reference bubble: a real soap film clears in a few ms; 70 ms
// keeps the tear visible for a handful of frames. (Not yet approved by Lu.)
export function ruptureDurationSeconds(radius, meanNm) {
  const r = Number.isFinite(radius) ? radius : 1
  const h = Number.isFinite(meanNm) ? meanNm : 400
  return Math.max(0.045, Math.min(0.13, 0.07 * r * Math.sqrt(Math.max(20, h) / 400)))
}
