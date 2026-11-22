import fs from 'node:fs'
import path from 'node:path'
import { protocol } from 'electron'
import { mimeTypeFor } from '../../server/mime'

// App content is served from app://monoform instead of file://: Chromium blocks
// fetch() on file URLs, which the GLB loader and mediabunny chunks depend on.
const SCHEME = 'app'
const HOST = 'monoform'

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

// Must run before app.whenReady().
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

const notFound = (): Response => new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
const badRequest = (): Response => new Response('Bad Request', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

export function registerAppProtocol(rendererRoot: string): void {
  const root = path.resolve(rendererRoot)
  protocol.handle(SCHEME, async request => {
    const url = new URL(request.url)
    if (url.host !== HOST) return notFound()
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    let pathname = ''
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return badRequest()
    }
    let target = path.resolve(root, '.' + pathname)
    if (target !== root && !target.startsWith(root + path.sep)) return badRequest()
    try {
      if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html')
      const data = await fs.promises.readFile(target)
      const headers: Record<string, string> = {
        'Content-Type': mimeTypeFor(target),
        'Content-Length': String(data.length),
        'Cache-Control': 'no-cache',
      }
      if (target.endsWith('.html')) headers['Content-Security-Policy'] = CSP
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(new Uint8Array(data), { status: 200, headers })
    } catch {
      return notFound()
    }
  })
}
