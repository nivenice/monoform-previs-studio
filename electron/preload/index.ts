import { contextBridge } from 'electron'

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
}

contextBridge.exposeInMainWorld('monoform', runtime)

export type MonoformRuntime = typeof runtime
