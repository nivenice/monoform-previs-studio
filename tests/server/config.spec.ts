import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelConfigStore } from '../../server/config'

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monoform-config-'))
  const keyFile = path.join(dir, 'key.txt')
  const configFile = path.join(dir, 'model-config.local.json')
  return { dir, keyFile, configFile, store: new ModelConfigStore({ configFile, keyFile }) }
}

test('config merges key file with a JSON override and hides the key', t => {
  const { dir, keyFile, configFile, store } = makeStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(keyFile, [
    '# comment',
    'base-url=https://key.example/v1',
    'api-key=secret-key',
    'model=key-model',
    'uncaptured line',
  ].join('\n'))
  fs.writeFileSync(configFile, JSON.stringify({ 'base-url': 'https://override.example/v1', model: 'override-model', ignored: true }))
  const cfg = store.load()
  assert.equal(cfg['base-url'], 'https://override.example/v1')
  assert.equal(cfg['api-key'], 'secret-key')
  assert.equal(cfg.model, 'override-model')
  assert.deepEqual(store.publicConfig(), {
    baseUrl: 'https://override.example/v1',
    model: 'override-model',
    apiKeyConfigured: true,
    modelConfigured: true,
  })
})

test('save keeps only the three supported keys and preserves existing values', t => {
  const { dir, keyFile, configFile, store } = makeStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(keyFile, 'base-url=https://key.example/v1\napi-key=secret-key\nmodel=key-model\n')
  const saved = store.save({ 'base-url': 'http://127.0.0.1:9999/v1', 'api-key': '', model: 'new-model', extra: 'ignored' })
  assert.equal(saved['base-url'], 'http://127.0.0.1:9999/v1')
  assert.equal(saved['api-key'], 'secret-key')
  assert.equal(saved.model, 'new-model')
  const persisted = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.deepEqual(persisted, {
    'base-url': 'http://127.0.0.1:9999/v1',
    model: 'new-model',
    'api-key': 'secret-key',
  })
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
})

test('malformed JSON and missing files fall back without throwing', t => {
  const { dir, configFile, store } = makeStore()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(configFile, '{not json')
  assert.deepEqual(store.load(), {})
  assert.deepEqual(store.publicConfig(), {
    baseUrl: '',
    model: '',
    apiKeyConfigured: false,
    modelConfigured: false,
  })
})
