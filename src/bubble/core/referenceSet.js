// Canonical visual-mechanics coverage. These seeds are not product content;
// they are stable calibration fixtures chosen from real genome extremes so a
// shader or physics change can be compared against the same Bubble set.

export const BUBBLE_REFERENCES = Object.freeze([
  { id: 'calm', label: 'sakin film', seed: 'reference-3420' },
  { id: 'vivid', label: 'canlı film', seed: 'reference-9' },
  { id: 'pastel', label: 'kalın pastel film', seed: 'reference-943' },
  { id: 'thin', label: 'ince film', seed: 'reference-189' },
  { id: 'turbulent', label: 'türbülanslı film', seed: 'reference-13463' },
  { id: 'bands', label: 'kusursuz bantlar', seed: 'reference-60' },
  { id: 'eye', label: 'kalıcı girdap', seed: 'reference-344' },
  { id: 'ghost', label: 'hayalet', seed: 'reference-52' },
  { id: 'early-black', label: 'erken siyah zar', seed: 'reference-93' },
  { id: 'plumes', label: 'konvektif tüyler', seed: 'reference-511' },
  { id: 'giant', label: 'dev', seed: 'reference-221' },
  { id: 'baby', label: 'yavru baloncuk', seed: 'reference-3249' },
])

export function bubbleReference(id) {
  return BUBBLE_REFERENCES.find((reference) => reference.id === id) || null
}
