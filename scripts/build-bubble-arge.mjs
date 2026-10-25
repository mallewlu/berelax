// Builds the Bubble Zoom Lab as a self-contained static page at
// public/meetbubble/ so it is served on berelax.space/meetbubble/ without
// touching the main site's build. The old /bubble-arge/ address forwards
// there. Run: node scripts/build-bubble-arge.mjs
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'public/meetbubble')

rmSync(outDir, { recursive: true, force: true })
await build({
  root,
  configFile: false,
  base: '/meetbubble/',
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
    .replace('<title>Bubble Zoom Lab — Be Relax</title>', '<title>Meet Bubble — Be Relax</title>')
    .replace('<head>', '<head>\n    <meta name="robots" content="noindex, nofollow" />'),
)
// The first links went out as /bubble-arge/: forward them, query included.
const oldDir = resolve(root, 'public/bubble-arge')
rmSync(oldDir, { recursive: true, force: true })
mkdirSync(oldDir, { recursive: true })
writeFileSync(
  resolve(oldDir, 'index.html'),
  '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Meet Bubble — Be Relax</title>' +
    '<script>location.replace("/meetbubble/" + location.search + location.hash)</script>',
)
console.log('meetbubble ->', outDir)
