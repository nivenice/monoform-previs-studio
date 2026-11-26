import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAiService } from '../../server/index'
import { startAiServer, type RunningAiServer } from '../../server/http'

const validScene = () => ({
  version: 2,
  title: 'HTTP 白模',
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

async function startHarness(options: { token?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoform-agent-http-'))
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'stub-model', name: 'Stub' }] })
    if (body?.response_format) return jsonResponse({ choices: [{ message: { content: JSON.stringify(validScene()) } }] })
    if (body?.stream) {
      const rigTools = Array.isArray(body.tools) && body.tools.some((tool: any) => tool.function?.name === 'write_pose_keyframes')
      if (rigTools) {
        const hasToolResult = Array.isArray(body.messages) && body.messages.some((message: any) => message.role === 'tool')
        if (hasToolResult) {
          return sseResponse(['data: {"choices":[{"delta":{"content":"挥手已完成。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
        }
        const call = {
          index: 0,
          id: 'rig_call_1',
          type: 'function',
          function: { name: 'write_pose_keyframes', arguments: '{"frames":[]}' },
        }
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ])
      }
      const hasTool = Array.isArray(body.messages) && body.messages.some((message: any) => message.role === 'tool')
      if (hasTool) {
        return sseResponse(['data: {"choices":[{"delta":{"content":"已生成白模。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'])
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"scene_to_white_model","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    }
    return jsonResponse({ choices: [{ message: { content: '[]' } }] })
  }
  const service = createAiService({
    configFile: path.join(dir, 'model-config.json'),
    keyFile: path.join(dir, 'key.txt'),
    skillsDir: path.join(dir, 'skills'),
    agentDbFile: path.join(dir, 'agent.db'),
    fetchImpl,
    sleep: async () => {},
  })
  let running: RunningAiServer | null = null
  const origin = await startAiServer({
    service,
    token: options.token,
    log: () => {},
  }).then(value => {
    running = value
    return value.origin
  })
  return {
    origin,
    service,
    async close() {
      await running?.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

const headers = (token?: string): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {}
const jsonHeaders = (token?: string): Record<string, string> => ({ 'Content-Type': 'application/json', ...headers(token) })

function parseSse(text: string): Array<{ event: string; data: any }> {
  return text.split(/\r?\n\r?\n/).map(frame => {
    let event = 'message'
    const data = []
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!data.length) return null
    return { event, data: JSON.parse(data.join('\n')) }
  }).filter(Boolean) as Array<{ event: string; data: any }>
}

test('agent config is public-safe, saves chat + vision and lists models through drafts', async t => {
  const harness = await startHarness()
  t.after(() => harness.close())
  const initial = await fetch(`${harness.origin}/api/agent/config`)
  assert.equal(initial.status, 200)
  const initialJson: any = await initial.json()
  assert.equal(initialJson.chat.configured, false)
  assert.equal(initialJson.chat.apiKey, undefined)
  assert.equal(initialJson.vision.usingChatFallback, false)

  const saved = await fetch(`${harness.origin}/api/agent/config`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      chat: { provider: 'custom', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'secret-key', model: 'stub-chat' },
      vision: { provider: '', baseUrl: '', apiKey: '', model: '' },
    }),
  })
  assert.equal(saved.status, 200)
  const savedJson: any = await saved.json()
  assert.equal(savedJson.chat.configured, true)
  assert.equal(savedJson.chat.apiKey, undefined)
  assert.equal(savedJson.vision.usingChatFallback, true)

  const models = await fetch(`${harness.origin}/api/agent/models`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ scope: 'chat', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'other-key' }),
  })
  assert.equal(models.status, 200)
  assert.deepEqual(await models.json(), { models: [{ id: 'stub-model', name: 'Stub' }] })
})

test('conversation endpoints cover create, upload, SSE turn, detail and delete', async t => {
  const harness = await startHarness()
  t.after(() => harness.close())
  await fetch(`${harness.origin}/api/agent/config`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ chat: { provider: 'custom', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'secret-key', model: 'stub-chat' } }),
  })

  const created = await fetch(`${harness.origin}/api/agent/conversations`, { method: 'POST' })
  assert.equal(created.status, 200)
  const createdJson: any = await created.json()
  const conversation: any = createdJson.conversation
  const listBefore = await fetch(`${harness.origin}/api/agent/conversations`)
  assert.deepEqual(await listBefore.json(), { conversations: [] })

  const form = new FormData()
  form.append('image', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), 'scene.png')
  const uploaded = await fetch(`${harness.origin}/api/agent/conversations/${conversation.id}/attachments`, {
    method: 'POST',
    body: form,
  })
  assert.equal(uploaded.status, 200)
  const uploadedJson: any = await uploaded.json()
  const attachment: any = uploadedJson.attachment
  assert.equal(attachment.name, 'scene.png')

  const attachmentResponse = await fetch(`${harness.origin}/api/agent/attachments/${attachment.id}`)
  assert.equal(attachmentResponse.status, 200)
  assert.deepEqual(new Uint8Array(await attachmentResponse.arrayBuffer()), new Uint8Array([1, 2, 3, 4]))

  const turn = await fetch(`${harness.origin}/api/agent/turn`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      conversationId: conversation.id,
      text: '把这张图转成白模',
      attachmentIds: [attachment.id],
      sceneContext: '{"project":"HTTP 测试"}',
    }),
  })
  assert.equal(turn.status, 200)
  assert.match(turn.headers.get('content-type') || '', /text\/event-stream/)
  const events = parseSse(await turn.text())
  assert.equal(events[0].event, 'conversation')
  const messageEvent = events.find(event => event.event === 'message')
  assert.ok(messageEvent)
  assert.equal(messageEvent.data.message.toolCalls[0].name, 'scene_to_white_model')
  assert.equal(events.at(-1)?.event, 'done')

  const withTool = await fetch(`${harness.origin}/api/agent/turn`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      conversationId: conversation.id,
      toolResults: [{ toolCallId: 'call_1', content: '{"ok":true,"added":1}' }],
      sceneContext: '{"project":"HTTP 测试"}',
    }),
  })
  const toolEvents = parseSse(await withTool.text())
  assert.equal(toolEvents.filter(event => event.event === 'delta').map(event => event.data.text).join(''), '已生成白模。')

  const detailResponse = await fetch(`${harness.origin}/api/agent/conversations/${conversation.id}`)
  assert.equal(detailResponse.status, 200)
  const detail: any = await detailResponse.json()
  assert.deepEqual(detail.messages.map((message: any) => message.role), ['user', 'assistant', 'tool', 'assistant'])

  const tool = await fetch(`${harness.origin}/api/agent/scene-to-white-model`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ conversationId: conversation.id, attachmentId: attachment.id, note: '保留主体' }),
  })
  assert.equal(tool.status, 200)
  const toolJson: any = await tool.json()
  assert.equal(toolJson.scene.title, 'HTTP 白模')
  assert.equal(toolJson.scene.creations.length, 1)

  const deleted = await fetch(`${harness.origin}/api/agent/conversations/${conversation.id}`, { method: 'DELETE' })
  assert.equal(deleted.status, 200)
  assert.equal((await fetch(`${harness.origin}/api/agent/conversations/${conversation.id}`)).status, 404)
  assert.deepEqual(await (await fetch(`${harness.origin}/api/agent/conversations`)).json(), { conversations: [] })
})

test('the specialist turn endpoint streams rig tool calls without creating a conversation', async t => {
  const harness = await startHarness()
  t.after(() => harness.close())
  await fetch(`${harness.origin}/api/agent/config`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ chat: { provider: 'custom', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'secret-key', model: 'stub-chat' } }),
  })

  const response = await fetch(`${harness.origin}/api/agent/specialist/turn`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      specialist: 'rig',
      context: '{"target":{"id":"actor-lead"}}',
      brief: '抬手挥两下',
      history: [],
    }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/)
  const events = parseSse(await response.text())
  const message = events.find(event => event.event === 'message')
  assert.equal(message?.data.message.toolCalls[0].name, 'write_pose_keyframes')
  assert.equal(events.at(-1)?.event, 'done')
  assert.deepEqual(await (await fetch(`${harness.origin}/api/agent/conversations`)).json(), { conversations: [] })

  const invalid = await fetch(`${harness.origin}/api/agent/specialist/turn`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ specialist: 'rig', context: '{}' }),
  })
  assert.equal(invalid.status, 400)
  const invalidJson: any = await invalid.json()
  assert.match(invalidJson.error, /动作说明/)

  const unknown = await fetch(`${harness.origin}/api/agent/specialist/turn`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ specialist: 'camera', context: '{}', brief: 'x' }),
  })
  assert.equal(unknown.status, 400)
})

test('agent routes use the same bearer token gate', async t => {
  const harness = await startHarness({ token: 'secret' })
  t.after(() => harness.close())
  assert.equal((await fetch(`${harness.origin}/api/agent/config`)).status, 401)
  assert.equal((await fetch(`${harness.origin}/api/agent/config`, { headers: headers('wrong') })).status, 401)
  assert.equal((await fetch(`${harness.origin}/api/agent/specialist/turn`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ specialist: 'rig', context: '{}', brief: '挥手', history: [] }),
  })).status, 401)
  const allowed = await fetch(`${harness.origin}/api/agent/config`, { headers: headers('secret') })
  assert.equal(allowed.status, 200)
})

test('unknown agent routes and invalid ids return Chinese 4xx errors', async t => {
  const harness = await startHarness()
  t.after(() => harness.close())
  const unknown = await fetch(`${harness.origin}/api/agent/nope`)
  assert.equal(unknown.status, 404)
  const unknownJson: any = await unknown.json()
  assert.match(unknownJson.error, /未知 API/)
  const invalid = await fetch(`${harness.origin}/api/agent/conversations/bad`, { method: 'DELETE' })
  assert.equal(invalid.status, 400)
})
