import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentStore } from '../../server/agent/store'

function makeStore(file = ':memory:') {
  return new AgentStore(file)
}

test('conversations only appear after a message and keep their first title', t => {
  const store = makeStore()
  t.after(() => store.close())
  const conversation = store.createConversation()
  assert.equal(conversation.title, '新会话')
  assert.deepEqual(store.listConversations(), [])

  store.appendMessage({ conversationId: conversation.id, role: 'user', content: '把这张图转成白模' })
  store.setTitleFromText(conversation.id, '把这张图转成白模')
  store.setTitleFromText(conversation.id, '第二条消息不应改标题')

  const list = store.listConversations()
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '把这张图转成白模')
  assert.equal(list[0].messageCount, 1)
  assert.equal(store.getConversation(conversation.id)?.conversation.title, '把这张图转成白模')
})

test('messages keep order, tool calls survive the JSON round trip and attachments join', t => {
  const store = makeStore()
  t.after(() => store.close())
  const conversation = store.createConversation()
  const attachment = store.addAttachment(conversation.id, {
    name: '场景图.png',
    mime: 'image/png',
    bytes: new Uint8Array([1, 2, 3, 4]),
  })
  store.appendMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '转白模',
    attachmentIds: [attachment.id],
  })
  store.appendMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call-1', name: 'scene_to_white_model', arguments: '{"note":"保留主体"}' }],
  })
  store.appendMessage({ conversationId: conversation.id, role: 'tool', content: '{"ok":true}', toolCallId: 'call-1' })
  store.appendMessage({ conversationId: conversation.id, role: 'assistant', content: '已加入 1 个体块。' })

  const detail = store.getConversation(conversation.id)
  assert.ok(detail)
  assert.deepEqual(detail.messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant'])
  assert.equal(detail.messages[0].attachments?.[0].name, '场景图.png')
  assert.equal(detail.messages[0].attachments?.[0].conversationId, conversation.id)
  assert.deepEqual(detail.messages[1].toolCalls, [{ id: 'call-1', name: 'scene_to_white_model', arguments: '{"note":"保留主体"}' }])
  assert.equal(detail.messages[2].toolCallId, 'call-1')
  assert.deepEqual(store.getAttachment(attachment.id)?.bytes, new Uint8Array([1, 2, 3, 4]))
})

test('deleting a conversation cascades messages and attachments', t => {
  const store = makeStore()
  t.after(() => store.close())
  const conversation = store.createConversation()
  const attachment = store.addAttachment(conversation.id, {
    name: 'a.png',
    mime: 'image/png',
    bytes: new Uint8Array([9]),
  })
  store.appendMessage({ conversationId: conversation.id, role: 'user', content: 'hi', attachmentIds: [attachment.id] })
  assert.equal(store.deleteConversation(conversation.id), true)
  assert.equal(store.getConversation(conversation.id), null)
  assert.equal(store.getAttachment(attachment.id), null)
  assert.equal(store.deleteConversation(conversation.id), false)
})

test('a file-backed store reopens with the same conversation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoform-agent-store-'))
  let second: AgentStore | null = null
  t.after(() => {
    second?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, 'agent.db')
  const first = makeStore(file)
  const conversation = first.createConversation()
  first.appendMessage({ conversationId: conversation.id, role: 'user', content: '持久化' })
  first.close()

  second = makeStore(file)
  const detail = second.getConversation(conversation.id)
  assert.ok(detail)
  assert.equal(detail.messages.length, 1)
  assert.equal(detail.messages[0].content, '持久化')
})

test('titles are truncated per character and empty text is ignored', t => {
  const store = makeStore()
  t.after(() => store.close())
  const conversation = store.createConversation()
  store.setTitleFromText(conversation.id, '')
  assert.equal(store.getConversation(conversation.id)?.conversation.title, '新会话')
  store.setTitleFromText(conversation.id, '一'.repeat(40))
  assert.equal(store.getConversation(conversation.id)?.conversation.title.length, 24)
})
