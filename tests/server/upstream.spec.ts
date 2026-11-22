import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chatEndpoint,
  chatJson,
  fetchRemoteModels,
  modelsEndpoint,
  parseJsonFromModel,
  stripCodeFence,
} from '../../server/upstream'

const CFG = { 'base-url': 'https://api.example/v1', 'api-key': 'secret', model: 'vision-model' }

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('endpoint builders preserve the special /chat/completions form', () => {
  assert.equal(chatEndpoint('https://api.example/v1'), 'https://api.example/v1/chat/completions')
  assert.equal(chatEndpoint('https://api.example/v1/chat/completions/'), 'https://api.example/v1/chat/completions')
  assert.equal(modelsEndpoint('https://api.example/v1'), 'https://api.example/v1/models')
  assert.equal(modelsEndpoint('https://api.example/v1/chat/completions'), 'https://api.example/v1/models')
})

test('fetchRemoteModels sends auth headers and maps model rows', async () => {
  let captured: any = null
  const fetchImpl = (async (url: string, init: any) => {
    captured = { url, init }
    return jsonResponse({ data: [{ id: 'm1', name: 'Model 1' }, { id: 'm2' }, { name: 'no id' }] })
  }) as unknown as typeof fetch
  const models = await fetchRemoteModels(CFG, { fetchImpl })
  assert.equal(captured.url, 'https://api.example/v1/models')
  assert.equal(captured.init.headers.Authorization, 'Bearer secret')
  assert.equal(captured.init.headers['X-Title'], 'MONOFORM Scene to White Model')
  assert.deepEqual(models, [
    { id: 'm1', name: 'Model 1' },
    { id: 'm2', name: 'm2' },
  ])
})

test('fetchRemoteModels does not retry 4xx but retries 5xx', async () => {
  let count = 0
  const fetch4xx = (async () => {
    count++
    return jsonResponse({ error: 'bad request' }, 400)
  }) as unknown as typeof fetch
  await assert.rejects(fetchRemoteModels(CFG, { fetchImpl: fetch4xx, sleep: async () => {} }), /HTTP 400: \{"error":"bad request"\}/)
  assert.equal(count, 1)

  count = 0
  const fetch5xx = (async () => {
    count++
    return count === 1 ? jsonResponse({ error: 'temporary' }, 500) : jsonResponse([{ id: 'm3' }])
  }) as unknown as typeof fetch
  const models = await fetchRemoteModels(CFG, { fetchImpl: fetch5xx, sleep: async () => {} })
  assert.equal(count, 2)
  assert.deepEqual(models, [{ id: 'm3', name: 'm3' }])
})

test('fetchRemoteModels retries network errors three times', async () => {
  let count = 0
  const fetchImpl = (async () => {
    count++
    throw new Error('socket closed')
  }) as unknown as typeof fetch
  await assert.rejects(
    fetchRemoteModels(CFG, { fetchImpl, sleep: async () => {} }),
    /上游模型服务连接失败: socket closed/,
  )
  assert.equal(count, 3)
})

test('fetchRemoteModels requires base-url and api-key', async () => {
  await assert.rejects(fetchRemoteModels({ model: 'm' }), /请先配置 base-url 和 api-key/)
})

test('chatJson builds the JSON-mode payload and parses fenced JSON', async () => {
  let captured: any = null
  const fetchImpl = (async (url: string, init: any) => {
    captured = { url, init }
    return jsonResponse({ choices: [{ message: { content: '```json\n{"camera":"ok"}\n```' } }] })
  }) as unknown as typeof fetch
  const result = await chatJson(CFG, 'system prompt', 'user prompt', { fetchImpl, sleep: async () => {} })
  assert.deepEqual(result, { camera: 'ok' })
  assert.equal(captured.url, 'https://api.example/v1/chat/completions')
  const payload = JSON.parse(captured.init.body)
  assert.equal(payload.model, 'vision-model')
  assert.equal(payload.temperature, 0.1)
  assert.deepEqual(payload.response_format, { type: 'json_object' })
  assert.equal(payload.messages[0].content, 'system prompt')
  assert.equal(payload.messages[1].content[0].text, 'user prompt')
})

test('chatJson attaches images as data URLs and joins list content', async () => {
  let captured: any = null
  const fetchImpl = (async (_url: string, init: any) => {
    captured = init
    return jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }] } }] })
  }) as unknown as typeof fetch
  const result = await chatJson(CFG, 'system', 'user', {
    fetchImpl,
    sleep: async () => {},
    image: new Uint8Array([1, 2, 3]),
    mime: 'image/png',
  })
  assert.deepEqual(result, { ok: true })
  const payload = JSON.parse(captured.body)
  assert.equal(payload.messages[1].content[1].type, 'image_url')
  assert.equal(payload.messages[1].content[1].image_url.url, 'data:image/png;base64,AQID')
})

test('chatJson parses the first complete JSON value after prose', async () => {
  const fetchImpl = (async () => jsonResponse({
    choices: [{ message: { content: '说明文字：{"version":2,"title":"x"} 后面是多余说明' } }],
  })) as unknown as typeof fetch
  const result = await chatJson(CFG, 'system', 'user', { fetchImpl, sleep: async () => {} })
  assert.deepEqual(result, { version: 2, title: 'x' })
})

test('chatJson surfaces 4xx immediately and retries 5xx three times', async () => {
  let count = 0
  const fetch4xx = (async () => {
    count++
    return new Response('bad key', { status: 401 })
  }) as unknown as typeof fetch
  await assert.rejects(chatJson(CFG, 's', 'u', { fetchImpl: fetch4xx, sleep: async () => {} }), /模型服务 HTTP 401: bad key/)
  assert.equal(count, 1)

  count = 0
  const fetch5xx = (async () => {
    count++
    return new Response('upstream down', { status: 503 })
  }) as unknown as typeof fetch
  await assert.rejects(chatJson(CFG, 's', 'u', { fetchImpl: fetch5xx, sleep: async () => {} }), /模型服务 HTTP 503: upstream down/)
  assert.equal(count, 3)
})

test('chatJson rejects incomplete configuration and non-JSON output', async () => {
  await assert.rejects(chatJson({}, 's', 'u'), /缺少 base-url、api-key 或 model/)
  const fetchImpl = (async () => jsonResponse({ choices: [{ message: { content: 'no json here' } }] })) as unknown as typeof fetch
  await assert.rejects(chatJson(CFG, 's', 'u', { fetchImpl, sleep: async () => {} }), /模型没有返回 JSON/)
})

test('stripCodeFence and parseJsonFromModel handle common model output', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}')
  assert.deepEqual(parseJsonFromModel('前缀 [1,2,3] 后缀'), [1, 2, 3])
  assert.throws(() => parseJsonFromModel('plain text'), /模型没有返回 JSON/)
})
