import { api } from './api.js'
import { fetchJsonResponse, readJsonResponse } from './apiClient.js'
import { readSseStream } from './agentSse.js'

const jsonHeaders = { 'Content-Type': 'application/json' }

export async function getAgentConfig() {
  return fetchJsonResponse('/api/agent/config', {}, '读取 AI 配置失败')
}

export async function saveAgentConfig(payload) {
  return fetchJsonResponse('/api/agent/config', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  }, '保存 AI 配置失败')
}

export async function fetchAgentModels(scope, draft = {}) {
  const data = await fetchJsonResponse('/api/agent/models', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ scope, baseUrl: draft.baseUrl || '', apiKey: draft.apiKey || '' }),
  }, '拉取模型失败', 100000)
  return Array.isArray(data.models) ? data.models : []
}

export async function listAgentConversations() {
  const data = await fetchJsonResponse('/api/agent/conversations', {}, '读取会话失败')
  return Array.isArray(data.conversations) ? data.conversations : []
}

export async function createAgentConversation() {
  const data = await fetchJsonResponse('/api/agent/conversations', { method: 'POST' }, '新建会话失败')
  return data.conversation
}

export async function getAgentConversation(id) {
  return fetchJsonResponse(`/api/agent/conversations/${encodeURIComponent(id)}`, {}, '读取会话失败')
}

export async function deleteAgentConversation(id) {
  return fetchJsonResponse(`/api/agent/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }, '删除会话失败')
}

export async function uploadAgentAttachment(conversationId, file, outerSignal) {
  const form = new FormData()
  form.append('image', file)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  const onAbort = () => controller.abort()
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort()
    else outerSignal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await api.fetch(`/api/agent/conversations/${encodeURIComponent(conversationId)}/attachments`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    const data = await readJsonResponse(response, '上传图片失败')
    return data.attachment
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(outerSignal?.aborted ? '已停止' : '上传图片超时')
    throw error
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onAbort)
  }
}

export async function runSceneTool({ conversationId, attachmentId, note = '', signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 200000)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await api.fetch('/api/agent/scene-to-white-model', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ conversationId, attachmentId, note }),
      signal: controller.signal,
    })
    return await readJsonResponse(response, '场景转白模失败')
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(signal?.aborted ? '已停止' : '场景转白模超时（200 秒）')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function openAgentTurn({ conversationId, text, attachmentIds, toolResults, sceneContext, signal, onEvent }) {
  const body = { conversationId, sceneContext: String(sceneContext || '') }
  if (text !== undefined) {
    body.text = text
    body.attachmentIds = Array.isArray(attachmentIds) ? attachmentIds : []
  }
  if (Array.isArray(toolResults)) body.toolResults = toolResults
  const response = await api.fetch('/api/agent/turn', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    await readJsonResponse(response, 'AI 请求失败')
    throw new Error('AI 请求失败')
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    const data = await readJsonResponse(response, 'AI 服务返回无效响应')
    throw new Error(data?.error || 'AI 服务返回了非流式响应')
  }
  await readSseStream(response, event => {
    if (!event.data) return
    let payload = null
    try { payload = JSON.parse(event.data) } catch { return }
    if (payload && typeof payload === 'object') onEvent(payload)
  }, signal)
}
