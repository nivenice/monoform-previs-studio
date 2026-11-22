import { ModelConfigStore } from './config'
import { chatJson, fetchRemoteModels } from './upstream'
import { objectSystemPrompt, poseSystemPrompt, sceneSystemPrompt } from './prompts/skills'
import { normalizePerspectiveResponse } from './scene'
import type { AiService, GenerateSceneResult, SceneQuality } from './types'

export interface AiServiceOptions {
  configFile: string
  keyFile?: string
  skillsDir: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export function createAiService(options: AiServiceOptions): AiService {
  const store = new ModelConfigStore({ configFile: options.configFile, keyFile: options.keyFile })
  const upstream = { fetchImpl: options.fetchImpl, sleep: options.sleep }
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
    async generateScene(input) {
      const requestText = '请根据上传的场景图生成白模场景。用户补充要求：' + (input.prompt || '无')
      const parsed = await chatJson(store.load(), sceneSystemPrompt(), requestText, {
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
      const result: GenerateSceneResult = { scene, warnings, quality }
      return result
    },
    async generatePose(prompt) {
      return chatJson(store.load(), poseSystemPrompt(options.skillsDir), prompt || '生成自然站立姿势', upstream)
    },
    async generateObject(prompt) {
      return chatJson(store.load(), objectSystemPrompt(options.skillsDir), prompt || '设计一个简单的可调白模物体', upstream)
    },
  }
}

export { ModelConfigStore } from './config'
export { startAiServer } from './http'
export type * from './types'
