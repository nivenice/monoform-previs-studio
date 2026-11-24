// Renderer-side tool registry for the AI assistant. The model only ever gets
// the names declared in server/agent/prompt.ts; each name must be listed here
// and executed through the whitelist below. Scene writes are applied by App.jsx
// through its normal setState calls, so undo and autosave keep working.
import {
  GET_SCENE_INFO,
  MANAGE_KEYFRAMES,
  SCENE_COMMANDS,
  SET_POSE,
  SET_TIMELINE,
  TRANSFORM_OBJECTS,
  runSceneCommand,
} from './agentSceneCommands.js'

export const SCENE_TOOL_NAME = 'scene_to_white_model'

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: SCENE_TOOL_NAME,
    label: '场景转白模',
    description: '把聊天里附上的场景参考图转换成可编辑白模体块，追加到当前场景。',
    runningText: '正在分析结构并生成白模，可能需要一两分钟…',
  },
  {
    name: GET_SCENE_INFO,
    label: '读取场景',
    description: '读取当前镜头里所有对象、摄像机、关键帧、姿势和时间轴信息。',
    runningText: '正在读取当前场景信息…',
  },
  {
    name: TRANSFORM_OBJECTS,
    label: '调整对象变换',
    description: '批量调整场景对象的位置、旋转角度和缩放大小。',
    runningText: '正在调整对象的位置、旋转与缩放…',
  },
  {
    name: SET_POSE,
    label: '调整人物姿势',
    description: '切换人物的动作预设（含举枪瞄准），并可按骨骼微调角度。',
    runningText: '正在调整人物姿势…',
  },
  {
    name: MANAGE_KEYFRAMES,
    label: '管理关键帧',
    description: '批量写入、删除或清空镜头与物体的关键帧，并可用相对机位取景。',
    runningText: '正在写入关键帧…',
  },
  {
    name: SET_TIMELINE,
    label: '设置时间轴',
    description: '设置当前镜头的帧率与时长，写入关键帧前必须先确定。',
    runningText: '正在设置镜头时长与帧率…',
  },
]

const MAX_TOOL_OUTPUT = 7000

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// Models occasionally emit an extra closing brace or append a field after the
// object. Recover the longest valid prefix / a balanced object instead of
// failing the whole tool call.
function repairJson(text) {
  let output = ''
  const stack = []
  let inString = false
  let escaped = false
  for (const char of text) {
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; output += char; continue }
    if (char === '{' || char === '[') { stack.push(char); output += char; continue }
    if (char === '}' || char === ']') {
      const open = stack.at(-1)
      const matches = (char === '}' && open === '{') || (char === ']' && open === '[')
      if (matches) { stack.pop(); output += char }
      continue
    }
    output += char
  }
  if (inString) output += '"'
  while (stack.length) output += stack.pop() === '{' ? '}' : ']'
  return output
}

export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  const text = String(raw || '').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch (error) {
    const position = /position (\d+)/.exec(String(error?.message || ''))
    if (position) {
      try {
        const parsed = JSON.parse(text.slice(0, Number(position[1])).trim())
        if (isPlainObject(parsed)) return parsed
      } catch { /* fall through to the balanced repair */ }
    }
    try {
      const parsed = JSON.parse(repairJson(text))
      return isPlainObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }
}

export function pickAttachment(args, attachments = []) {
  const list = Array.isArray(attachments) ? attachments : []
  const requested = String(args?.attachment_id || args?.attachmentId || '').trim()
  if (requested) return list.find(item => item.id === requested) || null
  return list.length === 1 ? list[0] : null
}

const toolResult = (ok, tool, error) => JSON.stringify({ ok, tool, error })

// Tool results travel back through the chat as JSON text with an 8000 character
// cap on the server, so oversized payloads are trimmed here instead of being
// cut mid-object by the transport.
export function serializeToolOutput(payload, limit = MAX_TOOL_OUTPUT) {
  let serialized = JSON.stringify(payload)
  if (serialized.length <= limit) return serialized
  const compact = { ...payload }
  if (compact.result && typeof compact.result === 'object') {
    compact.result = { ...compact.result }
    compact.result.poses = Array.isArray(compact.result.poses) ? compact.result.poses.map(pose => pose.id) : []
    compact.result.conventions = undefined
    if (Array.isArray(compact.result.objects)) {
      let objects = compact.result.objects.map(object => ({
        id: object.id,
        name: object.name,
        type: object.type,
        position: object.position,
        rotationDegrees: object.rotationDegrees,
        scale: object.scale,
        keyframeFrames: object.keyframeFrames,
        ...(object.pose ? { pose: object.pose } : {}),
      }))
      while (objects.length > 1) {
        serialized = JSON.stringify({ ...compact, result: { ...compact.result, objects, truncated: true } })
        if (serialized.length <= limit) return serialized
        objects = objects.slice(0, Math.max(1, Math.ceil(objects.length / 2)))
      }
      compact.result.objects = objects.slice(0, 1)
      compact.result.truncated = true
    }
    serialized = JSON.stringify(compact)
    if (serialized.length <= limit) return serialized
  }
  compact.truncated = true
  serialized = JSON.stringify(compact)
  return serialized.length <= limit ? serialized : serialized.slice(0, limit)
}

async function executeSceneCommand(name, args, context) {
  const toolkit = context?.sceneToolkit
  if (!toolkit || typeof toolkit.snapshot !== 'function' || typeof toolkit.applyScenePatch !== 'function') {
    return toolResult(false, name, '场景编辑工具不可用：没有连接当前工程状态')
  }
  try {
    const result = runSceneCommand(name, toolkit.snapshot(), args)
    if (result.patch) toolkit.applyScenePatch(result.patch, result.summary)
    return serializeToolOutput({
      ok: true,
      tool: name,
      ...result.summary,
      ...(result.result || {}),
    })
  } catch (error) {
    return toolResult(false, name, String(error?.message || error || '场景操作失败').slice(0, 1000))
  }
}

export async function executeAgentTool(call, context = {}) {
  const name = String(call?.name || '')
  const args = parseToolArguments(call?.arguments)
  if (!args) return toolResult(false, name, '工具参数不是有效 JSON')
  if (name === SCENE_TOOL_NAME) {
    const attachments = Array.isArray(context.attachments) ? context.attachments : []
    const attachment = pickAttachment(args, attachments)
    if (!attachment) {
      return toolResult(false, name, attachments.length ? '请指定要转白模的图片' : '请先在聊天里附上一张场景图')
    }
    try {
      const result = await context.runSceneTool({
        conversationId: context.conversationId,
        attachmentId: attachment.id,
        note: args.note ? String(args.note).slice(0, 2000) : '',
      })
      const summary = context.applyScene(result, attachment)
      return serializeToolOutput({ ok: true, tool: name, ...summary })
    } catch (error) {
      return toolResult(false, name, String(error?.message || error || '场景转白模失败').slice(0, 1000))
    }
  }
  if (SCENE_COMMANDS.includes(name)) return executeSceneCommand(name, args, context)
  return toolResult(false, name, `未知工具：${name || '未命名'}`)
}

export function parseToolResult(content) {
  try {
    const parsed = JSON.parse(String(content || ''))
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, error: String(content || '') }
  } catch {
    return { ok: false, error: String(content || '').slice(0, 1000) }
  }
}
