import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cameraKeyframeFromCamera,
  clampKeyframeFrames,
  keyframeMaxFrame,
  normalizeFrameNumber,
  objectAtFrame,
  objectKeyframeFromObject,
  objectsAtFrame,
  resolveCameraAtFrame,
  rotateVectorXYZ,
} from '../src/keyframeOps.js'

const person = {
  id: 'actor',
  type: 'person',
  bodyType: 'standard',
  pose: 'idle',
  poseTime: 0.08,
  continuousMotion: false,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  rigRoot: [0, 0, 0],
  joints: {},
}

const objectKey = (frame, patch = {}) => ({
  frame,
  interpolation: 'linear',
  position: [frame, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  pose: 'idle',
  poseTime: 0.08,
  continuousMotion: false,
  rigRoot: [0, 0, 0],
  joints: {},
  ...patch,
})

const cameraKey = (frame, patch = {}) => ({
  frame,
  interpolation: 'linear',
  position: [frame, 0, 0],
  rotation: [0, 0, 0],
  focalLength: 42,
  ...patch,
})

test('frame helpers normalize, dedupe and cap keyframes', () => {
  assert.equal(normalizeFrameNumber('12.6'), 13)
  assert.equal(normalizeFrameNumber(-4), 0)
  assert.equal(normalizeFrameNumber('abc'), 0)
  assert.equal(keyframeMaxFrame([{ frame: 12 }], { a: [{ frame: 40 }], b: [] }), 40)
  assert.equal(keyframeMaxFrame([], {}), 0)
  assert.deepEqual(clampKeyframeFrames([{ frame: -3 }, { frame: 200 }, { frame: 200 }], 120).map(key => key.frame), [0, 120])
})

test('objectAtFrame interpolates transforms and honours per-key interpolation', () => {
  const linear = objectAtFrame(person, [objectKey(0), objectKey(10)], 5, 24)
  assert.deepEqual(linear.position, [5, 0, 0])
  assert.equal(linear.pose, 'idle')

  const held = objectAtFrame(person, [objectKey(0, { interpolation: 'hold' }), objectKey(10)], 5, 24)
  assert.deepEqual(held.position, [0, 0, 0])

  const head = objectAtFrame(person, [], 5, 24)
  assert.equal(head, person)
})

test('objectAtFrame interpolates joints only while the pose state stays the same', () => {
  const left = objectKey(0, { joints: { mixamorigRightArm: [0, 0, 0] } })
  const right = objectKey(10, { joints: { mixamorigRightArm: [1, 0, 0] } })
  const blended = objectAtFrame(person, [left, right], 5, 24)
  assert.ok(Math.abs(blended.joints.mixamorigRightArm[0] - 0.5) < 1e-9)

  const switched = objectAtFrame(person, [left, objectKey(10, { pose: 'walk', joints: { mixamorigRightArm: [1, 0, 0] } })], 5, 24)
  assert.equal(switched.pose, 'idle')
  assert.equal(switched.joints.mixamorigRightArm[0], 0)
})

test('objectsAtFrame maps every object and tolerates a missing track', () => {
  const framed = objectsAtFrame([person, { ...person, id: 'box', type: 'box', position: [2, 0, 0] }], { actor: [objectKey(0), objectKey(10)] }, 5, 24)
  assert.deepEqual(framed[0].position, [5, 0, 0])
  assert.deepEqual(framed[1].position, [2, 0, 0])
})

test('camera tracks interpolate position, focal length and angles on the short arc', () => {
  const keys = [cameraKey(0), cameraKey(10, { position: [10, 0, 0], rotation: [0, 1, 0], focalLength: 52 })]
  const middle = resolveCameraAtFrame(keys, 5, '16:9', { position: [9, 9, 9] })
  assert.deepEqual(middle.position, [5, 0, 0])
  assert.equal(middle.focalLength, 47)
  assert.ok(Math.abs(middle.rotation[1] - 0.5) < 1e-9)

  const empty = resolveCameraAtFrame([], 3, '9:16', { position: [1, 2, 3], focalLength: 35 })
  assert.deepEqual(empty.position, [1, 2, 3])
  assert.equal(empty.aspectRatio, '9:16')
})

test('keyframe builders own the pose and camera defaults', () => {
  const key = objectKeyframeFromObject({ ...person, pose: 'walk', poseTime: undefined }, 7)
  assert.equal(key.frame, 7)
  assert.equal(key.pose, 'walk')
  assert.equal(key.interpolation, 'smooth')
  assert.equal(key.poseTime, 0.24)
  assert.ok(key.joints && typeof key.joints === 'object')

  const camera = cameraKeyframeFromCamera({
    position: [1, 2, 3],
    rotation: [0.1, 0.2, 0.3],
    focalLength: 50,
    follow: { enabled: true, targetId: 'actor', shot: 'close', distance: 3, height: 2, lookHeight: 1.2, offset: [0, 2, 3], orbitDegrees: 15, sideOffset: 0.4 },
  }, 12, 'hold')
  assert.equal(camera.frame, 12)
  assert.equal(camera.interpolation, 'hold')
  assert.equal(camera.shot, 'close')
  assert.equal(camera.followEnabled, true)
  assert.deepEqual(camera.followOffset, [0, 2, 3])
  assert.equal(camera.followOrbitDegrees, 15)
})

test('rotateVectorXYZ rotates around x, then y, then z', () => {
  const rotated = rotateVectorXYZ([1, 0, 0], [0, Math.PI / 2, 0])
  assert.ok(Math.abs(rotated[0]) < 1e-9)
  assert.ok(Math.abs(rotated[2] + 1) < 1e-9)
})
