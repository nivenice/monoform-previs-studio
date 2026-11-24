// Delivery regression for the "007 opening" prompt:
// “场景内包含一个人物模型，镜头在她的侧方，他突然转身举枪对着镜头”
// The assistant is expected to build these keyframes with the scene tools; the
// assertions below describe what an acceptable 5 second shot looks like.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runSceneCommand } from '../src/agentSceneCommands.js'
import { objectAtFrame } from '../src/keyframeOps.js'
import { presetJoints } from '../src/rig.js'

const FPS = 24
const DURATION = 5
const TOTAL_FRAMES = FPS * DURATION

const initialProject = () => ({
  objects: [{
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
  }],
  camera: { position: [7.4, 4.6, 8.2], rotation: [0, 0.6, 0], focalLength: 42, aspectRatio: '16:9' },
  keyframes: [],
  objectKeyframes: {},
  routeTracks: {},
  settings: { name: '007 开场', fps: FPS, durationSeconds: 15, loopPlayback: false },
  shots: [{ id: 'shot-01', name: '镜头 01', fps: FPS, durationSeconds: 15, loopPlayback: false }],
  activeShotId: 'shot-01',
  activeShotName: '镜头 01',
  currentFrame: 0,
  fps: FPS,
  selectedId: 'actor-lead',
  customPoses: [],
})

const applyPatch = (state, patch) => {
  const next = { ...state }
  if (patch.settings) {
    next.settings = patch.settings
    next.fps = patch.settings.fps
  }
  if (patch.objects) next.objects = patch.objects
  if (patch.camera) next.camera = patch.camera
  if (patch.keyframes) next.keyframes = patch.keyframes
  if (patch.objectKeyframes) next.objectKeyframes = patch.objectKeyframes
  if (patch.selectedId) next.selectedId = patch.selectedId
  if (Number.isFinite(patch.currentFrame)) next.currentFrame = patch.currentFrame
  return next
}

const run = (name, state, args) => {
  const result = runSceneCommand(name, state, args)
  return { result, state: result.patch ? applyPatch(state, result.patch) : state }
}

function buildShot() {
  let state = initialProject()
  state = run('set_timeline', state, { fps: FPS, durationSeconds: DURATION }).state
  state = run('transform_objects', state, { targets: ['actor-lead'], position: [0, 0, 0], yawDegrees: 0 }).state
  const keyed = run('manage_keyframes', state, {
    camera: {
      frames: [
        { frame: 0, framing: { subjectId: 'actor-lead', azimuthDegrees: 90, distance: 4.6, height: 1.5, lookHeight: 1.25, focalLength: 45 } },
        { frame: TOTAL_FRAMES, framing: { subjectId: 'actor-lead', azimuthDegrees: 90, distance: 3.9, height: 1.5, lookHeight: 1.25, focalLength: 50 } },
      ],
    },
    objects: [{
      target: 'actor-lead',
      frames: [
        { frame: 0, pose: 'idle', yawDegrees: 0 },
        { frame: 36, pose: 'idle', yawDegrees: 0, interpolation: 'linear' },
        { frame: 48, pose: 'idle', yawDegrees: 68 },
        { frame: 64, pose: 'aim_pistol', yawDegrees: 65 },
        { frame: TOTAL_FRAMES, pose: 'aim_pistol', yawDegrees: 65 },
      ],
    }],
  })
  return { state: keyed.state, result: keyed.result }
}

test('the agent can author the 5 second side-angle turn-and-aim shot', () => {
  const { state, result } = buildShot()

  // Timeline: 5 seconds at 24 fps, every key inside 0–120.
  assert.equal(state.settings.durationSeconds, 5)
  assert.equal(state.settings.fps, 24)
  const allFrames = [...state.keyframes, ...Object.values(state.objectKeyframes).flat()].map(key => key.frame)
  assert.ok(allFrames.length > 0)
  assert.ok(Math.max(...allFrames) <= TOTAL_FRAMES)

  // Camera: two keys, on the subject's left (+X), pushing in from 4.6 m to 3.9 m.
  assert.deepEqual(result.summary.cameraFrames, [0, TOTAL_FRAMES])
  assert.equal(state.keyframes.length, 2)
  const [first, last] = [...state.keyframes].sort((a, b) => a.frame - b.frame)
  assert.ok(Math.abs(Math.hypot(first.position[0], first.position[2]) - 4.6) < 1e-6)
  assert.ok(first.position[0] > 3.5, 'camera should sit on the subject left (+X)')
  assert.ok(last.position[0] < first.position[0], 'camera should push in towards the subject')
  assert.equal(first.focalLength, 45)
  assert.equal(last.focalLength, 50)
  assert.ok(first.position[1] > 1)
  // The camera looks at the subject: rotation matches a look-at solution.
  assert.ok(Math.abs(first.rotation[1] - Math.PI / 2) < 1e-6)

  // Character track: back to camera, fast turn, then the aim pose held to the end.
  // She stops at a 3/4 angle (25° off the camera axis) so the extended arm keeps
  // its silhouette instead of collapsing into the lens.
  const track = state.objectKeyframes['actor-lead']
  assert.deepEqual(track.map(key => key.frame), [0, 36, 48, 64, TOTAL_FRAMES])
  const actor = state.objects.find(object => object.id === 'actor-lead')
  const start = objectAtFrame(actor, track, 0, FPS)
  const turned = objectAtFrame(actor, track, 64, FPS)
  const end = objectAtFrame(actor, track, TOTAL_FRAMES, FPS)
  assert.equal(start.pose, 'idle')
  assert.ok(Math.abs(start.rotation[1]) < 1e-9)
  const cameraAzimuth = Math.atan2(first.position[0], first.position[2])
  assert.ok(Math.abs(cameraAzimuth - Math.PI / 2) < 1e-6, 'camera sits on the +X side')
  assert.ok(Math.abs(turned.rotation[1] - (Math.PI / 2 - 25 * Math.PI / 180)) < 1e-9)
  assert.ok(Math.abs(cameraAzimuth - turned.rotation[1] - 25 * Math.PI / 180) < 1e-9, 'she faces the lens at a 3/4 angle')
  assert.equal(turned.pose, 'aim_pistol')
  assert.deepEqual(turned.joints.mixamorigRightArm, presetJoints('aim_pistol').mixamorigRightArm)
  assert.deepEqual(end.joints.mixamorigRightForeArm, presetJoints('aim_pistol').mixamorigRightForeArm)

  // The arm offsets interpolate between the idle and aim keys instead of snapping.
  const midRaise = objectAtFrame(actor, track, 52, FPS)
  const aim = presetJoints('aim_pistol').mixamorigRightArm
  assert.ok(Math.abs(midRaise.joints.mixamorigRightArm[1]) > 0.05)
  assert.ok(Math.abs(midRaise.joints.mixamorigRightArm[1]) < Math.abs(aim[1]))
  const midTurn = objectAtFrame(actor, track, 42, FPS)
  assert.ok(midTurn.rotation[1] > 0 && midTurn.rotation[1] < Math.PI / 2)

  // Reading the scene back reports the same tracks for the model to verify.
  const info = runSceneCommand('get_scene_info', state, {})
  assert.deepEqual(info.result.camera.keyframeFrames, [0, TOTAL_FRAMES])
  assert.deepEqual(info.result.objects[0].keyframeFrames, [0, 36, 48, 64, TOTAL_FRAMES])
  assert.equal(info.result.objects[0].current.pose, 'aim_pistol')
})

test('the shot survives a shorter retake only when the keyframes fit', () => {
  const { state } = buildShot()
  assert.throws(() => runSceneCommand('set_timeline', state, { durationSeconds: 2 }), /至少 5 秒/)
  const extended = runSceneCommand('set_timeline', state, { durationSeconds: 8 })
  assert.equal(extended.summary.totalFrames, 192)
})
