import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSceneContext, stringifySceneContext } from '../src/agentContext.js'

const object = index => ({
  id: `obj-${index}`,
  name: `物体 ${index}`,
  type: index % 2 ? 'box' : 'person',
  position: [index + 0.123456, 0, -index],
  scale: [1.2345, 2, 3],
  ...(index === 0 ? { locked: true } : {}),
  ...(index === 1 ? { visible: false } : {}),
})

test('scene context caps objects, rounds numbers and keeps camera/timeline data', () => {
  const context = buildSceneContext({
    objects: Array.from({ length: 50 }, (_, index) => object(index)),
    camera: { position: [1.23456, 2, 3], target: [0, 0, 0], rotation: [0, Math.PI / 2, 0], focalLength: 42.345, aspectRatio: '16:9' },
    keyframes: [{ frame: 0 }, { frame: 120 }],
    objectKeyframes: { 'obj-0': [{ frame: 0 }, { frame: 24 }] },
    routeTracks: { 'obj-1': { id: 'obj-1', points: [[0, 0, 0], [1, 0, 0]] } },
    shots: [{ name: '镜头 01', fps: 24, durationSeconds: 15 }],
    activeShotName: '镜头 01',
    activeShotId: 'shot-1',
    currentFrame: 12.7,
    fps: 24,
    settings: { name: '测试工程', fps: 24, durationSeconds: 15 },
    selectedId: 'obj-0',
  })
  assert.equal(context.objectCount, 50)
  assert.equal(context.objects.length, 40)
  assert.equal(context.truncated, true)
  assert.deepEqual(context.objects[0].position, [0.12, 0, 0])
  assert.equal(context.objects[1].hidden, true)
  assert.equal(context.objects[0].locked, true)
  assert.equal(context.objects[0].keyframeCount, 2)
  assert.deepEqual(context.objects[0].keyframeFrames, [0, 24])
  assert.equal(context.objects[1].hasRoute, true)
  assert.deepEqual(context.camera.position, [1.23, 2, 3])
  assert.deepEqual(context.camera.rotationDegrees, [0, 90, 0])
  assert.equal(context.camera.focalLength, 42.35)
  assert.equal(context.camera.keyframeCount, 2)
  assert.deepEqual(context.camera.keyframeFrames, [0, 120])
  assert.deepEqual(context.shots, [{ name: '镜头 01', fps: 24, durationSeconds: 15 }])
  assert.equal(context.activeShot, '镜头 01')
  assert.equal(context.timeline.currentFrame, 13)
  assert.equal(context.timeline.totalFrames, 360)
  assert.equal(context.selectedId, 'obj-0')
  assert.ok(context.tools.includes('manage_keyframes'))
  assert.ok(stringifySceneContext({ objects: [] }).includes('"objectCount":0'))
})

test('scene context handles missing or malformed source fields', () => {
  const context = buildSceneContext({})
  assert.equal(context.objectCount, 0)
  assert.deepEqual(context.objects, [])
  assert.deepEqual(context.camera.position, [])
  assert.equal(context.timeline.currentFrame, 0)
  assert.equal(context.project, '')
})
