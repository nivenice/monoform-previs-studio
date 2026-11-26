// Renderer-side bridge to the Electron updater. In the browser build there is
// no installer to update, so the same UI degrades to a "page is always current"
// message instead of faking a version check.

const runtime = typeof window === 'undefined' ? null : window.monoform

export const APP_VERSION = runtime?.appVersion || (typeof __APP_VERSION__ === 'undefined' ? '0.0.0' : __APP_VERSION__)
export const IS_DESKTOP = Boolean(runtime?.platform)
export const CAN_CHECK_UPDATES = typeof runtime?.checkForUpdates === 'function'

const PLATFORM_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

export const PLATFORM_NAME = PLATFORM_NAMES[runtime?.platform] || ''

function browserResult() {
  return {
    ok: true,
    result: {
      currentVersion: APP_VERSION,
      latestVersion: APP_VERSION,
      hasUpdate: false,
      browser: true,
      notes: [],
      releasedAt: '',
      downloadUrl: '',
      releaseNotesUrl: '',
      source: '',
      checkedAt: new Date().toISOString(),
    },
  }
}

export async function checkForUpdates() {
  if (!CAN_CHECK_UPDATES) return browserResult()
  try {
    return await runtime.checkForUpdates()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '检查更新失败，请稍后重试。' }
  }
}

export async function downloadUpdate() {
  if (typeof runtime?.downloadUpdate !== 'function') {
    return { ok: false, error: '浏览器版不下载安装包，请从项目仓库下载桌面版。' }
  }
  try {
    return await runtime.downloadUpdate()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '下载更新失败，请稍后重试。' }
  }
}

export async function openDownloadedUpdate() {
  if (typeof runtime?.openDownloadedUpdate !== 'function') return { ok: false, error: '当前版本不支持打开安装包。' }
  try {
    return await runtime.openDownloadedUpdate()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法打开安装包。' }
  }
}

export async function showDownloadedUpdate() {
  if (typeof runtime?.showDownloadedUpdate !== 'function') return { ok: false, error: '当前版本不支持定位安装包。' }
  try {
    return await runtime.showDownloadedUpdate()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法定位安装包。' }
  }
}

export async function openExternal(url) {
  if (typeof runtime?.openExternal === 'function') {
    try {
      return await runtime.openExternal(url)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法打开链接。' }
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return { ok: true }
}

export function onUpdateProgress(callback) {
  if (typeof runtime?.onUpdateProgress !== 'function') return () => {}
  runtime.onUpdateProgress(callback)
  return () => {
    if (typeof runtime?.offUpdateProgress === 'function') runtime.offUpdateProgress()
  }
}
