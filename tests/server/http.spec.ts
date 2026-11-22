import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startAiServer, type RunningAiServer } from '../../server/http'
import type { AiService, PublicModelConfig } from '../../server/types'

const PUBLIC_CONFIG: PublicModelConfig = {
  baseUrl: 'https://api.example/v1',
  model: 'vision-model',
  apiKeyConfigured: true,
  modelConfigured: true,
}

const minimalScene = () => ({
  version: 2 as const,
  title: '测试场景',
  walls: [],
  rooms: [],
  creations: [],
  actors: [],
  props: [],
  lights: [],
  sun: {},
  groundColor: '#e5e5e5',
  roofEnabled: false,
})

function createStubService(overrides: Partial<AiService> = {}) {
  const calls: Record<string, any> = {}
  const service: AiService = {
    health: () => ({ ok: true, modelConfigured: true }),
    publicConfig: () => PUBLIC_CONFIG,
    saveConfig: patch => {
      calls.configPatch = patch
      return PUBLIC_CONFIG
    },
    listModels: async () => ({ models: [{ id: 'm1', name: 'Model 1' }], ...PUBLIC_CONFIG }),
    generateScene: async input => {
      calls.sceneInput = input
      return {
        scene: minimalScene(),
        warnings: [],
        quality: { status: 'ready', visualCheck: 'outstanding', warnings: [], corrections: [] },
      }
    },
    generatePose: async prompt => ({ pose: 'ok', prompt }),
    generateObject: async prompt => ({ object: 'ok', prompt }),
    ...overrides,
  }
  return { service, calls }
}

async function startServer(options: { service?: AiService; token?: string; staticDir?: string } = {}): Promise<RunningAiServer> {
  return startAiServer({
    service: options.service || createStubService().service,
    host: '127.0.0.1',
    port: 0,
    token: options.token,
    staticDir: options.staticDir,
    log: () => {},
  })
}

const authHeaders = (token?: string): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {}

test('health and public config are served without auth headers', async t => {
  const running = await startServer()
  t.after(async () => { await running.close() })
  const health = await fetch(`${running.origin}/api/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true, modelConfigured: true })
  const config = await fetch(`${running.origin}/api/model-config`)
  assert.equal(config.status, 200)
  assert.deepEqual(await config.json(), PUBLIC_CONFIG)
})

test('token mode protects everything except health', async t => {
  const running = await startServer({ token: 'secret' })
  t.after(async () => { await running.close() })
  assert.equal((await fetch(`${running.origin}/api/health`)).status, 200)
  assert.equal((await fetch(`${running.origin}/api/model-config`)).status, 401)
  assert.equal((await fetch(`${running.origin}/api/model-config`, { headers: authHeaders('wrong') })).status, 401)
  const authorized = await fetch(`${running.origin}/api/model-config`, { headers: authHeaders('secret') })
  assert.equal(authorized.status, 200)
  assert.deepEqual(await authorized.json(), PUBLIC_CONFIG)
})

test('CORS preflight allows localhost origins and makes private-network requests explicit', async t => {
  const running = await startServer({ token: 'secret' })
  t.after(async () => { await running.close() })
  const response = await fetch(`${running.origin}/api/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
      'Access-Control-Request-Private-Network': 'true',
    },
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.match(response.headers.get('access-control-allow-headers') || '', /authorization/)
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true')
})

test('a standalone server rejects non-local origins', async t => {
  const running = await startServer()
  t.after(async () => { await running.close() })
  const response = await fetch(`${running.origin}/api/health`, { headers: { Origin: 'https://evil.example' } })
  assert.equal(response.status, 403)
  const local = await fetch(`${running.origin}/api/health`, { headers: { Origin: 'http://localhost:5173' } })
  assert.equal(local.status, 200)
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173')
})

test('model config validates URL and model length, then saves through the service', async t => {
  const { service, calls } = createStubService()
  const running = await startServer({ service, token: 'secret' })
  t.after(async () => { await running.close() })
  const post = (body: unknown) => fetch(`${running.origin}/api/model-config`, {
    method: 'POST',
    headers: { ...authHeaders('secret'), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal((await post({ 'base-url': 'http://example.com/v1' })).status, 400)
  assert.equal((await post({ model: 'x'.repeat(181) })).status, 400)
  assert.equal((await post('not an object')).status, 400)
  const valid = await post({ 'base-url': 'https://api.example/v1', 'api-key': 'key', model: 'm' })
  assert.equal(valid.status, 200)
  assert.deepEqual(calls.configPatch, { 'base-url': 'https://api.example/v1', 'api-key': 'key', model: 'm' })
})

test('generate-scene accepts multipart uploads and forwards image data', async t => {
  const { service, calls } = createStubService()
  const running = await startServer({ service, token: 'secret' })
  t.after(async () => { await running.close() })
  const form = new FormData()
  form.append('prompt', '保留主体')
  form.append('image', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'scene.png')
  const response = await fetch(`${running.origin}/api/generate-scene`, {
    method: 'POST',
    headers: authHeaders('secret'),
    body: form,
  })
  assert.equal(response.status, 200)
  assert.equal(calls.sceneInput.prompt, '保留主体')
  assert.equal(calls.sceneInput.mime, 'image/png')
  assert.deepEqual([...calls.sceneInput.image], [137, 80, 78, 71])
})

test('generate-scene rejects wrong content types, empty uploads and huge bodies', async t => {
  const { service } = createStubService()
  const running = await startServer({ service, token: 'secret' })
  t.after(async () => { await running.close() })
  const jsonResponse = await fetch(`${running.origin}/api/generate-scene`, {
    method: 'POST',
    headers: { ...authHeaders('secret'), 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(jsonResponse.status, 400)

  const emptyForm = new FormData()
  emptyForm.append('prompt', 'no image')
  const emptyResponse = await fetch(`${running.origin}/api/generate-scene`, {
    method: 'POST',
    headers: authHeaders('secret'),
    body: emptyForm,
  })
  assert.equal(emptyResponse.status, 400)

  const huge = await fetch(`${running.origin}/api/model-config`, {
    method: 'POST',
    headers: { ...authHeaders('secret'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(9000) }),
  })
  assert.equal(huge.status, 413)
})

test('pose, object, model listing and unknown routes keep the documented shapes', async t => {
  const { service } = createStubService()
  const running = await startServer({ service, token: 'secret' })
  t.after(async () => { await running.close() })
  const post = (route: string, body: unknown) => fetch(`${running.origin}${route}`, {
    method: 'POST',
    headers: { ...authHeaders('secret'), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const pose = await post('/api/generate-pose', { prompt: '站立' })
  assert.deepEqual(await pose.json(), { pose: { pose: 'ok', prompt: '站立' } })
  const object = await post('/api/generate-object', { prompt: '箱子' })
  assert.deepEqual(await object.json(), { object: { object: 'ok', prompt: '箱子' } })
  const models = await fetch(`${running.origin}/api/models`, { headers: authHeaders('secret') })
  assert.deepEqual(await models.json(), { models: [{ id: 'm1', name: 'Model 1' }], ...PUBLIC_CONFIG })
  assert.equal((await fetch(`${running.origin}/api/nope`)).status, 401)
  const unknown = await fetch(`${running.origin}/api/nope`, { headers: authHeaders('secret') })
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), { error: '未知 API' })
})

test('upstream model listing failures are wrapped as 502 with Chinese copy', async t => {
  const { service } = createStubService({ listModels: async () => { throw new Error('boom') } })
  const running = await startServer({ service, token: 'secret' })
  t.after(async () => { await running.close() })
  const response = await fetch(`${running.origin}/api/models`, { headers: authHeaders('secret') })
  assert.equal(response.status, 502)
  const payload: any = await response.json()
  assert.match(payload.error, /^拉取模型列表失败: boom$/)
})

test('standalone static serving keeps the old 8891 web-preview workflow', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoform-static-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>MONOFORM</title>')
  const running = await startServer({ staticDir: dir })
  t.after(async () => { await running.close() })
  const index = await fetch(`${running.origin}/`)
  assert.equal(index.status, 200)
  assert.match(await index.text(), /MONOFORM/)
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal((await fetch(`${running.origin}/missing.txt`)).status, 404)
})
