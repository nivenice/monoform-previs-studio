// Orchestrates the animator subagent. The loop is renderer-driven, exactly like
// the main agent: one LLM call per round, tools executed locally through the
// shared scene toolkit, and the resulting patch applied through the normal
// setState path so undo and autosave keep working.
import { buildRigAgentContext } from './rigAgentContext.js'
import { RIG_TOOL_LABELS, executeRigTool } from './rigAgentTools.js'
import { resolveRigTarget } from './rigAgentCommands.js'

const MAX_ROUNDS = 5

const abortError = () => {
  const error = new Error('已停止')
  error.name = 'AbortError'
  return error
}

const errorText = error => String(error?.message || error || '骨骼动画师执行失败').slice(0, 1000)

const progress = (callback, event) => {
  try { callback?.(event) } catch { /* UI progress must never break the edit loop */ }
}

const parseToolResult = content => {
  try {
    const parsed = JSON.parse(String(content || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const uniqueList = values => [...new Set(values)]

function summarize({ person, frames, bones, staticPose }) {
  if (frames.length === 0) return `骨骼动画师已调整“${person.name}”的基础姿势，涉及 ${bones.length} 根骨骼`
  return `骨骼动画师已为“${person.name}”写入 ${frames.length} 个姿态关键帧（${frames.join('/')}），调整 ${bones.length} 根骨骼`
}

export async function runRigSubagent({
  target,
  brief,
  startFrame,
  endFrame,
  basePose = '',
  toolkit,
  requestTurn,
  signal,
  onProgress,
  maxRounds = MAX_ROUNDS,
}) {
  const frames = new Set()
  const bones = new Set()
  const warnings = []
  let staticPose = false
  let rounds = 0
  let note = ''
  try {
    if (!toolkit || typeof toolkit.snapshot !== 'function' || typeof toolkit.applyScenePatch !== 'function') {
      return { ok: false, tool: 'delegate_character_pose', error: '骨骼动画师不可用：没有连接当前工程状态' }
    }
    if (typeof requestTurn !== 'function') {
      return { ok: false, tool: 'delegate_character_pose', error: '骨骼动画师不可用：没有连接模型服务' }
    }
    if (!String(brief || '').trim()) {
      return { ok: false, tool: 'delegate_character_pose', error: '请给骨骼动画师一句动作说明' }
    }
    const initial = toolkit.snapshot()
    const person = resolveRigTarget(initial, target)
    const built = buildRigAgentContext(initial, person, { startFrame, endFrame, basePose })
    const range = built.range
    const history = []
    const toolRange = { start: range.start, end: range.end, totalFrames: range.totalFrames }

    for (let round = 1; round <= maxRounds; round += 1) {
      if (signal?.aborted) throw abortError()
      rounds = round
      progress(onProgress, { type: 'round', round, maxRounds })
      const message = await requestTurn({
        context: built.json,
        brief: String(brief).slice(0, 4000),
        history: history.map(item => ({ ...item })),
        signal,
      })
      if (!message || typeof message !== 'object') throw new Error('骨骼动画师没有返回回复')
      if (message.content) note = String(message.content).slice(0, 800)
      const calls = (Array.isArray(message.toolCalls) ? message.toolCalls : [])
        .filter(call => call && call.name)
        .map((call, index) => ({
          id: String(call.id || `rig-call-${round}-${index}`),
          name: String(call.name),
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        }))
      if (!calls.length) {
        if (!frames.size && !staticPose) {
          return {
            ok: false,
            tool: 'delegate_character_pose',
            target: { id: person.id, name: person.name || person.id },
            error: '骨骼动画师没有写入任何骨骼；请把动作说得更具体一些',
            rounds,
            note,
          }
        }
        return {
          ok: true,
          tool: 'delegate_character_pose',
          target: { id: person.id, name: person.name || person.id },
          message: summarize({ person: { name: person.name || person.id }, frames: [...frames].sort((a, b) => a - b), bones: [...bones], staticPose }),
          frames: [...frames].sort((a, b) => a - b),
          bones: [...bones],
          staticPose,
          rounds,
          note,
          warnings: uniqueList(warnings),
        }
      }

      history.push({ role: 'assistant', content: message.content || '', toolCalls: calls })
      for (const call of calls) {
        if (signal?.aborted) throw abortError()
        const label = RIG_TOOL_LABELS[call.name] || call.name
        progress(onProgress, { type: 'tool-start', name: call.name, label })
        const result = executeRigTool(call, { toolkit, targetId: person.id, range: toolRange })
        if (result.patch) {
          toolkit.applyScenePatch(result.patch)
          if (call.name === 'set_character_joints') staticPose = true
          for (const frame of result.summary?.frames || []) {
            const number = Number(frame)
            if (Number.isFinite(number)) frames.add(number)
          }
          for (const name of result.summary?.bones || []) bones.add(String(name))
          for (const name of result.summary?.joints || []) bones.add(String(name))
          for (const warning of result.summary?.warnings || []) warnings.push(String(warning))
        }
        const parsed = parseToolResult(result.content)
        progress(onProgress, {
          type: 'tool-result',
          name: call.name,
          label,
          ok: parsed?.ok !== false,
          message: parsed?.message || parsed?.error || '',
        })
        history.push({ role: 'tool', toolCallId: call.id, content: result.content })
      }
    }
    if (!frames.size && !staticPose) {
      return {
        ok: false,
        tool: 'delegate_character_pose',
        error: '骨骼动画师工具调用次数过多，且没有写入骨骼；请重新发送更具体的动作',
        rounds,
        note,
      }
    }
    return {
      ok: false,
      tool: 'delegate_character_pose',
      target: { id: person.id, name: person.name || person.id },
      error: '骨骼动画师工具调用次数过多；已保留已写入的部分，可撤销后重试',
      partial: true,
      frames: [...frames].sort((a, b) => a - b),
      bones: [...bones],
      staticPose,
      rounds,
      note,
      warnings: uniqueList(warnings),
    }
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error
    return {
      ok: false,
      tool: 'delegate_character_pose',
      error: errorText(error),
      partial: frames.size > 0 || staticPose,
      frames: [...frames].sort((a, b) => a - b),
      bones: [...bones],
      staticPose,
      rounds,
      note,
      warnings: uniqueList(warnings),
    }
  }
}
