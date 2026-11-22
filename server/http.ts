import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { mimeTypeFor } from './mime'
import type { AiService } from './types'

const MAX_MULTIPART_BODY = 25 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_CONFIG_BODY = 8 * 1024
const MAX_PROMPT_BODY = 64 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const truncate = (value: string, length: number): string => value.slice(0, length)

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface StartAiServerOptions {
  service: AiService
  host?: string
  port?: number
  token?: string
  staticDir?: string
  log?: (line: string) => void
}

export interface RunningAiServer {
  origin: string
  port: number
  server: http.Server
  close(): Promise<void>
}

const isLoopbackHost = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1'

const isLocalOrigin = (origin: string): boolean =>
  /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin === 'app://monoform'

function corsHeaders(req: http.IncomingMessage, allowAny: boolean): Record<string, string> {
  const origin = req.headers.origin
  const headers: Record<string, string> = {}
  if (allowAny) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (origin && isLocalOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  return headers
}

function originAllowed(req: http.IncomingMessage, allowAny: boolean): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  return allowAny || isLocalOrigin(origin)
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(value)
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

function sendEmpty(res: http.ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers)
  res.end()
}

function readRequestBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0)
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      reject(new HttpError(413, `请求体超过 ${Math.round(limit / 1024 / 1024 * 10) / 10} MB 上限`))
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > limit) {
        req.resume()
        fail(new HttpError(413, `请求体超过 ${Math.round(limit / 1024 / 1024 * 10) / 10} MB 上限`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', error => fail(error))
    req.on('aborted', () => fail(new Error('请求已中断')))
  })
}

async function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const body = await readRequestBody(req, limit)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, '请求 JSON 格式无效')
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, staticDir: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Method Not Allowed')
    return
  }
  let decoded = ''
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Bad Request')
    return
  }
  const root = path.resolve(staticDir)
  let target = path.resolve(root, '.' + decoded)
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Bad Request')
    return
  }
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html')
    const data = fs.readFileSync(target)
    res.writeHead(200, {
      'Content-Type': mimeTypeFor(target),
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  service: AiService,
  token: string,
  staticDir: string | undefined,
  log: (line: string) => void,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname
  const allowAnyOrigin = Boolean(token)
  const cors = corsHeaders(req, allowAnyOrigin)
  log(`[${req.socket.remoteAddress || '127.0.0.1'}] ${req.method || 'GET'} ${pathname}`)
  try {
    if (pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        if (!originAllowed(req, allowAnyOrigin)) {
          sendEmpty(res, 403)
          return
        }
        const headers: Record<string, string> = {
          ...cors,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Max-Age': '86400',
        }
        if (req.headers['access-control-request-private-network'] === 'true') {
          headers['Access-Control-Allow-Private-Network'] = 'true'
        }
        sendEmpty(res, 204, headers)
        return
      }
      if (!originAllowed(req, allowAnyOrigin)) {
        sendJson(res, 403, { error: '请求来源不被允许' }, cors)
        return
      }
      if (token && pathname !== '/api/health') {
        const authorization = req.headers.authorization || ''
        if (authorization !== `Bearer ${token}`) {
          sendJson(res, 401, { error: '未授权的本机服务请求' }, cors)
          return
        }
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, service.health(), cors)
        return
      }
      if (req.method === 'GET' && pathname === '/api/model-config') {
        sendJson(res, 200, service.publicConfig(), cors)
        return
      }
      if (req.method === 'GET' && pathname === '/api/models') {
        try {
          sendJson(res, 200, await service.listModels(), cors)
        } catch (error) {
          sendJson(res, 502, { error: `拉取模型列表失败: ${truncate(errorMessage(error), 500)}` }, cors)
        }
        return
      }
      if (req.method === 'POST' && pathname === '/api/model-config') {
        const payload = await readJsonBody(req, MAX_CONFIG_BODY)
        if (!isObject(payload)) throw new HttpError(400, '模型设置格式无效')
        const baseUrl = String(payload['base-url'] ?? '').trim()
        if (baseUrl && !(baseUrl.startsWith('https://') || baseUrl.startsWith('http://127.0.0.1:'))) {
          throw new HttpError(400, 'API 地址必须是 HTTPS 或本机地址')
        }
        const model = String(payload.model ?? '').trim()
        if (model.length > 180) throw new HttpError(400, '模型 ID 不能超过 180 个字符')
        sendJson(res, 200, service.saveConfig(payload), cors)
        return
      }
      if (req.method === 'POST' && pathname === '/api/generate-scene') {
        const contentType = String(req.headers['content-type'] || '')
        if (!/^multipart\/form-data\b/i.test(contentType)) {
          throw new HttpError(400, '请使用 multipart/form-data 上传场景图')
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
          throw new HttpError(400, '场景图片表单解析失败')
        }
        const image = form.get('image')
        if (!image || typeof image === 'string' || typeof image.arrayBuffer !== 'function' || image.size <= 0) {
          throw new HttpError(400, '请先上传场景图')
        }
        const mime = image.type || 'application/octet-stream'
        if (!IMAGE_TYPES.has(mime)) throw new HttpError(400, '场景图必须是 PNG、JPG 或 WebP')
        if (image.size > MAX_IMAGE_BYTES) throw new HttpError(413, '场景图不能超过 20 MB')
        const promptValue = form.get('prompt')
        const prompt = typeof promptValue === 'string' ? promptValue : ''
        const imageBytes = new Uint8Array(await image.arrayBuffer())
        sendJson(res, 200, await service.generateScene({ image: imageBytes, mime, prompt }), cors)
        return
      }
      if (req.method === 'POST' && pathname === '/api/generate-pose') {
        const payload = await readJsonBody(req, MAX_PROMPT_BODY)
        if (!isObject(payload)) throw new HttpError(400, '请求格式无效')
        const prompt = String(payload.prompt ?? '生成自然站立姿势')
        sendJson(res, 200, { pose: await service.generatePose(prompt) }, cors)
        return
      }
      if (req.method === 'POST' && pathname === '/api/generate-object') {
        const payload = await readJsonBody(req, MAX_PROMPT_BODY)
        if (!isObject(payload)) throw new HttpError(400, '请求格式无效')
        const prompt = String(payload.prompt ?? '设计一个简单的可调白模物体')
        sendJson(res, 200, { object: await service.generateObject(prompt) }, cors)
        return
      }
      sendJson(res, 404, { error: '未知 API' }, cors)
      return
    }

    if (staticDir) {
      serveStatic(req, res, pathname, staticDir)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message }, cors)
    } else {
      // API errors are shown in the UI; no key is included here.
      sendJson(res, 502, { error: truncate(errorMessage(error), 2000) }, cors)
    }
  }
}

export async function startAiServer(options: StartAiServerOptions): Promise<RunningAiServer> {
  const host = options.host || '127.0.0.1'
  if (!isLoopbackHost(host)) throw new Error('AI 服务只允许绑定本机回环地址')
  const token = options.token || ''
  const log = options.log || ((line: string) => console.log(line))
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, options.service, token, options.staticDir, log)
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port ?? 0, host)
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : (options.port ?? 0)
  const originHost = host.includes(':') ? `[${host}]` : host
  return {
    origin: `http://${originHost}:${port}`,
    port,
    server,
    close: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(error => error ? reject(error) : resolve())
      server.closeIdleConnections?.()
    }),
  }
}
