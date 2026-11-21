const normalizeDigits = value => Math.max(0, Math.min(4, Math.round(Number(value) || 0)))
const clampValue = (value, min, max) => {
  const minimum = Number(min)
  const maximum = Number(max)
  const lower = Number.isFinite(minimum) ? minimum : value
  const upper = Number.isFinite(maximum) ? maximum : value
  return Math.min(upper, Math.max(lower, value))
}
const roundValue = (value, digits) => {
  const rounded = Number(Number(value).toFixed(normalizeDigits(digits)))
  return Object.is(rounded, -0) ? 0 : rounded
}

export function normalizeAxisLocks(value) {
  return [0, 1, 2].map(axis => Boolean(Array.isArray(value) ? value[axis] : false))
}

export function toggleAxisLock(value, axis) {
  const locks = normalizeAxisLocks(value)
  if (axis === 0 || axis === 1 || axis === 2) locks[axis] = !locks[axis]
  return locks
}

export function resetVectorPreservingLocks(defaults, current, locks) {
  const normalizedLocks = normalizeAxisLocks(locks)
  return defaults.map((fallback, axis) => {
    if (!normalizedLocks[axis]) return fallback
    const present = Array.isArray(current) && Number.isFinite(Number(current[axis]))
    return present ? Number(current[axis]) : fallback
  })
}

export function mergeCameraAxisLocks(camera, baseCamera) {
  return {
    ...camera,
    positionAxisLocks: normalizeAxisLocks(baseCamera?.positionAxisLocks),
    rotationAxisLocks: normalizeAxisLocks(baseCamera?.rotationAxisLocks),
  }
}

export function axisValueDigits(step) {
  const numeric = Math.abs(Number(step))
  if (!Number.isFinite(numeric) || numeric <= 0) return 2
  const text = String(numeric)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : Math.min(4, text.length - dot - 1)
}

export function formatAxisValue(value, digits = 0) {
  const numeric = Number(value)
  const safeDigits = normalizeDigits(digits)
  if (!Number.isFinite(numeric)) return (0).toFixed(safeDigits)
  return roundValue(numeric, safeDigits).toFixed(safeDigits)
}

export function parseAxisValue(text, min, max, digits = 2) {
  const source = String(text ?? '').trim()
  if (!source) return null
  const numeric = Number(source)
  if (!Number.isFinite(numeric)) return null
  return roundValue(clampValue(numeric, min, max), digits)
}

export function stepAxisValue(value, direction, step, min, max, digits = 2) {
  const current = Number.isFinite(Number(value)) ? Number(value) : 0
  const amount = Math.abs(Number(step)) || 0.01
  const sign = Number(direction) < 0 ? -1 : 1
  return roundValue(clampValue(current + amount * sign, min, max), digits)
}
