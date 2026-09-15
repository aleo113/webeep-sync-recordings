const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const load = require('./load-typescript.cjs')

function loginWithInterceptor() {
  const app = new EventEmitter()
  app.getPath = () => '/unused'
  let intercept
  const { loginManager } = load('src/modules/login.ts', {
    electron: {
      app,
      session: { defaultSession: { webRequest: {
        onBeforeRequest: (_filter, handler) => { intercept = handler },
      } } },
      protocol: { registerHttpProtocol() {} },
      safeStorage: {},
    },
    'fs/promises': { readFile: async () => { throw new Error('No saved token') } },
    './logger': { createLogger: () => ({ log() {}, debug() {} }) },
  })
  app.emit('ready')
  return {
    loginManager,
    request: details => new Promise(resolve => intercept(details, resolve)),
  }
}

test('recording session checks reach WeBeep without triggering token acquisition', async () => {
  const { loginManager, request } = loginWithInterceptor()
  const recordingRequest = { webContentsId: 42, resourceType: 'mainFrame' }
  assert.deepEqual(await request(recordingRequest), {})
  loginManager.loginWindow = { isDestroyed: () => false, webContents: { id: 7 } }
  assert.deepEqual(await request(recordingRequest), {})
})

test('only the live login window main frame redirects to acquire a token', async () => {
  const { loginManager, request } = loginWithInterceptor()
  loginManager.loginWindow = { isDestroyed: () => false, webContents: { id: 7 } }
  const result = await request({ webContentsId: 7, resourceType: 'mainFrame' })
  assert.equal(result.redirectURL,
    'https://webeep.polimi.it/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=12345')
  assert.deepEqual(await request({ webContentsId: 7, resourceType: 'subFrame' }), {})
  loginManager.loginWindow.isDestroyed = () => true
  assert.deepEqual(await request({ webContentsId: 7, resourceType: 'mainFrame' }), {})
})
