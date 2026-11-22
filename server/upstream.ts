import type { ModelSummary, RawModelConfig } from './types'

export interface UpstreamOptions {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export interface ChatJsonOptions extends UpstreamOptions {
  image?: Uint8Array
  mime?: string
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const truncate = (value: string, length: number): string => value.slice(0, length)

export function chatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : trimmed + '/chat/completions'
}

export function modelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions')
    ? trimmed.slice(0, -'/chat/completions'.length) + '/models'
    : trimmed + '/models'
}

const upstreamHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'HTTP-Referer': 'http://127.0.0.1:5173',
  'X-Title': 'MONOFORM Scene to White Model',
})

export async function fetchRemoteModels(cfg: RawModelConfig, options: UpstreamOptions = {}): Promise<ModelSummary[]> {
  const baseUrl = (cfg['base-url'] || '').replace(/\/+$/, '')
  const apiKey = cfg['api-key'] || ''
  if (!baseUrl || !apiKey) throw new Error('请先配置 base-url 和 api-key')
  const endpoint = modelsEndpoint(baseUrl)
  const fetchImpl = options.fetchImpl || fetch
  const sleep = options.sleep || defaultSleep
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        headers: upstreamHeaders(apiKey),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      lastError = new Error(`上游模型服务连接失败: ${truncate(errorMessage(error), 300)}`)
      if (attempt === 2) throw lastError
      await sleep(1000 + attempt * 1000)
      continue
    }
    if (!response.ok) {
      const detail = truncate(await response.text(), 300)
      lastError = new Error(`上游模型服务 HTTP ${response.status}: ${detail}`)
      if (response.status < 500 || attempt === 2) throw lastError
      await sleep(1000 + attempt * 1000)
      continue
    }
    try {
      const payload: any = await response.json()
      const rows: unknown[] = Array.isArray(payload)
        ? payload
        : (payload && Array.isArray(payload.data) ? payload.data : [])
      return rows
        .filter((row): row is Record<string, any> => {
          if (!row || typeof row !== 'object' || Array.isArray(row)) return false
          return Boolean((row as Record<string, any>).id)
        })
        .map(row => ({ id: String(row.id), name: String(row.name ?? row.id ?? '') }))
    } catch (error) {
      lastError = new Error(`上游模型服务返回无效 JSON: ${truncate(errorMessage(error), 300)}`)
      if (attempt === 2) throw lastError
      await sleep(1000 + attempt * 1000)
    }
  }
  throw lastError || new Error('拉取模型失败: 未知错误')
}

export async function chatJson(
  cfg: RawModelConfig,
  systemPrompt: string,
  userText: string,
  options: ChatJsonOptions = {},
): Promise<unknown> {
  const baseUrl = (cfg['base-url'] || '').replace(/\/+$/, '')
  const apiKey = cfg['api-key'] || ''
  const model = cfg.model || ''
  if (!baseUrl || !apiKey || !model) throw new Error('model-key.txt 缺少 base-url、api-key 或 model')
  const endpoint = chatEndpoint(baseUrl)
  const fetchImpl = options.fetchImpl || fetch
  const sleep = options.sleep || defaultSleep
  const content: Array<Record<string, any>> = [{ type: 'text', text: userText }]
  if (options.image && options.image.length) {
    const mime = options.mime || 'image/png'
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${Buffer.from(options.image).toString('base64')}` },
    })
  }
  const payload = {
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
  }
  let raw = ''
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { ...upstreamHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180_000),
      })
    } catch (error) {
      lastError = new Error(errorMessage(error))
      if (attempt < 2) await sleep(2 ** attempt * 1000)
      continue
    }
    if (!response.ok) {
      const detail = truncate(await response.text(), 1000)
      // Retry transient upstream failures, but surface client/config errors immediately.
      if (response.status < 500 || attempt === 2) {
        throw new Error(`模型服务 HTTP ${response.status}: ${detail}`)
      }
      lastError = new Error(`模型服务 HTTP ${response.status}: ${detail}`)
      if (attempt < 2) await sleep(2 ** attempt * 1000)
      continue
    }
    raw = await response.text()
    break
  }
  if (!raw) {
    if (lastError) throw new Error(`模型服务连接失败（已重试3次）: ${truncate(errorMessage(lastError), 500)}`)
    throw new Error('模型服务返回空响应')
  }
  const result: any = JSON.parse(raw)
  let contentOut: any = result?.choices?.[0]?.message?.content
  if (Array.isArray(contentOut)) {
    contentOut = contentOut.map(item => (item && typeof item === 'object' ? String(item.text ?? '') : '')).join('')
  }
  return parseJsonFromModel(String(contentOut ?? ''))
}

export function stripCodeFence(text: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text)
  return match ? match[1].trim() : text.trim()
}

function extractFirstJsonValue(text: string): string | null {
  const opening = text[0]
  if (opening !== '{' && opening !== '[') return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      depth--
      if (depth === 0) return text.slice(0, index + 1)
    }
  }
  return null
}

export function parseJsonFromModel(text: string): unknown {
  const cleaned = stripCodeFence(text)
  try {
    return JSON.parse(cleaned)
  } catch {
    const starts = [cleaned.indexOf('{'), cleaned.indexOf('[')].filter(index => index >= 0)
    if (!starts.length) throw new Error('模型没有返回 JSON')
    const start = Math.min(...starts)
    const candidate = extractFirstJsonValue(cleaned.slice(start))
    if (!candidate) throw new Error('模型没有返回 JSON')
    return JSON.parse(candidate)
  }
}
