// Builds the Bubble Zoom Lab as a self-contained static page at
// public/bubble-arge/ so it is served on berelax.space/bubble-arge/ without
// touching the main site's build. Run: node scripts/build-bubble-arge.mjs
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'public/bubble-arge')

rmSync(outDir, { recursive: true, force: true })
await build({
  root,
  configFile: false,
  base: '/bubble-arge/',
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    rolldownOptions: { input: resolve(root, 'bubble-zoom-lab.html') },
  },
})

const page = resolve(outDir, 'index.html')
renameSync(resolve(outDir, 'bubble-zoom-lab.html'), page)
writeFileSync(
  page,
  readFileSync(page, 'utf8')
    .replace('<title>Bubble Zoom Lab — Be Relax</title>', '<title>Bubble Ar-Ge — Be Relax</title>')
    .replace('<head>', '<head>\n    <meta name="robots" content="noindex, nofollow" />'),
)
console.log('bubble-arge ->', outDir)
