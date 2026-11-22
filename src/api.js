// The Electron preload exposes an absolute loopback origin and a per-session
// token. The browser build has no preload, so it keeps using relative /api
// requests through the Vite dev/preview proxy.
const runtime = typeof window === 'undefined' ? null : window.monoform

export function createApi({ baseUrl = '', token = '', unavailableMessage = '' } = {}) {
  const requestUrl = path => `${baseUrl}${path}`
  return {
    url: requestUrl,
    async fetch(path, options = {}) {
      if (unavailableMessage) throw new Error(unavailableMessage)
      const headers = new Headers(options.headers || {})
      if (token) headers.set('Authorization', `Bearer ${token}`)
      return fetch(requestUrl(path), { ...options, headers })
    },
  }
}

export const api = createApi(
  runtime
    ? {
        baseUrl: runtime.apiBaseUrl || '',
        token: runtime.apiToken || '',
        unavailableMessage: runtime.apiBaseUrl ? '' : (runtime.aiError || '本地识图服务不可用'),
      }
    : {},
)
