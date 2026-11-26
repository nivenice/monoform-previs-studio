import { useEffect, useState } from 'react'
import { CircleCheck, Download, ExternalLink, FolderOpen, Info, LoaderCircle, PackageCheck, RefreshCw, ShieldCheck, X } from 'lucide-react'
import {
  APP_VERSION,
  CAN_CHECK_UPDATES,
  IS_DESKTOP,
  PLATFORM_NAME,
  checkForUpdates,
  downloadUpdate,
  onUpdateProgress,
  openDownloadedUpdate,
  openExternal,
  showDownloadedUpdate,
} from './updateApi.js'

const CHANGELOG_URL = 'https://github.com/nivenice/monoform-previs-studio/blob/master/docs/CHANGELOG.md'
const REPOSITORY_URL = 'https://github.com/nivenice/monoform-previs-studio'
const DOWNLOADS_URL = 'https://github.com/nivenice/monoform-previs-studio/tree/master/downloads'

const formatBytes = value => {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const progressText = progress => {
  if (!progress) return ''
  if (progress.percent === null || progress.percent === undefined) return `已下载 ${formatBytes(progress.received)}`
  const total = progress.total ? ` / ${formatBytes(progress.total)}` : ''
  return `${progress.percent}% · ${formatBytes(progress.received)}${total}`
}

export function AboutDialog({ onClose }) {
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [downloaded, setDownloaded] = useState(null)

  useEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => onUpdateProgress(setProgress), [])

  const version = result?.currentVersion || APP_VERSION

  const runCheck = async () => {
    setStatus('checking')
    setError('')
    setResult(null)
    setDownloaded(null)
    const response = await checkForUpdates()
    if (!response?.ok) {
      setStatus('error')
      setError(response?.error || '检查更新失败，请稍后重试。')
      return
    }
    setResult(response.result)
    if (response.result.browser) setStatus('browser')
    else setStatus(response.result.hasUpdate ? 'update' : 'current')
  }

  const startDownload = async () => {
    if (!result?.hasUpdate || downloading) return
    setDownloading(true)
    setError('')
    setProgress({ received: 0, total: 0, percent: 0 })
    const response = await downloadUpdate()
    setDownloading(false)
    if (!response?.ok) {
      setError(response?.error || '下载更新失败，请稍后重试。')
      setProgress(null)
      return
    }
    setDownloaded(response)
    setProgress({ received: response.size, total: response.size, percent: 100 })
  }

  const openDownloaded = async () => {
    const response = await openDownloadedUpdate()
    if (!response?.ok) setError(response?.error || '无法打开安装包。')
  }

  const openFolder = async () => {
    const response = await showDownloadedUpdate()
    if (!response?.ok) setError(response?.error || '无法定位安装包。')
  }

  const openLink = async url => {
    const response = await openExternal(url)
    if (response && response.ok === false) setError(response.error || '无法打开链接。')
  }

  const statusText = () => {
    if (status === 'checking') return '正在连接更新服务器…'
    if (status === 'current') return `已是最新版本 · v${result?.latestVersion}`
    if (status === 'update') return `发现新版本 v${result?.latestVersion} · 当前 v${result?.currentVersion}`
    if (status === 'browser') return '网页版刷新页面即会加载最新构建，无需手动检查。'
    if (status === 'error') return '检查更新失败'
    return '尚未检查 · 点击右侧按钮比较最新发布版本'
  }

  return (
    <div className="settings-overlay about-overlay" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="settings-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div className="settings-dialog-head">
          <div><Info size={17} /><span><strong id="about-title">关于 MONOFORM · AGENT</strong><small>白模预演工作台 · v{version}</small></span></div>
          <button type="button" onClick={onClose} aria-label="关闭关于面板"><X size={14} /></button>
        </div>
        <div className="about-body">
          <section className="about-version-card">
            <div className="about-version-copy">
              <span>当前版本</span>
              <strong>v{version}</strong>
              <small>{IS_DESKTOP ? `桌面安装版 · ${PLATFORM_NAME || 'Electron'}` : '浏览器版 · 随页面更新'}</small>
            </div>
            <span className="about-version-badge"><ShieldCheck size={13} /> {IS_DESKTOP ? '安装包更新' : '页面自动更新'}</span>
          </section>

          <section className="about-section">
            <div className="about-section-head"><Info size={14} /><strong>说明</strong></div>
            <p>MONOFORM · AGENT 是面向分镜、构图和镜头预演的轻量三维白模工作台。桌面版和浏览器版共用同一套场景、镜头与动画数据，可导出 PNG、MP4 和 .monoform.json 工程。</p>
            <ul>
              <li>桌面版会自动启动本机 AI 服务；没有模型密钥或断网时，搭景、动画和导出仍可正常使用。</li>
              <li>工程和自定义姿势保存在本机，AI 会话保存在本机 SQLite，不会随工程 JSON 上传。</li>
              <li>安装包未做代码签名，Windows 可能提示「未知发布者」；请从项目仓库下载并核对 SHA-256 校验值。</li>
            </ul>
          </section>

          <section className="about-section about-update-section">
            <div className="about-section-head"><RefreshCw size={14} /><strong>检查更新</strong><small>更新源：GitHub</small></div>
            <div className="about-update-row">
              <div className="about-update-copy">
                <strong>当前版本 v{version}</strong>
                <small className={status === 'error' ? 'is-error' : ''} role="status" aria-live="polite">{statusText()}</small>
              </div>
              <button type="button" className="about-check-button" onClick={runCheck} disabled={status === 'checking' || downloading}>
                {status === 'checking' ? <LoaderCircle size={13} className="about-spin" /> : <RefreshCw size={13} />}
                {status === 'checking' ? '检查中…' : result ? '重新检查' : '检查更新'}
              </button>
            </div>

            {status === 'update' && (
              <div className="about-release">
                <div className="about-release-head"><strong>v{result.latestVersion}</strong>{result.releasedAt && <span>{result.releasedAt}</span>}</div>
                {result.notes?.length > 0 ? (
                  <ul className="about-release-notes">{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
                ) : <p className="about-release-empty">本次更新没有附带说明，可打开更新日志查看完整内容。</p>}
                {CAN_CHECK_UPDATES ? (
                  <>
                    <div className="about-actions">
                      <button type="button" className="is-primary" onClick={startDownload} disabled={downloading}>
                        {downloading ? <LoaderCircle size={13} className="about-spin" /> : <Download size={13} />}
                        {downloading ? '下载中…' : '下载安装包'}
                      </button>
                      <button type="button" onClick={() => openLink(result.downloadUrl || DOWNLOADS_URL)}><ExternalLink size={13} /> 浏览器下载</button>
                    </div>
                    {progress && (
                      <div className={`about-progress ${progress.percent === null ? 'is-indeterminate' : ''}`}>
                        <span><i style={progress.percent === null ? undefined : { width: `${progress.percent}%` }} /></span>
                        <small>{progressText(progress)}</small>
                      </div>
                    )}
                    {downloaded && (
                      <p className="about-downloaded"><CircleCheck size={12} /> 安装包已保存到 <code>{downloaded.filePath}</code>。安装前请保存工程并关闭当前窗口。</p>
                    )}
                    {downloaded && (
                      <div className="about-actions">
                        <button type="button" className="is-primary" onClick={openDownloaded}><PackageCheck size={13} /> 打开安装包</button>
                        <button type="button" onClick={openFolder}><FolderOpen size={13} /> 打开所在文件夹</button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="about-actions">
                    <button type="button" className="is-primary" onClick={() => openLink(result.downloadUrl || DOWNLOADS_URL)}><Download size={13} /> 下载桌面安装包</button>
                  </div>
                )}
              </div>
            )}

            {error && <p className="about-error" role="alert">{error}</p>}
            <p className="about-update-hint">更新信息来自项目仓库的 docs/version.json。桌面版下载安装包后可直接打开安装；浏览器版刷新页面即为最新。</p>
          </section>

          <div className="about-links">
            <button type="button" onClick={() => openLink(CHANGELOG_URL)}>更新日志 <ExternalLink size={11} /></button>
            <button type="button" onClick={() => openLink(REPOSITORY_URL)}>项目仓库 <ExternalLink size={11} /></button>
            <button type="button" onClick={() => openLink(DOWNLOADS_URL)}>所有安装包 <ExternalLink size={11} /></button>
          </div>
        </div>
        <div className="settings-dialog-actions"><button type="button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  )
}
