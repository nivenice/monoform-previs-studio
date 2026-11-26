import test from 'node:test'
import assert from 'node:assert/strict'
import { requestRigSpecialistTurn } from '../src/agentApi.js'

const sse = frames => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')

test('the renderer posts the rig context/history and returns the final assistant message', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(sse([
      { type: 'delta', text: '正在思考' },
      { type: 'message', message: { id: 'm1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_character_state', arguments: '{}' }] } },
      { type: 'done' },
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const message = await requestRigSpecialistTurn({
      context: '{"target":{"id":"actor-lead"}}',
      brief: '挥手',
      history: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'write_pose_keyframes', arguments: '{}' }] }],
    })
    assert.equal(message.id, 'm1')
    assert.equal(message.toolCalls[0].name, 'get_character_state')
    assert.equal(calls[0].url, '/api/agent/specialist/turn')
    assert.equal(calls[0].body.specialist, 'rig')
    assert.equal(calls[0].body.context, '{"target":{"id":"actor-lead"}}')
    assert.equal(calls[0].body.brief, '挥手')
    assert.equal(calls[0].body.history.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a specialist error event becomes a thrown Chinese error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(sse([{ type: 'error', message: '模型超时' }]), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  try {
    await assert.rejects(
      requestRigSpecialistTurn({ context: '{}', brief: '挥手', history: [] }),
      /模型超时/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
