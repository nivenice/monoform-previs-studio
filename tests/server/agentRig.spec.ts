import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelConfigStore } from '../../server/config'
import { createAgentService } from '../../server/agent/service'
import { buildRigSystemPrompt, RIG_AGENT_TOOLS } from '../../server/agent/rigPrompt'
import { parseSpecialistInput } from '../../server/agent/specialist'
import { AGENT_TOOLS, DELEGATE_POSE } from '../../server/agent/prompt'
import type { SpecialistTurnInput } from '../../server/agent/types'

const sseResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const chatConfig = {
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:9999/v1',
  apiKey: 'test-key',
  model: 'stub-chat',
}

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoform-agent-rig-'))
  const configStore = new ModelConfigStore({
    configFile: path.join(dir, 'model-config.json'),
    keyFile: path.join(dir, 'missing-key.txt'),
  })
  const requests: Array<{ url: string; body: any }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url: String(input), body })
    if (body?.stream) {
      const hasToolResult = Array.isArray(body.messages) && body.messages.some((message: any) => message.role === 'tool')
      if (hasToolResult) {
        return sseResponse(['data: {"choices":[{"delta":{"content":"挥手已完成。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
      }
      const call = {
        index: 0,
        id: 'rig_call_1',
        type: 'function',
        function: {
          name: 'write_pose_keyframes',
          arguments: JSON.stringify({
            frames: [{ frame: 10, pose: 'idle', poseTime: 0.08, jointsDegrees: { mixamorigRightArm: [0, 0, -30] } }],
          }),
        },
      }
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ])
    }
    return jsonResponse({ choices: [{ message: { content: '[]' } }] })
  }
  const service = createAgentService({
    dbFile: path.join(dir, 'agent.db'),
    configStore,
    generateScene: async () => ({ scene: {}, warnings: [], quality: { status: 'ready', visualCheck: 'outstanding', warnings: [], corrections: [] } } as any),
    fetchImpl,
    sleep: async () => {},
  })
  return {
    service,
    requests,
    cleanup: () => {
      service.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const baseInput = (): SpecialistTurnInput => ({
  specialist: 'rig',
  context: '{"target":{"id":"actor-lead","name":"主角"}}',
  brief: '让主角抬右手挥两下',
  history: [],
})

test('the main agent exposes the delegation tool and the rig agent has exactly four tools', () => {
  assert.ok(AGENT_TOOLS.some(tool => tool.function.name === DELEGATE_POSE))
  assert.deepEqual(RIG_AGENT_TOOLS.map(tool => tool.function.name), ['get_character_state', 'get_character_keyframes', 'set_character_joints', 'write_pose_keyframes'])
  const prompt = buildRigSystemPrompt('{"target":{"id":"actor-lead"}}')
  assert.match(prompt, /rig_context/)
  assert.match(prompt, /mixamorigRightForeArm/)
  assert.match(prompt, /get_character_keyframes/)
  assert.match(prompt, /write_pose_keyframes/)
  assert.match(prompt, /局部欧拉角增量/)
})

test('a specialist turn uses the rig prompt and tools, streams a tool call and does not touch the conversation store', async t => {
  const harness = makeHarness()
  t.after(harness.cleanup)
  harness.service.saveConfig({ chat: chatConfig })
  assert.deepEqual(harness.service.listConversations(), [])

  const events: any[] = []
  await harness.service.specialistTurn(baseInput(), event => events.push(event))
  const message = events.find(event => event.type === 'message').message
  assert.equal(message.toolCalls[0].name, 'write_pose_keyframes')
  assert.equal(events.at(-1)?.type, 'done')
  const request = harness.requests[0].body
  assert.match(request.messages[0].content, /rig_context/)
  assert.equal(request.messages[0].role, 'system')
  assert.equal(request.messages[1].role, 'user')
  assert.deepEqual(request.tools.map((tool: any) => tool.function.name), ['get_character_state', 'get_character_keyframes', 'set_character_joints', 'write_pose_keyframes'])
  assert.equal(request.temperature, 0.2)
  assert.deepEqual(harness.service.listConversations(), [])

  const history = [
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'rig_call_1', name: 'write_pose_keyframes', arguments: '{}' }] },
    { role: 'tool' as const, toolCallId: 'rig_call_1', content: '{"ok":true}' },
  ]
  const second: any[] = []
  await harness.service.specialistTurn({ ...baseInput(), history }, event => second.push(event))
  assert.equal(second.find(event => event.type === 'message').message.content, '挥手已完成。')
  const secondRequest = harness.requests[1].body
  assert.ok(secondRequest.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'rig_call_1'))
  assert.deepEqual(harness.service.listConversations(), [])
})

test('specialist input validation rejects malformed histories and unknown specialists', () => {
  assert.throws(() => parseSpecialistInput({ ...baseInput(), specialist: 'camera' }), /未知的骨骼动画师/)
  assert.throws(() => parseSpecialistInput({ ...baseInput(), context: '' }), /缺少角色上下文/)
  assert.throws(() => parseSpecialistInput({ ...baseInput(), brief: '' }), /缺少动作说明/)
  assert.throws(() => parseSpecialistInput({
    ...baseInput(),
    history: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] }],
  }), /缺少工具结果/)
  assert.throws(() => parseSpecialistInput({
    ...baseInput(),
    history: [{ role: 'tool', content: '{}', toolCallId: 'missing' }],
  }), /没有对应的工具调用/)
  assert.throws(() => parseSpecialistInput({
    ...baseInput(),
    history: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] },
      { role: 'tool', content: '{}', toolCallId: 'c1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: '{}' }] },
      { role: 'tool', content: '{}', toolCallId: 'c1' },
    ],
  }), /id 重复/)
})

test('a specialist turn without chat config or beyond the round limit is rejected', async t => {
  const harness = makeHarness()
  t.after(harness.cleanup)
  await assert.rejects(harness.service.specialistTurn(baseInput(), () => {}), /请先配置对话模型/)
  harness.service.saveConfig({ chat: chatConfig })

  const history: any[] = []
  for (let round = 0; round < 5; round += 1) {
    const id = `c${round}`
    history.push({ role: 'assistant', content: '', toolCalls: [{ id, name: 'write_pose_keyframes', arguments: '{}' }] })
    history.push({ role: 'tool', toolCallId: id, content: '{}' })
  }
  await assert.rejects(
    harness.service.specialistTurn({ ...baseInput(), history }, () => {}),
    /工具调用次数过多/,
  )
  assert.equal(harness.requests.length, 0)
})
