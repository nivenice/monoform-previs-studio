import test from 'node:test'
import assert from 'node:assert/strict'
import { executeAgentTool, parseToolArguments, parseToolResult, pickAttachment, serializeToolOutput } from '../src/agentTools.js'

const attachment = { id: 'att-1', name: 'scene.png', mime: 'image/png', file: { name: 'scene.png' } }

const sceneState = () => ({
  objects: [{ id: 'actor-lead', name: '人物 · 主角', type: 'person', bodyType: 'standard', pose: 'idle', poseTime: 0.08, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
  camera: { position: [4, 2, 6], rotation: [0, 0.5, 0], focalLength: 42, aspectRatio: '16:9' },
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
})

test('tool arguments are parsed defensively and a sole attachment is auto-picked', () => {
  assert.deepEqual(parseToolArguments('{"note":"保留主体"}'), { note: '保留主体' })
  assert.deepEqual(parseToolArguments({ note: 'object' }), { note: 'object' })
  assert.equal(parseToolArguments('not json'), null)
  assert.equal(pickAttachment({}, [attachment]).id, 'att-1')
  assert.equal(pickAttachment({ attachment_id: 'att-1' }, [attachment, { id: 'att-2' }]).id, 'att-1')
  assert.equal(pickAttachment({}, [attachment, { id: 'att-2' }]), null)
  assert.equal(pickAttachment({ attachment_id: 'missing' }, [attachment]), null)
})

test('scene tool runs the scene request and applies the result', async () => {
  const calls = []
  const result = await executeAgentTool({ name: 'scene_to_white_model', arguments: '{"note":"保留比例"}' }, {
    conversationId: 'c-1',
    attachments: [attachment],
    runSceneTool: async input => { calls.push(input); return { scene: { title: 'x' } } },
    applyScene: (scene, picked) => {
      assert.equal(picked.id, 'att-1')
      assert.equal(scene.scene.title, 'x')
      return { added: 3, evidence: 2, warnings: 1, message: '新增 3 个体块' }
    },
  })
  const parsed = parseToolResult(result)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.added, 3)
  assert.equal(parsed.warnings, 1)
  assert.deepEqual(calls, [{ conversationId: 'c-1', attachmentId: 'att-1', note: '保留比例' }])
})

test('missing attachments, unknown tools and thrown errors become tool errors', async () => {
  const noAttachment = parseToolResult(await executeAgentTool({ name: 'scene_to_white_model', arguments: '{}' }, {
    conversationId: 'c-1',
    attachments: [],
  }))
  assert.equal(noAttachment.ok, false)
  assert.match(noAttachment.error, /场景图/)

  const unknown = parseToolResult(await executeAgentTool({ name: 'other_tool', arguments: '{}' }, {}))
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /未知工具/)

  const failed = parseToolResult(await executeAgentTool({ name: 'scene_to_white_model', arguments: '{}' }, {
    conversationId: 'c-1',
    attachments: [attachment],
    runSceneTool: async () => { throw new Error('识图失败') },
    applyScene: () => ({}),
  }))
  assert.equal(failed.ok, false)
  assert.equal(failed.error, '识图失败')
})

test('scene commands read the snapshot and apply their patch through the toolkit', async () => {
  const patches = []
  const toolkit = {
    snapshot: () => sceneState(),
    applyScenePatch: patch => { patches.push(patch) },
  }

  const info = parseToolResult(await executeAgentTool({ name: 'get_scene_info', arguments: '{}' }, { sceneToolkit: toolkit }))
  assert.equal(info.ok, true)
  assert.equal(info.objects[0].id, 'actor-lead')
  assert.equal(patches.length, 0)

  const transformed = parseToolResult(await executeAgentTool({
    name: 'transform_objects',
    arguments: JSON.stringify({ targets: ['actor-lead'], yawDegrees: 90, scale: 1.2 }),
  }, { sceneToolkit: toolkit }))
  assert.equal(transformed.ok, true)
  assert.equal(patches.length, 1)
  assert.deepEqual(patches[0].objects[0].scale, [1.2, 1.2, 1.2])
  assert.equal(patches[0].selectedId, 'actor-lead')

  const keyed = parseToolResult(await executeAgentTool({
    name: 'manage_keyframes',
    arguments: JSON.stringify({ objects: [{ target: 'actor-lead', frames: [{ frame: 0, pose: 'aim_pistol' }, { frame: 120, pose: 'aim_pistol' }] }] }),
  }, { sceneToolkit: toolkit }))
  assert.equal(keyed.ok, true)
  assert.equal(patches.length, 2)
  assert.equal(patches[1].objectKeyframes['actor-lead'].length, 2)
  assert.equal(patches[1].currentFrame, undefined)
})

test('scene command failures and a missing toolkit become tool errors', async () => {
  const bad = parseToolResult(await executeAgentTool({
    name: 'transform_objects',
    arguments: '{"targets":["missing"],"scale":2}',
  }, { sceneToolkit: { snapshot: sceneState, applyScenePatch: () => {} } }))
  assert.equal(bad.ok, false)
  assert.match(bad.error, /找不到对象/)

  const noToolkit = parseToolResult(await executeAgentTool({ name: 'get_scene_info', arguments: '{}' }, {}))
  assert.equal(noToolkit.ok, false)
  assert.match(noToolkit.error, /没有连接当前工程状态/)

  const brokenJson = parseToolResult(await executeAgentTool({ name: 'set_pose', arguments: '{oops' }, {}))
  assert.equal(brokenJson.ok, false)
  assert.match(brokenJson.error, /JSON/)
})

test('oversized tool output stays parseable JSON under the transport limit', () => {
  const payload = {
    ok: true,
    tool: 'get_scene_info',
    objects: Array.from({ length: 200 }, (_, index) => ({ id: `obj-${index}`, name: `物体 ${index}`, position: [index, 0, 0], scale: [1, 1, 1], rotationDegrees: [0, 0, 0], keyframeFrames: [0, 1, 2] })),
    limit: 'x'.repeat(2000),
  }
  const serialized = serializeToolOutput({ ok: true, tool: 'get_scene_info', result: payload })
  assert.ok(serialized.length <= 7000)
  const parsed = JSON.parse(serialized)
  assert.equal(parsed.ok, true)
  assert.ok(Array.isArray(parsed.result.objects))
  assert.equal(parsed.result.truncated, true)
  assert.ok(parsed.result.objects.length < 200)
})
