import './bubble.css'
import { createBubbleExperience } from './core/bubbleExperience.js'
import { layoutAround, refitOnChange } from './core/layout.js'

// Bubble Genesis: the product page. The bubble itself is the shared core
// (src/bubble/core); this page only keeps its own interface in step with it.
// (The previous engine, main.js / physics.js / shaders.js, is no longer used.)

const canvas = document.querySelector('#bubble-canvas')
const status = document.querySelector('#status')
const intro = document.querySelector('.intro')
// The page's text keeps clear of the bubble on every screen.
const ui = [document.querySelector('.brand'), intro, status]

let bubble = null
let stopRefit = () => {}
try {
  bubble = createBubbleExperience({
    canvas,
    layout: layoutAround(ui),
    onFirstTouch() {
      intro.classList.add('is-quiet')
    },
    onError() {
      status.textContent = 'GÖRSEL ORTAM YÜKLENEMEDİ'
    },
  })

  stopRefit = refitOnChange(bubble, ui)
} catch (error) {
  status.textContent = 'BU CİHAZDA GRAFİK AKIŞI DESTEKLENMİYOR'
  console.error(error)
}

function dispose() {
  stopRefit()
  bubble?.dispose()
}

window.addEventListener('pagehide', dispose, { once: true })
if (import.meta.hot) import.meta.hot.dispose(dispose)
