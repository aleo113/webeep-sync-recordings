const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./load-typescript.cjs')
const parser = load('src/modules/recording-links.ts')
const id = 'abcdef0123456789abcdef0123456789'
const playback = `https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/${id}`
test('recognizes recording IDs consistently across playback and legacy links', () => {
  assert.equal(parser.extractVideoID(playback.toUpperCase()), id)
  assert.equal(parser.extractVideoID(`https://politecnicomilano.webex.com/ldr.php?RcId=${id.toUpperCase()}`), id)
  assert.equal(parser.extractVideoID(playback + 'not-an-id'), null)
  assert.equal(parser.extractVideoID('https://webex.com/ldr.php?RCID=garbage'), null)
})
test('rejects lookalike hosts, embedded host strings and executable URLs', () => {
  for (const url of [`https://evilwebex.com/playback/${id}`, `https://webex.com.evil.test/playback/${id}`, `https://example.test/?redirect=${playback}`, `javascript:open('${playback}')`, `https://user:pass@webex.com/playback/${id}`]) {
    assert.equal(parser.extractVideoID(url), null, url)
  }
})
test('decodes HTML and JavaScript escapes and deduplicates archive candidates', () => {
  const base = 'https://recordings.polimi.it/recman_frontend/index.php'
  const html = `<a href="?evn_preview_link=1&amp;transfer_id=42">Open</a><script>location.href = "${playback.replaceAll('/', '\\/')}"</script><a href="${playback}">Again</a>`
  assert.deepEqual(parser.extractCandidateUrlsFromHtml(html, base), [base + '?evn_preview_link=1&transfer_id=42', playback])
  assert.equal(parser.normalizeRecordingUrl('javascript:alert(1)', base), null)
})
test('chooses a recording page rather than a WebEx login or landing page', () => {
  assert.equal(parser.resolvedRecordingUrl(['https://webex.com/login', playback]), playback)
  assert.equal(parser.resolvedRecordingUrl(['https://webex.com/login']), null)
})
test('parses Italian dates without swapping month and day, and preserves missing dates', () => {
  const date = parser.parseLectureDate('05/09/2026 14:30')
  assert.equal(date.getDate(), 5)
  assert.equal(date.getMonth(), 8)
  assert.equal(date.getHours(), 14)
  assert.equal(parser.parseLectureDate('31/02/2026'), null)
  assert.equal(parser.parseLectureDate(null), null)
  assert.equal(parser.parseLectureDate('not a date'), null)
  assert.equal(parser.parseLectureDate('2026-09-05').getFullYear(), 2026)
})
