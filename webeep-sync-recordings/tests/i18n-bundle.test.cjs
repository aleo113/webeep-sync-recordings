const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const test = require("node:test")
const webpack = require("webpack")

test("packaged translations initialize and load English and Italian", async () => {
  const root = path.resolve(__dirname, "..")
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "webeep-i18n-"))
  try {
    const config = require("../webpack.main.config")
    await new Promise((resolve, reject) => {
      const compiler = webpack({
        ...config,
        mode: "production",
        context: root,
        entry: path.join(root, "src/modules/i18next.ts"),
        output: { path: output, filename: "bundle.cjs", library: { type: "commonjs2" } },
        plugins: [],
      })
      compiler.run((error, stats) => {
        compiler.close(() => {
          if (error) reject(error)
          else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
          else resolve()
        })
      })
    })
    fs.cpSync(path.join(root, "static/locales"), path.join(output, "static/locales"), { recursive: true })
    const result = execFileSync(process.execPath, ["--unhandled-rejections=strict", "-e", `
      const { i18nInit, i18n } = require(${JSON.stringify(path.join(output, "bundle.cjs"))});
      Promise.all([i18nInit(), i18nInit()]).then(async () => {
        for (const language of ['en', 'it']) {
          await i18n.changeLanguage(language);
          if (!i18n.hasResourceBundle(language, 'client')) throw new Error('Missing ' + language);
        }
        console.log('Translations loaded');
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `], { timeout: 20000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
    assert.match(result, /Translations loaded/)
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
})
