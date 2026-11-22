import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { app, BrowserWindow, dialog, Menu, session } from 'electron'
import { createAiService } from '../../server/index'
import { startAiServer, type RunningAiServer } from '../../server/http'
import { registerAppProtocol, registerAppScheme } from './app-protocol'
import { createMainWindow, type RuntimeInfo } from './window'

// Privileged custom schemes can only be registered before the app is ready.
registerAppScheme()

let mainWindow: BrowserWindow | null = null
let aiServer: RunningAiServer | null = null

function resolveConfigFile(): string {
  const override = process.env.MONOFORM_MODEL_CONFIG_FILE
  if (override) return path.resolve(override)
  if (!app.isPackaged) return path.join(app.getAppPath(), 'server', 'model-config.local.json')
  return path.join(app.getPath('userData'), 'model-config.json')
}

function resolveSkillsDir(): string {
  const override = process.env.MONOFORM_SKILLS_DIR
  return override ? path.resolve(override) : path.join(app.getAppPath(), 'skills')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function prepareRuntime(): Promise<RuntimeInfo> {
  const rendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  const isDev = Boolean(rendererUrl)
  const token = randomBytes(32).toString('hex')
  let apiBaseUrl = ''
  let aiError = ''
  try {
    const service = createAiService({ configFile: resolveConfigFile(), skillsDir: resolveSkillsDir() })
    const configuredPort = Number(process.env.MONOFORM_AI_PORT)
    aiServer = await startAiServer({
      service,
      host: '127.0.0.1',
      port: Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 0,
      token,
    })
    apiBaseUrl = aiServer.origin
    console.log(`[monoform] AI service: ${apiBaseUrl}`)
  } catch (error) {
    aiError = `本地识图服务启动失败：${errorText(error)}`
    console.error(`[monoform] ${aiError}`)
  }
  return { apiBaseUrl, apiToken: apiBaseUrl ? token : '', aiError, rendererUrl, isDev }
}

function registerSessionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({
      title: '保存导出文件',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
    })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    try {
      app.setAppUserModelId('com.monoform.previs')
      Menu.setApplicationMenu(null)
      registerSessionHandlers()
      const runtime = await prepareRuntime()
      registerAppProtocol(path.join(app.getAppPath(), 'out', 'renderer'))
      mainWindow = createMainWindow(runtime)
      mainWindow.on('closed', () => { mainWindow = null })
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow(runtime)
          mainWindow.on('closed', () => { mainWindow = null })
        }
      })
    } catch (error) {
      dialog.showErrorBox('MONOFORM 启动失败', errorText(error))
      app.quit()
    }
  }).catch(error => {
    dialog.showErrorBox('MONOFORM 启动失败', errorText(error))
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    if (aiServer) {
      void aiServer.close().catch(() => undefined)
      aiServer = null
    }
  })
}
