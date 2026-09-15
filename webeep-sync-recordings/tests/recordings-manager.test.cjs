const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const load = require('./load-typescript.cjs')
const id = 'a'.repeat(32)
const url = `https://politecnicomilano.webex.com/recording/playback/${id}`
function managerWith(item) {
  const data = { settings: {}, persistence: { recordingCatalog: { [id]: item }, downloadedRecordings: {} } }
  const unlink = []
  const { RecordingsManager } = load('src/modules/recordings-manager.ts', {
    './store': { store: { data, write: async () => {} }, storeIsReady: async () => {} },
    './credentials': { credentialsManager: { load: async () => null } },
    './login': { loginManager: { isLogged: false } },
    './logger': { createLogger: () => ({ log() {}, error() {} }) },
    './recordings': { resolveWebExRecordingUrl: async () => url, getWebExStreamInfo: async () => { throw new Error('No optional metadata') } },
    './transcriber-worker': { transcriberWorker: new EventEmitter() },
    'fs/promises': { unlink: async value => unlink.push(value) },
    got: {},
  })
  return { manager: new RecordingsManager(), data, unlink }
}
function recording(status = 'completed') {
  return { recording: { recordingId: id, title: 'Lesson', courseId: 1, courseName: 'Course', date: null, webexUrl: url, sourceModuleId: 42 }, status, filePath: '/video.mp4', notesPath: '/notes.md', transcriptPath: '/transcript.txt', mediaRecordingId: id }
}
test('adding an existing link keeps artifacts and source metadata without requiring a WebEx ticket', async () => {
  const { manager } = managerWith(recording())
  const item = await manager.addManualRecording(url)
  assert.equal(item.notesPath, '/notes.md')
  assert.equal(item.transcriptPath, '/transcript.txt')
  assert.equal(item.mediaRecordingId, id)
  assert.equal(item.recording.sourceModuleId, 42)
  assert.equal(item.status, 'completed')
})
test('active recordings cannot be deleted while workers own the media', async () => {
  const { manager, unlink } = managerWith(recording('transcribing'))
  await assert.rejects(manager.deleteRecording(id), /Cancel the active job/)
  assert.deepEqual(unlink, [])
})
test('deleting video retains notes and transcript references', async () => {
  const { manager, data, unlink } = managerWith(recording())
  await manager.deleteRecording(id)
  assert.deepEqual(unlink, ['/video.mp4'])
  const item = data.persistence.recordingCatalog[id]
  assert.equal(item.filePath, undefined)
  assert.equal(item.notesPath, '/notes.md')
  assert.equal(item.recording.downloaded, false)
})
test('removes falsely discovered meeting entries without deleting local artifacts', () => {
  const meeting = 'https://politecnicomilano.webex.com/wbxmjs/joinservice/sites/politecnicomilano/meeting/download/' + id
  const item = recording('available')
  item.recording.webexUrl = meeting
  delete item.filePath
  delete item.notesPath
  delete item.transcriptPath
  const { manager, unlink } = managerWith(item)
  assert.equal(manager.getCatalog()[id], undefined)
  assert.deepEqual(unlink, [])

  const retained = recording()
  retained.recording.webexUrl = meeting
  assert.equal(managerWith(retained).manager.getCatalog()[id], retained)
})
