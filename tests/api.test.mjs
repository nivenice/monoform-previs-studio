import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api.js'

async function withFetchStub(run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('browser api keeps relative urls and adds no authorization header', async () => {
  const api = createApi({})
  assert.equal(api.url('/api/health'), '/api/health')
  await withFetchStub(async calls => {
    await api.fetch('/api/health')
    assert.equal(calls[0].url, '/api/health')
    assert.equal(new Headers(calls[0].options.headers).get('Authorization'), null)
  })
})

test('electron api prefixes the loopback origin and sends the bearer token', async () => {
  const api = createApi({ baseUrl: 'http://127.0.0.1:4321', token: 'token-123' })
  assert.equal(api.url('/api/health'), 'http://127.0.0.1:4321/api/health')
  await withFetchStub(async calls => {
    await api.fetch('/api/health', { headers: { 'X-Test': '1' } })
    assert.equal(calls[0].url, 'http://127.0.0.1:4321/api/health')
    const headers = new Headers(calls[0].options.headers)
    assert.equal(headers.get('Authorization'), 'Bearer token-123')
    assert.equal(headers.get('X-Test'), '1')
  })
})

test('an unavailable electron service rejects with its Chinese message before fetching', async () => {
  const api = createApi({ baseUrl: '', unavailableMessage: '本地识图服务启动失败：端口占用' })
  await withFetchStub(async calls => {
    await assert.rejects(api.fetch('/api/health'), /本地识图服务启动失败/)
    assert.equal(calls.length, 0)
  })
})
