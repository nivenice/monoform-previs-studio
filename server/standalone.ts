import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAiService } from './index'
import { startAiServer } from './http'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = process.env.MONOFORM_AI_HOST || '127.0.0.1'
const PORT = Number(process.env.MONOFORM_AI_PORT || '8891')
const CONFIG_FILE = process.env.MONOFORM_MODEL_CONFIG_FILE || path.join(ROOT, 'server', 'model-config.local.json')
const SKILLS_DIR = process.env.MONOFORM_SKILLS_DIR || path.join(ROOT, 'skills')
const AGENT_DB_FILE = process.env.MONOFORM_AGENT_DB_FILE || path.join(ROOT, '.monoform-runtime', 'agent.db')
const TOKEN = process.env.MONOFORM_AI_TOKEN || ''

const service = createAiService({ configFile: CONFIG_FILE, skillsDir: SKILLS_DIR, agentDbFile: AGENT_DB_FILE })

try {
  const running = await startAiServer({
    service,
    host: HOST,
    port: Number.isFinite(PORT) ? PORT : 8891,
    token: TOKEN || undefined,
    staticDir: path.join(ROOT, 'dist'),
  })
  console.log(`Miorning White-Model Previs: ${running.origin}`)
  console.log(`Model config: ${service.publicConfig().modelConfigured ? 'ready' : 'missing'}`)
  console.log(`Conversations: ${AGENT_DB_FILE}`)
  const shutdown = async (): Promise<void> => {
    await running.close()
    process.exit(0)
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`AI 服务启动失败: ${message}`)
  process.exitCode = 1
}
