import fs from 'node:fs'
import path from 'node:path'
import type { PublicAgentConfig, PublicChatConfig, PublicVisionConfig } from './agent/types'
import type { ChatModelConfig, PublicModelConfig, RawModelConfig } from './types'

export const DEFAULT_KEY_FILE = 'F:\\hermes-sceneTo 3d\\model-key.txt'

export const VISION_KEYS = ['base-url', 'api-key', 'model'] as const
export const CHAT_KEYS = ['chat-base-url', 'chat-api-key', 'chat-model'] as const
export const PROVIDER_KEYS = ['provider', 'chat-provider'] as const
export const CONFIG_KEYS = [...VISION_KEYS, ...CHAT_KEYS, ...PROVIDER_KEYS] as const

type ConfigKey = typeof CONFIG_KEYS[number]
type ChatKey = typeof CHAT_KEYS[number]

const isConfigKey = (key: string): key is ConfigKey =>
  (CONFIG_KEYS as readonly string[]).includes(key)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export interface ModelConfigStoreOptions {
  configFile: string
  keyFile?: string
}

export class ModelConfigStore {
  readonly configFile: string
  readonly keyFile: string

  constructor(options: ModelConfigStoreOptions) {
    this.configFile = options.configFile
    this.keyFile = options.keyFile || process.env.MONOFORM_MODEL_KEY_FILE || DEFAULT_KEY_FILE
  }

  private readKeyFile(): RawModelConfig {
    const values: RawModelConfig = {}
    let raw = ''
    try {
      raw = fs.readFileSync(this.keyFile, 'utf8')
    } catch {
      return values
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const index = trimmed.indexOf('=')
      const key = trimmed.slice(0, index).trim()
      const value = trimmed.slice(index + 1).trim()
      if (key && isConfigKey(key)) values[key] = value
    }
    return values
  }

  private readStoreConfig(): RawModelConfig {
    let data: unknown
    try {
      data = JSON.parse(fs.readFileSync(this.configFile, 'utf8'))
    } catch {
      return {}
    }
    if (!isObject(data)) return {}
    const values: RawModelConfig = {}
    for (const [key, value] of Object.entries(data)) {
      // Empty strings are kept: they let the JSON file override a value that
      // otherwise came from the legacy key file.
      if (isConfigKey(key) && typeof value === 'string') values[key] = value
    }
    return values
  }

  private merged(): RawModelConfig {
    return Object.assign(this.readKeyFile(), this.readStoreConfig())
  }

  load(): RawModelConfig {
    const source = this.merged()
    const values: RawModelConfig = {}
    for (const key of VISION_KEYS) {
      if (source[key] !== undefined) values[key] = source[key]
    }
    if (source.provider !== undefined) values.provider = source.provider
    return values
  }

  chatConfig(): ChatModelConfig {
    const source = this.merged()
    const values: ChatModelConfig = {}
    for (const key of CHAT_KEYS) {
      if (source[key] !== undefined) values[key] = source[key]
    }
    if (source['chat-provider'] !== undefined) values['chat-provider'] = source['chat-provider']
    return values
  }

  save(patch: unknown): RawModelConfig {
    const current = this.load()
    const source = isObject(patch) ? patch : {}
    for (const key of [...VISION_KEYS, 'provider'] as const) {
      const value = source[key]
      if (value !== undefined && value !== null && String(value).trim()) {
        current[key] = String(value).trim()
      }
    }
    const persisted = this.readStoreConfig()
    Object.assign(persisted, current)
    this.writeConfig(persisted)
    return current
  }

  saveChat(patch: unknown): ChatModelConfig {
    const current = this.chatConfig()
    const source = isObject(patch) ? patch : {}
    const fields: Array<[string, ChatKey | 'chat-provider']> = [
      ['baseUrl', 'chat-base-url'],
      ['apiKey', 'chat-api-key'],
      ['model', 'chat-model'],
      ['provider', 'chat-provider'],
      ['chat-base-url', 'chat-base-url'],
      ['chat-api-key', 'chat-api-key'],
      ['chat-model', 'chat-model'],
      ['chat-provider', 'chat-provider'],
    ]
    for (const [inputKey, storeKey] of fields) {
      const value = source[inputKey]
      if (value !== undefined && value !== null && String(value).trim()) {
        current[storeKey] = String(value).trim()
      }
    }
    const persisted = this.readStoreConfig()
    Object.assign(persisted, current)
    this.writeConfig(persisted)
    return current
  }

  clearVision(): void {
    const persisted = this.readStoreConfig()
    for (const key of [...VISION_KEYS, 'provider'] as const) delete persisted[key]
    this.writeConfig(persisted)
  }

  private writeConfig(values: RawModelConfig): void {
    const dir = path.dirname(this.configFile)
    fs.mkdirSync(dir, { recursive: true })
    const persisted: RawModelConfig = {}
    for (const key of CONFIG_KEYS) {
      const value = values[key]
      if (typeof value === 'string' && value.trim()) persisted[key] = value.trim()
    }
    const data = JSON.stringify(persisted, null, 2) + '\n'
    const tempFile = `${this.configFile}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(tempFile, data, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tempFile, this.configFile)
    } catch (error) {
      try { fs.unlinkSync(tempFile) } catch { /* the temp file may never have been created */ }
      throw error
    }
  }

  private effectiveVision(): RawModelConfig | null {
    const vision = this.load()
    if (vision['base-url'] && vision['api-key'] && vision.model) return vision
    const chat = this.chatConfig()
    if (chat['chat-base-url'] && chat['chat-api-key'] && chat['chat-model']) {
      return {
        'base-url': chat['chat-base-url'],
        'api-key': chat['chat-api-key'],
        model: chat['chat-model'],
      }
    }
    return null
  }

  effectiveVisionConfig(): RawModelConfig | null {
    return this.effectiveVision()
  }

  publicConfig(): PublicModelConfig {
    const cfg = this.load()
    const baseUrl = cfg['base-url'] || ''
    const model = cfg.model || ''
    const apiKey = cfg['api-key'] || ''
    return {
      baseUrl,
      model,
      apiKeyConfigured: Boolean(apiKey),
      modelConfigured: Boolean(this.effectiveVision()),
    }
  }

  publicAgentConfig(): PublicAgentConfig {
    const chat = this.chatConfig()
    const vision = this.load()
    const chatConfigured = Boolean(chat['chat-base-url'] && chat['chat-api-key'] && chat['chat-model'])
    const visionConfigured = Boolean(vision['base-url'] && vision['api-key'] && vision.model)
    const chatPublic: PublicChatConfig = {
      provider: chat['chat-provider'] || '',
      baseUrl: chat['chat-base-url'] || '',
      model: chat['chat-model'] || '',
      apiKeyConfigured: Boolean(chat['chat-api-key']),
      configured: chatConfigured,
    }
    const effectiveModel = visionConfigured ? vision.model || '' : (chatConfigured ? chat['chat-model'] || '' : '')
    const visionPublic: PublicVisionConfig = {
      provider: vision.provider || '',
      baseUrl: vision['base-url'] || '',
      model: vision.model || '',
      apiKeyConfigured: Boolean(vision['api-key']),
      configured: visionConfigured,
      usingChatFallback: !visionConfigured && chatConfigured,
      effectiveModel,
    }
    return { chat: chatPublic, vision: visionPublic }
  }
}

