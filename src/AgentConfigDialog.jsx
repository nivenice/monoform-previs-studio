import { useEffect, useState } from 'react'
import { Settings2, X } from 'lucide-react'
import { fetchAgentModels, getAgentConfig, saveAgentConfig } from './agentApi.js'
import { humanAiError } from './apiClient.js'

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'qwen', label: '阿里云百炼 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'moonshot', label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'custom', label: '自定义', baseUrl: '' },
]

const providerOf = id => PROVIDERS.find(item => item.id === id) || null

function ConfigSection({ title, hint, optional, value, onChange, models, onFetch, busy, onUseChat }) {
  const changeProvider = event => {
    const provider = event.target.value
    if (!provider) {
      onChange({ provider: '', baseUrl: '', apiKey: '', apiKeyConfigured: false, model: '' })
      return
    }
    const preset = providerOf(provider)
    onChange({ ...value, provider, ...(preset && preset.baseUrl ? { baseUrl: preset.baseUrl } : {}) })
  }
  return (
    <section className="agent-config-section">
      <div className="agent-config-section-head">
        <div><strong>{title}</strong>{optional && <span className="agent-config-optional">可选</span>}</div>
        <small>{hint}</small>
      </div>
      <label className="model-settings-field"><span>供应商</span>
        <select aria-label={`${title}供应商`} value={value.provider} onChange={changeProvider}>
          {optional && <option value="">未配置（复用对话模型）</option>}
          {PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label className="model-settings-field"><span>API 地址</span>
        <input
          aria-label={`${title} API 地址`}
          value={value.baseUrl}
          onChange={event => onChange({ ...value, baseUrl: event.target.value })}
          placeholder="https://.../v1"
          spellCheck={false}
        />
      </label>
      <label className="model-settings-field"><span>API Key</span>
        <input
          aria-label={`${title} API Key`}
          type="password"
          autoComplete="off"
          value={value.apiKey}
          onChange={event => onChange({ ...value, apiKey: event.target.value })}
          placeholder={value.apiKeyConfigured ? '已配置，留空保持' : '填写 API Key'}
        />
      </label>
      <div className="agent-config-model-row">
        <label className="model-settings-field"><span>模型</span>
          <input
            aria-label={`${title}模型`}
            value={value.model}
            onChange={event => onChange({ ...value, model: event.target.value })}
            placeholder="模型 ID"
            spellCheck={false}
          />
        </label>
        <button type="button" className="agent-config-fetch" onClick={onFetch} disabled={busy}>{busy ? '拉取中…' : '拉取列表'}</button>
      </div>
      {models.length > 0 && (
        <select
          className="agent-config-model-picker"
          aria-label={`从列表选择${title}模型`}
          value=""
          onChange={event => { if (event.target.value) onChange({ ...value, model: event.target.value }) }}
        >
          <option value="">从已拉取列表选择…</option>
          {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>
      )}
      {optional && onUseChat && (
        <button type="button" className="agent-config-use-chat" onClick={onUseChat}>沿用对话服务地址与密钥</button>
      )}
    </section>
  )
}

export function AgentConfigDialog({ onClose, onSaved }) {
  const [chat, setChat] = useState({ provider: 'deepseek', baseUrl: '', apiKey: '', apiKeyConfigured: false, model: '' })
  const [vision, setVision] = useState({ provider: '', baseUrl: '', apiKey: '', apiKeyConfigured: false, model: '' })
  const [chatModels, setChatModels] = useState([])
  const [visionModels, setVisionModels] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    let active = true
    getAgentConfig().then(config => {
      if (!active) return
      setChat({
        provider: config.chat.provider || 'custom',
        baseUrl: config.chat.baseUrl || '',
        apiKey: '',
        apiKeyConfigured: Boolean(config.chat.apiKeyConfigured),
        model: config.chat.model || '',
      })
      setVision({
        provider: config.vision.provider || '',
        baseUrl: config.vision.baseUrl || '',
        apiKey: '',
        apiKeyConfigured: Boolean(config.vision.apiKeyConfigured),
        model: config.vision.model || '',
      })
    }).catch(err => { if (active) setError(humanAiError(err)) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const fetchModels = async scope => {
    setBusy(scope)
    setError('')
    setStatus('正在拉取模型列表…')
    try {
      const models = await fetchAgentModels(scope, scope === 'chat' ? chat : vision)
      if (scope === 'chat') setChatModels(models)
      else setVisionModels(models)
      setStatus(models.length ? `已拉取 ${models.length} 个模型` : '模型列表为空，可直接手动填写模型 ID')
    } catch (err) {
      setError(humanAiError(err))
      setStatus('')
    } finally {
      setBusy('')
    }
  }

  const useChatService = () => {
    setVision(current => ({
      ...current,
      provider: chat.provider,
      baseUrl: chat.baseUrl,
      apiKey: '',
      apiKeyConfigured: chat.apiKeyConfigured,
    }))
  }

  const save = async () => {
    setError('')
    if (!chat.baseUrl.trim() || !chat.model.trim()) {
      setError('请填写对话模型的 API 地址和模型 ID')
      return
    }
    if (!chat.apiKey.trim() && !chat.apiKeyConfigured) {
      setError('请填写对话模型的 API Key')
      return
    }
    const visionAny = Boolean(vision.provider || vision.baseUrl.trim() || vision.apiKey.trim() || vision.model.trim())
    if (visionAny) {
      if (!vision.baseUrl.trim() || !vision.model.trim()) {
        setError('识图配置不完整：请填写 API 地址、密钥和模型，或全部留空以复用对话模型')
        return
      }
      if (!vision.apiKey.trim() && !vision.apiKeyConfigured) {
        setError('请填写识图模型的 API Key')
        return
      }
    }
    setBusy('save')
    setStatus('正在保存…')
    try {
      const config = await saveAgentConfig({
        chat: { provider: chat.provider, baseUrl: chat.baseUrl.trim(), apiKey: chat.apiKey.trim(), model: chat.model.trim() },
        vision: {
          provider: vision.provider,
          baseUrl: vision.baseUrl.trim(),
          apiKey: vision.apiKey.trim(),
          model: vision.model.trim(),
        },
      })
      onSaved(config)
    } catch (err) {
      setError(humanAiError(err))
      setStatus('')
    } finally {
      setBusy('')
    }
  }

  return (
    <div
      className="settings-overlay agent-config-overlay"
      role="presentation"
      onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        className="settings-dialog agent-config-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-config-title"
      >
        <div className="settings-dialog-head">
          <div><Settings2 size={17} /><span><strong id="agent-config-title">AI 模型设置</strong><small>对话模型必填 · 识图模型可留空</small></span></div>
          <button type="button" onClick={onClose} aria-label="关闭模型设置"><X size={14} /></button>
        </div>
        <div className="agent-config-body">
          <ConfigSection
            title="对话模型"
            hint="Agent 的主模型，必须支持 OpenAI 兼容的 tools 调用。"
            value={chat}
            onChange={setChat}
            models={chatModels}
            onFetch={() => fetchModels('chat')}
            busy={busy === 'chat'}
          />
          <ConfigSection
            title="识图模型"
            hint="用于「场景转白模」。留空则复用对话模型，此时对话模型需支持图片输入。"
            optional
            value={vision}
            onChange={setVision}
            models={visionModels}
            onFetch={() => fetchModels('vision')}
            busy={busy === 'vision'}
            onUseChat={useChatService}
          />
          {error && <div className="agent-config-error" role="alert">{error}</div>}
          {status && !error && <div className="agent-config-status" role="status">{status}</div>}
          <small className="agent-config-hint">密钥只保存在本机服务端配置文件里，不进入工程文件，也不会回显到界面。</small>
        </div>
        <div className="settings-dialog-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button type="button" className="agent-config-save" onClick={save} disabled={Boolean(busy)}>{busy === 'save' ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  )
}
