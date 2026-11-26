import test from 'node:test'
import assert from 'node:assert/strict'
import { presetJoints } from '../src/rig.js'
import {
  GET_CHARACTER_STATE,
  SET_CHARACTER_JOINTS,
  readCharacterState,
  resolveRigTarget,
  runRigCommand,
  setCharacterJoints,
  writePoseKeyframes,
} from '../src/rigAgentCommands.js'

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

const range = { start: 0, end: 120, totalFrames: 120 }
const applyPatch = (state, patch) => ({ ...state, ...patch })

test('rig target resolution accepts selected/id and rejects minimal, locked and ambiguous targets', () => {
  assert.equal(resolveRigTarget(baseState(), 'selected').id, 'actor-lead')
  assert.equal(resolveRigTarget(baseState(), 'actor-lead').id, 'actor-lead')

  const minimal = baseState({ objects: [person({ id: 'mini', name: '极简', bodyType: 'minimal' })] })
  assert.throws(() => resolveRigTarget(minimal, 'mini'), /极简模型/)

  const locked = baseState({ objects: [person({ locked: true })] })
  assert.throws(() => resolveRigTarget(locked, 'actor-lead'), /锁定/)

  const ambiguous = baseState({ objects: [person({ id: 'a', name: '角色' }), person({ id: 'b', name: '角色' })] })
  assert.throws(() => resolveRigTarget(ambiguous, '角色'), /匹配到多个对象|一次只能/)

  assert.throws(() => resolveRigTarget(baseState(), 'persons'), /一次只能/)
})

test('set_character_joints overlays existing joints or resets to a preset', () => {
  const state = baseState()
  const overlay = setCharacterJoints(state, 'actor-lead', {
    jointsDegrees: { mixamorigRightArm: [0, 0, -30] },
  })
  const actor = overlay.patch.objects[0]
  assert.ok(Math.abs(actor.joints.mixamorigRightArm[2] + 30 * Math.PI / 180) < 1e-9)
  assert.deepEqual(actor.joints.mixamorigLeftArm, presetJoints('idle').mixamorigLeftArm)
  assert.equal(overlay.summary.message.includes('基础姿势'), true)

  const preset = setCharacterJoints(state, 'actor-lead', {
    preset: 'aim_pistol',
    jointsDegrees: { mixamorigHead: [0, 0, 0] },
  })
  assert.equal(preset.patch.objects[0].pose, 'aim_pistol')
  assert.deepEqual(preset.patch.objects[0].joints.mixamorigRightArm, presetJoints('aim_pistol').mixamorigRightArm)

  assert.throws(() => setCharacterJoints(state, 'actor-lead', {}), /请提供/)
  assert.throws(() => setCharacterJoints(state, 'actor-lead', { jointsDegrees: { nope: [0, 0, 0] } }), /未知骨骼/)
})

test('write_pose_keyframes validates the delegated range and bone-only fields', () => {
  const state = baseState()
  assert.throws(() => writePoseKeyframes(state, 'actor-lead', {
    frames: [{ frame: 121, jointsDegrees: { mixamorigHead: [10, 0, 0] } }],
  }, { range }), /超出委派范围/)

  assert.throws(() => writePoseKeyframes(state, 'actor-lead', {
    frames: [{ frame: 10, position: [0, 0, 0], jointsDegrees: { mixamorigHead: [10, 0, 0] } }],
  }, { range }), /不支持字段/)

  assert.throws(() => writePoseKeyframes(state, 'actor-lead', {
    frames: [{ frame: 10, pose: 'idle', preset: 'idle' }],
  }, { range }), /不要同时给/)

  assert.throws(() => writePoseKeyframes(state, 'actor-lead', {
    frames: [{ frame: 10 }],
  }, { range }), /没有任何骨骼/)

  const routeDriven = baseState({ routeTracks: { 'actor-lead': { points: [[0, 0, 0], [1, 0, 0]] } } })
  assert.throws(() => writePoseKeyframes(routeDriven, 'actor-lead', {
    frames: [{ frame: 10, jointsDegrees: { mixamorigHead: [10, 0, 0] } }],
  }, { range }), /路线/)
})

test('write_pose_keyframes writes pose keys and preserves an existing frame transform', () => {
  const state = baseState({
    objectKeyframes: {
      'actor-lead': [{
        frame: 40,
        interpolation: 'linear',
        position: [1, 0, 2],
        rotation: [0, 1, 0],
        scale: [1, 1, 1],
        pose: 'idle',
        poseTime: 0.08,
        continuousMotion: false,
        rigRoot: [0, 0, 0],
        joints: presetJoints('idle'),
      }],
    },
  })
  const result = writePoseKeyframes(state, 'actor-lead', {
    frames: [{
      frame: 40,
      pose: 'idle',
      poseTime: 0.08,
      interpolation: 'smooth',
      jointsDegrees: { mixamorigRightArm: [0, 0, -60] },
    }],
  }, { range })
  const key = result.patch.objectKeyframes['actor-lead'][0]
  assert.deepEqual(key.rotation, [0, 1, 0])
  assert.deepEqual(key.position, [1, 0, 2])
  assert.equal(key.interpolation, 'smooth')
  assert.ok(Math.abs(key.joints.mixamorigRightArm[2] + 60 * Math.PI / 180) < 1e-9)
  assert.deepEqual(result.summary.frames, [40])
  assert.deepEqual(result.summary.bones, ['mixamorigRightArm'])
})

test('a new in-between key inherits the interpolated transform from its neighbours', () => {
  const withTurn = baseState({
    objectKeyframes: {
      'actor-lead': [
        { frame: 0, interpolation: 'smooth', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pose: 'idle', poseTime: 0.08, continuousMotion: false, rigRoot: [0, 0, 0], joints: presetJoints('idle') },
        { frame: 100, interpolation: 'smooth', position: [0, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1], pose: 'idle', poseTime: 0.08, continuousMotion: false, rigRoot: [0, 0, 0], joints: presetJoints('idle') },
      ],
    },
  })
  const inserted = writePoseKeyframes(withTurn, 'actor-lead', {
    frames: [{ frame: 50, jointsDegrees: { mixamorigHead: [10, 0, 0] } }],
  }, { range })
  const key = inserted.patch.objectKeyframes['actor-lead'].find(item => item.frame === 50)
  assert.ok(Math.abs(key.rotation[1] - Math.PI / 4) < 1e-6)
  assert.ok(Math.abs(key.joints.mixamorigHead[0] - 10 * Math.PI / 180) < 1e-9)
})

test('read_character_state reports base, current and keyframe joints after a write', () => {
  const state = baseState()
  const written = writePoseKeyframes(state, 'actor-lead', {
    frames: [{ frame: 12, pose: 'idle', poseTime: 0.08, jointsDegrees: { mixamorigHead: [10, 0, 0] } }],
  }, { range })
  const next = applyPatch(state, written.patch)
  const read = readCharacterState(next, 'actor-lead')
  assert.equal(read.timeline.fps, 24)
  assert.equal(read.keyframes.length, 1)
  assert.deepEqual(read.keyframes[0].jointsDegrees.mixamorigHead, [10, 0, 0])
  assert.equal(read.target.routeDriven, false)
  assert.equal(runRigCommand(GET_CHARACTER_STATE, next, {}, { targetId: 'actor-lead' }).result.keyframes.length, 1)
  assert.equal(SET_CHARACTER_JOINTS, 'set_character_joints')
})
