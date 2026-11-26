import test from 'node:test'
import assert from 'node:assert/strict'
import { presetJoints } from '../src/rig.js'
import { runRigSubagent } from '../src/rigSubagent.js'

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

const toolkitFor = state => {
  let current = state
  return {
    snapshot: () => current,
    applyScenePatch: patch => { current = { ...current, ...patch } },
  }
}

const toolCall = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })

test('the rig subagent writes pose keyframes, reads them back and summarizes the result', async () => {
  const replies = [
    { content: '', toolCalls: [toolCall('c1', 'write_pose_keyframes', {
      frames: [{ frame: 10, pose: 'idle', poseTime: 0.08, jointsDegrees: { mixamorigRightArm: [0, 0, -45] } }],
    })] },
    { content: '', toolCalls: [toolCall('c2', 'get_character_state', {})] },
    { content: '右手已抬起并保持。', toolCalls: [] },
  ]
  let index = 0
  const toolkit = toolkitFor(baseState())
  const progress = []
  const result = await runRigSubagent({
    target: 'selected',
    brief: '抬起右手',
    startFrame: 0,
    endFrame: 60,
    toolkit,
    requestTurn: async () => replies[index++],
    onProgress: event => progress.push(event),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.frames, [10])
  assert.deepEqual(result.bones, ['mixamorigRightArm'])
  assert.equal(result.staticPose, false)
  assert.equal(result.note, '右手已抬起并保持。')
  assert.match(result.message, /1 个姿态关键帧/)
  const state = toolkit.snapshot()
  assert.equal(state.objectKeyframes['actor-lead'].length, 1)
  assert.equal(state.objectKeyframes['actor-lead'][0].frame, 10)
  assert.ok(progress.some(event => event.type === 'round' && event.round === 1))
  assert.ok(progress.some(event => event.type === 'tool-start' && event.label === '写入姿态关键帧'))
  assert.ok(progress.some(event => event.type === 'tool-result' && event.ok === true))
})

test('a static performance sets the base joints and reports staticPose', async () => {
  let index = 0
  const replies = [
    { content: '', toolCalls: [toolCall('c1', 'set_character_joints', {
      jointsDegrees: { mixamorigHead: [12, 0, 0] },
    })] },
    { content: '头部已微调。', toolCalls: [] },
  ]
  const toolkit = toolkitFor(baseState())
  const result = await runRigSubagent({
    target: 'actor-lead',
    brief: '微微低头',
    toolkit,
    requestTurn: async () => replies[index++],
  })
  assert.equal(result.ok, true)
  assert.equal(result.staticPose, true)
  assert.deepEqual(result.frames, [])
  const actor = toolkit.snapshot().objects[0]
  assert.ok(Math.abs(actor.joints.mixamorigHead[0] - 12 * Math.PI / 180) < 1e-9)
})

test('no writes, too many rounds and a minimal target become clear failures', async () => {
  const noWrite = await runRigSubagent({
    target: 'actor-lead',
    brief: '站着',
    toolkit: toolkitFor(baseState()),
    requestTurn: async () => ({ content: '我做不到。', toolCalls: [] }),
  })
  assert.equal(noWrite.ok, false)
  assert.match(noWrite.error, /没有写入任何骨骼/)

  let round = 0
  const looping = await runRigSubagent({
    target: 'actor-lead',
    brief: '一直挥手',
    toolkit: toolkitFor(baseState()),
    requestTurn: async () => {
      round += 1
      return {
        content: '',
        toolCalls: [toolCall(`c${round}`, 'write_pose_keyframes', {
          frames: [{ frame: 10, pose: 'idle', poseTime: 0.08, jointsDegrees: { mixamorigRightArm: [0, 0, -20] } }],
        })],
      }
    },
  })
  assert.equal(looping.ok, false)
  assert.equal(looping.partial, true)
  assert.match(looping.error, /工具调用次数过多/)

  let calls = 0
  const minimal = await runRigSubagent({
    target: 'mini',
    brief: '挥手',
    toolkit: toolkitFor(baseState({ objects: [person({ id: 'mini', name: '极简', bodyType: 'minimal' })], selectedId: 'mini' })),
    requestTurn: async () => { calls += 1; return { content: '', toolCalls: [] } },
  })
  assert.equal(minimal.ok, false)
  assert.match(minimal.error, /极简模型/)
  assert.equal(calls, 0)
})

test('aborting the subagent rethrows AbortError instead of being reported as a tool failure', async () => {
  const error = new Error('已停止')
  error.name = 'AbortError'
  await assert.rejects(() => runRigSubagent({
    target: 'actor-lead',
    brief: '挥手',
    toolkit: toolkitFor(baseState()),
    requestTurn: async () => { throw error },
  }), /已停止/)
})
