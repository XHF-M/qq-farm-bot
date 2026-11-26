import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const vue = require('vue')
const { compileScript, parse } = require('vue/compiler-sfc')

test('the seed grid loads the inventory array and preserves the saved order', async () => {
  const rows = [
    { seedId: 10, name: '黄瓜', count: 3, requiredLevel: 1, image: '', plantSize: 1 },
    { seedId: 20, name: '玉米', count: 2, requiredLevel: 1, image: '', plantSize: 1 },
    { seedId: 30, name: '大南瓜', count: 1, requiredLevel: 1, image: '', plantSize: 2 },
  ]
  const source = readFileSync(new URL('../src/components/settings/BagSeedPriority.vue', import.meta.url), 'utf8')
  const { content } = compileScript(parse(source).descriptor, { id: 'bag-seed-priority' })
  const { outputText } = ts.transpileModule(content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const api = { get: async () => ({ data: { ok: true, data: rows } }) }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    id => id === '@/api' ? api : require(id),
    module,
    module.exports,
  )

  const component = module.exports.default
  const renderer = vue.createRenderer({
    createComment: () => ({}),
    insert(node, parent) { node.parent = parent },
    remove() {},
    parentNode: node => node.parent,
    nextSibling: () => null,
  })
  const priority = vue.ref([99, 20])
  let grid
  const app = renderer.createApp({
    render: () => vue.h(component, {
      ref: (instance) => { grid = instance },
      accountId: '1',
      modelValue: priority.value,
      'onUpdate:modelValue': value => { priority.value = value },
    }),
  })
  // The renderer only mounts setup; read the same computed ordering used by the template.
  component.render = () => null
  const originalWindow = globalThis.window
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  globalThis.window = { removeEventListener() {} }
  globalThis.cancelAnimationFrame = () => {}
  try {
    app.mount({})
    await new Promise(resolve => setImmediate(resolve))
    const state = grid.$.setupState
    assert.equal(state.error, '')
    assert.deepEqual(state.ordered.map(seed => seed.seedId), [20, 10])
    state.move(10, 20)
    assert.deepEqual(priority.value, [99, 10, 20])
    await vue.nextTick()
    assert.deepEqual(state.ordered.map(seed => seed.seedId), [10, 20])
  }
  finally {
    app.unmount()
    globalThis.window = originalWindow
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  }
})
