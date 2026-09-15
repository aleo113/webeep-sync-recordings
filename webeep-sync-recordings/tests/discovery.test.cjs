const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-typescript.cjs')
const ids = ['1','2','3','4'].map(d => d.repeat(32))
const url = id => `https://politecnicomilano.webex.com/recording/playback/${id}`
const archive = 'https://recordings.polimi.it/recman_frontend/index.php'
function fixture({ rows = [], pages, modules = [], cached = {}, navigate, archives = {} } = {}) {
  let active = archive
  const visits = []
  const data = { settings: {}, persistence: { recordingCatalog: {}, recordingDiscoveryState: { modules: cached, archives } } }
  const browser = {
    async navigateAndWait(value) { visits.push(value); active = value },
    async executeScript() {
      const page = pages?.[active]
      if (page instanceof Error) throw page
      return page || { rows, links: [], html: '', url: active, pageLinks: [], frames: [], login: false, archive: true }
    },
    async navigateInTemporaryWindow(value) {
      visits.push(value)
      if (navigate) return navigate(value)
      return { urls: [value], finalUrl: value, html: '' }
    },
    async getCookies() { return {} },
  }
  const api = load('src/modules/recordings.ts', {
    './browser-recorder': { recordingBrowser: browser },
    './moodle': { moodleClient: { getCoursesWithoutCache: async () => [{ id: 1, name: 'Course' }], cachedCourses: [{ id: 1, shouldSync: true }], getRecordingModules: async () => [...modules] } },
    './logger': { createLogger: () => ({ log() {}, debug() {}, error() {} }) },
    './store': { store: { data } },
    got: { get: async () => ({ body: '{}' }) },
  })
  return { api, data, visits }
}
const moduleFor = (id, link, name = 'Lesson') => ({ id, url: link, name, courseId: 1 })
const archiveModule = moduleFor(10, archive, 'Archivio registrazioni')
test('known rows never hide new recordings further down an archive', async () => {
  const rows = ids.map((id, index) => ({ href: url(id), title: `Lesson ${index}` }))
  const { api } = fixture({ rows })
  const result = await api.extractWebExUrlsFromRecMan(archive, { knownCandidateUrls: new Set([url(ids[0]), url(ids[1])]) })
  assert.deepEqual(result.map(item => item.webexUrl), [url(ids[2]), url(ids[3])])
})
test('follows pagination even when first-page rows are already known', async () => {
  const next = archive + '?page=2'
  const snapshot = (rows, links = []) => ({ rows, pageLinks: links, frames: [], url: archive, html: '', login: false, archive: true })
  const { api, visits } = fixture({ pages: {
    [archive]: snapshot([{ href: url(ids[0]) }, { href: url(ids[1]) }], [next]),
    [next]: snapshot([{ href: url(ids[2]) }], [next]),
  } })
  const result = await api.extractWebExUrlsFromRecMan(archive, { knownCandidateUrls: new Set([url(ids[0]), url(ids[1])]) })
  assert.equal(result.length, 1)
  assert.deepEqual(visits, [archive, next])
})
test('reports archive failures and leaves them retryable', async () => {
  const { api, data } = fixture({ modules: [archiveModule], pages: { [archive]: new Error('timed out') } })
  const result = await api.checkForNewRecordings()
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /timed out/)
  assert.equal(data.persistence.recordingDiscoveryState.modules['1:10'], undefined)
})
test('a broken candidate does not discard other successfully resolved recordings', async () => {
  const broken = archive + '?evn_preview_link=1&transfer_id=fail'
  const { api } = fixture({ modules: [archiveModule], rows: [{ href: broken }, { href: url(ids[0]), title: 'Working lesson' }], navigate: async () => { throw new Error('expired session') } })
  const result = await api.checkForNewRecordings()
  assert.equal(result.recordings.length, 1)
  assert.equal(result.failures.length, 1)
})
test('deduplicates direct and archive links, keeps archive dates and reports progress', async () => {
  const { api } = fixture({ modules: [moduleFor(1, url(ids[0])), archiveModule], rows: [{ href: url(ids[0]), title: 'Lecture', dateText: '05/09/2026' }] })
  const progress = []
  const result = await api.checkForNewRecordings({ onProgress: value => progress.push(value) })
  assert.equal(result.recordings.length, 1)
  assert.equal(result.recordings[0].date.getMonth(), 8)
  assert.equal(progress.at(-1).coursesChecked, 1)
  assert.equal(progress.at(-1).activitiesChecked, 2)
})
test('expired unsupported classifications are checked again; login failures are not cached', async () => {
  const source = 'https://webeep.polimi.it/mod/url/view.php?id=1'
  const { api, data } = fixture({ modules: [moduleFor(1, source), archiveModule], cached: { '1:1': { sourceUrl: source, resolvedUrl: source, kind: 'unsupported', checkedAt: 1 } }, navigate: async () => ({ urls: [], finalUrl: source, html: '<input type="password">' }) })
  const result = await api.checkForNewRecordings()
  assert.equal(result.failures.length, 1)
  assert.equal(data.persistence.recordingDiscoveryState.modules['1:1'], undefined)
})
test('full rescan bypasses recent negative cache entries', async () => {
  const source = 'https://webeep.polimi.it/mod/url/view.php?id=1'
  const { api } = fixture({ modules: [moduleFor(1, source), archiveModule], cached: { '1:1': { sourceUrl: source, resolvedUrl: source, kind: 'unsupported', checkedAt: Date.now() } }, navigate: async () => ({ urls: [url(ids[0])], finalUrl: url(ids[0]), html: '' }) })
  const result = await api.checkForNewRecordings({ force: true })
  assert.equal(result.recordings.length, 1)
})

test('cached archive activities follow the current RecMan entry link', async () => {
  const source = 'https://webeep.polimi.it/mod/url/view.php?id=10'
  const entry = 'https://onlineservices.polimi.it/recman_frontend/recman_frontend/controller/UserListActivity.do?jaf_currentWFID=fresh'
  const { api, visits } = fixture({
    modules: [moduleFor(10, source, 'Archivio registrazioni')],
    cached: { '1:10': { sourceUrl: source, resolvedUrl: archive, kind: 'archive', checkedAt: Date.now() } },
    pages: {
      [source]: { rows: [{ href: entry }], html: '', url: source, pageLinks: [], frames: [], login: false, archive: false },
      [entry]: { rows: [{ href: url(ids[0]), title: 'Lecture' }], html: '', url: entry, pageLinks: [], frames: [], login: false, archive: true },
    },
  })
  const result = await api.checkForNewRecordings()
  assert.deepEqual(result.failures, [])
  assert.equal(result.recordings.length, 1)
  assert.deepEqual(visits, [source, entry])
})

test('expired RecMan workflows report session expiry and stay retryable', async () => {
  const { api, data } = fixture({ modules: [archiveModule], pages: {
    [archive]: { rows: [], pageLinks: [], frames: [], url: archive, login: false, archive: false,
      html: "<html><body><a href='https://aunicalogin.polimi.it/aunicalogin/sessioneterminata.jsp?source_c_app=24670'>Errore interno, fai click per effettuare il logout e ricominciare</a></body></html>" },
  } })
  const result = await api.checkForNewRecordings()
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /session.*expired/i)
  assert.equal(data.persistence.recordingDiscoveryState.modules['1:10'], undefined)
})

test('renews an expired workflow through the current WeBeep course archive link', async () => {
  const course = 'https://webeep.polimi.it/course/view.php?id=1'
  const entry = 'https://onlineservices.polimi.it/recman_frontend/entry'
  const { api, visits } = fixture({ modules: [archiveModule], pages: {
    [archive]: { rows: [], pageLinks: [], frames: [], url: archive, login: false, archive: false,
      html: "<a href='https://aunicalogin.polimi.it/aunicalogin/sessioneterminata.jsp'>Errore interno</a>" },
    [course]: { login: false, url: course, links: [{ href: entry, text: 'Archivio registrazioni', onclick: '' }] },
    [entry]: { rows: [{ href: url(ids[0]), title: 'Lecture' }], pageLinks: [], frames: [], url: entry, html: '', login: false, archive: true },
  } })
  const result = await api.checkForNewRecordings()
  assert.deepEqual(result.failures, [])
  assert.equal(result.recordings.length, 1)
  assert.deepEqual(visits, [archive, course, entry])
})

test('a first scan of the Distributed Systems archive retains pagination and archive classification', async () => {
  const source = 'https://webeep.polimi.it/mod/url/view.php?id=463069'
  const recording = 'https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/daebce95c96b49e99b9b2fe42df2b8c8/playback'
  const next = archive + '?page=2'
  const { api, data, visits } = fixture({
    modules: [moduleFor(463069, source, 'Archivio registrazioni')],
    navigate: async () => ({ urls: [archive], finalUrl: archive, html: `<a href="${recording}">Lecture</a>` }),
    pages: {
      [source]: { rows: [{ href: recording, title: 'Lecture 1' }], html: '', url: archive, pageLinks: [next], frames: [], login: false, archive: true },
      [next]: { rows: [{ href: url(ids[0]), title: 'Lecture 2' }], html: '', url: next, pageLinks: [], frames: [], login: false, archive: true },
    },
  })
  const result = await api.checkForNewRecordings()
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.recordings.map(item => item.webexUrl), [recording, url(ids[0])])
  assert.equal(data.persistence.recordingDiscoveryState.modules['1:463069'].kind, 'archive')
  assert.deepEqual(visits, [source, next])
})

test('two meeting rooms before the archive do not get opened or reused as recordings', async () => {
  const source = 'https://webeep.polimi.it/mod/url/view.php?id=463069'
  const first = 'https://politecnicomilano.webex.com/meet/gianpaolo.cugola'
  const second = 'https://politecnicomilano.webex.com/meet/alessandro.margara'
  const { api, visits } = fixture({
    modules: [moduleFor(463068, first), moduleFor(463070, second), moduleFor(463069, source, 'Archivio registrazioni')],
    cached: { '1:463068': { sourceUrl: first, resolvedUrl: `https://politecnicomilano.webex.com/wbxmjs/joinservice/sites/politecnicomilano/meeting/download/${ids[1]}`, kind: 'webex', checkedAt: Date.now() } },
    rows: [{ href: url(ids[0]), title: 'Lecture' }],
  })
  const result = await api.checkForNewRecordings()
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.recordings.map(item => item.webexUrl), [url(ids[0])])
  assert.equal(result.unsupportedActivities, 2)
  assert.deepEqual(visits, [source])
})

test('course lookup prefers the named archive over earlier generic Polimi service links', async () => {
  const course = 'https://webeep.polimi.it/course/view.php?id=1'
  const source = 'https://webeep.polimi.it/mod/url/view.php?id=463069'
  const { api } = fixture({ pages: { [course]: { url: course, login: false, links: [
    { text: 'Online services', href: 'https://aunicalogin.polimi.it/aunicalogin/getservizio.xml?id_servizio=1' },
    { text: 'Meeting room', href: 'https://politecnicomilano.webex.com/meet/gianpaolo.cugola' },
    { text: 'Archivio registrazioni', href: source },
  ] } } })
  assert.equal(await api.getAunicaUrlFromWebeep(1), source)
})

test('the archive launch page ignores generic service links before the labelled archive', async () => {
  const source = 'https://webeep.polimi.it/mod/url/view.php?id=463069'
  const unrelated = 'https://aunicalogin.polimi.it/aunicalogin/getservizio.xml?id_servizio=2292'
  const entry = 'https://aunicalogin.polimi.it/aunicalogin/getservizio.xml?id_servizio=2294&c_classe_webeep=888574-STD'
  const { api, visits } = fixture({ pages: {
    [source]: { rows: [{ href: unrelated, text: 'Online services' }, { href: entry, text: 'Recordings archive' }, { href: unrelated, text: 'Online services' }], html: '', url: source, pageLinks: [], frames: [], login: false, archive: false },
    [unrelated]: new Error('This service is not the recording archive'),
    [entry]: { rows: [{ href: url(ids[0]), title: 'Lecture' }], html: '', url: archive, pageLinks: [], frames: [], login: false, archive: true },
  } })
  const result = await api.extractWebExUrlsFromRecMan(source)
  assert.deepEqual(result.map(item => item.webexUrl), [url(ids[0])])
  assert.deepEqual(visits, [source, entry])
})
