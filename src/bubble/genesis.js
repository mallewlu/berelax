import './bubble.css'
import { createBubbleExperience } from './core/bubbleExperience.js'
import { newSeed } from './core/genome.js'
import { layoutAround, refitOnChange } from './core/layout.js'

// Bubble Genesis: the product page. The bubble itself is the shared core
// (src/bubble/core); this page only keeps its own interface in step with it.
// (Of the previous engine only physics.js is left, kept for its test.)

const canvas = document.querySelector('#bubble-canvas')
const status = document.querySelector('#status')
const intro = document.querySelector('.intro')
const newBubble = document.querySelector('#new-bubble')
// The page's text keeps clear of the bubble on every screen.
const ui = [document.querySelector('.brand'), newBubble, intro, status]

let bubble = null
let stopRefit = () => {}
// An error replaces the button: without a bubble it does nothing, and on
// phones the message sits in the same corner.
function showError(message) {
  status.textContent = message
  newBubble.hidden = true
}
try {
  bubble = createBubbleExperience({
    canvas,
    layout: layoutAround(ui),
    onFirstTouch() {
      intro.classList.add('is-quiet')
    },
    onError() {
      showError('GÖRSEL ORTAM YÜKLENEMEDİ')
    },
  })

  stopRefit = refitOnChange(bubble, ui)
  newBubble.addEventListener('click', () => bubble.birth(newSeed()))
} catch (error) {
  showError('BU CİHAZDA GRAFİK AKIŞI DESTEKLENMİYOR')
  console.error(error)
}

function dispose() {
  stopRefit()
  bubble?.dispose()
}

window.addEventListener('pagehide', dispose, { once: true })
if (import.meta.hot) import.meta.hot.dispose(dispose)
