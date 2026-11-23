import path from 'node:path'
import { app, BrowserWindow, shell } from 'electron'

export interface RuntimeInfo {
  apiBaseUrl: string
  apiToken: string
  aiError: string
  rendererUrl?: string
  isDev: boolean
}

function isAllowedNavigation(target: string, runtime: RuntimeInfo): boolean {
  try {
    const url = new URL(target)
    if (runtime.rendererUrl) return url.origin === new URL(runtime.rendererUrl).origin
    return url.protocol === 'app:' && url.host === 'monoform'
  } catch {
    return false
  }
}

export function createMainWindow(runtime: RuntimeInfo): BrowserWindow {
  const preload = path.join(app.getAppPath(), 'out', 'preload', 'index.cjs')
  // Windows/Linux: hide the native title bar, keep native caption buttons as a
  // dark overlay so drag, snap, maximize and accessibility keep working.
  // Keep the overlay color/height in sync with --panel and .topbar in styles.css.
  const windowChrome = process.platform === 'win32' || process.platform === 'linux'
    ? {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: {
          color: '#242422',
          symbolColor: '#c9c5ba',
          height: 49,
        },
      }
    : {}
  const win = new BrowserWindow({
    ...windowChrome,
    width: 1500,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#181817',
    show: false,
    autoHideMenuBar: true,
    title: 'MONOFORM · AGENT',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      // MP4 export must keep rendering even when the window is not focused.
      backgroundThrottling: false,
      additionalArguments: [
        `--monoform-api-base=${runtime.apiBaseUrl}`,
        `--monoform-api-token=${runtime.apiToken}`,
        `--monoform-ai-error=${encodeURIComponent(runtime.aiError)}`,
      ],
    },
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, target) => {
    if (isAllowedNavigation(target, runtime)) return
    event.preventDefault()
    if (/^https?:/i.test(target)) void shell.openExternal(target)
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (!runtime.isDev || input.type !== 'keyDown') return
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (!devtools) return
    event.preventDefault()
    win.webContents.toggleDevTools()
  })

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[monoform] renderer failed to load (${code} ${description}): ${url}`)
  })

  if (runtime.rendererUrl) void win.loadURL(runtime.rendererUrl)
  else void win.loadURL('app://monoform/index.html')

  return win
}
