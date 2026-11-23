import { ModelConfigStore } from './config'
import { chatJson, fetchRemoteModels } from './upstream'
import { createAgentService } from './agent/service'
import { objectSystemPrompt, poseSystemPrompt, sceneSystemPrompt } from './prompts/skills'
import { normalizePerspectiveResponse } from './scene'
import type { AiService, GenerateSceneResult, RawModelConfig, SceneQuality } from './types'

export interface AiServiceOptions {
  configFile: string
  keyFile?: string
  skillsDir: string
  agentDbFile?: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export function createAiService(options: AiServiceOptions): AiService {
  const store = new ModelConfigStore({ configFile: options.configFile, keyFile: options.keyFile })
  const upstream = { fetchImpl: options.fetchImpl, sleep: options.sleep }

  const generateScene = async (input: { image: Uint8Array; mime: string; prompt: string }): Promise<GenerateSceneResult> => {
    const config: RawModelConfig | null = store.effectiveVisionConfig()
    if (!config) throw new Error('未配置识图模型；请在 AI 助手的模型设置里配置，或让对话模型支持图片')
    const requestText = '请根据上传的场景图生成白模场景。用户补充要求：' + (input.prompt || '无')
    const parsed = await chatJson(config, sceneSystemPrompt(), requestText, {
      ...upstream,
      image: input.image,
      mime: input.mime,
    })
    const { scene, warnings } = normalizePerspectiveResponse(parsed)
    const corrections = Array.isArray(scene.previs?.corrections) ? scene.previs.corrections : []
    const quality: SceneQuality = {
      status: warnings.length ? 'review' : 'ready',
      visualCheck: 'outstanding',
      warnings,
      corrections,
    }
    return { scene, warnings, quality }
  }

  const agent = options.agentDbFile
    ? createAgentService({
        dbFile: options.agentDbFile,
        configStore: store,
        generateScene,
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
      })
    : undefined

  return {
    health() {
      return { ok: true, modelConfigured: store.publicConfig().modelConfigured }
    },
    publicConfig() {
      return store.publicConfig()
    },
    saveConfig(patch: unknown) {
      store.save(patch)
      return store.publicConfig()
    },
    async listModels() {
      const models = await fetchRemoteModels(store.load(), upstream)
      return { models, ...store.publicConfig() }
    },
    generateScene,
    async generatePose(prompt) {
      return chatJson(store.load(), poseSystemPrompt(options.skillsDir), prompt || '生成自然站立姿势', upstream)
    },
    async generateObject(prompt) {
      return chatJson(store.load(), objectSystemPrompt(options.skillsDir), prompt || '设计一个简单的可调白模物体', upstream)
    },
    ...(agent ? { agent } : {}),
  }
}

export { ModelConfigStore } from './config'
export { startAiServer } from './http'
export type * from './types'
