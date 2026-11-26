import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GET_SCENE_INFO,
  MANAGE_KEYFRAMES,
  SET_POSE,
  SET_TIMELINE,
  SceneCommandError,
  TRANSFORM_OBJECTS,
  runSceneCommand,
} from '../src/agentSceneCommands.js'
import { objectAtFrame } from '../src/keyframeOps.js'
import { presetJoints } from '../src/rig.js'

const person = () => ({
  id: 'actor-lead',
  name: '人物 · 主角',
  type: 'person',
  bodyType: 'standard',
  pose: 'walk',
  poseTime: 0.24,
  continuousMotion: false,
  position: [-1.25, 0, 0.3],
  rotation: [0, 0.25, 0],
  scale: [1, 1, 1],
  rigRoot: [0, 0, 0],
  joints: {},
  color: '#e8e3d8',
})

const block = () => ({
  id: 'block-stage',
  name: '平台',
  type: 'box',
  position: [1.4, 0.45, -0.8],
  rotation: [0, -0.18, 0],
  scale: [2.8, 0.9, 2.1],
  positionAxisLocks: [false, false, false],
  rotationAxisLocks: [false, false, false],
  scaleAxisLocks: [false, false, false],
})

const baseState = (patch = {}) => ({
  objects: [person(), block()],
  camera: { position: [7.4, 4.6, 8.2], rotation: [0, 0.6, 0], focalLength: 42, aspectRatio: '16:9' },
  keyframes: [],
  objectKeyframes: {},
  routeTracks: {},
  settings: { name: '测试场景', fps: 24, durationSeconds: 15, loopPlayback: false },
  shots: [],
  activeShotId: 'shot-01',
  activeShotName: '镜头 01',
  currentFrame: 0,
  fps: 24,
  selectedId: 'actor-lead',
  customPoses: [],
  ...patch,
})

const run = (name, state, args) => runSceneCommand(name, state, args)

test('get_scene_info reports objects, poses, limits and current-frame state', () => {
  const state = baseState({
    currentFrame: 12,
    keyframes: [{ frame: 0 }],
    objectKeyframes: { 'actor-lead': [{ frame: 0, interpolation: 'linear', position: [0, 0, 0], rotation: [0, 1.5708, 0], scale: [1, 1, 1], pose: 'idle', poseTime: 0.08, joints: {} }] },
  })
  const result = run(GET_SCENE_INFO, state, {})
  assert.equal(result.ok, true)
  assert.equal(result.result.project.fps, 24)
  assert.equal(result.result.project.totalFrames, 360)
  assert.equal(result.result.project.currentFrame, 12)
  assert.equal(result.result.objects.length, 2)
  const actor = result.result.objects.find(object => object.id === 'actor-lead')
  assert.equal(actor.poseLabel, '行走')
  assert.deepEqual(actor.rotationDegrees, [0, 14.3, 0])
  assert.deepEqual(actor.keyframeFrames, [0])
  assert.equal(actor.current.rotationDegrees[1], 90)
  assert.ok(result.result.poses.some(pose => pose.id === 'aim_pistol'))
  assert.deepEqual(result.result.limits.fps, [24, 25, 30])
  assert.equal(result.result.conventions.subjectForwardAtYaw0, '+Z')

  const detailed = run(GET_SCENE_INFO, state, { objectId: 'actor-lead', includeJoints: true })
  assert.equal(detailed.result.objectCount, 2)
  assert.equal(detailed.result.objects.length, 1)
  assert.deepEqual(detailed.result.objects[0].jointsDegrees, {})
})

test('transform_objects applies yaw, uniform scale and relative offsets while respecting locks', () => {
  const state = baseState()
  const result = run(TRANSFORM_OBJECTS, state, { targets: ['actor-lead'], yawDegrees: 90, scale: 1.1, position: { delta: [1, 0, -0.3] } })
  assert.equal(result.ok, true)
  const actor = result.patch.objects.find(object => object.id === 'actor-lead')
  assert.ok(Math.abs(actor.rotation[1] - Math.PI / 2) < 1e-9)
  assert.deepEqual(actor.scale, [1.1, 1.1, 1.1])
  assert.deepEqual(actor.position, [-0.25, 0, 0])
  assert.equal(result.patch.selectedId, 'actor-lead')

  const locked = baseState({ objects: [{ ...block(), locked: true }] })
  assert.throws(() => run(TRANSFORM_OBJECTS, locked, { targets: ['block-stage'], scale: 2 }), /锁定/)

  const axisLocked = baseState({ objects: [{ ...block(), scaleAxisLocks: [false, true, false] }] })
  const lockedResult = run(TRANSFORM_OBJECTS, axisLocked, { targets: ['block-stage'], scale: [2, 2, 2] })
  assert.deepEqual(lockedResult.patch.objects[0].scale, [2, 0.9, 2])
  assert.match(lockedResult.summary.warnings.join(), /缩放Y轴已锁定/)
})

test('transform_objects explains unknown or ambiguous targets', () => {
  assert.throws(() => run(TRANSFORM_OBJECTS, baseState(), { targets: ['missing'] }), /找不到对象/)
  assert.throws(() => run(TRANSFORM_OBJECTS, baseState(), {}), /请指定目标对象/)

  const duplicates = baseState({ objects: [{ ...block(), id: 'a', name: '墙' }, { ...block(), id: 'b', name: '墙' }] })
  assert.throws(() => run(TRANSFORM_OBJECTS, duplicates, { targets: ['墙'], scale: 2 }), /匹配到多个对象/)
})

test('set_pose switches to a preset and merges per-joint degrees', () => {
  const state = baseState()
  const result = run(SET_POSE, state, { targets: 'selected', preset: 'aim_pistol' })
  const actor = result.patch.objects.find(object => object.id === 'actor-lead')
  assert.equal(actor.pose, 'aim_pistol')
  assert.deepEqual(actor.joints.mixamorigRightArm, presetJoints('aim_pistol').mixamorigRightArm)
  assert.equal(result.summary.updated[0].poseLabel, '举枪瞄准')

  const overridden = run(SET_POSE, baseState(), { targets: ['actor-lead'], preset: 'idle', jointsDegrees: { 'mixamorigHead': [10, 0, 0] } })
  const overriddenActor = overridden.patch.objects.find(object => object.id === 'actor-lead')
  assert.ok(Math.abs(overriddenActor.joints.mixamorigHead[0] - 10 * Math.PI / 180) < 1e-9)

  assert.throws(() => run(SET_POSE, baseState(), { targets: ['actor-lead'], preset: 'not_a_pose' }), /未知姿势/)
  assert.throws(() => run(SET_POSE, baseState(), { targets: ['block-stage'], preset: 'idle' }), /只作用于人物/)
  assert.throws(() => run(SET_POSE, baseState(), { targets: ['actor-lead'], jointsDegrees: { 'mixamorigSpine': [0, 0, 0], nope: [1, 0, 0] } }), /未知骨骼/)
})

test('set_timeline changes fps and duration but never clips existing keyframes', () => {
  const result = run(SET_TIMELINE, baseState(), { fps: 24, durationSeconds: 5 })
  assert.equal(result.patch.settings.durationSeconds, 5)
  assert.equal(result.summary.totalFrames, 120)
  assert.equal(result.summary.message.includes('0–120'), true)

  const withKeys = baseState({ keyframes: [{ frame: 200 }] })
  assert.throws(() => run(SET_TIMELINE, withKeys, { durationSeconds: 5 }), /至少 9 秒/)
  assert.throws(() => run(SET_TIMELINE, baseState(), { fps: 26 }), /帧率只能是/)
  assert.throws(() => run(SET_TIMELINE, baseState(), { durationSeconds: 90 }), /1–60/)
})

test('manage_keyframes writes camera framing and object pose tracks in one call', () => {
  const state = baseState({ settings: { name: '测试场景', fps: 24, durationSeconds: 5, loopPlayback: false } })
  const result = run(MANAGE_KEYFRAMES, state, {
    camera: {
      frames: [
        { frame: 0, framing: { subjectId: 'actor-lead', azimuthDegrees: 90, distance: 4.6, height: 1.5, lookHeight: 1.25, focalLength: 45 } },
        { frame: 120, framing: { subjectId: 'actor-lead', azimuthDegrees: 90, distance: 3.9, height: 1.5, lookHeight: 1.25, focalLength: 50 } },
      ],
    },
    objects: [{
      target: 'actor-lead',
      frames: [
        { frame: 0, pose: 'idle', yawDegrees: 0 },
        { frame: 36, pose: 'idle', yawDegrees: 0, interpolation: 'linear' },
        { frame: 64, pose: 'aim_pistol', yawDegrees: 92 },
        { frame: 120, pose: 'aim_pistol', yawDegrees: 90 },
      ],
    }],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.summary.cameraFrames, [0, 120])
  assert.deepEqual(result.summary.objects[0].frames, [0, 36, 64, 120])
  assert.equal(result.patch.currentFrame, 120)

  const cameraKeys = result.patch.keyframes
  // Azimuth +90 puts the camera on the subject's left (+X side) of x=-1.25.
  const dx = cameraKeys[0].position[0] + 1.25
  const dz = cameraKeys[0].position[2] - 0.3
  assert.ok(Math.abs(Math.hypot(dx, dz) - 4.6) < 1e-6)
  assert.ok(dx > 4)
  assert.ok(Math.abs(cameraKeys[0].focalLength - 45) < 1e-9)

  const track = result.patch.objectKeyframes['actor-lead']
  const raised = objectAtFrame(person(), track, 64, 24)
  assert.equal(raised.pose, 'aim_pistol')
  const mid = objectAtFrame(person(), track, 50, 24)
  assert.ok(Math.abs(mid.joints.mixamorigRightArm[1]) > 0.05, 'arm offsets should interpolate between idle and aim')
  assert.ok(mid.joints.mixamorigRightArm[1] < presetJoints('aim_pistol').mixamorigRightArm[1])
  assert.ok(Math.abs(mid.rotation[1] - 92 * Math.PI / 180 * ((50 - 36) / 28)) < 0.2)
})

test('set_pose skips or rejects the static minimal model', () => {
  const minimal = baseState({ objects: [{ ...person(), id: 'mini', name: '极简', bodyType: 'minimal' }] })
  assert.throws(() => run(SET_POSE, minimal, { targets: ['mini'], preset: 'idle' }), /极简模型/)

  const mixed = baseState({ objects: [person(), { ...person(), id: 'mini', name: '极简', bodyType: 'minimal' }] })
  const result = run(SET_POSE, mixed, { targets: ['actor-lead', 'mini'], preset: 'aim_pistol' })
  assert.equal(result.patch.objects.find(object => object.id === 'actor-lead').pose, 'aim_pistol')
  assert.equal(result.patch.objects.find(object => object.id === 'mini').pose, 'walk')
  assert.match(result.summary.skipped.map(item => item.reason).join(), /极简模型/)
})

test('a new object key inherits the interpolated transform from neighbouring keys', () => {
  const state = baseState()
  const written = run(MANAGE_KEYFRAMES, state, {
    objects: [{
      target: 'actor-lead',
      frames: [
        { frame: 0, pose: 'idle', poseTime: 0.08, yawDegrees: 0 },
        { frame: 100, pose: 'idle', poseTime: 0.08, yawDegrees: 90 },
      ],
    }],
  })
  const afterWrite = baseState({
    settings: state.settings,
    objectKeyframes: written.patch.objectKeyframes,
  })
  const inserted = run(MANAGE_KEYFRAMES, afterWrite, {
    objects: [{
      target: 'actor-lead',
      frames: [{ frame: 50, jointsDegrees: { mixamorigHead: [10, 0, 0] } }],
    }],
  })
  const middle = inserted.patch.objectKeyframes['actor-lead'].find(key => key.frame === 50)
  assert.ok(Math.abs(middle.rotation[1] - Math.PI / 4) < 1e-6)
  assert.ok(Math.abs(middle.joints.mixamorigHead[0] - 10 * Math.PI / 180) < 1e-9)
})

test('manage_keyframes validates frames, deletes and protects route driven tracks', () => {
  const state = baseState({ settings: { name: '测试', fps: 24, durationSeconds: 5, loopPlayback: false } })
  assert.throws(() => run(MANAGE_KEYFRAMES, state, { camera: { frames: [{ frame: 200 }] } }), /超出范围 0–120/)

  const written = run(MANAGE_KEYFRAMES, state, {
    camera: { frames: [{ frame: 0, position: [0, 2, 6], lookAt: [0, 1, 0] }, { frame: 60, position: [1, 2, 6], lookAt: [0, 1, 0] }] },
    objects: [{ target: 'actor-lead', frames: [{ frame: 0, yawDegrees: 0 }, { frame: 60, yawDegrees: 90 }] }],
  })
  const afterWrite = baseState({
    settings: state.settings,
    keyframes: written.patch.keyframes,
    objectKeyframes: written.patch.objectKeyframes,
  })

  const deleted = run(MANAGE_KEYFRAMES, afterWrite, { action: 'delete', camera: { frames: [{ frame: 60 }] }, objects: [{ target: 'actor-lead', frames: [{ frame: 60 }] }] })
  assert.deepEqual(deleted.summary.deletedCameraFrames, [60])
  assert.deepEqual(deleted.summary.deletedObjectFrames, [{ id: 'actor-lead', name: '人物 · 主角', frames: [60] }])
  assert.equal(deleted.patch.keyframes.length, 1)
  assert.equal(deleted.patch.objectKeyframes['actor-lead'].length, 1)

  const routeState = baseState({ routeTracks: { 'actor-lead': { id: 'actor-lead', points: [[0, 0, 0], [1, 0, 0]], startFrame: 0, endFrame: 10, keyframes: [0, 10], keyframesOwned: true } } })
  assert.throws(() => run(MANAGE_KEYFRAMES, { ...routeState, objectKeyframes: { 'actor-lead': [{ frame: 0 }] } }, { action: 'clear', objects: [{ target: 'actor-lead' }] }), /没有删除任何关键帧/)

  const listed = run(MANAGE_KEYFRAMES, afterWrite, { action: 'list' })
  assert.deepEqual(listed.summary.cameraFrames, [0, 60])
  assert.deepEqual(listed.summary.objects[0].frames, [0, 60])
})

test('unknown commands and missing arguments fail in Chinese', () => {
  assert.throws(() => run('other', baseState(), {}), SceneCommandError)
  assert.throws(() => run(MANAGE_KEYFRAMES, baseState(), { action: 'upsert' }), /没有写入关键帧/)
  assert.throws(() => run(MANAGE_KEYFRAMES, baseState(), { action: 'rename' }), /未知操作/)
})
