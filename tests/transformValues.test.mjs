import test from 'node:test'
import assert from 'node:assert/strict'
import {
  axisValueDigits,
  formatAxisValue,
  mergeCameraAxisLocks,
  normalizeAxisLocks,
  parseAxisValue,
  resetVectorPreservingLocks,
  stepAxisValue,
  toggleAxisLock,
} from '../src/transformValues.js'

test('axis locks normalize missing and partial values to three booleans', () => {
  assert.deepEqual(normalizeAxisLocks(undefined), [false, false, false])
  assert.deepEqual(normalizeAxisLocks([true]), [true, false, false])
  assert.deepEqual(normalizeAxisLocks(['1', 0, null]), [true, false, false])
  assert.deepEqual(normalizeAxisLocks('true'), [false, false, false])
})

test('axis lock toggling keeps the original array untouched', () => {
  const source = [false, false, false]
  assert.deepEqual(toggleAxisLock(source, 1), [false, true, false])
  assert.deepEqual(source, [false, false, false])
  assert.deepEqual(toggleAxisLock([true, true, true], 2), [true, true, false])
})

test('reset only changes unlocked axes and falls back when locked values are invalid', () => {
  assert.deepEqual(resetVectorPreservingLocks([0, 0, 0], [5, 6, 7], [true, false, true]), [5, 0, 7])
  assert.deepEqual(resetVectorPreservingLocks([1, 1, 1], [0.5, 'bad', 3], [true, true, false]), [0.5, 1, 1])
  assert.deepEqual(resetVectorPreservingLocks([0, 0, 0], null, [false, false, false]), [0, 0, 0])
})

test('camera frame results keep the base camera axis locks', () => {
  const frame = { position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], focalLength: 50 }
  const merged = mergeCameraAxisLocks(frame, { positionAxisLocks: [true, false, false], rotationAxisLocks: [false, true, false] })
  assert.deepEqual(merged.position, [1, 2, 3])
  assert.deepEqual(merged.rotation, [0.1, 0.2, 0.3])
  assert.equal(merged.focalLength, 50)
  assert.deepEqual(merged.positionAxisLocks, [true, false, false])
  assert.deepEqual(merged.rotationAxisLocks, [false, true, false])
  assert.deepEqual(mergeCameraAxisLocks(frame, null).positionAxisLocks, [false, false, false])
})

test('axis digits follow the configured step', () => {
  assert.equal(axisValueDigits(1), 0)
  assert.equal(axisValueDigits(0.1), 1)
  assert.equal(axisValueDigits(0.01), 2)
  assert.equal(axisValueDigits(0.05), 2)
  assert.equal(axisValueDigits(0.005), 3)
  assert.equal(axisValueDigits(0), 2)
})

test('axis value formatting is fixed precision and never shows negative zero', () => {
  assert.equal(formatAxisValue(1, 2), '1.00')
  assert.equal(formatAxisValue(14.36, 1), '14.4')
  assert.equal(formatAxisValue(-0.0001, 2), '0.00')
  assert.equal(formatAxisValue('bad', 1), '0.0')
})

test('axis value parsing rejects empty input and clamps finite values', () => {
  assert.equal(parseAxisValue('5', -30, 30, 2), 5)
  assert.equal(parseAxisValue(' -1.25 ', -30, 30, 2), -1.25)
  assert.equal(parseAxisValue('100', -30, 30, 2), 30)
  assert.equal(parseAxisValue('-100', -30, 30, 2), -30)
  assert.equal(parseAxisValue('0.126', -30, 30, 2), 0.13)
  assert.equal(parseAxisValue('', -30, 30, 2), null)
  assert.equal(parseAxisValue('-', -30, 30, 2), null)
  assert.equal(parseAxisValue('abc', -30, 30, 2), null)
  assert.equal(parseAxisValue('Infinity', -30, 30, 2), null)
})

test('axis arrow stepping respects step, direction, range and decimal precision', () => {
  assert.equal(stepAxisValue(0.2, 1, 0.1, -180, 180, 1), 0.3)
  assert.equal(stepAxisValue(0, -1, 0.1, -180, 180, 1), -0.1)
  assert.equal(stepAxisValue(179.95, 1, 0.1, -180, 180, 1), 180)
  assert.equal(stepAxisValue(-179.95, -1, 0.1, -180, 180, 1), -180)
  assert.equal(stepAxisValue(0.05, 1, 0.01, 0.05, 5, 2), 0.06)
})
