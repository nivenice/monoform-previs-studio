// Small SSE reader for the local agent stream. The browser EventSource cannot
// send the Authorization header, so the panel uses fetch + this parser.
export function createSseParser() {
  let buffer = ''
  const separator = /\r?\n\r?\n/

  const parseFrame = frame => {
    const lines = frame.split(/\r?\n/)
    let event = 'message'
    const data = []
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue
      const index = line.indexOf(':')
      const field = index === -1 ? line : line.slice(0, index)
      let value = index === -1 ? '' : line.slice(index + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    return data.length ? { event, data: data.join('\n') } : null
  }

  return {
    push(chunk) {
      buffer += String(chunk || '')
      const events = []
      let match = separator.exec(buffer)
      while (match) {
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const event = parseFrame(frame)
        if (event) events.push(event)
        match = separator.exec(buffer)
      }
      return events
    },
    flush() {
      const frame = buffer
      buffer = ''
      if (!frame.trim()) return []
      const event = parseFrame(frame)
      return event ? [event] : []
    },
  }
}

export async function readSseStream(response, onEvent, signal) {
  if (!response.body) throw new Error('本地服务没有返回流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      for (const event of parser.push(decoder.decode(value, { stream: true }))) onEvent(event)
    }
    for (const event of parser.flush()) onEvent(event)
  } finally {
    try { reader.releaseLock() } catch { /* the stream may already be closed */ }
  }
}
