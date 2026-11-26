import type http from 'node:http'
import { HttpError, errorMessage, isObject, readJsonBody, readRequestBody, truncate } from '../http-body'
import type { AgentEvent, AgentService, SpecialistEvent, TurnInput, TurnToolResult } from './types'
import { AgentInputError } from './types'
import { parseSpecialistInput } from './specialist'

const MAX_TURN_BODY = 256 * 1024
const MAX_CONFIG_BODY = 16 * 1024
const MAX_TOOL_BODY = 16 * 1024
const MAX_MULTIPART_BODY = 25 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_NOTE = 2_000
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const ID_PATTERN = /^[A-Za-z0-9_-]{6,80}$/

function sendJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string>,
): void {
  const data = JSON.stringify(value)
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(data)),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

function sendBinary(
  res: http.ServerResponse,
  bytes: Uint8Array,
  mime: string,
  headers: Record<string, string>,
): void {
  res.writeHead(200, {
    ...headers,
    'Content-Type': mime,
    'Content-Length': String(bytes.length),
    'Cache-Control': 'private, max-age=60',
  })
  res.end(Buffer.from(bytes))
}

const errorStatus = (error: unknown): number => {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 502
}

const stringValue = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value)

function parseTurnInput(payload: Record<string, unknown>): TurnInput {
  const conversationId = stringValue(payload.conversationId).trim()
  if (!ID_PATTERN.test(conversationId)) throw new HttpError(400, '会话 id 无效')
  const text = payload.text === undefined ? undefined : String(payload.text ?? '')
  if (text !== undefined && text.length > 32_000) throw new HttpError(400, '消息内容过长')
  const attachmentIds = Array.isArray(payload.attachmentIds)
    ? payload.attachmentIds.map(item => stringValue(item).trim()).filter(Boolean)
    : undefined
  if (attachmentIds && attachmentIds.length > 4) throw new HttpError(400, '每条消息最多 4 张图片')
  const toolResults: TurnToolResult[] | undefined = Array.isArray(payload.toolResults)
    ? payload.toolResults.filter(isObject).map(item => ({
        toolCallId: stringValue(item.toolCallId).trim(),
        content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? {}),
      }))
    : undefined
  if (toolResults && toolResults.length > 4) throw new HttpError(400, '工具结果过多')
  const hasText = text !== undefined
  const hasTools = Boolean(toolResults?.length)
  if (hasText === hasTools) throw new HttpError(400, '一次只能发送用户消息或工具结果')
  const sceneContext = typeof payload.sceneContext === 'string' ? payload.sceneContext : ''
  if (sceneContext.length > 16_000) throw new HttpError(400, '场景上下文过长')
  return { conversationId, text, attachmentIds, toolResults, sceneContext }
}

function parseTurnBody(payload: unknown): TurnInput {
  if (!isObject(payload)) throw new HttpError(400, '请求格式无效')
  return parseTurnInput(payload)
}

async function handleTurn(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: AgentService,
  cors: Record<string, string>,
): Promise<void> {
  const input = parseTurnBody(await readJsonBody(req, MAX_TURN_BODY))
  res.writeHead(200, {
    ...cors,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  res.socket?.setNoDelay(true)

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    agent.abort(input.conversationId)
  }
  const send = (event: AgentEvent): void => {
    if (closed) return
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    } catch {
      close()
    }
  }
  const heartbeat = setInterval(() => {
    if (closed) return
    try {
      res.write(': ping\n\n')
    } catch {
      close()
    }
  }, 15_000)
  res.once('close', close)
  try {
    await agent.turn(input, send)
  } catch (error) {
    if (!closed) {
      send({
        type: 'error',
        message: truncate(errorMessage(error), 2_000),
      })
    }
  } finally {
    clearInterval(heartbeat)
    res.off('close', close)
    try { res.end() } catch { /* the client may already be gone */ }
    closed = true
  }
}

async function handleSpecialistTurn(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: AgentService,
  cors: Record<string, string>,
): Promise<void> {
  const payload = await readJsonBody(req, MAX_TURN_BODY)
  const input = parseSpecialistInput(payload)
  res.writeHead(200, {
    ...cors,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  res.socket?.setNoDelay(true)

  const controller = new AbortController()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    controller.abort()
  }
  const send = (event: SpecialistEvent): void => {
    if (closed) return
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    } catch {
      close()
    }
  }
  const heartbeat = setInterval(() => {
    if (closed) return
    try {
      res.write(': ping\n\n')
    } catch {
      close()
    }
  }, 15_000)
  res.once('close', close)
  try {
    await agent.specialistTurn(input, send, controller.signal)
  } catch (error) {
    if (!closed) send({ type: 'error', message: truncate(errorMessage(error), 2_000) })
  } finally {
    clearInterval(heartbeat)
    res.off('close', close)
    try { res.end() } catch { /* the client may already be gone */ }
    closed = true
  }
}

async function handleAttachmentUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: AgentService,
  conversationId: string,
  cors: Record<string, string>,
): Promise<void> {
  if (!ID_PATTERN.test(conversationId)) throw new HttpError(400, '会话 id 无效')
  const contentType = String(req.headers['content-type'] || '')
  if (!/^multipart\/form-data\b/i.test(contentType)) {
    throw new HttpError(400, '请使用 multipart/form-data 上传图片')
  }
  const body = await readRequestBody(req, MAX_MULTIPART_BODY)
  let form: FormData
  try {
    form = await new Request('http://127.0.0.1/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    }).formData()
  } catch {
    throw new HttpError(400, '图片表单解析失败')
  }
  const image = form.get('image')
  if (!image || typeof image === 'string' || typeof image.arrayBuffer !== 'function' || image.size <= 0) {
    throw new HttpError(400, '请先上传图片')
  }
  const mime = image.type || 'application/octet-stream'
  if (!IMAGE_TYPES.has(mime)) throw new HttpError(400, '图片必须是 PNG、JPG 或 WebP')
  if (image.size > MAX_IMAGE_BYTES) throw new HttpError(413, '图片不能超过 20 MB')
  const bytes = new Uint8Array(await image.arrayBuffer())
  const attachment = agent.addAttachment(conversationId, {
    name: image.name || '场景图',
    mime,
    bytes,
  })
  sendJson(res, 200, { attachment }, cors)
}

async function handleSceneTool(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: AgentService,
  cors: Record<string, string>,
): Promise<void> {
  const payload = await readJsonBody(req, MAX_TOOL_BODY)
  if (!isObject(payload)) throw new HttpError(400, '请求格式无效')
  const conversationId = stringValue(payload.conversationId).trim()
  const attachmentId = stringValue(payload.attachmentId).trim()
  if (!ID_PATTERN.test(conversationId) || !ID_PATTERN.test(attachmentId)) {
    throw new HttpError(400, '会话或附件 id 无效')
  }
  const note = stringValue(payload.note).slice(0, MAX_NOTE)
  const result = await agent.runSceneTool({ conversationId, attachmentId, note })
  sendJson(res, 200, result, cors)
}

async function handleConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: AgentService,
  cors: Record<string, string>,
): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, agent.config(), cors)
    return
  }
  const payload = await readJsonBody(req, MAX_CONFIG_BODY)
  sendJson(res, 200, agent.saveConfig(payload), cors)
}

async function handleModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: AgentService,
  cors: Record<string, string>,
): Promise<void> {
  const payload = await readJsonBody(req, MAX_CONFIG_BODY)
  if (!isObject(payload)) throw new HttpError(400, '请求格式无效')
  const scope = payload.scope === 'vision' ? 'vision' : payload.scope === 'chat' ? 'chat' : ''
  if (!scope) throw new HttpError(400, '未知的模型类型')
  const draft = isObject(payload.draft) ? payload.draft : payload
  try {
    const result = await agent.listModels(scope, {
      baseUrl: typeof draft.baseUrl === 'string' ? draft.baseUrl : '',
      apiKey: typeof draft.apiKey === 'string' ? draft.apiKey : '',
    })
    sendJson(res, 200, result, cors)
  } catch (error) {
    if (error instanceof AgentInputError) throw error
    throw new HttpError(502, `拉取模型列表失败: ${truncate(errorMessage(error), 500)}`)
  }
}

export async function handleAgentRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  agent: AgentService,
  cors: Record<string, string>,
  log?: (line: string) => void,
): Promise<void> {
  void log
  const segments = pathname.split('/').filter(Boolean)
  try {
    const action = segments[2]
    const id = segments[3]

    if (action === 'config' && segments.length === 3) {
      if (req.method === 'GET' || req.method === 'POST') {
        await handleConfig(req, res, agent, cors)
        return
      }
      throw new HttpError(405, '方法不被支持')
    }
    if (action === 'models' && segments.length === 3) {
      if (req.method !== 'POST') throw new HttpError(405, '方法不被支持')
      await handleModels(req, res, agent, cors)
      return
    }
    if (action === 'turn' && segments.length === 3) {
      if (req.method !== 'POST') throw new HttpError(405, '方法不被支持')
      await handleTurn(req, res, agent, cors)
      return
    }
    if (action === 'specialist' && id === 'turn' && segments.length === 4) {
      if (req.method !== 'POST') throw new HttpError(405, '方法不被支持')
      await handleSpecialistTurn(req, res, agent, cors)
      return
    }
    if (action === 'scene-to-white-model' && segments.length === 3) {
      if (req.method !== 'POST') throw new HttpError(405, '方法不被支持')
      await handleSceneTool(req, res, agent, cors)
      return
    }
    if (action === 'conversations' && segments.length === 3) {
      if (req.method === 'GET') {
        sendJson(res, 200, { conversations: agent.listConversations() }, cors)
        return
      }
      if (req.method === 'POST') {
        sendJson(res, 200, { conversation: agent.createConversation() }, cors)
        return
      }
      throw new HttpError(405, '方法不被支持')
    }
    if (action === 'conversations' && id && segments.length === 4) {
      if (!ID_PATTERN.test(id)) throw new HttpError(400, '会话 id 无效')
      if (req.method === 'GET') {
        const detail = agent.getConversation(id)
        if (!detail) throw new HttpError(404, '会话不存在')
        sendJson(res, 200, detail, cors)
        return
      }
      if (req.method === 'DELETE') {
        if (!agent.deleteConversation(id)) throw new HttpError(404, '会话不存在')
        sendJson(res, 200, { ok: true }, cors)
        return
      }
      throw new HttpError(405, '方法不被支持')
    }
    if (action === 'conversations' && id && segments.length === 5 && segments[4] === 'attachments') {
      if (req.method !== 'POST') throw new HttpError(405, '方法不被支持')
      await handleAttachmentUpload(req, res, agent, id, cors)
      return
    }
    if (action === 'attachments' && id && segments.length === 4) {
      if (req.method !== 'GET') throw new HttpError(405, '方法不被支持')
      if (!ID_PATTERN.test(id)) throw new HttpError(400, '附件 id 无效')
      const attachment = agent.getAttachment(id)
      if (!attachment) throw new HttpError(404, '附件不存在')
      sendBinary(res, attachment.bytes, attachment.meta.mime, cors)
      return
    }
    throw new HttpError(404, '未知 API')
  } catch (error) {
    if (res.headersSent) {
      try { res.end() } catch { /* already closed */ }
      return
    }
    sendJson(res, errorStatus(error), { error: truncate(errorMessage(error), 2_000) }, cors)
  }
}
