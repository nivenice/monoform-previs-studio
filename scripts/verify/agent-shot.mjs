// End-to-end verification for the AI shot tools.
//
// Starts from a fresh browser project, types the delivery prompt into the real
// assistant panel, waits for the tool rounds to finish, then saves the resulting
// .monoform.json and six camera-monitor frames.
//
// Prerequisites: `npm run build:web` and `npm run server` (port 8891) with a
// configured chat model. Run with:
//   npx electron scripts/verify/agent-shot.mjs
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = process.env.MONOFORM_VERIFY_URL || 'http://127.0.0.1:8891/'
const PROMPT = process.env.MONOFORM_VERIFY_PROMPT
  || '场景内包含一个人物模型，镜头在她的侧方，他突然转身举枪对着镜头，类似 007 开场那一幕；帮我完成 5 秒的镜头，并写好场景物体对应的所有关键帧。'
const OUT_DIR = path.resolve(process.cwd(), process.env.MONOFORM_VERIFY_OUT || path.join('.monoform-verify', '007'))
const FRAMES = (process.env.MONOFORM_VERIFY_FRAMES || '0,24,48,72,96,119')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value >= 0)
const MAX_WAIT_MS = 300_000

const logFile = () => path.join(OUT_DIR, 'verify.log')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = message => {
  const line = `[verify ${new Date().toISOString()}] ${message}`
  console.log(line)
  try { fs.appendFileSync(logFile(), `${line}\n`) } catch { /* directory may not exist yet */ }
}

async function waitFor(win, expression, timeout = MAX_WAIT_MS, label = expression) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const value = await win.webContents.executeJavaScript(expression, true)
      if (value) return value
    } catch { /* page may be reloading */ }
    await sleep(750)
  }
  throw new Error(`等待超时：${label}`)
}

const seekScript = frame => `(() => {
  const track = document.querySelector('.camera-track-slot .track')
  if (!track) return false
  const rect = track.getBoundingClientRect()
  const readout = document.querySelector('.time-readout span')?.textContent || ''
  const total = Number((/\\/\\s*(\\d+)/.exec(readout) || [])[1] || 0)
  if (!total) return false
  const x = rect.left + rect.width * Math.min(1, ${frame} / total) + 1
  track.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: rect.top + rect.height / 2, pointerId: 1, button: 0 }))
  return document.querySelector('.time-readout strong')?.textContent || false
})()`

const monitorRectScript = `(() => {
  const element = document.querySelector('.monitor-canvas')
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    scale: window.devicePixelRatio || 1,
  }
})()`

// capturePage can resolve empty or hang while the window is occluded, so every
// capture is bounded and retried, and cropping happens after a full capture.
async function captureWindow(win, label) {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const image = await Promise.race([
      win.webContents.capturePage(),
      sleep(15_000).then(() => null),
    ])
    if (image && !image.isEmpty()) return image
    log(`${label} 截图为空，重试 ${attempt + 1}/3`)
    await sleep(700)
  }
  return null
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const win = new BrowserWindow({
    width: 1680,
    height: 1000,
    show: true,
    backgroundColor: '#1a1a18',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false, backgroundThrottling: false },
  })
  win.setMenuBarVisibility(false)
  win.setAlwaysOnTop(true, 'screen-saver')

  await win.loadURL(BASE_URL)
  await waitFor(win, `Boolean(document.querySelector('.agent-panel'))`, 60_000, 'app shell')

  const presetFile = process.env.MONOFORM_VERIFY_PROJECT || ''
  if (presetFile) {
    // Render an existing project without spending another model turn.
    const serialized = fs.readFileSync(path.resolve(presetFile), 'utf8')
    await win.webContents.executeJavaScript(`localStorage.setItem('monoform-project', ${JSON.stringify(serialized)}); true`, true)
    await win.reload()
    await waitFor(win, `Boolean(document.querySelector('.agent-panel'))`, 60_000, 'app shell with project')
    log(`已载入工程：${presetFile}`)
  } else {
    // Deterministic baseline: the default project has exactly one character.
    await win.webContents.executeJavaScript(`localStorage.removeItem('monoform-project'); localStorage.removeItem('stageframe-project'); true`, true)
    await win.reload()
    await waitFor(win, `Boolean(document.querySelector('.agent-panel'))`, 60_000, 'app shell after reset')
    await waitFor(win, `document.querySelectorAll('.agent-suggestions button').length > 0`, 30_000, 'agent ready')

    const ready = await win.webContents.executeJavaScript(`document.querySelector('.agent-suggestions button')?.textContent || ''`, true)
    if (!/007/.test(ready)) {
      log(`AI 助手未就绪：${ready}`)
      app.exit(2)
      return
    }

    // Open the assistant tab and submit the delivery prompt.
    await win.webContents.executeJavaScript(`(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find(button => button.textContent.includes('AI 助手'))
      tab?.click()
      return Boolean(tab)
    })()`, true)
    await sleep(300)
    await win.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.agent-input')
      if (!textarea) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(PROMPT)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`, true)
    await sleep(200)
    await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.agent-send-button')
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`, true)
    log(`已发送提示词：${PROMPT}`)

    await waitFor(win, `Boolean(document.querySelector('.agent-send-button.is-stop'))`, 60_000, 'turn started')
    await waitFor(win, `!document.querySelector('.agent-send-button.is-stop')`, MAX_WAIT_MS, 'turn finished')
    await sleep(2500)

    const transcript = await win.webContents.executeJavaScript(`(() => {
      const messages = [...document.querySelectorAll('.agent-message')].map(message => ({
        role: message.classList.contains('is-user') ? 'user' : 'assistant',
        text: message.querySelector('.agent-message-text')?.textContent || '',
        tools: [...message.querySelectorAll('.agent-tool-card')].map(card => ({
          status: card.querySelector('.agent-tool-status')?.textContent || '',
          title: card.querySelector('strong')?.textContent || '',
          note: [...card.querySelectorAll('small')].map(small => small.textContent).join(' | '),
        })),
      }))
      const banner = document.querySelector('.agent-banner')?.textContent || ''
      return { messages, banner }
    })()`, true)
    fs.writeFileSync(path.join(OUT_DIR, 'transcript.json'), JSON.stringify(transcript, null, 2))
    log(`对话完成：${transcript.messages.filter(message => message.role === 'assistant').length} 条助手消息`)

    const project = await win.webContents.executeJavaScript(`localStorage.getItem('monoform-project') || ''`, true)
    if (!project) throw new Error('没有读到工程数据：AI 助手可能没有写入任何内容')
    fs.writeFileSync(path.join(OUT_DIR, '007-opening-5s.monoform.json'), JSON.stringify(JSON.parse(project), null, 2))
  }

  const rect = await win.webContents.executeJavaScript(monitorRectScript, true)
  if (!rect) throw new Error('找不到摄像机监视器元素，无法截图')
  const scale = rect.scale || 1
  for (const frame of FRAMES) {
    const displayed = await win.webContents.executeJavaScript(seekScript(frame), true)
    await sleep(800)
    const image = await captureWindow(win, `第 ${frame} 帧`)
    if (!image) {
      log(`第 ${frame} 帧截图失败，已跳过`)
      continue
    }
    const cropped = image.crop({
      x: Math.max(0, Math.round(rect.x * scale)),
      y: Math.max(0, Math.round(rect.y * scale)),
      width: Math.max(2, Math.round(rect.width * scale)),
      height: Math.max(2, Math.round(rect.height * scale)),
    })
    fs.writeFileSync(path.join(OUT_DIR, `frame-${String(frame).padStart(3, '0')}.png`), cropped.toPNG())
    log(`已截图第 ${frame} 帧（播放头 ${displayed || '?'}）`)
  }
  const full = await captureWindow(win, '界面')
  if (full) fs.writeFileSync(path.join(OUT_DIR, 'ui.png'), full.toPNG())

  log(`输出目录：${OUT_DIR}`)
  app.exit(0)
}

app.whenReady().then(() => {
  main().catch(error => {
    log(`失败：${error?.stack || error}`)
    app.exit(1)
  })
})

app.on('window-all-closed', () => { app.exit(0) })

process.on('uncaughtException', error => {
  log(`未捕获异常：${error?.stack || error}`)
  app.exit(1)
})
