import { randomUUID } from 'node:crypto'
import { chatEndpoint } from '../upstream'
import type { RawModelConfig } from '../types'
import { AGENT_TOOLS } from './prompt'
import type { AgentToolCall } from './types'

export interface StreamChatOptions {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
  tools?: unknown
  temperature?: number
}

export interface StreamChatResult {
  content: string
  toolCalls: AgentToolCall[]
  finishReason: string
}

const UPSTREAM_TIMEOUT_MS = 180_000
const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const truncate = (value: string, length: number): string => value.slice(0, length)

const upstreamHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'HTTP-Referer': 'http://127.0.0.1:5173',
  'X-Title': 'MONOFORM Agent',
})

function extractContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          return String((item as { text: string }).text)
        }
        return ''
      })
      .join('')
  }
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return String((value as { text: string }).text)
  }
  return ''
}

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

function accumulateToolDeltas(
  calls: Map<number, ToolCallAccumulator>,
  raw: unknown,
): void {
  if (!Array.isArray(raw)) return
  raw.forEach((item, offset) => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    const index = Number.isInteger(record.index) ? Number(record.index) : offset
    const current = calls.get(index) || { id: '', name: '', arguments: '' }
    if (typeof record.id === 'string' && record.id) current.id = current.id || record.id
    const fn = record.function && typeof record.function === 'object'
      ? record.function as Record<string, unknown>
      : {}
    if (typeof fn.name === 'string' && fn.name && !current.name) current.name = fn.name
    if (typeof fn.arguments === 'string') current.arguments += fn.arguments
    else if (fn.arguments && typeof fn.arguments === 'object') current.arguments += JSON.stringify(fn.arguments)
    calls.set(index, current)
  })
}

function finalizeToolCalls(calls: Map<number, ToolCallAccumulator>): AgentToolCall[] {
  return [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: call.id || `call-${index}-${randomUUID()}`,
      name: call.name || '',
      arguments: call.arguments || '{}',
    }))
    .filter(call => Boolean(call.name))
}

function parseCompletionMessage(payload: unknown, onDelta: (text: string) => void): StreamChatResult {
  const record = payload && typeof payload === 'object' ? payload as Record<string, any> : {}
  if (record.error) throw new Error(`模型服务返回错误: ${truncate(JSON.stringify(record.error), 500)}`)
  const choice = Array.isArray(record.choices) ? record.choices[0] : null
  if (!choice) throw new Error('模型服务返回了无效响应')
  const message = choice.message && typeof choice.message === 'object' ? choice.message : {}
  const content = extractContent(message.content)
  if (content) onDelta(content)
  const calls = new Map<number, ToolCallAccumulator>()
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((item: unknown, offset: number) => {
      if (!item || typeof item !== 'object') return
      const call = item as Record<string, any>
      const fn = call.function && typeof call.function === 'object' ? call.function : {}
      calls.set(offset, {
        id: typeof call.id === 'string' ? call.id : '',
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      })
    })
  }
  const toolCalls = finalizeToolCalls(calls)
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : ''
  if (!content && !toolCalls.length) throw new Error('模型返回空响应')
  return { content, toolCalls, finishReason }
}

async function consumeStream(
  response: Response,
  onDelta: (text: string) => void,
): Promise<StreamChatResult> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error('模型服务返回了无法解析的响应')
    }
    return parseCompletionMessage(payload, onDelta)
  }
  if (!response.body) throw new Error('模型服务返回空响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason = ''
  let sawData = false
  const calls = new Map<number, ToolCallAccumulator>()

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trimStart().trim()
    if (!data || data === '[DONE]') return
    sawData = true
    let payload: Record<string, any>
    try {
      payload = JSON.parse(data) as Record<string, any>
    } catch {
      throw new Error('模型服务返回了无法解析的流数据')
    }
    if (payload.error) throw new Error(`模型服务返回错误: ${truncate(JSON.stringify(payload.error), 500)}`)
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
    if (!choice) return
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {}
    const piece = extractContent(delta.content)
    if (piece) {
      content += piece
      onDelta(piece)
    }
    accumulateToolDeltas(calls, delta.tool_calls)
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        consumeLine(line)
        index = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) consumeLine(buffer)
  } finally {
    try { reader.releaseLock() } catch { /* the stream may already be closed */ }
  }

  if (!sawData) throw new Error('模型服务返回空响应')
  const toolCalls = finalizeToolCalls(calls)
  if (!content && !toolCalls.length) throw new Error('模型返回空响应')
  return { content, toolCalls, finishReason }
}

export async function streamChatCompletion(
  cfg: RawModelConfig,
  messages: Array<Record<string, unknown>>,
  options: StreamChatOptions,
  onDelta: (text: string) => void,
): Promise<StreamChatResult> {
  const baseUrl = (cfg['base-url'] || '').replace(/\/+$/, '')
  const apiKey = cfg['api-key'] || ''
  const model = cfg.model || ''
  if (!baseUrl || !apiKey || !model) throw new Error('对话模型配置不完整；请先在 AI 助手设置里填写 API 地址、密钥和模型')
  const endpoint = chatEndpoint(baseUrl)
  const fetchImpl = options.fetchImpl || fetch
  const sleep = options.sleep || defaultSleep
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const payload = {
    model,
    messages,
    tools: options.tools ?? AGENT_TOOLS,
    tool_choice: 'auto',
    stream: true,
    temperature: options.temperature ?? 0.3,
  }
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let emitted = false
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { ...upstreamHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
      if (!response.ok) {
        const detail = truncate(await response.text(), 1000)
        const error = new Error(`模型服务 HTTP ${response.status}: ${detail}`)
        if (response.status < 500 || attempt === 2) throw error
        lastError = error
        await sleep(1000 + attempt * 1000)
        continue
      }
      return await consumeStream(response, text => {
        emitted = true
        onDelta(text)
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (timeoutSignal.aborted) throw new Error(`模型服务响应超时（${Math.round(UPSTREAM_TIMEOUT_MS / 1000)} 秒）`)
      if (emitted || attempt === 2) throw error
      if (error instanceof Error && /HTTP 4\d\d/.test(error.message)) throw error
      lastError = error instanceof Error ? error : new Error(errorMessage(error))
      await sleep(1000 + attempt * 1000)
    }
  }
  throw lastError || new Error('模型服务连接失败')
}
