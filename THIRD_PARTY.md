# Imported components

| Directory | Source | Imported revision | License file |
| --- | --- | --- | --- |
| `webeep-sync-recordings` | https://github.com/aleo113/webeep-sync-recordings | `0b1656e8d89364ce39d2932025e2c5ca9c063004` | [GPLv3](webeep-sync-recordings/LICENSE) |
| `Transcriber` | https://github.com/aleo113/Transcriber | `0c96b1e0659d4252297d2b29b689d3f7b747ecf9` | No license file in the imported source |
| `Transcriber/PoliWebex` | https://github.com/sup3rgiu/PoliWebex | `e138d965b7ff3c44931e9c5f6bd70f8082607cb5` | [MIT](Transcriber/PoliWebex/LICENSE) |

PoliWebex is vendored at the revision previously pinned by Transcriber. Its upstream source and license are retained. To update it, compare a new upstream revision, apply the reviewed changes to this directory, update the revision here, and verify recording downloads.

Local integration changes to the vendored downloader: `package.json` explicitly permits the pinned Puppeteer and keytar installation scripts, needed to install Chromium and the native keyring module on npm versions that require an allowlist. The source remains at the revision listed above.
