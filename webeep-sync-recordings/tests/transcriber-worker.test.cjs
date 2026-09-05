const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const load = require('./load-typescript.cjs')
function workerWith(settings) {
  const launches = []
  const { TranscriberWorker } = load('src/modules/transcriber-worker.ts', {
    './store': { store: { data: { settings } }, storeIsReady: async () => {} },
    electron: { app: { isPackaged: false, getAppPath: () => '/suite/webeep-sync-recordings', getPath: () => '/home/student' } },
    fs: { existsSync: () => false, readdirSync: () => ['v18.20.0', 'v22.12.0', 'v20.9.0', 'not-a-version'] },
    child_process: { spawn(executable, args, options) {
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.stdin = new Writable({ write(data, encoding, done) { launches.at(-1).command = JSON.parse(data.toString()); done() } })
      launches.push({ executable, args, options, child })
      return child
    } },
  })
  return { worker: new TranscriberWorker(), launches }
}
test('selected notes provider and model reach the Python worker', async () => {
  const { worker, launches } = workerWith({ transcriberNotesMode: 'api', transcriberNotesProvider: 'claude', transcriberClaudeModel: ' sonnet ', transcriberCodexModel: '' })
  await worker.start({ recordingId: 'id', mediaPath: '/video.mp4', sourceUrl: '', materialsPath: '/materials', outputPath: '/notes' })
  assert.equal(launches[0].command.notes_provider, 'claude')
  assert.equal(launches[0].command.claude_model, 'sonnet')
  assert.equal(Object.hasOwn(launches[0].command, 'codex_model'), false)
})
test('macOS workers find nvm, Homebrew and CLI tools before stale system paths', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalPath = process.env.PATH
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    process.env.PATH = '/usr/local/bin:/usr/bin'
    const { worker } = workerWith({})
    const env = worker.workerEnv()
    assert.equal(env.PATH.split(':')[0], '/home/student/.nvm/versions/node/v22.12.0/bin')
    assert.ok(env.PATH.includes('/opt/homebrew/bin'))
    assert.ok(env.PATH.includes('/home/student/.local/bin'))
    assert.equal(env.PATH.split(':').filter(p => p === '/usr/local/bin').length, 1)
    assert.equal(process.env.PATH, '/usr/local/bin:/usr/bin')
  } finally {
    Object.defineProperty(process, 'platform', original)
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})
