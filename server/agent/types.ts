// Agent-side shapes. Conversation rows are untrusted-ish local data: tool calls
// and attachment ids are parsed from JSON columns, so they are normalized before
// they reach the renderer or the upstream model.
import type { GenerateSceneResult, ModelSummary, RawModelConfig } from '../types'

export interface PublicChatConfig {
  provider: string
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
  configured: boolean
}

export interface PublicVisionConfig extends PublicChatConfig {
  usingChatFallback: boolean
  effectiveModel: string
}

export interface PublicAgentConfig {
  chat: PublicChatConfig
  vision: PublicVisionConfig
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: string
}

export interface AttachmentMeta {
  id: string
  conversationId: string
  name: string
  mime: string
  size: number
  createdAt: number
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: AgentToolCall[]
  toolCallId?: string
  attachments?: AttachmentMeta[]
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary extends Conversation {
  messageCount: number
}

export interface ConversationDetail {
  conversation: Conversation
  messages: AgentMessage[]
}

export interface TurnToolResult {
  toolCallId: string
  content: string
}

export interface TurnInput {
  conversationId: string
  text?: string
  attachmentIds?: string[]
  toolResults?: TurnToolResult[]
  sceneContext?: string
}

export type AgentEvent =
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'delta'; text: string }
  | { type: 'message'; message: AgentMessage }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface AgentModelList {
  models: ModelSummary[]
}

export interface AgentService {
  /** Empty when the conversation database is available. */
  readonly disabledReason: string
  config(): PublicAgentConfig
  saveConfig(patch: unknown): PublicAgentConfig
  listModels(scope: 'chat' | 'vision', draft?: { baseUrl?: string; apiKey?: string }): Promise<AgentModelList>
  createConversation(): Conversation
  listConversations(): ConversationSummary[]
  getConversation(id: string): ConversationDetail | null
  deleteConversation(id: string): boolean
  addAttachment(conversationId: string, input: { name: string; mime: string; bytes: Uint8Array }): AttachmentMeta
  getAttachment(id: string): { meta: AttachmentMeta; bytes: Uint8Array } | null
  runSceneTool(input: { conversationId: string; attachmentId: string; note?: string }): Promise<GenerateSceneResult>
  turn(input: TurnInput, emit: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void>
  abort(conversationId: string): void
  close(): void
}

export type EffectiveVisionConfig = RawModelConfig

export class AgentInputError extends Error {
  readonly status = 400
}

export class AgentNotFoundError extends Error {
  readonly status = 404
}

export class AgentConflictError extends Error {
  readonly status = 409
}

export class AgentUnavailableError extends Error {
  readonly status = 503
}
