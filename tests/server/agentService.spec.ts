import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelConfigStore } from '../../server/config'
import { createAgentService } from '../../server/agent/service'
import type { AgentEvent } from '../../server/agent/types'
import type { GenerateSceneResult } from '../../server/types'

const validScene = () => ({
  version: 2 as const,
  title: '测试白模',
  walls: [],
  rooms: [],
  creations: [{ id: 'c1', a: { x: 0, y: 0 }, b: { x: 2, y: 3 }, baseZ: 0, height: 2, color: '#ddd' }],
  actors: [],
  props: [],
  lights: [],
  sun: {},
  groundColor: '#e5e5e5',
  roofEnabled: false,
  previs: {
    camera: { position: [0, -8, 3], target: [0, 0, 1], fov: 45 },
    imageComposition: {},
    evidence: [{ name: '主体', parts: ['c1'], screen: { bbox: [0, 0, 1, 1] } }],
  },
})

const sceneResult = (): GenerateSceneResult => ({
  scene: validScene() as any,
  warnings: [],
  quality: { status: 'ready', visualCheck: 'outstanding', warnings: [], corrections: [] },
})

function sseResponse(chunks: string[]): Response {
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

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoform-agent-service-'))
  const configStore = new ModelConfigStore({
    configFile: path.join(dir, 'model-config.json'),
    keyFile: path.join(dir, 'missing-key.txt'),
  })
  const requests: Array<{ url: string; body: any }> = []
  const scenes: any[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, body })
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'stub-model' }] })
    if (body?.response_format) return jsonResponse({ choices: [{ message: { content: JSON.stringify(validScene()) } }] })
    if (body?.stream) {
      const hasToolResult = Array.isArray(body.messages) && body.messages.some((message: any) => message.role === 'tool')
      if (hasToolResult) {
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"已生成白模。"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"scene_to_white_model","arguments":"{"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ])
    }
    return jsonResponse({ choices: [{ message: { content: '[]' } }] })
  }
  const service = createAgentService({
    dbFile: path.join(dir, 'agent.db'),
    configStore,
    generateScene: async input => {
      scenes.push(input)
      return sceneResult()
    },
    fetchImpl,
    sleep: async () => {},
  })
  return {
    dir,
    configStore,
    service,
    requests,
    scenes,
    cleanup: () => {
      service.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const chatConfig = {
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:9999/v1',
  apiKey: 'test-key',
  model: 'stub-chat',
}

test('chat config is required and vision falls back to chat when empty', t => {
  const harness = makeHarness()
  t.after(harness.cleanup)
  assert.equal(harness.service.config().chat.configured, false)
  harness.service.saveConfig({ chat: chatConfig })
  const config = harness.service.config()
  assert.equal(config.chat.configured, true)
  assert.equal(config.vision.usingChatFallback, true)
  assert.equal(config.vision.effectiveModel, 'stub-chat')

  harness.service.saveConfig({
    chat: chatConfig,
    vision: { provider: 'custom', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: '', model: 'stub-vision' },
  })
  const next = harness.service.config()
  assert.equal(next.vision.configured, true)
  assert.equal(next.vision.usingChatFallback, false)
  assert.equal(next.vision.effectiveModel, 'stub-vision')

  harness.service.saveConfig({ chat: chatConfig, vision: {} })
  const fallback = harness.service.config()
  assert.equal(fallback.vision.configured, false)
  assert.equal(fallback.vision.usingChatFallback, true)
})

test('turn streams a tool call, persists it, then continues with the tool result', async t => {
  const harness = makeHarness()
  t.after(harness.cleanup)
  harness.service.saveConfig({ chat: chatConfig })
  const conversation = harness.service.createConversation()
  const attachment = harness.service.addAttachment(conversation.id, {
    name: 'scene.png',
    mime: 'image/png',
    bytes: new Uint8Array([7, 8, 9]),
  })

  const first: AgentEvent[] = []
  await harness.service.turn({
    conversationId: conversation.id,
    text: '把这张图转成白模',
    attachmentIds: [attachment.id],
    sceneContext: '{"project":"测试工程"}',
  }, event => first.push(event))

  assert.equal(first[0].type, 'conversation')
  const firstMessage = first.find(event => event.type === 'message') as any
  assert.equal(firstMessage.message.toolCalls[0].name, 'scene_to_white_model')
  assert.equal(firstMessage.message.toolCalls[0].arguments, '{}')
  assert.equal(first.at(-1)?.type, 'done')
  assert.match(harness.requests[0].body.messages[0].content, /场景上下文|scene context/)
  assert.match(harness.requests[0].body.messages[0].content, /测试工程/)

  const second: AgentEvent[] = []
  await harness.service.turn({
    conversationId: conversation.id,
    toolResults: [{ toolCallId: 'call_1', content: '{"ok":true,"added":1}' }],
    sceneContext: '{"project":"测试工程"}',
  }, event => second.push(event))
  assert.equal(second.filter(event => event.type === 'delta').map((event: any) => event.text).join(''), '已生成白模。')
  const finalMessage = second.find(event => event.type === 'message') as any
  assert.equal(finalMessage.message.content, '已生成白模。')
  const toolTurn = harness.requests[1].body.messages
  assert.ok(toolTurn.some((message: any) => message.role === 'tool' && message.tool_call_id === 'call_1'))

  const detail = harness.service.getConversation(conversation.id)
  assert.deepEqual(detail?.messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant'])
  assert.equal(detail?.messages[0].attachments?.[0].id, attachment.id)
})

test('scene tool loads the attachment and forwards the note', async t => {
  const harness = makeHarness()
  t.after(harness.cleanup)
  harness.service.saveConfig({ chat: chatConfig })
  const conversation = harness.service.createConversation()
  const attachment = harness.service.addAttachment(conversation.id, {
    name: 'scene.png',
    mime: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
  })
  const result = await harness.service.runSceneTool({
    conversationId: conversation.id,
    attachmentId: attachment.id,
    note: '保留主体比例',
  })
  assert.equal(result.scene.title, '测试白模')
  assert.equal(harness.scenes.length, 1)
  assert.deepEqual(harness.scenes[0].image, new Uint8Array([1, 2, 3]))
  assert.equal(harness.scenes[0].mime, 'image/png')
  assert.equal(harness.scenes[0].prompt, '保留主体比例')
})

test('incomplete tool groups are dropped from the upstream history', async t => {
  const harness = makeHarness()
  t.after(harness.cleanup)
  harness.service.saveConfig({ chat: chatConfig })
  const conversation = harness.service.createConversation()
  await harness.service.turn({ conversationId: conversation.id, text: '第一轮', sceneContext: '' }, () => {})
  // Simulate a stopped turn: the assistant requested a tool but the result never arrived.
  const detail = harness.service.getConversation(conversation.id)!
  assert.equal(detail.messages.length, 2)
  harness.requests.length = 0
  await harness.service.turn({ conversationId: conversation.id, text: '重新开始', sceneContext: '' }, () => {})
  const sent = harness.requests[0].body.messages
  assert.ok(!sent.some((message: any) => message.tool_calls?.some((call: any) => call.id === 'call_1')))
})

test('a turn without chat config is rejected', async t => {
  const harness = makeHarness()
  t.after(harness.cleanup)
  const conversation = harness.service.createConversation()
  await assert.rejects(
    harness.service.turn({ conversationId: conversation.id, text: 'hi', sceneContext: '' }, () => {}),
    /请先配置对话模型/,
  )
})
