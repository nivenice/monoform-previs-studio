import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildUpdateCheck,
  compareVersions,
  isAllowedExternalUrl,
  isAllowedUpdateDownloadUrl,
  isNewerVersion,
  manifestFromGitHubRelease,
  normalizeManifest,
  pickLatestManifest,
  updateDownloadFileName,
} from '../../electron/main/update-core'

const manifest = {
  version: '0.7.0',
  notes: ['顶部新增「关于」面板'],
  releasedAt: '2026-11-26',
  downloadUrl: 'https://github.com/nivenice/monoform-previs-studio/raw/master/downloads/MONOFORM-0.7.0-win-x64-setup.exe',
  releaseNotesUrl: 'https://github.com/nivenice/monoform-previs-studio/blob/master/docs/CHANGELOG.md',
}

test('compareVersions orders releases numerically and handles pre-releases', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1)
  assert.equal(compareVersions('v0.7.0', '0.7.0'), 0)
  assert.equal(compareVersions('0.7', '0.7.0'), 0)
  assert.equal(compareVersions('0.7.0-beta.2', '0.7.0'), -1)
  assert.equal(compareVersions('0.7.0', '0.7.0-beta.2'), 1)
  assert.equal(compareVersions('0.7.0-beta.10', '0.7.0-beta.2'), 1)
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), true)
  assert.equal(isNewerVersion('0.7.0', '0.7.0'), false)
  assert.throws(() => compareVersions('0.7.0', 'latest'), /无法比较版本号/)
})

test('normalizeManifest accepts docs/version.json and drops unsafe fields', () => {
  const parsed = normalizeManifest({
    version: 'v0.7.0',
    notes: '- 新增关于面板\n- 支持检查更新\n\n',
    releasedAt: '2026-11-26T10:00:00+08:00',
    downloadUrl: manifest.downloadUrl,
    releaseNotesUrl: 'http://example.com/notes',
  })
  assert.ok(parsed)
  assert.equal(parsed.version, '0.7.0')
  assert.deepEqual(parsed.notes, ['新增关于面板', '支持检查更新'])
  assert.equal(parsed.releasedAt, '2026-11-26')
  assert.equal(parsed.downloadUrl, manifest.downloadUrl)
  assert.equal(parsed.releaseNotesUrl, '')
  assert.equal(normalizeManifest({ latestVersion: '0.8.0' })?.version, '0.8.0')
  assert.equal(normalizeManifest({ version: 'not-a-version' }), null)
  assert.equal(normalizeManifest(null), null)
  assert.deepEqual(normalizeManifest({ version: '1.0.0' })?.notes, [])
})

test('manifestFromGitHubRelease maps a release payload', () => {
  const parsed = manifestFromGitHubRelease({
    tag_name: 'v0.7.1',
    body: '### 修复\n- 下载进度显示\n* 更新弹窗',
    published_at: '2026-12-01T02:00:00Z',
    html_url: 'https://github.com/nivenice/monoform-previs-studio/releases/tag/v0.7.1',
    assets: [
      { browser_download_url: 'https://github.com/nivenice/monoform-previs-studio/releases/download/v0.7.1/notes.txt' },
      { browser_download_url: 'https://github.com/nivenice/monoform-previs-studio/releases/download/v0.7.1/MONOFORM-0.7.1-win-x64-setup.exe' },
    ],
  })
  assert.ok(parsed)
  assert.equal(parsed.version, '0.7.1')
  assert.deepEqual(parsed.notes, ['修复', '下载进度显示', '更新弹窗'])
  assert.equal(parsed.releasedAt, '2026-12-01')
  assert.match(parsed.downloadUrl, /MONOFORM-0\.7\.1-win-x64-setup\.exe$/)
})

test('pickLatestManifest falls back across endpoints', async () => {
  const selection = await pickLatestManifest(
    ['https://raw.example/version.json', 'https://api.github.com/repos/nivenice/monoform-previs-studio/releases/latest'],
    async url => {
      if (url.includes('raw.example')) throw new Error('offline')
      return {
        tag_name: 'v0.8.0',
        body: '- 新增功能',
        assets: [],
        html_url: 'https://github.com/nivenice/monoform-previs-studio/releases/tag/v0.8.0',
      }
    },
  )
  assert.equal(selection.manifest.version, '0.8.0')
  assert.match(selection.source, /api\.github\.com/)
  await assert.rejects(() => pickLatestManifest(['https://a.example'], async () => ({ nope: true })), /无法获取更新信息/)
  await assert.rejects(
    () => pickLatestManifest(['https://a.example'], async () => { throw new Error('offline') }),
    /offline/,
  )
})

test('buildUpdateCheck compares the running version with the manifest', () => {
  const current = buildUpdateCheck('0.7.0', manifest, 'https://raw.example/version.json', new Date('2026-11-26T12:00:00Z'))
  assert.equal(current.currentVersion, '0.7.0')
  assert.equal(current.latestVersion, '0.7.0')
  assert.equal(current.hasUpdate, false)
  assert.equal(current.checkedAt, '2026-11-26T12:00:00.000Z')
  const older = buildUpdateCheck('0.6.0', manifest, 'https://raw.example/version.json')
  assert.equal(older.hasUpdate, true)
})

test('updateDownloadFileName keeps only a safe installer name', () => {
  assert.equal(
    updateDownloadFileName('https://github.com/nivenice/monoform-previs-studio/raw/master/downloads/MONOFORM-0.7.0-win-x64-setup.exe', '0.7.0'),
    'MONOFORM-0.7.0-win-x64-setup.exe',
  )
  assert.equal(
    updateDownloadFileName('https://github.com/nivenice/monoform-previs-studio/download?id=1', '0.7.0'),
    'MONOFORM-0.7.0-win-x64-setup.exe',
  )
  const traversal = updateDownloadFileName('https://github.com/nivenice/monoform-previs-studio/..%2Fevil.exe', '0.7.0')
  assert.equal(traversal.includes('/'), false)
  assert.equal(traversal.includes('\\'), false)
  assert.match(traversal, /\.exe$/)
})

test('download and external links stay on the trusted hosts', () => {
  assert.equal(isAllowedUpdateDownloadUrl(manifest.downloadUrl), true)
  assert.equal(isAllowedUpdateDownloadUrl('https://objects.githubusercontent.com/a.exe'), true)
  assert.equal(isAllowedUpdateDownloadUrl('http://github.com/a.exe'), false)
  assert.equal(isAllowedUpdateDownloadUrl('https://evil.example/a.exe'), false)
  assert.equal(isAllowedUpdateDownloadUrl('javascript:alert(1)'), false)
  assert.equal(isAllowedExternalUrl('https://github.com/nivenice/monoform-previs-studio'), true)
  assert.equal(isAllowedExternalUrl('https://nivenice.github.io/monoform-previs-studio/'), true)
  assert.equal(isAllowedExternalUrl('https://example.com'), false)
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false)
})

test('the release manifest, changelog and package version stay in sync', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
  const release = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'version.json'), 'utf8')) as {
    version: string
    downloadUrl: string
    notes: string[]
  }
  const changelog = fs.readFileSync(path.join(root, 'docs', 'CHANGELOG.md'), 'utf8')
  assert.equal(release.version, pkg.version)
  assert.ok(release.notes.length > 0)
  assert.ok(release.downloadUrl.includes(pkg.version))
  assert.ok(changelog.includes(`## v${pkg.version} `))
})
