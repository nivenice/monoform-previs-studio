import test from 'node:test'
import assert from 'node:assert/strict'
import { MINIMAL_PERSON_DIMENSIONS, MINIMAL_PERSON_MAX_FACE_CHARS, fitFaceTextSize, normalizeFaceText } from '../src/minimalPerson.js'

const textLength = text => Array.from(text).length

test('face text trims, collapses whitespace, and keeps at most five characters', () => {
  assert.equal(normalizeFaceText('  主角  '), '主角')
  assert.equal(normalizeFaceText('主角\n姓名'), '主角 姓名')
  assert.equal(normalizeFaceText('A   B'), 'A B')
  assert.equal(normalizeFaceText('ABCDEFGH'), 'ABCDE')
  assert.equal(normalizeFaceText(null), '')
  assert.equal(normalizeFaceText(undefined), '')
})

test('face text truncation counts code points so emoji are never split', () => {
  const label = normalizeFaceText('😀😀😀😀😀😀')
  assert.equal(textLength(label), MINIMAL_PERSON_MAX_FACE_CHARS)
  assert.equal(label, '😀😀😀😀😀')
})

test('face text size shrinks to fit the face panel and never drops below the minimum', () => {
  const measure = (text, size) => textLength(text) * size
  assert.equal(fitFaceTextSize('', measure, 400), 200)
  assert.equal(fitFaceTextSize('主', measure, 400), 200)
  assert.equal(fitFaceTextSize('五个汉字字符', measure, 400), 66)
  assert.equal(fitFaceTextSize('五个汉字字符', measure, 10, 200, 52), 52)
})

test('minimal person proportions match the standard previz height', () => {
  const dimensions = MINIMAL_PERSON_DIMENSIONS
  const totalHeight = dimensions.bodyHeight - dimensions.headOverlap + dimensions.headRadius * 2
  assert.ok(totalHeight > 1.7 && totalHeight < 1.8)
  assert.ok(dimensions.headRadius * 2 < dimensions.bodyRadius * 2)
  assert.equal(dimensions.faceHalfAngleDegrees, 40)
  assert.ok(dimensions.bodyRadius > 0 && dimensions.bodyHeight > 0 && dimensions.headRadius > 0)
})
