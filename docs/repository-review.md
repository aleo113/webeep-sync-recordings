# Repository review and integration

## Scope

Reviewed the combined source layout and setup, desktop build configuration, recording URL discovery, browser navigation, catalogue/job ownership, settings persistence, translations, and the Python worker boundary. Incorporated the parallel Claude/macOS work from desktop commit `21f8ea4` and Transcriber commit `368137b`, retaining both histories.

## Changes

| Problem | Result |
| --- | --- |
| Separate Git repositories and a downloader submodule made sharing incomplete | One checkout contains all source; `scripts/workspace.py` sets up and checks both runtimes. Original Git metadata is backed up locally under `.git/monorepo-backup`. |
| Two consecutive known archive rows stopped discovery | All exposed pages and rows are inspected; known successful links avoid repeated preview navigation. |
| Archive/navigation failures looked like successful empty results | Failures are reported per course/activity/link and remain retryable. A scan can retain successful results when individual previews fail. |
| Unsupported activity classifications never expired | Negative results expire after six hours; archive links get a daily full refresh, with an explicit full-rescan action. |
| Loose URL matching accepted lookalike hosts and inconsistent IDs | Shared parsing checks HTTP(S), exact WebEx hostname boundaries and 32-digit hexadecimal recording IDs; it decodes HTML/JavaScript link escapes. |
| Italian dates were parsed in US order; missing dates became “today” | Day/month parsing is explicit, invalid/missing dates remain unknown, and unknown dates sort last. |
| Duplicate titles could overwrite a downloaded file | Downloaded filenames include the recording ID. Re-adding a link preserves notes, transcript paths and source metadata; active jobs block video deletion. |
| Settings labels disappeared because of duplicate JSON keys | Both translation sections are merged. General, Recordings, Transcription and About are separate sections. |
| Theme/folder choices could persist after Cancel | Changes stay in the form until Save; closing the dialog restores the theme preview. Numeric, enum and path values are validated before persistence. |
| Long course lists crowded out recordings | Course files and Recordings have separate views, retaining the original fonts, colours, compact sections and controls. Recordings support search, status filters, course groups, natural title/date sorting and eligible batch actions. |
| Claude/macOS changes were absent from the original local snapshots | Provider/model controls, worker payloads, provider tests, SSO checks, credential forwarding and macOS packaging/tool-path support are integrated. The shell launcher no longer requires GNU `readlink -f`. |
| npm could report installation success while skipping native/browser hooks | The pinned keytar/Puppeteer installation scripts are explicitly listed, and setup checks that the native module and browser exist. |

## Verification

- Fresh clone: the shared setup command installs both runtimes and validates the native downloader module, Chromium and worker import without the original sibling repositories. Setup leaves the checkout clean, and the complete verification command passes from an unrelated working directory in that fresh clone. The first Python download timed out; retrying with a longer pip timeout succeeded.
- Python: 43 unit tests, including provider dispatch, worker options, credentials forwarding and bundled configuration.
- Worker subprocess: invocation from an unrelated working directory returns the expected structured `MEDIA_NOT_FOUND` error for missing input, without downloading models.
- Desktop: ESLint, TypeScript, and 22 tests for URL parsing, discovery pagination/caches/failures, catalogue ordering, settings, artifact preservation, provider payloads and macOS PATH construction.
- Real Chromium fixture: archive table extraction preserves column positions and dates, and follows pagination past known rows.
- Rendered application fixtures: recordings search, eligible batch selection, invalid-settings rejection, theme restoration on Escape, provider/model saving, light/dark layouts and a 600 px viewport. No account or lecture downloads were used.
- Linux x64 Electron package builds successfully. This packages the desktop app; it does not bundle the Python runtime, models or native downloader tools.

## Remaining verification and dependency work

Authenticated WeBeep/RecMan/WebEx discovery must still be checked against live course pages, especially unfamiliar archive pagination, cross-origin frames and SSO flows. The fixture checks cannot establish access to every real recording. macOS signing/notarization, GUI launches and actual Claude-generated notes need verification on the relevant machine/account; the current checks use mocked provider subprocesses.

Dependency updates include i18next-fs-backend, compatible shell-quote/websocket-driver/tar updates and the downloader’s tree-kit lock entry. The audits still report advisories in the legacy dependency graph. In particular, older Electron Forge tooling retains [tar 6](https://github.com/advisories/GHSA-23hp-3jrh-7fpw), and PoliWebex retains [request](https://github.com/advisories/GHSA-p8p7-x288-28g6) and its [form-data dependency](https://github.com/advisories/GHSA-fjxv-7rqg-78g4). Replacing those libraries and updating the Electron/Forge toolchain requires separate compatibility testing; no force-upgrade was applied.

Reproduce the audits from each JavaScript directory with `pnpm audit` (desktop) and `npm audit` (PoliWebex). Audit totals include development and transitive dependencies and do not establish exploitability in this application.

The npm hook configuration follows the [npm install-script policy](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/). Claude note generation exposes only the required Read tool when attachments exist, using the [Claude CLI tool controls](https://code.claude.com/docs/en/cli-usage), and retains the imported restriction to the private attachment directory.
