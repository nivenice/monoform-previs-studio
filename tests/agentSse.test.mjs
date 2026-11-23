import test from 'node:test'
import assert from 'node:assert/strict'
import { createSseParser, readSseStream } from '../src/agentSse.js'

test('parses event names and JSON data across chunk boundaries', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.push('event: delta\ndata: {"text":"你'), [])
  assert.deepEqual(parser.push('好"}\n\nevent: done\ndata: {}\n\n'), [
    { event: 'delta', data: '{"text":"你好"}' },
    { event: 'done', data: '{}' },
  ])
})

test('handles CRLF, comments, multi-line data and a final frame without a blank line', () => {
  const parser = createSseParser()
  const first = parser.push(': ping\r\n\r\nevent: message\r\ndata: {"a":\r\ndata: 1}\r\n\r\n')
  assert.deepEqual(first, [{ event: 'message', data: '{"a":\n1}' }])
  assert.deepEqual(parser.push('data: {"tail":true}'), [])
  assert.deepEqual(parser.flush(), [{ event: 'message', data: '{"tail":true}' }])
})

test('readSseStream forwards parsed frames from a fetch-like body', async () => {
  const encoder = new TextEncoder()
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: delta\ndata: {"text":"A"}\n\n'))
      controller.enqueue(encoder.encode(': ping\n\nevent: done\ndata: {}\n\n'))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
  const events = []
  await readSseStream(response, event => events.push(event))
  assert.deepEqual(events.map(event => event.event), ['delta', 'done'])
})
