// Shared shapes for the local AI service. The model output is untrusted JSON,
// so scene values stay `unknown` until the normalizers validate them.

export interface PublicModelConfig {
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
  modelConfigured: boolean
}

export interface ModelSummary {
  id: string
  name: string
}

export interface SceneQuality {
  status: 'review' | 'ready'
  visualCheck: 'outstanding'
  warnings: string[]
  corrections: string[]
}

export interface GenerateSceneResult {
  scene: Scene
  warnings: string[]
  quality: SceneQuality
}

export interface Previs {
  camera?: Record<string, any>
  imageComposition?: Record<string, any>
  evidence?: unknown[]
  corrections?: string[]
  uncertainties?: unknown[]
  [key: string]: unknown
}

export interface Scene {
  version: 2
  title: string
  walls: unknown[]
  rooms: unknown[]
  creations: unknown[]
  actors: unknown[]
  props: unknown[]
  lights: unknown[]
  sun: unknown
  groundColor: string
  roofEnabled: boolean
  previs?: Previs
  [key: string]: unknown
}

export interface RawModelConfig {
  'base-url'?: string
  'api-key'?: string
  model?: string
}

export interface GenerateSceneInput {
  image: Uint8Array
  mime: string
  prompt: string
}

export interface AiHealth {
  ok: true
  modelConfigured: boolean
}

export interface AiService {
  health(): AiHealth
  publicConfig(): PublicModelConfig
  saveConfig(patch: unknown): PublicModelConfig
  listModels(): Promise<{ models: ModelSummary[] } & PublicModelConfig>
  generateScene(input: GenerateSceneInput): Promise<GenerateSceneResult>
  generatePose(prompt: string): Promise<unknown>
  generateObject(prompt: string): Promise<unknown>
}
