// Builds the bubble Ar-Ge tool pages as self-contained static pages under
// public/, served on berelax.space without touching the main site's build:
//  - bubble-compare.html -> /bubble-karsilastir/ (today's bubble, no fine
//    detail, detail drawn at birth; side by side on one clock)
//  - bubble-galeri.html  -> /bubble-galeri/ (40 fixed bubbles to mark)
//  - bubblefeed.html     -> /bubblefeed/ (endless blind vote, one at a time)
//  - bubble-kimlik.html  -> /bubble-kimlik/ (seed -> still images and a short loop)
//  - bubble-lab.html     -> /bubble-lab/ (the hub: every tool above; opened by
//    turning the logo once on the home page)
// Run: node scripts/build-bubble-compare.mjs
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import process from 'node:process'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const PAGES = [
  { html: 'bubble-compare.html', dir: 'bubble-karsilastir' },
  { html: 'bubble-galeri.html', dir: 'bubble-galeri' },
  { html: 'bubblefeed.html', dir: 'bubblefeed' },
  { html: 'bubble-kimlik.html', dir: 'bubble-kimlik' },
  { html: 'bubble-lab.html', dir: 'bubble-lab' },
]

const commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
const dirty = execSync('git status --porcelain src', { cwd: root }).toString().trim() ? '+' : ''
process.env.VITE_BUILD_ID = `${commit}${dirty} ${new Date().toISOString().slice(0, 10)}`

for (const { html, dir } of PAGES) {
  const outDir = resolve(root, 'public', dir)
  rmSync(outDir, { recursive: true, force: true })
  await build({
    root,
    configFile: false,
    base: `/${dir}/`,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      chunkSizeWarningLimit: 1000,
      rolldownOptions: { input: resolve(root, html) },
    },
  })
  const page = resolve(outDir, 'index.html')
  renameSync(resolve(outDir, html), page)
  writeFileSync(page, readFileSync(page, 'utf8').replace('<head>', '<head>\n    <meta name="robots" content="noindex, nofollow" />'))
  console.log(`${dir} ->`, outDir)
}
