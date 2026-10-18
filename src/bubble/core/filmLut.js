import * as THREE from 'three'

// Thin-film reflectance table: thickness (0..MAX nm) x cos(incidence) -> RGB.
// Same physics as the shader used to evaluate per pixel (two-interface Airy
// reflectance, unpolarised Fresnel, 16 spectral samples), baked once at load
// so phones read one texel instead of looping over wavelengths.

export const FILM_LUT_MAX_NM = 2400
const WIDTH = 768 // ~3 nm per texel: high orders still resolved
const HEIGHT = 48
export const FILM_IOR = 1.333
const SAMPLES = 16

// Optical calibration for a two-sided soap-film shell. The far surface is
// visible through the near film, but loses contrast around the centre where
// broad environment reflections otherwise read as an opaque glass sphere.
// It becomes stronger toward grazing angles, preserving the characteristic
// bright rim. Keep these values shared with shader.js and the optics tests.
export const FILM_OPTICAL_CALIBRATION = Object.freeze({
  environmentIntensity: 1.8,
  environmentFloor: 0.03,
  environmentRimFloor: 0.18,
  backSurfaceCentre: 0.55,
  backSurfaceRim: 0.84,
  // Colourful film keeps the earlier vivid look (environment 1.0, ground
  // fill 0.16, full back surface, premultiplied light). Only near-grey film
  // (white higher orders, silver first order) takes the transparent look
  // above. Chroma = (max - min) / max of the film reflectance.
  vividEnvironmentIntensity: 1.0,
  vividFloor: 0.16,
  greyChroma: 0.4,
  colourChroma: 0.7,
})

function lobe(x, centre, width) {
  const t = (x - centre) / width
  return Math.exp(-t * t)
}

function weight(l) {
  return [lobe(l, 600, 42) + 0.32 * lobe(l, 445, 22), lobe(l, 550, 44), lobe(l, 455, 30)]
}

const WAVELENGTHS = Array.from({ length: SAMPLES }, (_, i) => 400 + (i * 300) / (SAMPLES - 1))
const WEIGHTS = WAVELENGTHS.map(weight)
const TOTAL = WEIGHTS.reduce((sum, w) => [sum[0] + w[0], sum[1] + w[1], sum[2] + w[2]], [0, 0, 0])

// Airy reflectance of one soap film (air → liquid → air), integrated into
// linear RGB. Kept pure and exported so the LUT and its physical invariants
// are tested from the same implementation.
export function filmReflectanceRgb(thicknessNm, cosIncidence) {
  const thickness = Math.max(0, Number(thicknessNm) || 0)
  const cosI = Math.max(1e-4, Math.min(1, Number(cosIncidence) || 0))
  const sinT2 = (1 - cosI * cosI) / (FILM_IOR * FILM_IOR)
  const cosT = Math.sqrt(Math.max(0, 1 - sinT2))
  const rs = (cosI - FILM_IOR * cosT) / (cosI + FILM_IOR * cosT)
  const rp = (FILM_IOR * cosI - cosT) / (FILM_IOR * cosI + cosT)
  const interfaceR = Math.min(0.98, Math.max(0.02, 0.5 * (rs * rs + rp * rp)))
  const airy = (4 * interfaceR) / ((1 - interfaceR) * (1 - interfaceR))
  const rgb = [0, 0, 0]
  for (let i = 0; i < SAMPLES; i += 1) {
    const phase = Math.sin((2 * Math.PI * FILM_IOR * thickness * cosT) / WAVELENGTHS[i]) ** 2
    const reflectance = (airy * phase) / (1 + airy * phase)
    rgb[0] += WEIGHTS[i][0] * reflectance
    rgb[1] += WEIGHTS[i][1] * reflectance
    rgb[2] += WEIGHTS[i][2] * reflectance
  }
  return [rgb[0] / TOTAL[0], rgb[1] / TOTAL[1], rgb[2] / TOTAL[2]]
}

export function backSurfaceVisibility(cosIncidence) {
  const cosI = Math.max(0, Math.min(1, Number(cosIncidence) || 0))
  const grazing = 1 - cosI
  return (
    FILM_OPTICAL_CALIBRATION.backSurfaceCentre +
    (FILM_OPTICAL_CALIBRATION.backSurfaceRim - FILM_OPTICAL_CALIBRATION.backSurfaceCentre) * grazing * grazing
  )
}

// Premultiplied "over" composition used by the double-sided transparent
// material: far-film reflectance is attenuated by the near film.
export function twoSurfaceReflectanceRgb(thicknessNm, cosIncidence) {
  const front = filmReflectanceRgb(thicknessNm, cosIncidence)
  const backVisibility = backSurfaceVisibility(cosIncidence)
  return front.map((channel) => {
    const back = channel * backVisibility
    return channel + back * (1 - channel)
  })
}

export function createFilmLut() {
  const data = new Uint16Array(WIDTH * HEIGHT * 4)

  for (let y = 0; y < HEIGHT; y += 1) {
    const cosI = y / (HEIGHT - 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const thickness = (x / (WIDTH - 1)) * FILM_LUT_MAX_NM
      const rgb = filmReflectanceRgb(thickness, cosI)
      const o = (y * WIDTH + x) * 4
      data[o] = THREE.DataUtils.toHalfFloat(rgb[0])
      data[o + 1] = THREE.DataUtils.toHalfFloat(rgb[1])
      data[o + 2] = THREE.DataUtils.toHalfFloat(rgb[2])
      data[o + 3] = THREE.DataUtils.toHalfFloat(1)
    }
  }

  const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.HalfFloatType)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
