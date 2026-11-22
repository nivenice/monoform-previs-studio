import fs from 'node:fs'
import path from 'node:path'
import type { PublicModelConfig, RawModelConfig } from './types'

export const DEFAULT_KEY_FILE = 'F:\\hermes-sceneTo 3d\\model-key.txt'

const CONFIG_KEYS = ['base-url', 'model', 'api-key'] as const
type ConfigKey = typeof CONFIG_KEYS[number]

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
      if (key) values[key as ConfigKey] = value
    }
    return values
  }

  private readConfigFile(): RawModelConfig {
    let data: unknown
    try {
      data = JSON.parse(fs.readFileSync(this.configFile, 'utf8'))
    } catch {
      return {}
    }
    if (!isObject(data)) return {}
    const values: RawModelConfig = {}
    for (const [key, value] of Object.entries(data)) {
      if (isConfigKey(key) && value) values[key] = String(value)
    }
    return values
  }

  load(): RawModelConfig {
    const values = this.readKeyFile()
    Object.assign(values, this.readConfigFile())
    return values
  }

  save(patch: unknown): RawModelConfig {
    const current = this.load()
    const source = isObject(patch) ? patch : {}
    for (const key of CONFIG_KEYS) {
      const value = source[key]
      if (value !== undefined && value !== null && String(value).trim()) {
        current[key] = String(value).trim()
      }
    }
    const persisted: RawModelConfig = {}
    for (const key of CONFIG_KEYS) {
      if (current[key]) persisted[key] = current[key]
    }
    this.writeConfig(persisted)
    return current
  }

  private writeConfig(values: RawModelConfig): void {
    const dir = path.dirname(this.configFile)
    fs.mkdirSync(dir, { recursive: true })
    const data = JSON.stringify(values, null, 2) + '\n'
    const tempFile = `${this.configFile}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(tempFile, data, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tempFile, this.configFile)
    } catch (error) {
      try { fs.unlinkSync(tempFile) } catch { /* the temp file may never have been created */ }
      throw error
    }
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
      modelConfigured: Boolean(baseUrl && apiKey && model),
    }
  }
}
