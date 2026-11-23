import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentMessage,
  AgentToolCall,
  AttachmentMeta,
  Conversation,
  ConversationDetail,
  ConversationSummary,
} from './types'

type SqliteModule = typeof import('node:sqlite')

// node:sqlite is only loaded when the running Node provides it. This keeps the
// rest of the local AI service (scene generation, health) alive on an older
// runtime instead of failing at module evaluation time.
function loadSqlite(): SqliteModule | null {
  try {
    const getBuiltin = process.getBuiltinModule
    if (typeof getBuiltin !== 'function') return null
    return getBuiltin('node:sqlite') as SqliteModule
  } catch {
    return null
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  tool_call_id TEXT,
  attachment_ids TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
`

const EMPTY_CONVERSATION_TTL = 24 * 60 * 60 * 1000

interface ConversationRow {
  id: string
  title: string
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls: string | null
  tool_call_id: string | null
  attachment_ids: string | null
  created_at: number
}

interface AttachmentRow {
  id: string
  conversation_id: string
  name: string
  mime: string
  size: number
  bytes: Uint8Array
  created_at: number
}

const parseStringArray = (value: string | null): string[] => {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(item => String(item)).filter(Boolean) : []
  } catch {
    return []
  }
}

const parseToolCalls = (value: string | null): AgentToolCall[] | undefined => {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    const calls = parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map(item => ({
        id: String(item.id || ''),
        name: String(item.name || ''),
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      }))
      .filter(item => item.id && item.name)
    return calls.length ? calls : undefined
  } catch {
    return undefined
  }
}

const attachmentMeta = (row: AttachmentRow): AttachmentMeta => ({
  id: row.id,
  conversationId: row.conversation_id,
  name: row.name,
  mime: row.mime,
  size: row.size,
  createdAt: row.created_at,
})

const conversationOf = (row: ConversationRow): Conversation => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const titleFromText = (text: string): string => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat ? [...flat].slice(0, 24).join('') : ''
}

export class AgentStore {
  private readonly db: DatabaseSync
  private closed = false

  constructor(file: string) {
    const sqlite = loadSqlite()
    if (!sqlite) {
      throw new Error('当前运行环境不支持 node:sqlite；会话功能需要 Node 22.13 或更新版本')
    }
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new sqlite.DatabaseSync(file)
    this.db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined)?.user_version || 0)
    if (version > 1) throw new Error('会话数据库版本过新；请更新 MONOFORM')
    this.db.exec(SCHEMA)
    if (version < 1) this.db.exec('PRAGMA user_version = 1')
    this.pruneEmptyConversations()
  }

  private requireOpen(): DatabaseSync {
    if (this.closed) throw new Error('会话数据库已关闭')
    return this.db
  }

  createConversation(): Conversation {
    const now = Date.now()
    const conversation: Conversation = {
      id: `c-${randomUUID()}`,
      title: '新会话',
      createdAt: now,
      updatedAt: now,
    }
    this.requireOpen()
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt)
    return conversation
  }

  listConversations(): ConversationSummary[] {
    const rows = this.requireOpen().prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at, COUNT(m.id) AS message_count
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `).all() as unknown as Array<ConversationRow & { message_count: number }>
    return rows.map(row => ({
      ...conversationOf(row),
      messageCount: Number(row.message_count) || 0,
    }))
  }

  getConversation(id: string): ConversationDetail | null {
    const db = this.requireOpen()
    const row = db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?').get(id) as unknown as ConversationRow | undefined
    if (!row) return null
    const messages = db.prepare(`
      SELECT id, conversation_id, role, content, tool_calls, tool_call_id, attachment_ids, created_at
      FROM messages WHERE conversation_id = ? ORDER BY rowid
    `).all(id) as unknown as MessageRow[]
    const attachments = db.prepare(`
      SELECT id, conversation_id, name, mime, size, bytes, created_at
      FROM attachments WHERE conversation_id = ?
    `).all(id) as unknown as AttachmentRow[]
    const attachmentMap = new Map(attachments.map(item => [item.id, attachmentMeta(item)]))
    return {
      conversation: conversationOf(row),
      messages: messages.map(message => {
        const ids = parseStringArray(message.attachment_ids)
        const toolCalls = parseToolCalls(message.tool_calls)
        return {
          id: message.id,
          role: message.role,
          content: message.content,
          ...(toolCalls ? { toolCalls } : {}),
          ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
          ...(ids.length ? { attachments: ids.map(attachmentId => attachmentMap.get(attachmentId)).filter(Boolean) as AttachmentMeta[] } : {}),
          createdAt: message.created_at,
        }
      }),
    }
  }

  conversationExists(id: string): boolean {
    return Boolean(this.requireOpen().prepare('SELECT 1 AS present FROM conversations WHERE id = ?').get(id))
  }

  deleteConversation(id: string): boolean {
    const result = this.requireOpen().prepare('DELETE FROM conversations WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  setTitleFromText(id: string, text: string): void {
    const title = titleFromText(text)
    if (!title) return
    this.requireOpen()
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND title = '新会话'")
      .run(title, Date.now(), id)
  }

  appendMessage(input: {
    conversationId: string
    role: 'user' | 'assistant' | 'tool'
    content?: string
    toolCalls?: AgentToolCall[]
    toolCallId?: string
    attachmentIds?: string[]
  }): AgentMessage {
    const db = this.requireOpen()
    const now = Date.now()
    const id = `m-${randomUUID()}`
    const content = String(input.content || '')
    const toolCalls = input.toolCalls?.length ? input.toolCalls : undefined
    const attachmentIds = input.attachmentIds?.length ? input.attachmentIds : undefined
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_call_id, attachment_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.role,
      content,
      toolCalls ? JSON.stringify(toolCalls) : null,
      input.toolCallId || null,
      attachmentIds ? JSON.stringify(attachmentIds) : null,
      now,
    )
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, input.conversationId)
    const attachments = attachmentIds
      ? (db.prepare(`
          SELECT id, conversation_id, name, mime, size, bytes, created_at
          FROM attachments WHERE conversation_id = ? AND id IN (${attachmentIds.map(() => '?').join(',')})
        `).all(input.conversationId, ...attachmentIds) as unknown as AttachmentRow[]).map(attachmentMeta)
      : undefined
    return {
      id,
      role: input.role,
      content,
      ...(toolCalls ? { toolCalls } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      createdAt: now,
    }
  }

  addAttachment(conversationId: string, input: { name: string; mime: string; bytes: Uint8Array }): AttachmentMeta {
    const db = this.requireOpen()
    const now = Date.now()
    const meta: AttachmentMeta = {
      id: `att-${randomUUID()}`,
      conversationId,
      name: String(input.name || '场景图').slice(0, 120),
      mime: input.mime,
      size: input.bytes.length,
      createdAt: now,
    }
    db.prepare(`
      INSERT INTO attachments (id, conversation_id, name, mime, size, bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(meta.id, conversationId, meta.name, meta.mime, meta.size, input.bytes, now)
    return meta
  }

  getAttachment(id: string): { meta: AttachmentMeta; bytes: Uint8Array } | null {
    const row = this.requireOpen().prepare(`
      SELECT id, conversation_id, name, mime, size, bytes, created_at
      FROM attachments WHERE id = ?
    `).get(id) as unknown as AttachmentRow | undefined
    if (!row) return null
    return { meta: attachmentMeta(row), bytes: row.bytes }
  }

  private pruneEmptyConversations(): void {
    const cutoff = Date.now() - EMPTY_CONVERSATION_TTL
    this.requireOpen().prepare(`
      DELETE FROM conversations
      WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)
    `).run(cutoff)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      if (this.db.isOpen) this.db.close()
    } catch {
      // Closing on process shutdown must never throw into Electron's quit path.
    }
  }
}
