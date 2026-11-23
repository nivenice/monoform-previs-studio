export const SCENE_TOOL_NAME = 'scene_to_white_model'

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: SCENE_TOOL_NAME,
    label: '场景转白模',
    description: '把聊天里附上的场景参考图转换成可编辑白模体块，追加到当前场景。',
  },
]

export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function pickAttachment(args, attachments = []) {
  const list = Array.isArray(attachments) ? attachments : []
  const requested = String(args?.attachment_id || args?.attachmentId || '').trim()
  if (requested) return list.find(item => item.id === requested) || null
  return list.length === 1 ? list[0] : null
}

const toolResult = (ok, error) => JSON.stringify({ ok, tool: SCENE_TOOL_NAME, error })

export async function executeAgentTool(call, context = {}) {
  const name = String(call?.name || '')
  if (name !== SCENE_TOOL_NAME) return toolResult(false, `未知工具：${name || '未命名'}`)
  const args = parseToolArguments(call?.arguments)
  if (!args) return toolResult(false, '工具参数不是有效 JSON')
  const attachments = Array.isArray(context.attachments) ? context.attachments : []
  const attachment = pickAttachment(args, attachments)
  if (!attachment) {
    return toolResult(false, attachments.length ? '请指定要转白模的图片' : '请先在聊天里附上一张场景图')
  }
  try {
    const result = await context.runSceneTool({
      conversationId: context.conversationId,
      attachmentId: attachment.id,
      note: args.note ? String(args.note).slice(0, 2000) : '',
    })
    const summary = context.applyScene(result, attachment)
    return JSON.stringify({
      ok: true,
      tool: SCENE_TOOL_NAME,
      ...summary,
    })
  } catch (error) {
    return toolResult(false, String(error?.message || error || '场景转白模失败').slice(0, 1000))
  }
}

export function parseToolResult(content) {
  try {
    const parsed = JSON.parse(String(content || ''))
    return parsed && typeof parsed === 'object' ? parsed : { ok: false, error: String(content || '') }
  } catch {
    return { ok: false, error: String(content || '').slice(0, 1000) }
  }
}
