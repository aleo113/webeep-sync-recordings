# Imported components

| Directory | Source | Imported revision | License file |
| --- | --- | --- | --- |
| `webeep-sync-recordings` | https://github.com/aleo113/webeep-sync-recordings | `21f8ea402ce8f805612e240205ee079167acca09` | [GPLv3](webeep-sync-recordings/LICENSE) |
| `Transcriber` | https://github.com/aleo113/Transcriber | `368137bc517f825e409cf4a173b136c05f374b2f` | No license file in the imported source |
| `Transcriber/PoliWebex` | https://github.com/sup3rgiu/PoliWebex | `e138d965b7ff3c44931e9c5f6bd70f8082607cb5` | [MIT](Transcriber/PoliWebex/LICENSE) |

PoliWebex is vendored at the revision previously pinned by Transcriber. Its upstream source and license are retained. To update it, compare a new upstream revision, apply the reviewed changes to this directory, update the revision here, and verify recording downloads.

Local integration changes to the vendored downloader: `package.json` explicitly permits the pinned Puppeteer and keytar installation scripts, needed to install Chromium and the native keyring module on npm versions that require an allowlist. The downloader JavaScript remains at the revision listed above; the lockfile also updates tree-kit within its existing dependency range.
