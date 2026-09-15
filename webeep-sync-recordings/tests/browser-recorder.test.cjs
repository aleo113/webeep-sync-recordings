const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const load = require('./load-typescript.cjs')

function fixture() {
  const { RecordingBrowser } = load('src/modules/browser-recorder.ts', {
    electron: {},
    './logger': { createLogger: () => ({ debug() {} }) },
  })
  const webContents = new EventEmitter()
  const browser = new RecordingBrowser()
  browser.getWindow = async () => ({ webContents, loadURL: async () => {} })
  return { browser, webContents }
}

test('waits for the final load when Polimi redirects after an intermediate page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { browser, webContents } = fixture()
  let finished = false
  const navigation = browser.navigateAndWait('https://aunicalogin.polimi.it/aunicalogin/getservizio.xml').then(() => { finished = true })
  await Promise.resolve()
  webContents.emit('did-finish-load')
  t.mock.timers.tick(1000)
  webContents.emit('did-start-navigation', {}, 'https://onlineservices.polimi.it/recman_frontend/', false, true)
  t.mock.timers.tick(1000)
  await Promise.resolve()
  assert.equal(finished, false)
  webContents.emit('did-finish-load')
  t.mock.timers.tick(1200)
  await navigation
  assert.equal(finished, true)
  assert.equal(webContents.listenerCount('did-start-navigation'), 0)
  assert.equal(webContents.listenerCount('did-finish-load'), 0)
})

test('an unfinished redirect still reaches the overall navigation timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { browser, webContents } = fixture()
  const navigation = browser.navigateAndWait('https://webeep.polimi.it/', undefined, 3000)
  const rejection = assert.rejects(navigation, /Navigation timeout/)
  await Promise.resolve()
  webContents.emit('did-finish-load')
  t.mock.timers.tick(1000)
  webContents.emit('did-start-navigation', {}, 'https://onlineservices.polimi.it/', false, true)
  t.mock.timers.tick(2000)
  await rejection
  assert.equal(webContents.listenerCount('did-start-navigation'), 0)
  assert.equal(webContents.listenerCount('did-finish-load'), 0)
})
