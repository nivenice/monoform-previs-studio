import { AgentInputError } from './types'
import type { AgentToolCall, SpecialistMessage, SpecialistTurnInput } from './types'

const MAX_CONTEXT = 16_000
const MAX_BRIEF = 4_000
const MAX_HISTORY_MESSAGES = 48
const MAX_CONTENT = 8_000
const MAX_TOOL_CALLS = 8
const MAX_ARGUMENTS = 8_000

export const MAX_RIG_TOOL_ROUNDS = 5

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value).trim()

function normalizeToolCall(value: unknown, messageIndex: number, callIndex: number): AgentToolCall {
  if (!isObject(value)) throw new AgentInputError(`第 ${messageIndex + 1} 条历史消息的第 ${callIndex + 1} 个工具调用格式无效`)
  const id = text(value.id)
  const name = text(value.name)
  if (!id || id.length > 80) throw new AgentInputError(`第 ${messageIndex + 1} 条历史消息含无效工具调用 id`)
  if (!name || name.length > 80) throw new AgentInputError(`第 ${messageIndex + 1} 条历史消息含无效工具名`)
  const rawArguments = value.arguments
  const args = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {})
  if (args.length > MAX_ARGUMENTS) throw new AgentInputError('工具调用参数过长')
  return { id, name, arguments: args }
}

function normalizeMessage(value: unknown, index: number): SpecialistMessage {
  if (!isObject(value)) throw new AgentInputError(`第 ${index + 1} 条历史消息格式无效`)
  const role = value.role
  if (role !== 'assistant' && role !== 'tool') {
    throw new AgentInputError('骨骼动画师的历史消息只能是 assistant 或 tool')
  }
  const content = typeof value.content === 'string' ? value.content : ''
  if (content.length > MAX_CONTENT) throw new AgentInputError('历史消息内容过长')
  if (role === 'tool') {
    const toolCallId = text(value.toolCallId)
    if (!toolCallId) throw new AgentInputError('工具结果缺少 toolCallId')
    return { role, content, toolCallId }
  }
  const rawCalls = value.toolCalls === undefined ? [] : value.toolCalls
  if (!Array.isArray(rawCalls)) throw new AgentInputError('assistant 历史的 toolCalls 必须是数组')
  if (rawCalls.length > MAX_TOOL_CALLS) throw new AgentInputError('单条消息的工具调用过多')
  const toolCalls = rawCalls.map((call, callIndex) => normalizeToolCall(call, index, callIndex))
  if (!content && !toolCalls.length) throw new AgentInputError('assistant 历史消息既没有文字也没有工具调用')
  return { role, content, toolCalls }
}

export function parseSpecialistInput(payload: unknown): SpecialistTurnInput {
  if (!isObject(payload)) throw new AgentInputError('请求格式无效')
  if (payload.specialist !== 'rig') throw new AgentInputError('未知的骨骼动画师类型')
  const context = text(payload.context)
  if (!context) throw new AgentInputError('骨骼动画师缺少角色上下文')
  if (context.length > MAX_CONTEXT) throw new AgentInputError('角色上下文过长')
  const brief = text(payload.brief)
  if (!brief) throw new AgentInputError('骨骼动画师缺少动作说明')
  if (brief.length > MAX_BRIEF) throw new AgentInputError('动作说明过长')
  const rawHistory = payload.history === undefined ? [] : payload.history
  if (!Array.isArray(rawHistory)) throw new AgentInputError('历史消息必须是数组')
  if (rawHistory.length > MAX_HISTORY_MESSAGES) throw new AgentInputError('骨骼动画师的历史消息过多')
  const history = rawHistory.map(normalizeMessage)

  // Every assistant tool call must have a matching tool result before another
  // assistant message. This mirrors the upstream chat contract and keeps a
  // malformed client history from being sent to the model.
  const pending = new Set<string>()
  const seen = new Set<string>()
  for (const [index, message] of history.entries()) {
    if (message.role === 'assistant') {
      if (pending.size) throw new AgentInputError('历史消息里有未完成的工具调用')
      for (const call of message.toolCalls || []) {
        if (seen.has(call.id)) throw new AgentInputError('历史消息里的工具调用 id 重复')
        seen.add(call.id)
        pending.add(call.id)
      }
      continue
    }
    const toolCallId = message.toolCallId || ''
    if (!pending.has(toolCallId)) throw new AgentInputError(`第 ${index + 1} 条工具结果没有对应的工具调用`)
    pending.delete(toolCallId)
  }
  if (pending.size) throw new AgentInputError('历史消息缺少工具结果')

  return { specialist: 'rig', context, brief, history }
}

export function specialistHistoryMessages(history: SpecialistMessage[]): Array<Record<string, unknown>> {
  return history.map(message => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId || '', content: message.content }
    }
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
  })
}
