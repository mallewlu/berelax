// Bubble genome: the conditions a bubble was born in. A real bubble's look and
// behaviour follow from its soap mix, the air it floats in and how it was
// blown. Each bubble draws nine hidden birth conditions from its seed and
// derives ~30 visible traits from them through simple physical relations,
// each with its own small independent variation. Correlations stay physical
// (glycerin: thicker, slower, longer-lived), so every combination is a
// believable bubble. Rare traits emerge from the tails of the conditions
// (a strong temperature difference raises a lasting vortex), never from
// "more colours". Same seed, same bubble, on every device.

// 64-bit seeds (16 hex chars) keep collisions negligible for billions of
// bubbles; any string works as a seed.
export function newSeed() {
  const words = crypto.getRandomValues(new Uint32Array(2))
  return Array.from(words, (w) => w.toString(16).padStart(8, '0')).join('')
}

// cyrb128 hash + sfc32 generator (public domain, widely used for seeded PRNG).
function cyrb128(text) {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < text.length; i += 1) {
    const k = text.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
}

function sfc32([a0, b0, c0, d0]) {
  let a = a0
  let b = b0
  let c = c0
  let d = d0
  return () => {
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) | 0
    t = (t + d) | 0
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const lerp = (a, b, t) => a + (b - a) * t
const logLerp = (a, b, t) => a * (b / a) ** t // even steps to the eye for sizes and speeds

// Every trait is a gene with 7, 11 or 13 values (prime counts, so traits do
// not fall into step with each other). A bubble is a short string of gene
// values: cheap to store, compare and check for twins, identical on every
// device. Strong visible traits get 13 values, quieter ones 11, subtle 7.
export const GENE_LEVELS = {
  // birth conditions (hidden causes)
  surfactant: 13, glycerin: 13, humidity: 13, draft: 13, thermal: 13, size: 13, blowSpeed: 13, unevenness: 13,
  // thickness and age
  birthNm: 13, lifeSeconds: 13, spread: 13, profile: 11, bandStrength: 13, bandCount: 11, bandWaviness: 11,
  tilt: 7, tiltAzimuth: 7,
  // flow
  flowSpeed: 13, laminar: 13, plumes: 13, plumeColumns: 7, swirlScale: 13, scaleRatio: 11, warp: 13,
  swirlFraction: 13, swirlSense: 7,
  // fine texture
  detail: 13, grain: 11, fibreAngle: 13, crispness: 11, octaveDecay: 7, breathing: 7,
  // black film
  blackOnsetNm: 11, spotScale: 7, spotEdge: 7, spotDensity: 7,
  // motion and touch
  radius: 13, damping: 7, healSeconds: 7, grip: 7, dent: 7, floatAmount: 11, floatTempo: 11,
  // own-axis turn: speed, axis tilt and direction, axis heading
  spinRate: 11, spinTilt: 7, spinHand: 7, spinHeading: 7,
  // rare behaviours
  vortexRadius: 7, vortexSpin: 7, vortexLatitude: 11, vortexLongitude: 7, pairing: 7,
  // order (calm stratified bands) <-> disorder (marbled turbulence); attached baby bubble
  order: 13, bud: 7,
}

// Rare traits: what makes a bubble special (never the number of colours).
export const RARE_TRAITS = {
  eye: 'göz (kalıcı girdap)',
  twinEyes: 'ikiz girdap',
  perfectBands: 'kusursuz bantlar',
  earlyBlack: 'erken siyah zar',
  ghost: 'hayalet',
  plumeStorm: 'tüy fırtınası',
  giant: 'dev',
  tiny: 'minik',
  baby: 'yavru baloncuk',
}

export function createGenome(seed) {
  const id = String(seed ?? '')
  const rand = sfc32(cyrb128(id))
  for (let i = 0; i < 12; i += 1) rand() // warm up
  const bell = () => (rand() + rand() + rand()) / 3 // most bubbles are ordinary
  // A trait follows its physical cause by `weight` and varies on its own by
  // the rest: physically consistent, yet rarely the same twice.
  const blend = (cause, weight = 0.55) => clamp(weight * clamp(cause, 0, 1) + (1 - weight) * rand(), 0, 1)
  const genes = {}
  // Snap a 0..1 value to its gene value; returns the snapped 0..1 position.
  const snap = (name, unit) => {
    const steps = GENE_LEVELS[name] - 1
    genes[name] = Math.round(clamp(unit, 0, 1) * steps)
    return genes[name] / steps
  }
  // Derived traits: blended causes crowd the middle, so open the tails up
  // with a smooth monotone stretch (no gap at the centre); extremes stay
  // rarer but every value can occur.
  const gene = (name, unit) => {
    const centred = 2 * clamp(unit, 0, 1) - 1
    return snap(name, 0.5 + 0.5 * centred * (1.4 - 0.4 * centred * centred))
  }
  const patternSeed = Math.floor(rand() * 4294967296) >>> 0

  // ---- Birth conditions (hidden) ----
  const birth = {
    surfactant: snap('surfactant', bell()),
    glycerin: snap('glycerin', rand() ** 1.6), // most mixes carry little glycerin
    humidity: snap('humidity', bell()),
    draft: snap('draft', rand() ** 1.3),
    thermal: snap('thermal', rand() ** 2.2), // strong warm-cold differences are rare
    size: snap('size', bell()),
    blowSpeed: snap('blowSpeed', bell()),
    unevenness: snap('unevenness', rand()),
  }
  const { surfactant, glycerin, humidity, draft, thermal, size, blowSpeed, unevenness } = birth
  // Order: still, stratified air gives calm banded films; drafts and warm-cold
  // differences give marbled turbulence. One gene drives the whole spectrum
  // (bands, sideways flow, swirls, fine detail), so it reads at a glance.
  const order = gene('order', blend(1.085 - draft - 0.5 * thermal, 0.45))

  // ---- Film thickness and ageing ----
  // Most bubbles are born in the vivid range (~450-900 nm); nearly colourless
  // thick newborns (up to 2000 nm) are the minority.
  const birthNm = logLerp(
    380,
    2000,
    gene('birthNm', blend(0.45 * glycerin + 0.35 * (1 - blowSpeed) + 0.2 * (1 - size), 0.3)) ** 1.6,
  )
  // Drainage time scale of the film (see thicknessAt).
  const lifeSeconds = logLerp(10, 400, gene('lifeSeconds', blend(0.4 * humidity + 0.4 * glycerin + 0.2 * (1 - draft), 0.35)))
  const spread = lerp(0.12, 0.95, gene('spread', blend(0.65 * unevenness + 0.35 * draft)))
  const profile = logLerp(0.4, 2.6, gene('profile', blend(1 - glycerin, 0.3)))
  const bandStrength = gene('bandStrength', blend(0.75 * order + 0.25 * surfactant, 0.8))
  const bandCount = 2 + snap('bandCount', rand()) * 10
  const bandWaviness = gene('bandWaviness', blend(0.6 * draft + 0.4 * unevenness, 0.4))
  const tilt = lerp(0, 0.2, gene('tilt', blend(draft, 0.6)))
  const tiltAzimuth = snap('tiltAzimuth', rand()) * Math.PI * 2 * (6 / 7)

  // ---- Flow ----
  const flowSpeed = logLerp(0.012, 0.16, gene('flowSpeed', blend(0.6 * (1 - order) + 0.25 * thermal + 0.15 * humidity - 0.2 * glycerin + 0.1, 0.6)))
  const laminar = gene('laminar', blend(0.85 * order + 0.15 * bandStrength, 0.8))
  const plumes = gene('plumes', blend((humidity - 0.3) * 1.6, 0.5))
  const plumeColumns = 5 + snap('plumeColumns', rand()) * 6
  const swirlScale = logLerp(0.7, 4.5, gene('swirlScale', blend(draft, 0.45)))
  const scaleRatio = lerp(1.5, 3.2, snap('scaleRatio', rand()))
  const warp = lerp(0.05, 1.0, gene('warp', blend(0.8 * (1 - order) + 0.2 * unevenness, 0.75)))
  const swirlFraction = lerp(0.03, 0.6, gene('swirlFraction', blend(0.6 * (1 - order) + 0.4 * unevenness, 0.7)))
  const swirlSense = lerp(-1, 1, snap('swirlSense', rand()))

  // ---- Fine texture ----
  const detail = lerp(0.08, 1.4, gene('detail', blend(0.55 * (1 - order) + 0.35 * unevenness - 0.25 * glycerin + 0.15, 0.65)))
  const grain = logLerp(8, 26, snap('grain', rand())) // base frequency of the fine texture
  const fibreAngle = snap('fibreAngle', rand()) * Math.PI * (12 / 13) // preferred filament direction
  const crispness = lerp(0.06, 0.36, snap('crispness', rand())) // lower: sharper filament edges
  const octaveDecay = lerp(0.78, 0.96, snap('octaveDecay', rand()))
  const breathing = lerp(0.002, 0.009, gene('breathing', blend(1 - glycerin, 0.5)))

  // ---- Black film ----
  const blackOnsetNm = lerp(45, 200, gene('blackOnsetNm', blend(surfactant, 0.45)))
  const spotScale = logLerp(20, 90, snap('spotScale', rand()))
  const spotEdge = lerp(0.04, 0.28, snap('spotEdge', rand()))
  const spotDensity = lerp(0.25, 1, gene('spotDensity', blend(surfactant, 0.5)))

  // ---- Motion and touch ----
  const radius = lerp(0.7, 1.3, gene('radius', blend(size, 0.6)))
  const damping = lerp(0.8, 1.5, gene('damping', blend(glycerin, 0.7)))
  const healSeconds = lerp(1.5, 8, gene('healSeconds', blend(glycerin, 0.7)))
  const grip = lerp(0.7, 0.95, gene('grip', blend(glycerin, 0.6)))
  const dent = lerp(0.7, 1.25, gene('dent', blend(1 - 0.6 * surfactant - 0.4 * glycerin, 0.6)))
  const floatAmount = lerp(0.3, 1.9, gene('floatAmount', blend(draft)))
  const floatTempo = lerp(0.55, 1.6, gene('floatTempo', blend(draft)))
  // Turning about its own axis (air shear sets bubbles slowly turning): one
  // turn in 30 s to 6 min, the axis tilted 0-70 degrees from upright and
  // pointing its own way. spinHand: 3 is a bubble that barely turns; below
  // it turns one way, above the other, the farther from 3 the more its axis
  // wobbles (precession).
  const spinPeriod = logLerp(360, 30, gene('spinRate', blend(draft, 0.4)))
  const spinTilt = lerp(0, 1.22, snap('spinTilt', rand()))
  const hand = snap('spinHand', rand()) * 6 - 3
  const spinHeading = snap('spinHeading', rand()) * Math.PI * 2 * (6 / 7)
  const spinRate = hand === 0 ? (Math.PI * 2) / spinPeriod * 0.12 : Math.sign(hand) * ((Math.PI * 2) / spinPeriod)
  const spinWobble = (Math.max(1, Math.abs(hand)) - 1) * 0.15
  const spinAxis = [
    Math.sin(spinTilt) * Math.cos(spinHeading),
    Math.cos(spinTilt),
    Math.sin(spinTilt) * Math.sin(spinHeading),
  ]

  // ---- Rare behaviours ----
  // Lasting vortices (Kellay et al.: Gaussian vortices on heated bubbles)
  // appear only with the strongest temperature difference.
  const pairing = snap('pairing', rand())
  const vortices = birth.thermal === 1 ? (pairing === 1 ? 2 : 1) : 0
  const vortexRadius = lerp(0.16, 0.34, snap('vortexRadius', rand()))
  const vortexSpin = lerp(1.4, 3.2, snap('vortexSpin', rand())) * (swirlSense < 0 ? -1 : 1)
  const vortexLatitude = lerp(-0.4, 0.5, snap('vortexLatitude', rand()))
  const vortexLongitude = snap('vortexLongitude', rand()) * Math.PI * 2 * (6 / 7)

  // A baby bubble stuck to the surface (a double bubble): extremely rare,
  // about 1 in 1250. Its size and place come from the genes.
  const budDraw = rand()
  const budVariant = rand()
  genes.bud = budDraw < 0.0008 ? 1 + Math.floor(budVariant * 6) : 0
  const budRadius = genes.bud ? 0.07 + 0.025 * (genes.bud - 1) : 0
  const budLatitude = lerp(-0.2, 0.75, genes.vortexLatitude / 10)
  const budLongitude = fibreAngle * 2 + 0.7

  const rare = []
  if (genes.bud) rare.push('baby')
  if (vortices === 1) rare.push('eye')
  if (vortices === 2) rare.push('twinEyes')
  if (genes.bandStrength >= 11 && genes.flowSpeed <= 1 && vortices === 0) rare.push('perfectBands')
  if (genes.surfactant >= 11) rare.push('earlyBlack')
  if (genes.glycerin === 12 && genes.birthNm >= 9) rare.push('ghost')
  if (genes.plumes >= 11 && genes.humidity >= 10) rare.push('plumeStorm')
  if (genes.size >= 11) rare.push('giant')
  if (genes.size <= 1) rare.push('tiny')
  const earlyBlack = rare.includes('earlyBlack')

  return {
    seed: id,
    patternSeed,
    // The bubble as a compact gene string (one base-36 digit per gene).
    code: Object.keys(GENE_LEVELS).map((name) => genes[name].toString(36)).join(''),
    genes,
    birth,
    birthNm,
    lifeSeconds,
    spread,
    profile,
    bandStrength,
    bandCount,
    bandWaviness,
    tilt,
    tiltAzimuth,
    flowSpeed,
    laminar,
    plumes,
    plumeColumns,
    vortices,
    swirlScale,
    scaleRatio,
    warp,
    swirlFraction,
    swirlSense,
    detail,
    grain,
    fibreAngle,
    crispness,
    octaveDecay,
    breathing,
    blackOnsetNm,
    earlyBlack,
    spotScale,
    spotEdge,
    spotDensity,
    radius,
    damping,
    healSeconds,
    grip,
    dent,
    floatAmount,
    floatTempo,
    spinRate,
    spinPeriod,
    spinTilt,
    spinAxis,
    spinWobble,
    vortexRadius,
    vortexSpin,
    vortexLatitude,
    vortexLongitude,
    order,
    budRadius,
    budLatitude,
    budLongitude,
    rare,
  }
}

// Film thinning (Reynolds drainage law: h ~ t^-1/2): fast at first, then slow.
export function thicknessAt(genome, seconds) {
  const t = Math.max(0, Number(seconds) || 0)
  return shapeFromMean(genome, Math.max(6, genome.birthNm / Math.sqrt(1 + t / genome.lifeSeconds)))
}

function shapeFromMean(genome, mean) {
  const progress = 1 - mean / genome.birthNm
  // Drainage thins the top first: the spread widens as the bubble ages.
  const k = Math.min(0.95, genome.spread * (1 + 0.4 * progress))
  return { meanNm: mean, topNm: Math.max(4, mean * (1 - k)), bottomNm: mean * (1 + k), progress }
}

// Thirteen age stages along Newton's sequence of interference colours
// (approximate mean film thickness, nm): from a nearly colourless newborn
// film to the black film of a bubble's last moments.
export const AGE_STAGES = [
  [1400, 'ilk nefes'],
  [1100, 'süt pastel'],
  [850, 'pastel'],
  [650, 'açılan renk'],
  [500, 'canlı'],
  [400, 'derin canlı'],
  [320, 'mavi-yeşil'],
  [250, 'mor-mavi'],
  [190, 'altın-turuncu'],
  [140, 'saman'],
  [90, 'gümüş'],
  [40, 'gri'],
  [0, 'siyah zar'],
]

export function ageStage(meanNm) {
  const index = AGE_STAGES.findIndex(([floor]) => meanNm > floor)
  return AGE_STAGES[index === -1 ? AGE_STAGES.length - 1 : index][1]
}

// ---- The ageing clock ----
// A bubble matures in real time for its first minutes (the birth moment: its
// colours open up). Once owned, the rest of its life is spread over years in
// equal small steps (log-linear thinning, ~0.2% a day), so it keeps the stage
// it was owned at for a long time. Thickness follows from elapsed time alone:
// every device shows the same bubble at the same moment, no long simulation.
export const OWNED_LIFE_YEARS = 4 // proposal; the product decision is open
const LAST_STAGE_NM = 30 // into the black-film stage
const YEAR_SECONDS = 365.25 * 24 * 3600

// `ownedAtSeconds`: seconds after birth when it was owned (null: never).
export function thicknessOnClock(genome, realSeconds, ownedAtSeconds = null) {
  const real = Math.max(0, Number(realSeconds) || 0)
  if (ownedAtSeconds === null || ownedAtSeconds === undefined || real <= ownedAtSeconds) {
    return thicknessAt(genome, real)
  }
  const atOwning = thicknessAt(genome, ownedAtSeconds).meanNm
  const end = Math.min(LAST_STAGE_NM, atOwning)
  const share = Math.min(1, (real - ownedAtSeconds) / (OWNED_LIFE_YEARS * YEAR_SECONDS))
  return shapeFromMean(genome, atOwning * (end / atOwning) ** share)
}

// Age at which the film reaches a given mean thickness (inverse of thicknessAt).
export function ageForThickness(genome, meanNm) {
  const ratio = genome.birthNm / Math.max(6, meanNm)
  return ratio <= 1 ? 0 : genome.lifeSeconds * (ratio * ratio - 1)
}
