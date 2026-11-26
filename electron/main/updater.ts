import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain, net, shell } from 'electron'
import {
  UPDATE_MANIFEST_URLS,
  buildUpdateCheck,
  isAllowedExternalUrl,
  isAllowedUpdateDownloadUrl,
  pickLatestManifest,
  updateDownloadFileName,
  type UpdateCheckResponse,
  type UpdateCheckResult,
  type UpdateDownloadResponse,
  type UpdateProgress,
} from './update-core'

const CHECK_TIMEOUT_MS = 6_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000

let cachedCheck: UpdateCheckResult | null = null
let downloadedFile = ''
let downloading = false

function userAgent(): string {
  return `MONOFORM-Updater/${app.getVersion()}`
}

function manifestEndpoints(): string[] {
  const override = process.env.MONOFORM_UPDATE_MANIFEST_URL?.trim()
  return override ? [override] : [...UPDATE_MANIFEST_URLS]
}

async function loadJson(url: string): Promise<unknown> {
  const response = await net.fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': userAgent() },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const { manifest, source } = await pickLatestManifest(manifestEndpoints(), loadJson)
  cachedCheck = buildUpdateCheck(app.getVersion(), manifest, source)
  return cachedCheck
}

function checkErrorMessage(error: unknown): string {
  console.error('[monoform] 检查更新失败：', error)
  return '无法获取更新信息，请检查网络后重试。'
}

function downloadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[monoform] 下载更新失败：', message)
  if (/EPERM|EACCES|ENOSPC|EROFS|EBUSY/i.test(message)) return '无法保存安装包，请检查下载目录权限或磁盘空间。'
  if (/HTTP|fetch|network|timeout|aborted|ENOTFOUND|ECONN|ETIMEDOUT|UND_ERR/i.test(message)) {
    return '下载失败，请检查网络后重试。'
  }
  return message
}

function sendProgress(win: BrowserWindow | null, payload: UpdateProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('monoform:update-progress', payload)
}

async function downloadUpdate(win: BrowserWindow | null): Promise<UpdateDownloadResponse> {
  if (downloading) return { ok: false, error: '更新正在下载中，请稍候。' }
  if (!cachedCheck) return { ok: false, error: '请先检查更新。' }
  if (!cachedCheck.hasUpdate) return { ok: false, error: '当前已是最新版本，无需下载。' }
  if (!cachedCheck.downloadUrl) {
    return { ok: false, error: '本次发布没有提供 Windows 安装包，请前往项目仓库下载。' }
  }
  if (!isAllowedUpdateDownloadUrl(cachedCheck.downloadUrl)) {
    return { ok: false, error: '更新下载地址不受信任，请前往项目仓库手动下载。' }
  }
  const fileName = updateDownloadFileName(cachedCheck.downloadUrl, cachedCheck.latestVersion)
  const target = path.join(app.getPath('downloads'), fileName)
  const temporary = `${target}.part`
  downloading = true
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.rm(temporary, { force: true })
    const response = await net.fetch(cachedCheck.downloadUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { 'user-agent': userAgent() },
    })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    const handle = await fs.promises.open(temporary, 'w')
    let received = 0
    let lastSentAt = 0
    try {
      const body = response.body as unknown as AsyncIterable<Uint8Array>
      for await (const chunk of body) {
        const buffer = Buffer.from(chunk)
        await handle.write(buffer)
        received += buffer.length
        const now = Date.now()
        if (now - lastSentAt > 180) {
          lastSentAt = now
          sendProgress(win, { received, total, percent: total > 0 ? Math.min(100, Math.round(received / total * 100)) : null })
        }
      }
    } finally {
      await handle.close()
    }
    if (received <= 0) throw new Error('安装包内容为空，请稍后重试。')
    await fs.promises.rm(target, { force: true })
    await fs.promises.rename(temporary, target)
    downloadedFile = target
    sendProgress(win, { received, total: total || received, percent: 100 })
    return { ok: true, filePath: target, fileName, size: received }
  } catch (error) {
    return { ok: false, error: downloadErrorMessage(error) }
  } finally {
    downloading = false
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function openDownloadedUpdate(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!downloadedFile || !fs.existsSync(downloadedFile)) {
    return { ok: false, error: '还没有下载好的安装包，请先下载。' }
  }
  const failure = await shell.openPath(downloadedFile)
  return failure ? { ok: false, error: `无法打开安装包：${failure}` } : { ok: true }
}

function showDownloadedUpdate(): { ok: true } | { ok: false; error: string } {
  if (!downloadedFile || !fs.existsSync(downloadedFile)) {
    return { ok: false, error: '安装包不存在，请重新下载。' }
  }
  shell.showItemInFolder(downloadedFile)
  return { ok: true }
}

export function registerUpdateHandlers(): void {
  ipcMain.handle('monoform:check-updates', async (): Promise<UpdateCheckResponse> => {
    try {
      return { ok: true, result: await checkForUpdates() }
    } catch (error) {
      return { ok: false, error: checkErrorMessage(error) }
    }
  })

  // Downloads always use the URL cached by the check above, never a URL chosen
  // by the renderer.
  ipcMain.handle('monoform:download-update', async event => {
    return downloadUpdate(BrowserWindow.fromWebContents(event.sender))
  })

  ipcMain.handle('monoform:open-downloaded-update', async () => openDownloadedUpdate())
  ipcMain.handle('monoform:show-downloaded-update', async () => showDownloadedUpdate())

  ipcMain.handle('monoform:open-external', async (_event, url: unknown) => {
    if (!isAllowedExternalUrl(url)) return { ok: false, error: '只能打开项目仓库的 HTTPS 链接。' }
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (error) {
      console.error('[monoform] 打开外部链接失败：', error)
      return { ok: false, error: '无法打开浏览器，请手动访问项目仓库。' }
    }
  })
}
