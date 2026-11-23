import test from 'node:test'
import assert from 'node:assert/strict'
import { executeAgentTool, parseToolArguments, parseToolResult, pickAttachment } from '../src/agentTools.js'

const attachment = { id: 'att-1', name: 'scene.png', mime: 'image/png', file: { name: 'scene.png' } }

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
