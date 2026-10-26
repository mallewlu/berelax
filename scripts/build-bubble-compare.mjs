// Builds the bubble comparison page (bubble-compare.html: today's bubble,
// no fine detail, detail drawn at birth; side by side on one clock) as a
// self-contained static page at public/bubble-karsilastir/, served on
// berelax.space/bubble-karsilastir/ without touching the main site's build.
// Run: node scripts/build-bubble-compare.mjs
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import process from 'node:process'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'public/bubble-karsilastir')

const commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
const dirty = execSync('git status --porcelain src', { cwd: root }).toString().trim() ? '+' : ''
process.env.VITE_BUILD_ID = `${commit}${dirty} ${new Date().toISOString().slice(0, 10)}`

rmSync(outDir, { recursive: true, force: true })
await build({
  root,
  configFile: false,
  base: '/bubble-karsilastir/',
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    rolldownOptions: { input: resolve(root, 'bubble-compare.html') },
  },
})

const page = resolve(outDir, 'index.html')
renameSync(resolve(outDir, 'bubble-compare.html'), page)
writeFileSync(page, readFileSync(page, 'utf8').replace('<head>', '<head>\n    <meta name="robots" content="noindex, nofollow" />'))
console.log('bubble-karsilastir ->', outDir)
