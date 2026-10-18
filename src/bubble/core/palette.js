import { filmReflectanceRgb } from './filmLut.js'

// Colour harmony from film physics. A film cannot be painted: its colour is
// its thickness (Newton's series). But films carrying micelles thin in steps
// (stratification) and settle into flat domains of a few thicknesses with
// sharp edges between them. Choosing those thicknesses chooses the palette:
// each bubble takes a colour scheme and finds the thicknesses whose interference hue fits it.

export const COLOUR_SCHEMES = [
  { name: 'benzer', angles: [-32, 0, 32] }, // analogous
  { name: 'zıt', angles: [0, 180] }, // complementary
  { name: 'bölünmüş zıt', angles: [0, 150, 210] }, // split complementary
  { name: 'üçlü', angles: [0, 120, 240] }, // triadic
  // One hue through every order it recurs in: higher orders show it paler,
  // so the film reads as tints and shades of a single colour. Some hues
  // recur rarely, so it accepts a wider band around its hue.
  { name: 'tek ton', angles: [0], tolerance: 26 }, // monochrome
]
export const MAX_LEVELS = 8

// Only clearly coloured film can carry a palette (see filmLut.js greyFromNm).
const MIN_NM = 140
const MAX_NM = 700
const MIN_CHROMA = 0.5
const HUE_TOLERANCE = 14 // degrees
const MIN_GAP_NM = 28

function hueOf([r, g, b]) {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d < 1e-9) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

// Hue and chroma of film at normal incidence, every 2 nm.
const TABLE = []
for (let nm = MIN_NM; nm <= MAX_NM; nm += 2) {
  const rgb = filmReflectanceRgb(nm, 1)
  const max = Math.max(...rgb)
  TABLE.push({ nm, hue: hueOf(rgb), chroma: (max - Math.min(...rgb)) / max })
}

const hueGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180)

// Palette thicknesses (nm, ascending) of a genome. The scheme's hues are
// fixed per bubble, and every hue recurs once per interference order, so the
// levels are fixed thicknesses over the whole coloured range: as the film
// thins it passes from domain to domain and the borders travel across it,
// but the palette itself never jumps.
export function paletteLevels(genome) {
  const scheme = COLOUR_SCHEMES[genome.colourScheme]
  const tolerance = scheme.tolerance || HUE_TOLERANCE
  const levels = []
  for (const angle of scheme.angles) {
    const target = (genome.hueShift + angle + 360) % 360
    // One level per run of matching film (one per order): its truest hue.
    let run = null
    for (const entry of TABLE) {
      const fits = entry.chroma >= MIN_CHROMA && hueGap(entry.hue, target) <= tolerance
      if (fits && (!run || hueGap(entry.hue, target) < hueGap(run.hue, target))) run = entry
      if (!fits && run) {
        levels.push(run.nm)
        run = null
      }
    }
    if (run) levels.push(run.nm)
  }
  levels.sort((a, b) => a - b)
  const kept = []
  for (const nm of levels) if (!kept.length || nm - kept[kept.length - 1] >= MIN_GAP_NM) kept.push(nm)
  return kept.slice(0, MAX_LEVELS)
}

// Writes the genome's palette into the bubble material (once per bubble).
export function applyPalette(uniforms, genome) {
  const levels = paletteLevels(genome)
  const target = uniforms.uLevels.value
  for (let i = 0; i < MAX_LEVELS; i += 1) target[i] = levels[i] || 0
  uniforms.uLevelCount.value = levels.length
  uniforms.uLevelSpan.value.set(MIN_NM, MAX_NM)
  uniforms.uPlateau.value = levels.length >= 2 ? genome.plateau : 0
}
