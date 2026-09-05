const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const ts = require('typescript')
module.exports = function load(file, mocks = {}) {
  const filename = path.resolve(__dirname, '..', file)
  const source = fs.readFileSync(filename, 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const realRequire = createRequire(filename)
  const requireModule = name => Object.hasOwn(mocks, name) ? mocks[name] : name.startsWith('.') ? load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), name + '.ts')), mocks) : realRequire(name)
  new Function('require', 'module', 'exports', '__filename', '__dirname', code)(requireModule, module, module.exports, filename, path.dirname(filename))
  return module.exports
}
