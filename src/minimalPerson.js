// Static "minimal" person body: a cylinder body plus a sphere head with a face panel.
// Keep this module free of three.js and DOM so the text rules stay unit-testable.
export const MINIMAL_PERSON_MAX_FACE_CHARS = 5

export const MINIMAL_PERSON_DIMENSIONS = Object.freeze({
  bodyRadius: 0.2,
  bodyHeight: 1.45,
  headRadius: 0.155,
  // The sphere sinks into the cylinder top by this much so the two shapes read as one body.
  headOverlap: 0.02,
  // Front-facing spherical cap on the head; the character faces +Z, like every other person here.
  faceHalfAngleDegrees: 40,
  faceSurfaceScale: 1.004,
})

export const MINIMAL_FACE_STYLE = Object.freeze({
  canvasSize: 512,
  panelColor: '#4a463c',
  rimColor: '#d8c18c',
  inkColor: '#f7f1e3',
  rimWidth: 18,
  rimInset: 9,
  maxTextWidthRatio: 0.78,
  maxFontSize: 200,
  minFontSize: 52,
})

export function normalizeFaceText(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, MINIMAL_PERSON_MAX_FACE_CHARS).join('')
}

export function fitFaceTextSize(text, measure, maxWidth, maxSize = MINIMAL_FACE_STYLE.maxFontSize, minSize = MINIMAL_FACE_STYLE.minFontSize) {
  const label = String(text ?? '')
  if (!label) return maxSize
  let size = maxSize
  while (size > minSize && measure(label, size) > maxWidth) size -= 2
  return Math.max(minSize, size)
}
