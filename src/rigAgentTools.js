// Renderer-side registry for the animator subagent. Only these three names are
// accepted; the main agent never sees them and the subagent never receives the
// main tools (camera, timeline, transforms).
import { parseToolArguments } from './agentTools.js'
import { GET_CHARACTER_STATE, RIG_TOOL_NAMES, SET_CHARACTER_JOINTS, WRITE_POSE_KEYFRAMES, runRigCommand } from './rigAgentCommands.js'

export const RIG_TOOL_DEFINITIONS = [
  { name: GET_CHARACTER_STATE, label: '读取角色姿态', description: '读取目标人物当前的姿势、关节角度和关键帧。' },
  { name: SET_CHARACTER_JOINTS, label: '调整关节旋转', description: '调整人物基础姿势的骨骼角度。' },
  { name: WRITE_POSE_KEYFRAMES, label: '写入姿态关键帧', description: '按帧写入关节旋转，形成精细动作。' },
]

export const RIG_TOOL_LABELS = Object.fromEntries(RIG_TOOL_DEFINITIONS.map(item => [item.name, item.label]))

const MAX_RIG_TOOL_OUTPUT = 6500

const errorResult = (name, error) => JSON.stringify({
  ok: false,
  tool: name,
  error: String(error?.message || error || '骨骼操作失败').slice(0, 1000),
})

function serializeRigOutput(name, payload) {
  let serialized = JSON.stringify(payload)
  if (serialized.length <= MAX_RIG_TOOL_OUTPUT) return serialized
  const compact = { ...payload }
  if (compact.state && Array.isArray(compact.state.keyframes)) {
    compact.state = { ...compact.state, keyframes: compact.state.keyframes.slice(-8), truncated: true }
    serialized = JSON.stringify(compact)
    if (serialized.length <= MAX_RIG_TOOL_OUTPUT) return serialized
  }
  if (compact.state) {
    delete compact.state.base
    delete compact.state.current
    delete compact.state.keyframes
    compact.truncated = true
    serialized = JSON.stringify(compact)
    if (serialized.length <= MAX_RIG_TOOL_OUTPUT) return serialized
  }
  return JSON.stringify({ ok: true, tool: name, message: payload.message || '已完成', truncated: true })
}

export function executeRigTool(call, context = {}) {
  const name = String(call?.name || '')
  const args = parseToolArguments(call?.arguments)
  if (!args) return { content: errorResult(name, '工具参数不是有效 JSON') }
  if (!RIG_TOOL_NAMES.includes(name)) return { content: errorResult(name, `未知的骨骼工具：${name || '未命名'}`) }
  const toolkit = context.toolkit
  if (!toolkit || typeof toolkit.snapshot !== 'function') {
    return { content: errorResult(name, '骨骼动画师不可用：没有连接当前工程状态') }
  }
  try {
    const state = toolkit.snapshot()
    const result = runRigCommand(name, state, args, {
      targetId: context.targetId,
      range: context.range,
    })
    const payload = {
      ok: true,
      tool: name,
      ...(result.summary || {}),
      ...(result.result ? { state: result.result } : {}),
    }
    return {
      content: serializeRigOutput(name, payload),
      patch: result.patch,
      summary: result.summary,
      result: result.result,
    }
  } catch (error) {
    return { content: errorResult(name, error) }
  }
}
