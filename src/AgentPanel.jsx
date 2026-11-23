import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, ChevronDown, History, Image as ImageIcon, Loader2, Paperclip, Plus, Send, Settings2, Sparkles, Square, Trash2, X,
} from 'lucide-react'
import {
  createAgentConversation, deleteAgentConversation, getAgentConfig, getAgentConversation,
  listAgentConversations, openAgentTurn, runSceneTool, uploadAgentAttachment,
} from './agentApi.js'
import { humanAiError } from './apiClient.js'
import { AgentConfigDialog } from './AgentConfigDialog.jsx'
import { stringifySceneContext } from './agentContext.js'
import { AGENT_TOOL_DEFINITIONS, executeAgentTool, parseToolResult } from './agentTools.js'

const MAX_FILES = 4
const MAX_FILE_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const formatTime = value => {
  const timestamp = Number(value)
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return `${date.getMonth() + 1}-${date.getDate()}`
}

const revokeMessages = messages => {
  for (const message of messages || []) {
    for (const attachment of message.attachments || []) {
      if (attachment.url) URL.revokeObjectURL(attachment.url)
    }
  }
}

const mapConversationDetail = detail => {
  const results = new Map()
  for (const message of detail.messages || []) {
    if (message.role === 'tool' && message.toolCallId) results.set(message.toolCallId, parseToolResult(message.content))
  }
  const entries = []
  for (const message of detail.messages || []) {
    if (message.role === 'user') {
      entries.push({
        id: message.id,
        role: 'user',
        content: message.content || '',
        attachments: (message.attachments || []).map(item => ({ ...item })),
      })
    } else if (message.role === 'assistant') {
      entries.push({
        id: message.id,
        role: 'assistant',
        content: message.content || '',
        toolCalls: (message.toolCalls || []).map(call => {
          const result = results.get(call.id)
          return {
            ...call,
            status: result ? (result.ok ? 'ok' : 'error') : 'pending',
            result,
          }
        }),
      })
    }
  }
  return entries
}

function ToolCard({ call }) {
  const label = AGENT_TOOL_DEFINITIONS.find(item => item.name === call.name)?.label || call.name || '工具'
  const status = call.status || 'pending'
  const result = call.result
  return (
    <div className={`agent-tool-card is-${status}`}>
      <div className="agent-tool-head">
        <span className="agent-tool-icon"><Sparkles size={12} /></span>
        <strong>{label}</strong>
        <span className="agent-tool-status">
          {status === 'running' ? '执行中' : status === 'ok' ? '完成' : status === 'error' ? '失败' : '未完成'}
        </span>
      </div>
      {status === 'running' && <small>正在分析结构并生成白模，可能需要一两分钟…</small>}
      {result?.ok && (
        <small>
          {result.message || `新增 ${Number(result.added) || 0} 个体块`}
          {Number(result.warnings) ? ` · ${result.warnings} 条待核对` : ''}
        </small>
      )}
      {result && !result.ok && <small className="is-error">{result.error || '执行失败'}</small>}
      {!result && status === 'pending' && <small>上一次工具调用未完成；可以重新发送消息。</small>}
    </div>
  )
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`agent-message is-${isUser ? 'user' : 'assistant'}`}>
      <div className="agent-message-body">
        {message.content && <div className="agent-message-text">{message.content}</div>}
        {message.attachments?.length > 0 && (
          <div className="agent-message-attachments">
            {message.attachments.map(attachment => (
              attachment.url
                ? <img key={attachment.id} src={attachment.url} alt={attachment.name || '场景图'} title={attachment.name} />
                : (
                  <span key={attachment.id} className="agent-attachment-chip" title={attachment.name}>
                    <ImageIcon size={12} /><span>{attachment.name || '场景图'}</span>
                  </span>
                )
            ))}
          </div>
        )}
        {message.toolCalls?.length > 0 && (
          <div className="agent-tool-list">
            {message.toolCalls.map(call => <ToolCard key={call.id} call={call} />)}
          </div>
        )}
        {message.streaming && <span className="agent-cursor" aria-hidden="true" />}
        {message.stopped && <small className="agent-message-note">已停止</small>}
        {message.error && <small className="agent-message-note is-error">{message.error}</small>}
      </div>
    </div>
  )
}

export const AgentPanel = memo(function AgentPanel({ getSceneContext, onApplyScene }) {
  const [config, setConfig] = useState(null)
  const [conversations, setConversations] = useState([])
  const [conversationId, setConversationId] = useState('')
  const [title, setTitle] = useState('')
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState([])
  const [streaming, setStreaming] = useState(false)
  const [status, setStatus] = useState('')
  const [clientError, setClientError] = useState('')
  const [error, setError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState('')
  const [configOpen, setConfigOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  const abortRef = useRef(null)
  const fileInputRef = useRef(null)
  const textareaRef = useRef(null)
  const messageListRef = useRef(null)
  const headerRef = useRef(null)
  const messagesRef = useRef(messages)
  const filesRef = useRef(files)
  messagesRef.current = messages
  filesRef.current = files

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await getAgentConfig())
    } catch (err) {
      setClientError(humanAiError(err))
    }
  }, [])

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listAgentConversations())
    } catch (err) {
      setError(humanAiError(err))
    }
  }, [])

  useEffect(() => {
    void loadConfig()
    void refreshConversations()
  }, [loadConfig, refreshConversations])

  useEffect(() => () => {
    abortRef.current?.abort()
    revokeMessages(messagesRef.current)
    for (const item of filesRef.current) URL.revokeObjectURL(item.url)
  }, [])

  useEffect(() => {
    if (!historyOpen) return
    const onPointerDown = event => {
      if (headerRef.current?.contains(event.target)) return
      setHistoryOpen(false)
    }
    const onKeyDown = event => { if (event.key === 'Escape') setHistoryOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [historyOpen])

  useEffect(() => {
    const element = messageListRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance < 140) element.scrollTop = element.scrollHeight
  }, [messages])

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(120, element.scrollHeight)}px`
  }, [draft])

  const removeFile = key => {
    setFiles(current => {
      const target = current.find(item => item.key === key)
      if (target) URL.revokeObjectURL(target.url)
      return current.filter(item => item.key !== key)
    })
  }

  const addFiles = list => {
    const incoming = Array.from(list || [])
    if (!incoming.length) return
    const accepted = []
    let firstError = ''
    for (const file of incoming) {
      if (!IMAGE_TYPES.has(file.type)) { firstError = '图片必须是 PNG、JPG 或 WebP'; continue }
      if (file.size > MAX_FILE_BYTES) { firstError = '单张图片不能超过 20 MB'; continue }
      if (files.length + accepted.length >= MAX_FILES) { firstError = `每条消息最多 ${MAX_FILES} 张图片`; break }
      accepted.push({ key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, url: URL.createObjectURL(file) })
    }
    if (accepted.length) setFiles(current => [...current, ...accepted].slice(0, MAX_FILES))
    if (firstError) setError(firstError)
  }

  const newConversation = () => {
    if (streaming) return
    revokeMessages(messages)
    for (const item of files) URL.revokeObjectURL(item.url)
    setMessages([])
    setFiles([])
    setConversationId('')
    setTitle('')
    setDraft('')
    setError('')
    setStatus('')
    setHistoryOpen(false)
    setConfirmDeleteId('')
  }

  const selectConversation = async id => {
    if (streaming || !id) return
    setHistoryOpen(false)
    setError('')
    try {
      const detail = await getAgentConversation(id)
      revokeMessages(messages)
      for (const item of files) URL.revokeObjectURL(item.url)
      setFiles([])
      setDraft('')
      setMessages(mapConversationDetail(detail))
      setConversationId(id)
      setTitle(detail.conversation.title || '')
      setStatus('')
    } catch (err) {
      setError(humanAiError(err))
    }
  }

  const removeConversation = async id => {
    if (streaming) return
    try {
      await deleteAgentConversation(id)
      setConfirmDeleteId('')
      if (id === conversationId) newConversation()
      await refreshConversations()
    } catch (err) {
      setError(humanAiError(err))
    }
  }

  const runTurnLoop = async ({ conversationId: activeId, text, attachmentIds, sceneContext, uploaded, signal }) => {
    const abortError = () => {
      const next = new Error('已停止')
      next.name = 'AbortError'
      return next
    }
    let payload = { conversationId: activeId, text, attachmentIds, sceneContext }
    for (let round = 0; round < 5; round += 1) {
      if (signal.aborted) throw abortError()
      const localId = `local-a-${Date.now()}-${round}`
      setMessages(current => [...current, { id: localId, role: 'assistant', content: '', toolCalls: [], streaming: true }])
      let finalMessage = null
      let currentId = localId
      let streamError = ''
      setStatus(round === 0 ? '正在生成…' : '正在整理工具结果…')
      await openAgentTurn({
        ...payload,
        signal,
        onEvent: event => {
          if (event.type === 'conversation') {
            setConversationId(event.conversation.id)
            setTitle(event.conversation.title || '')
          } else if (event.type === 'delta') {
            const piece = String(event.text || '')
            if (!piece) return
            setMessages(current => current.map(item => item.id === localId ? { ...item, content: item.content + piece } : item))
          } else if (event.type === 'message') {
            finalMessage = event.message
            currentId = event.message.id
            setMessages(current => current.map(item => item.id === localId ? {
              ...item,
              id: event.message.id,
              content: event.message.content || '',
              toolCalls: (event.message.toolCalls || []).map(call => ({ ...call, status: 'running' })),
              streaming: false,
            } : item))
          } else if (event.type === 'error') {
            streamError = event.message || 'AI 请求失败'
          }
        },
      })
      if (signal.aborted) throw abortError()
      if (streamError) throw new Error(streamError)
      if (!finalMessage) throw new Error('AI 服务没有返回回复')
      if (!finalMessage.toolCalls?.length) return
      setStatus('正在执行工具…')
      const results = []
      for (const call of finalMessage.toolCalls) {
        if (signal.aborted) throw abortError()
        const raw = await executeAgentTool(call, {
          conversationId: activeId,
          attachments: uploaded,
          runSceneTool: args => runSceneTool({ ...args, signal }),
          applyScene: onApplyScene,
          signal,
        })
        const parsed = parseToolResult(raw)
        setMessages(current => current.map(item => item.id === currentId ? {
          ...item,
          toolCalls: (item.toolCalls || []).map(toolCall => toolCall.id === call.id ? {
            ...toolCall,
            status: parsed.ok ? 'ok' : 'error',
            result: parsed,
          } : toolCall),
        } : item))
        if (signal.aborted) throw abortError()
        results.push({ toolCallId: call.id, content: raw })
      }
      payload = { conversationId: activeId, toolResults: results, sceneContext }
    }
    throw new Error('工具调用次数过多；请重新发送消息')
  }

  const submit = async textOverride => {
    if (streaming) return
    const text = String(textOverride ?? draft).trim()
    if (!text && !files.length) return
    if (!config) {
      setError('AI 配置尚未读取完成，请稍后重试')
      return
    }
    if (!config.chat.configured) {
      setError('请先配置对话模型')
      setConfigOpen(true)
      return
    }
    if (clientError) return
    setError('')
    setHistoryOpen(false)
    setStreaming(true)
    setStatus('正在连接…')
    const controller = new AbortController()
    abortRef.current = controller
    const pending = files
    try {
      let activeId = conversationId
      if (!activeId) {
        const conversation = await createAgentConversation()
        activeId = conversation.id
        setConversationId(activeId)
        setTitle(conversation.title || '新会话')
      }
      const uploaded = []
      for (let index = 0; index < pending.length; index += 1) {
        setStatus(`上传图片 ${index + 1}/${pending.length}…`)
        const attachment = await uploadAgentAttachment(activeId, pending[index].file, controller.signal)
        uploaded.push({ ...attachment, file: pending[index].file, url: pending[index].url })
      }
      setMessages(current => [...current, {
        id: `local-u-${Date.now()}`,
        role: 'user',
        content: text,
        attachments: uploaded.map(item => ({
          id: item.id,
          name: item.name,
          mime: item.mime,
          size: item.size,
          file: item.file,
          url: item.url,
        })),
      }])
      setDraft('')
      setFiles([])
      const sceneContext = stringifySceneContext(getSceneContext())
      await runTurnLoop({
        conversationId: activeId,
        text,
        attachmentIds: uploaded.map(item => item.id),
        sceneContext,
        uploaded,
        signal: controller.signal,
      })
      setStatus('')
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        setStatus('已停止')
        setMessages(current => current.map(item => item.streaming ? { ...item, streaming: false, stopped: true } : item))
      } else {
        const detail = humanAiError(err)
        setError(detail)
        setStatus('')
        setMessages(current => current.map(item => item.streaming ? { ...item, streaming: false, error: detail } : item))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      void refreshConversations()
    }
  }

  const stop = () => {
    if (!streaming) return
    setStatus('正在停止…')
    abortRef.current?.abort()
  }

  const retry = async () => {
    setClientError('')
    setError('')
    await loadConfig()
    await refreshConversations()
  }

  const handlePaste = event => {
    const pasted = event.clipboardData?.files
    if (pasted?.length) {
      event.preventDefault()
      addFiles(pasted)
    }
  }

  const handleDrop = event => {
    event.preventDefault()
    setDragActive(false)
    addFiles(event.dataTransfer?.files)
  }

  const handleKeyDown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  const canChat = Boolean(config?.chat?.configured) && !clientError
  const hasMessages = messages.length > 0
  const busy = streaming || Boolean(status && status !== '已停止')

  return (
    <section className="agent-panel" aria-label="AI 助手">
      <div className="agent-head" ref={headerRef}>
        <div className="agent-head-title" title={title || '新对话'}>
          <span>{title || '新对话'}</span>
          {streaming && <i className="agent-live-dot" aria-hidden="true" />}
        </div>
        <div className="agent-head-actions">
          <button
            type="button"
            className={`agent-head-button agent-history-toggle ${historyOpen ? 'is-active' : ''}`}
            onClick={() => {
              if (streaming) return
              setHistoryOpen(open => !open)
              if (!historyOpen) void refreshConversations()
            }}
            disabled={streaming}
            title="会话历史"
          >
            <History size={12} /><span>历史</span><ChevronDown size={10} />
          </button>
          <button type="button" className="agent-head-button" onClick={newConversation} disabled={streaming} title="新建会话" aria-label="新建会话"><Plus size={14} /></button>
          <button type="button" className="agent-head-button" onClick={() => setConfigOpen(true)} title="模型与工具设置" aria-label="模型与工具设置"><Settings2 size={14} /></button>
        </div>
        {historyOpen && (
          <div className="agent-history">
            <div className="agent-history-head"><strong>会话历史</strong><span>{conversations.length}</span></div>
            {conversations.length === 0 && <div className="agent-history-empty">暂无会话</div>}
            {conversations.map(conversation => (
              <div key={conversation.id} className={`agent-history-row ${conversation.id === conversationId ? 'is-active' : ''}`}>
                <button
                  type="button"
                  className="agent-history-main"
                  onClick={() => void selectConversation(conversation.id)}
                  disabled={streaming || confirmDeleteId === conversation.id}
                >
                  <strong>{conversation.title}</strong>
                  <small>{formatTime(conversation.updatedAt)} · {conversation.messageCount || 0} 条</small>
                </button>
                {confirmDeleteId === conversation.id ? (
                  <div className="agent-history-confirm">
                    <span>删除？</span>
                    <button type="button" onClick={() => void removeConversation(conversation.id)}>删除</button>
                    <button type="button" onClick={() => setConfirmDeleteId('')}>取消</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="agent-history-delete"
                    onClick={() => setConfirmDeleteId(conversation.id)}
                    disabled={streaming}
                    title="删除会话"
                    aria-label={`删除会话 ${conversation.title}`}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {clientError && (
        <div className="agent-banner is-error">
          <AlertTriangle size={13} />
          <span>{clientError}</span>
          <button type="button" onClick={() => void retry()}>重试</button>
        </div>
      )}
      {error && !clientError && (
        <div className="agent-banner is-warning">
          <AlertTriangle size={13} />
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={11} /></button>
        </div>
      )}

      <div className={`agent-messages ${hasMessages ? '' : 'is-empty'}`} ref={messageListRef}>
        {!hasMessages && (
          <div className="agent-empty">
            <span className="agent-empty-mark"><Sparkles size={24} /></span>
            <strong>AI 助手</strong>
            {config?.chat?.configured ? (
              <>
                <p>上传场景图，我可以把它转成可编辑白模；也可以问当前场景的构图与镜头。</p>
                <div className="agent-suggestions">
                  <button type="button" onClick={() => fileInputRef.current?.click()}>上传场景图 → 转白模</button>
                  <button type="button" onClick={() => { setDraft('当前场景里有哪些对象？'); textareaRef.current?.focus() }}>当前场景里有哪些对象？</button>
                </div>
              </>
            ) : (
              <>
                <p>还没有配置对话模型。配置后即可上传场景图，通过对话完成场景转白模。</p>
                <button type="button" className="agent-empty-cta" onClick={() => setConfigOpen(true)}>打开模型设置</button>
              </>
            )}
            <small>Enter 发送 · Shift+Enter 换行 · 可直接粘贴图片</small>
          </div>
        )}
        {messages.map(message => <MessageBubble key={message.id} message={message} />)}
      </div>

      <div
        className={`agent-composer ${dragActive ? 'is-drag' : ''}`}
        onDragOver={event => { event.preventDefault(); setDragActive(true) }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        {!canChat && !clientError && (
          <button type="button" className="agent-config-cta" onClick={() => setConfigOpen(true)}>
            <Settings2 size={12} /> 先配置对话模型
          </button>
        )}
        {files.length > 0 && (
          <div className="agent-composer-files">
            {files.map(item => (
              <div key={item.key} className="agent-composer-file">
                <img src={item.url} alt={item.file.name} />
                <button type="button" onClick={() => removeFile(item.key)} aria-label={`移除 ${item.file.name}`}><X size={10} /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="agent-input"
          rows={1}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={canChat ? '描述场景或上传图片，说「转白模」…' : '配置对话模型后开始聊天'}
          disabled={Boolean(clientError)}
          aria-label="AI 助手输入框"
        />
        <div className="agent-composer-actions">
          <div className="agent-composer-left">
            <button
              type="button"
              className="agent-icon-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming || Boolean(clientError)}
              title="添加场景图"
              aria-label="添加场景图"
            >
              <Paperclip size={14} />
            </button>
            <button type="button" className="agent-model-chip" onClick={() => setConfigOpen(true)} title="模型与工具设置">
              <Sparkles size={10} />
              <span>{config?.chat?.configured ? config.chat.model : '未配置模型'}</span>
            </button>
            <span className="agent-tool-count" title={AGENT_TOOL_DEFINITIONS.map(item => item.label).join('、')}>{AGENT_TOOL_DEFINITIONS.length} 个工具</span>
          </div>
          <div className="agent-composer-right">
            {busy && <span className="agent-status"><Loader2 size={11} className="agent-spin" />{status || '处理中…'}</span>}
            {!busy && status && <span className="agent-status">{status}</span>}
            {streaming ? (
              <button type="button" className="agent-send-button is-stop" onClick={stop} title="停止生成" aria-label="停止生成"><Square size={12} /></button>
            ) : (
              <button
                type="button"
                className="agent-send-button"
                onClick={() => void submit()}
                disabled={!canChat || (!draft.trim() && !files.length)}
                title="发送"
                aria-label="发送"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={event => { addFiles(event.target.files); event.target.value = '' }}
        />
      </div>

      {configOpen && (
        <AgentConfigDialog
          onClose={() => setConfigOpen(false)}
          onSaved={next => { setConfig(next); setConfigOpen(false); setError('') }}
        />
      )}
    </section>
  )
})
