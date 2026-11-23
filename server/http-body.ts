import type http from 'node:http'

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const truncate = (value: string, length: number): string => value.slice(0, length)

export function readRequestBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
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

export async function readJsonBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const body = await readRequestBody(req, limit)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, '请求 JSON 格式无效')
  }
}
