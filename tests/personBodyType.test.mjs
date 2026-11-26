import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PERSON_BODY_TYPES,
  isMinimalBody,
  isRiggedPerson,
  normalizeBodyType,
} from '../src/personBodyType.js'

test('legacy body types collapse to the standard rigged character', () => {
  assert.equal(normalizeBodyType('standard'), 'standard')
  assert.equal(normalizeBodyType('minimal'), 'minimal')
  for (const legacy of ['female', 'male', 'tall', 'broad', 'unknown', '', null, undefined]) {
    assert.equal(normalizeBodyType(legacy), 'standard')
  }
  assert.equal(normalizeBodyType('MINIMAL'), 'minimal')
  assert.deepEqual(PERSON_BODY_TYPES, [['standard', '标准人物'], ['minimal', '极简模型']])
})

test('rigged and minimal flags follow the normalized body type', () => {
  const person = (bodyType, id = 'p') => ({ id, type: 'person', bodyType })
  assert.equal(isRiggedPerson(person('standard')), true)
  assert.equal(isRiggedPerson(person('female')), true)
  assert.equal(isRiggedPerson(person(undefined)), true)
  assert.equal(isRiggedPerson(person('minimal')), false)
  assert.equal(isRiggedPerson({ type: 'box', bodyType: 'standard' }), false)
  assert.equal(isMinimalBody(person('minimal')), true)
  assert.equal(isMinimalBody(person('standard')), false)
})
