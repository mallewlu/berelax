// Keeps a page's own interface (text, buttons, HUD) off the bubble. Elements
// that would overlap the bubble at its default size and place push it aside:
// for each, the side (above/below or left/right) that shrinks it least.
// Elements already clear of the bubble change nothing.

const GAP = 12 // px between the interface and the bubble's space

function intersectsCircle(rect, cx, cy, r) {
  const x = Math.max(rect.left, Math.min(cx, rect.right))
  const y = Math.max(rect.top, Math.min(cy, rect.bottom))
  return (x - cx) ** 2 + (y - cy) ** 2 < r * r
}

// Pure: rects ({ left, top, right, bottom } in px) -> insets.
export function insetsAvoiding(rects, width, height, fill = 0.78) {
  const inset = { top: 0, right: 0, bottom: 0, left: 0 }
  const freeOf = (i) => Math.min(width - i.left - i.right, height - i.top - i.bottom)
  // Moving the bubble away from one element can bring it onto another, so
  // repeat until nothing overlaps (a few passes at most).
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false
    for (const rect of rects) {
      if (!(rect.right > rect.left && rect.bottom > rect.top)) continue
      // The bubble as it would be drawn with the insets found so far.
      const w = width - inset.left - inset.right
      const h = height - inset.top - inset.bottom
      const cx = inset.left + w / 2
      const cy = inset.top + h / 2
      const r = (fill * Math.min(w, h)) / 2 + GAP
      if (!intersectsCircle(rect, cx, cy, r)) continue
      const vertical = { ...inset }
      if ((rect.top + rect.bottom) / 2 < cy) vertical.top = Math.max(inset.top, rect.bottom + GAP)
      else vertical.bottom = Math.max(inset.bottom, height - rect.top + GAP)
      const sideways = { ...inset }
      if ((rect.left + rect.right) / 2 < cx) sideways.left = Math.max(inset.left, rect.right + GAP)
      else sideways.right = Math.max(inset.right, width - rect.left + GAP)
      Object.assign(inset, freeOf(vertical) >= freeOf(sideways) ? vertical : sideways)
      moved = true
    }
    if (!moved) break
  }
  return inset
}

// Live: measures the elements and refits the bubble whenever they change.
export function layoutAround(elements) {
  const list = elements.filter(Boolean)
  return () => {
    const rects = list
      .filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
      .map((element) => element.getBoundingClientRect())
    const fill = Math.min(window.innerWidth, window.innerHeight) < 500 ? 0.68 : 0.78
    const inset = insetsAvoiding(rects, window.innerWidth, window.innerHeight, fill)
    // Whole 16 px steps: a HUD whose numbers change width by a few pixels
    // must not nudge the bubble.
    for (const side of Object.keys(inset)) inset[side] = Math.ceil(inset[side] / 16) * 16
    return inset
  }
}

export function refitOnChange(bubble, elements) {
  if (!('ResizeObserver' in window)) return () => {}
  let active = true
  const observer = new ResizeObserver(() => bubble.refit())
  for (const element of elements.filter(Boolean)) observer.observe(element)
  document.fonts?.ready.then(() => {
    if (active) bubble.refit()
  })
  return () => {
    active = false
    observer.disconnect()
  }
}
