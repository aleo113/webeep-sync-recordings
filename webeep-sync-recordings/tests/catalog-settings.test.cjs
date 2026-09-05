const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const load = require('./load-typescript.cjs')
const { groupRecordings, canDownload, canTranscribe } = load('src/modules/recording-catalog.ts')
const { validateSettingsUpdate } = load('src/modules/settings-validation.ts')
function item(id, courseId, date, title = `Lesson ${id}`, status = 'available') {
  return { recording: { recordingId: id, courseId, courseName: 'Same course name', date, title }, status }
}
test('groups courses by ID and sorts unknown dates last in both directions', () => {
  const records = [item('10', 1, null), item('2', 1, null), item('3', 1, '2026-09-05'), item('4', 2, null)]
  for (const sort of ['newest', 'oldest']) {
    const groups = groupRecordings(records, '', 'all', sort)
    assert.equal(groups.length, 2)
    assert.deepEqual(groups[0].items.map(i => i.recording.recordingId), ['3', '2', '10'])
  }
})
test('filters by title/course and exposes only eligible batch operations', () => {
  const ready = { ...item('1', 1, null, 'Pipelining', 'downloaded'), filePath: '/lecture.mp4' }
  const active = { ...ready, status: 'transcribing' }
  assert.equal(groupRecordings([ready, active], 'PIPELINE', 'all', 'newest').length, 0)
  assert.equal(groupRecordings([ready, active], 'pipelining', 'active', 'newest')[0].items.length, 1)
  assert.equal(canTranscribe(ready), true)
  assert.equal(canTranscribe(active), false)
  assert.equal(canDownload(ready), false)
})
test('settings reject missing, nonfinite and out-of-range values before persistence', () => {
  for (const value of [NaN, Infinity, null, -1, 0, 6, '2']) assert.throws(() => validateSettingsUpdate({ recordingsMaxConcurrent: value }))
  assert.throws(() => validateSettingsUpdate({ recordingsDownloadPath: '' }))
  assert.throws(() => validateSettingsUpdate({ nativeThemeSource: 'bad' }))
  assert.throws(() => validateSettingsUpdate({ unexpected: true }))
  assert.deepEqual(validateSettingsUpdate({ recordingsMaxConcurrent: 2, nativeThemeSource: 'dark' }), { recordingsMaxConcurrent: 2, nativeThemeSource: 'dark' })
})
test('both locales retain original settings labels and all new navigation labels', () => {
  for (const lang of ['en', 'it']) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, `../static/locales/${lang}/client.json`), 'utf8'))
    for (const key of ['settings', 'colorTheme', 'language', 'cancel', 'save', 'recordingsSection', 'tabs']) assert.ok(data.settings[key], `${lang}: ${key}`)
    assert.equal(data.recordings.sorts.newest.includes('sorts.'), false)
  }
})

test('Claude provider settings and empty default models are accepted', () => {
  assert.deepEqual(validateSettingsUpdate({ transcriberNotesProvider: 'claude', transcriberClaudeModel: '' }), { transcriberNotesProvider: 'claude', transcriberClaudeModel: '' })
  assert.throws(() => validateSettingsUpdate({ transcriberNotesProvider: 'unknown' }))
})
