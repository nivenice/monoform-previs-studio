import { api } from './api.js'

export async function readJsonResponse(response, fallbackMessage = '服务没有返回有效 JSON') {
  const raw = await response.text()
  let data = null
  if (raw.trim()) {
    try { data = JSON.parse(raw) } catch { throw new Error(`${fallbackMessage}（响应格式错误）`) }
  }
  if (!response.ok) throw new Error(data?.error || `${fallbackMessage}（HTTP ${response.status}）`)
  if (!data) throw new Error(`${fallbackMessage}（响应为空）`)
  return data
}

export async function fetchJsonResponse(url, options = {}, fallbackMessage = '请求失败', timeoutMs = 45000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await api.fetch(url, { ...options, signal: controller.signal })
    return await readJsonResponse(response, fallbackMessage)
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${fallbackMessage}（${Math.round(timeoutMs / 1000)} 秒超时）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function humanAiError(error) {
  const message = String(error?.message || error || '请求失败')
  if (/Failed to fetch|NetworkError|fetch failed|ECONNREFUSED/i.test(message)) {
    return '本地 AI 服务不可用；桌面版会自动启动，浏览器版请运行 npm run server'
  }
  return message.slice(0, 2000)
}
