import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRigAgentContext } from '../src/rigAgentContext.js'
import { presetJoints } from '../src/rig.js'

const person = (patch = {}) => ({
  id: 'actor-lead',
  name: '人物 · 主角',
  type: 'person',
  bodyType: 'standard',
  pose: 'idle',
  poseTime: 0.08,
  continuousMotion: false,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  rigRoot: [0, 0, 0],
  joints: presetJoints('idle'),
  color: '#e8e3d8',
  ...patch,
})

const baseState = (patch = {}) => ({
  objects: [person()],
  camera: { position: [4, 2, 6], rotation: [0, 0, 0], focalLength: 42, aspectRatio: '16:9' },
  keyframes: [],
  objectKeyframes: {},
  routeTracks: {},
  settings: { name: '测试', fps: 24, durationSeconds: 5, loopPlayback: false },
  shots: [],
  activeShotId: 'shot-01',
  activeShotName: '镜头 01',
  currentFrame: 0,
  fps: 24,
  selectedId: 'actor-lead',
  customPoses: [],
  ...patch,
})

const key = (frame, patch = {}) => ({
  frame,
  interpolation: 'smooth',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  pose: 'idle',
  poseTime: 0.08,
  continuousMotion: false,
  rigRoot: [0, 0, 0],
  joints: presetJoints('idle'),
  ...patch,
})

test('rig context carries target, range, joints, presets and bone hierarchy', () => {
  const target = person({ bodyType: 'female' })
  const built = buildRigAgentContext(baseState({ objects: [target] }), target, { startFrame: 10, endFrame: 60 })
  const context = JSON.parse(built.json)
  assert.equal(context.target.id, 'actor-lead')
  assert.equal(context.target.bodyType, 'standard')
  assert.deepEqual(context.range, { startFrame: 10, endFrame: 60, totalFrames: 120 })
  assert.equal(context.timeline.fps, 24)
  assert.equal(context.limits.maxRounds, 5)
  assert.ok(context.poses.some(pose => pose.id === 'aim_pistol'))
  assert.ok(context.referencePoses.some(pose => pose.id === 'aim_pistol'))
  assert.ok(context.bones.length >= 5)
  assert.ok(context.bones.flatMap(group => group.bones).some(bone => bone.id === 'mixamorigHips' && bone.parent === null))
  assert.ok(context.bones.flatMap(group => group.bones).some(bone => bone.id === 'mixamorigRightArm' && bone.parent === 'mixamorigRightShoulder'))
  assert.equal(context.conventions.rotation.includes('local'), true)
  assert.ok(built.json.length <= 15000)
})

test('long keyframe tracks are trimmed but the context stays valid JSON', () => {
  const track = Array.from({ length: 100 }, (_, index) => key(index, { pose: 'idle' }))
  const built = buildRigAgentContext(baseState({ objectKeyframes: { 'actor-lead': track } }), person(), { startFrame: 0, endFrame: 120 })
  assert.ok(built.json.length <= 15000)
  const context = JSON.parse(built.json)
  assert.ok(context.keyframes.length <= 24)
})

test('minimal models are rejected before any animator context is built', () => {
  const minimal = person({ bodyType: 'minimal' })
  assert.throws(() => buildRigAgentContext(baseState({ objects: [minimal] }), minimal), /极简模型/)
})
