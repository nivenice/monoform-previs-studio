import fs from 'node:fs'
import path from 'node:path'
import { PERSPECTIVE_SCENE_PROMPT } from './perspective'

export const POSE_SKILL_FILE = '图片或描述 → 生成人物姿势.json'
export const OBJECT_SKILL_FILE = '描述或图片 → 生成可调物体.json'

export function loadSkillPrompt(skillsDir: string, filename: string): string {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(path.join(skillsDir, filename), 'utf8'))
    if (doc && typeof doc === 'object' && 'prompt' in doc) {
      return String((doc as { prompt: unknown }).prompt ?? '')
    }
    return ''
  } catch {
    // The skills directory is intentionally untracked and may not exist.
    return ''
  }
}

export function sceneSystemPrompt(): string {
  // Perspective photos need their own camera and structure contract. Appending
  // the scene-only skill here contradicted the required previs field.
  return PERSPECTIVE_SCENE_PROMPT
}

export function poseSystemPrompt(skillsDir: string): string {
  return loadSkillPrompt(skillsDir, POSE_SKILL_FILE) + `
【白模预演扩展】
只输出完整的 miorning-adult-pose JSON，不要解释、Markdown 或代码围栏。若仅有动作文字，使用自然、保守且能保持重心的姿势。`
}

export function objectSystemPrompt(skillsDir: string): string {
  return loadSkillPrompt(skillsDir, OBJECT_SKILL_FILE)
}
