// Pure update-check helpers: version ordering, manifest parsing and URL gates.
// Kept free of Electron imports so the rules can be unit tested with tsx; the
// network and filesystem work lives in updater.ts.

export const UPDATE_MANIFEST_URLS = [
  'https://raw.githubusercontent.com/nivenice/monoform-previs-studio/master/docs/version.json',
  'https://api.github.com/repos/nivenice/monoform-previs-studio/releases/latest',
  'https://cdn.jsdelivr.net/gh/nivenice/monoform-previs-studio@master/docs/version.json',
]

const UPDATE_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

const EXTERNAL_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'nivenice.github.io',
])

const MAX_NOTES = 12
const MAX_NOTE_LENGTH = 400
const VERSION_PATTERN = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export interface UpdateManifest {
  version: string
  notes: string[]
  releasedAt: string
  downloadUrl: string
  releaseNotesUrl: string
}

export interface UpdateCheckResult extends UpdateManifest {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  checkedAt: string
  source: string
}

export interface UpdateProgress {
  received: number
  total: number
  percent: number | null
}

export type UpdateCheckResponse =
  | { ok: true; result: UpdateCheckResult }
  | { ok: false; error: string }

export type UpdateDownloadResponse =
  | { ok: true; filePath: string; fileName: string; size: number }
  | { ok: false; error: string }

interface ParsedVersion {
  numbers: number[]
  prerelease: string[]
}

function toVersionLabel(value: unknown): string {
  return String(value ?? '').trim().replace(/^v/i, '')
}

function parseVersion(value: unknown): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(String(value ?? '').trim())
  if (!match) return null
  const numbers = match[1].split('.').map(part => Number(part))
  if (numbers.some(part => !Number.isSafeInteger(part))) return null
  const prerelease = match[2] ? match[2].split('.').filter(Boolean) : []
  return { numbers, prerelease }
}

/** Compares two versions the way the release notes are published: 0.10 > 0.9, and a pre-release sorts below its final. */
export function compareVersions(left: unknown, right: unknown): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`无法比较版本号：${left} / ${right}`)
  const length = Math.max(a.numbers.length, b.numbers.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a.numbers[index] || 0) - (b.numbers[index] || 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < prereleaseLength; index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y)
      if (difference !== 0) return difference > 0 ? 1 : -1
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  return compareVersions(candidate, current) > 0
}

function normalizeDate(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function normalizeHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function cleanNote(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function normalizeNotes(value: unknown): string[] {
  const lines = Array.isArray(value)
    ? value.map(item => String(item ?? ''))
    : typeof value === 'string'
      ? value.split(/\r?\n/)
      : []
  const notes: string[] = []
  for (const line of lines) {
    const note = cleanNote(line).slice(0, MAX_NOTE_LENGTH)
    if (!note) continue
    notes.push(note)
    if (notes.length >= MAX_NOTES) break
  }
  return notes
}

/** Turns docs/version.json (or a GitHub release payload) into a predictable shape; null means "not a usable manifest". */
export function normalizeManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const version = toVersionLabel(record.version ?? record.latestVersion)
  if (!parseVersion(version)) return null
  return {
    version,
    notes: normalizeNotes(record.notes ?? record.body),
    releasedAt: normalizeDate(record.releasedAt ?? record.publishedAt ?? record.published_at),
    downloadUrl: normalizeHttpsUrl(record.downloadUrl ?? record.downloadURL ?? record.download),
    releaseNotesUrl: normalizeHttpsUrl(record.releaseNotesUrl ?? record.changelogUrl ?? record.html_url),
  }
}

export function manifestFromGitHubRelease(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const assets = Array.isArray(record.assets) ? record.assets : []
  let downloadUrl = ''
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue
    const url = normalizeHttpsUrl((asset as Record<string, unknown>).browser_download_url)
    if (/\.exe$/i.test(url)) {
      downloadUrl = url
      break
    }
  }
  return normalizeManifest({
    version: record.tag_name ?? record.name,
    notes: record.body,
    releasedAt: record.published_at,
    downloadUrl,
    releaseNotesUrl: record.html_url,
  })
}

export type ManifestLoader = (url: string) => Promise<unknown>

export interface ManifestSelection {
  manifest: UpdateManifest
  source: string
}

/** Tries each endpoint in order and returns the first well-formed manifest. */
export async function pickLatestManifest(endpoints: string[], load: ManifestLoader): Promise<ManifestSelection> {
  const failures: string[] = []
  for (const endpoint of endpoints) {
    try {
      const raw = await load(endpoint)
      const manifest = /^https:\/\/api\.github\.com\//i.test(endpoint)
        ? manifestFromGitHubRelease(raw)
        : normalizeManifest(raw)
      if (manifest) return { manifest, source: endpoint }
      failures.push(`${endpoint} 返回的更新信息不完整`)
    } catch (error) {
      failures.push(`${endpoint} ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`无法获取更新信息：${failures.join('；')}`)
}

export function buildUpdateCheck(
  currentVersion: string,
  manifest: UpdateManifest,
  source: string,
  checkedAt: Date = new Date(),
): UpdateCheckResult {
  const current = toVersionLabel(currentVersion) || '0.0.0'
  let hasUpdate = false
  try {
    hasUpdate = compareVersions(manifest.version, current) > 0
  } catch {
    hasUpdate = false
  }
  return {
    ...manifest,
    currentVersion: current,
    latestVersion: manifest.version,
    hasUpdate,
    checkedAt: checkedAt.toISOString(),
    source,
  }
}

export function isAllowedUpdateDownloadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && UPDATE_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && EXTERNAL_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/** Keeps installer file names boring: no paths, no shell-hostile characters. */
export function updateDownloadFileName(downloadUrl: string, version: string): string {
  let name = ''
  try {
    name = decodeURIComponent(new URL(downloadUrl).pathname.split('/').pop() || '')
  } catch {
    name = ''
  }
  name = name.replace(/[^\w.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  if (/\.exe$/i.test(name) && name.length > 4) return name
  return `MONOFORM-${toVersionLabel(version) || 'update'}-win-x64-setup.exe`
}
