import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type UpdateProgress = { received: number; total: number; percent: number | null }

let updateProgressListener: ((event: IpcRendererEvent, progress: UpdateProgress) => void) | null = null

function readArgument(name: string): string {
  const prefix = `--${name}=`
  const argument = process.argv.find(value => value.startsWith(prefix))
  return argument ? argument.slice(prefix.length) : ''
}

function readErrorArgument(): string {
  const raw = readArgument('monoform-ai-error')
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const runtime = {
  apiBaseUrl: readArgument('monoform-api-base'),
  apiToken: readArgument('monoform-api-token'),
  aiError: readErrorArgument(),
  platform: process.platform,
  appVersion: readArgument('monoform-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('monoform:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('monoform:download-update'),
  openDownloadedUpdate: () => ipcRenderer.invoke('monoform:open-downloaded-update'),
  showDownloadedUpdate: () => ipcRenderer.invoke('monoform:show-downloaded-update'),
  openExternal: (url: string) => ipcRenderer.invoke('monoform:open-external', url),
  onUpdateProgress: (callback: (progress: UpdateProgress) => void) => {
    if (updateProgressListener) ipcRenderer.removeListener('monoform:update-progress', updateProgressListener)
    updateProgressListener = (_event: IpcRendererEvent, progress: UpdateProgress) => callback(progress)
    ipcRenderer.on('monoform:update-progress', updateProgressListener)
  },
  offUpdateProgress: () => {
    if (!updateProgressListener) return
    ipcRenderer.removeListener('monoform:update-progress', updateProgressListener)
    updateProgressListener = null
  },
}

contextBridge.exposeInMainWorld('monoform', runtime)

export type MonoformRuntime = typeof runtime
