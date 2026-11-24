import type { GenerateSceneResult, RawModelConfig } from '../types'
import type { ModelConfigStore } from '../config'
import { fetchRemoteModels } from '../upstream'
import { AgentStore } from './store'
import { buildSystemPrompt, describeAttachmentNote } from './prompt'
import { streamChatCompletion } from './upstream'
import type {
  AgentEvent,
  AgentMessage,
  AgentService,
  AgentToolCall,
  Conversation,
  ConversationDetail,
  ConversationSummary,
  PublicAgentConfig,
  TurnInput,
  TurnToolResult,
} from './types'
import {
  AgentConflictError,
  AgentInputError,
  AgentNotFoundError,
  AgentUnavailableError,
} from './types'

export interface CreateAgentServiceOptions {
  dbFile?: string
  configStore: ModelConfigStore
  generateScene: (input: { image: Uint8Array; mime: string; prompt: string }) => Promise<GenerateSceneResult>
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const MAX_TEXT = 32_000
const MAX_TOOL_RESULT = 8_000
const MAX_SCENE_CONTEXT = 16_000
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_ATTACHMENTS = 4
const MAX_TOOL_ROUNDS = 8
const MAX_MODEL_LENGTH = 180
const MAX_PROVIDER_LENGTH = 40
const MAX_API_KEY_LENGTH = 4_096
const MAX_BASE_URL_LENGTH = 500
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value).trim()

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

function validateBaseUrl(value: string): string {
  if (!value) return ''
  if (value.length > MAX_BASE_URL_LENGTH) throw new AgentInputError('API 地址过长')
  if (!/^https:\/\//i.test(value) && !/^http:\/\/127\.0\.0\.1:\d+/i.test(value) && !/^http:\/\/localhost:\d+/i.test(value)) {
    throw new AgentInputError('API 地址必须是 HTTPS 或本机地址')
  }
  return value.replace(/\/+$/, '')
}

function validateModel(value: string): string {
  if (!value) throw new AgentInputError('请填写模型 ID')
  if (value.length > MAX_MODEL_LENGTH) throw new AgentInputError(`模型 ID 不能超过 ${MAX_MODEL_LENGTH} 个字符`)
  return value
}

function validateApiKey(value: string): string {
  if (value.length > MAX_API_KEY_LENGTH) throw new AgentInputError('API Key 过长')
  return value
}

function chatRawConfig(store: ModelConfigStore): RawModelConfig | null {
  const chat = store.chatConfig()
  const baseUrl = chat['chat-base-url'] || ''
  const apiKey = chat['chat-api-key'] || ''
  const model = chat['chat-model'] || ''
  if (!baseUrl || !apiKey || !model) return null
  return { 'base-url': baseUrl, 'api-key': apiKey, model }
}

function messageLength(message: AgentMessage): number {
  return message.content.length + (message.toolCalls || []).reduce((sum, call) => sum + call.arguments.length, 0)
}

function historyMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  // Drop assistant tool_calls whose results never arrived (stopped turn, crash)
  // so the next upstream request is always structurally valid.
  const valid: AgentMessage[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const expected = new Set(message.toolCalls.map(call => call.id))
      const results: AgentMessage[] = []
      let next = index + 1
      while (next < messages.length && messages[next].role === 'tool') {
        results.push(messages[next])
        next += 1
      }
      const answered = new Set(results.map(item => item.toolCallId).filter(Boolean))
      if ([...expected].every(id => answered.has(id))) valid.push(message, ...results)
      index = next - 1
      continue
    }
    if (message.role === 'tool') continue
    valid.push(message)
  }

  // Trim at user-message boundaries so a tool_call never loses its result.
  const segments: AgentMessage[][] = []
  let current: AgentMessage[] = []
  for (const message of valid) {
    if (message.role === 'user' && current.length) {
      segments.push(current)
      current = []
    }
    current.push(message)
  }
  if (current.length) segments.push(current)
  const total = (items: AgentMessage[][]): number => items.reduce((sum, segment) => sum + segment.reduce((inner, message) => inner + messageLength(message), 0), 0)
  while (segments.length > 1 && (segments.length > 12 || total(segments) > 48_000)) segments.shift()

  return segments.flat().map(message => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: message.content + describeAttachmentNote(message.attachments || []),
      }
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        } : {}),
      }
    }
    return { role: 'tool', tool_call_id: message.toolCallId || '', content: message.content }
  })
}

function toolRoundCount(messages: AgentMessage[]): number {
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  return messages
    .slice(lastUser + 1)
    .filter(message => message.role === 'assistant' && Boolean(message.toolCalls?.length))
    .length
}

export function createAgentService(options: CreateAgentServiceOptions): AgentService {
  let store: AgentStore | null = null
  let disabledReason = ''
  if (!options.dbFile) {
    disabledReason = '未配置会话数据库；会话功能不可用'
  } else {
    try {
      store = new AgentStore(options.dbFile)
    } catch (error) {
      disabledReason = `会话数据库不可用：${errorMessage(error)}`
    }
  }
  const active = new Map<string, AbortController>()

  const requireStore = (): AgentStore => {
    if (!store) throw new AgentUnavailableError(disabledReason || '会话数据库不可用')
    return store
  }

  const config = (): PublicAgentConfig => options.configStore.publicAgentConfig()

  const saveConfig = (patch: unknown): PublicAgentConfig => {
    const source = isObject(patch) ? patch : {}
    const currentChat = options.configStore.chatConfig()
    const currentVision = options.configStore.load()
    let chatValues: { provider: string; baseUrl: string; model: string; apiKey: string } | null = null
    let visionValues: { provider: string; baseUrl: string; model: string; apiKey: string } | null = null
    let clearVision = false

    if (isObject(source.chat)) {
      const raw = source.chat
      const baseUrl = validateBaseUrl(text(raw.baseUrl))
      if (!baseUrl) throw new AgentInputError('请填写对话模型的 API 地址')
      const model = validateModel(text(raw.model))
      const provider = text(raw.provider).slice(0, MAX_PROVIDER_LENGTH) || currentChat['chat-provider'] || 'custom'
      const oldBaseUrl = currentChat['chat-base-url'] || ''
      const apiKey = validateApiKey(text(raw.apiKey))
      if (oldBaseUrl && oldBaseUrl !== baseUrl && !apiKey) {
        throw new AgentInputError('更换 API 地址后请重新填写 API Key')
      }
      const effectiveKey = apiKey || (oldBaseUrl === baseUrl ? currentChat['chat-api-key'] || '' : '')
      if (!effectiveKey) throw new AgentInputError('请填写对话模型的 API Key')
      chatValues = { provider, baseUrl, model, apiKey: effectiveKey }
    }

    if ('vision' in source) {
      const raw = source.vision
      if (raw === null) {
        clearVision = true
      } else if (isObject(raw)) {
        const anyValue = ['provider', 'baseUrl', 'apiKey', 'model'].some(key => Boolean(text(raw[key])))
        if (anyValue) {
          const baseUrl = validateBaseUrl(text(raw.baseUrl))
          if (!baseUrl) throw new AgentInputError('识图模型配置不完整：请填写 API 地址，或全部留空以复用对话模型')
          const model = validateModel(text(raw.model))
          const provider = text(raw.provider).slice(0, MAX_PROVIDER_LENGTH) || currentVision.provider || 'custom'
          const oldBaseUrl = currentVision['base-url'] || ''
          const apiKey = validateApiKey(text(raw.apiKey))
          if (oldBaseUrl && oldBaseUrl !== baseUrl && !apiKey) {
            throw new AgentInputError('更换识图 API 地址后请重新填写 API Key')
          }
          const chat = options.configStore.chatConfig()
          const sameAsChat = Boolean(chat['chat-base-url']) && baseUrl === chat['chat-base-url']
          const effectiveKey = apiKey
            || (oldBaseUrl === baseUrl ? currentVision['api-key'] || '' : '')
            || (sameAsChat ? chat['chat-api-key'] || '' : '')
          if (!effectiveKey) throw new AgentInputError('请填写识图模型的 API Key')
          visionValues = { provider, baseUrl, model, apiKey: effectiveKey }
        } else {
          clearVision = true
        }
      } else {
        throw new AgentInputError('识图配置格式无效')
      }
    }

    const prospectiveChatConfigured = Boolean(chatValues) || options.configStore.publicAgentConfig().chat.configured
    if (!prospectiveChatConfigured) throw new AgentInputError('请先配置对话模型')

    if (chatValues) options.configStore.saveChat(chatValues)
    if (visionValues) {
      options.configStore.save({
        provider: visionValues.provider,
        'base-url': visionValues.baseUrl,
        'api-key': visionValues.apiKey,
        model: visionValues.model,
      })
    } else if (clearVision) {
      options.configStore.clearVision()
    }
    return options.configStore.publicAgentConfig()
  }

  const listModels = async (scope: 'chat' | 'vision', draft?: { baseUrl?: string; apiKey?: string }) => {
    if (scope !== 'chat' && scope !== 'vision') throw new AgentInputError('未知的模型类型')
    const chat = options.configStore.chatConfig()
    const vision = options.configStore.load()
    let storedBaseUrl = ''
    let storedKey = ''
    if (scope === 'chat') {
      storedBaseUrl = chat['chat-base-url'] || ''
      storedKey = chat['chat-api-key'] || ''
    } else {
      const visionComplete = Boolean(vision['base-url'] && vision['api-key'] && vision.model)
      storedBaseUrl = visionComplete ? vision['base-url'] || '' : chat['chat-base-url'] || ''
      storedKey = visionComplete ? vision['api-key'] || '' : chat['chat-api-key'] || ''
    }
    const draftBaseUrl = validateBaseUrl(text(draft?.baseUrl))
    const baseUrl = draftBaseUrl || storedBaseUrl
    const apiKey = text(draft?.apiKey) || (baseUrl === storedBaseUrl ? storedKey : '')
    if (!baseUrl) throw new AgentInputError('请填写 API 地址')
    if (!apiKey) throw new AgentInputError('请填写 API Key')
    const models = await fetchRemoteModels(
      { 'base-url': baseUrl, 'api-key': apiKey },
      { fetchImpl: options.fetchImpl, sleep: options.sleep },
    )
    return { models }
  }

  const createConversation = (): Conversation => requireStore().createConversation()
  const listConversations = (): ConversationSummary[] => requireStore().listConversations()
  const getConversation = (id: string): ConversationDetail | null => requireStore().getConversation(id)

  const deleteConversation = (id: string): boolean => {
    const target = requireStore()
    active.get(id)?.abort()
    active.delete(id)
    return target.deleteConversation(id)
  }

  const addAttachment = (conversationId: string, input: { name: string; mime: string; bytes: Uint8Array }) => {
    const target = requireStore()
    if (!target.conversationExists(conversationId)) throw new AgentNotFoundError('会话不存在')
    if (!IMAGE_TYPES.has(input.mime)) throw new AgentInputError('图片必须是 PNG、JPG 或 WebP')
    if (!input.bytes.length) throw new AgentInputError('图片内容为空')
    if (input.bytes.length > MAX_ATTACHMENT_BYTES) throw new AgentInputError('图片不能超过 20 MB')
    return target.addAttachment(conversationId, { name: input.name, mime: input.mime, bytes: input.bytes })
  }

  const getAttachment = (id: string) => requireStore().getAttachment(id)

  const runSceneTool = async (input: { conversationId: string; attachmentId: string; note?: string }) => {
    const target = requireStore()
    const conversationId = text(input.conversationId)
    const attachmentId = text(input.attachmentId)
    if (!conversationId || !attachmentId) throw new AgentInputError('缺少会话或附件')
    if (!target.conversationExists(conversationId)) throw new AgentNotFoundError('会话不存在')
    const attachment = target.getAttachment(attachmentId)
    if (!attachment || attachment.meta.conversationId !== conversationId) {
      throw new AgentNotFoundError('图片附件不存在')
    }
    if (!options.configStore.effectiveVisionConfig()) {
      throw new AgentInputError('未配置识图模型；请在 AI 助手的模型设置里配置，或让对话模型支持图片')
    }
    return options.generateScene({
      image: attachment.bytes,
      mime: attachment.meta.mime,
      prompt: text(input.note).slice(0, 2_000),
    })
  }

  const turn = async (input: TurnInput, emit: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void> => {
    const target = requireStore()
    const chat = chatRawConfig(options.configStore)
    if (!chat) throw new AgentInputError('请先配置对话模型（API 地址、密钥和模型）')
    const conversationId = text(input?.conversationId)
    if (!conversationId) throw new AgentInputError('缺少会话 id')
    if (!target.getConversation(conversationId)) throw new AgentNotFoundError('会话不存在')
    const hasText = input.text !== undefined
    const toolResults: TurnToolResult[] = Array.isArray(input.toolResults) ? input.toolResults : []
    const hasTools = toolResults.length > 0
    if (hasText === hasTools) throw new AgentInputError('一次只能发送用户消息或工具结果')
    const sceneContext = text(input.sceneContext).slice(0, MAX_SCENE_CONTEXT)
    if (active.has(conversationId)) throw new AgentConflictError('该会话正在生成中')

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    active.set(conversationId, controller)
    try {
      if (hasText) {
        const content = text(input.text).slice(0, MAX_TEXT)
        const attachmentIds = Array.isArray(input.attachmentIds)
          ? input.attachmentIds.map(item => text(item)).filter(Boolean)
          : []
        if (!content && !attachmentIds.length) throw new AgentInputError('请输入内容或上传场景图')
        if (attachmentIds.length > MAX_ATTACHMENTS) throw new AgentInputError(`每条消息最多 ${MAX_ATTACHMENTS} 张图片`)
        for (const attachmentId of attachmentIds) {
          const attachment = target.getAttachment(attachmentId)
          if (!attachment || attachment.meta.conversationId !== conversationId) {
            throw new AgentInputError('图片附件不属于当前会话')
          }
        }
        target.appendMessage({
          conversationId,
          role: 'user',
          content,
          attachmentIds,
        })
        target.setTitleFromText(conversationId, content || '场景转白模')
      } else {
        if (toolResults.length > MAX_ATTACHMENTS) throw new AgentInputError('工具结果过多')
        const messages = target.getConversation(conversationId)?.messages || []
        const calls = new Map<string, AgentToolCall>()
        const answered = new Set<string>()
        for (const message of messages) {
          if (message.role === 'assistant') {
            for (const call of message.toolCalls || []) calls.set(call.id, call)
          }
          if (message.role === 'tool' && message.toolCallId) answered.add(message.toolCallId)
        }
        if (toolRoundCount(messages) >= MAX_TOOL_ROUNDS) {
          throw new AgentInputError('工具调用次数过多；请重新发送消息')
        }
        const seen = new Set<string>()
        for (const result of toolResults) {
          const toolCallId = text(result?.toolCallId)
          const content = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? {})
          if (!toolCallId) throw new AgentInputError('工具结果缺少调用 id')
          if (seen.has(toolCallId) || answered.has(toolCallId)) throw new AgentInputError('工具结果重复')
          if (!calls.has(toolCallId)) throw new AgentInputError('工具调用不存在或已失效')
          seen.add(toolCallId)
          target.appendMessage({
            conversationId,
            role: 'tool',
            content: content.slice(0, MAX_TOOL_RESULT),
            toolCallId,
          })
        }
      }

      const detail = target.getConversation(conversationId)
      if (!detail) throw new AgentNotFoundError('会话不存在')
      emit({ type: 'conversation', conversation: detail.conversation })
      const messages = [
        { role: 'system', content: buildSystemPrompt(sceneContext) },
        ...historyMessages(detail.messages),
      ]
      const result = await streamChatCompletion(
        chat,
        messages,
        { fetchImpl: options.fetchImpl, sleep: options.sleep, signal: controller.signal },
        delta => {
          if (controller.signal.aborted) return
          emit({ type: 'delta', text: delta })
        },
      )
      if (controller.signal.aborted) return
      const message = target.appendMessage({
        conversationId,
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls,
      })
      emit({ type: 'message', message })
      emit({ type: 'done' })
    } finally {
      signal?.removeEventListener('abort', onAbort)
      active.delete(conversationId)
    }
  }

  const abort = (conversationId: string): void => {
    active.get(conversationId)?.abort()
  }

  const close = (): void => {
    for (const controller of active.values()) controller.abort()
    active.clear()
    store?.close()
  }

  return {
    disabledReason,
    config,
    saveConfig,
    listModels,
    createConversation,
    listConversations,
    getConversation,
    deleteConversation,
    addAttachment,
    getAttachment,
    runSceneTool,
    turn,
    abort,
    close,
  }
}
