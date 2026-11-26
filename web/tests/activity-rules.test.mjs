import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
// This repository runs its tests with Node's built-in runner.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')

// 只测纯函数 normalizeActivitySnapshot，不实例化 store、不发请求。
// activity-center.ts 顶部的 defineStore 在模块加载期不会副作用，可以安全引入。
function loadSnapshotNormalizer() {
  const imports = { '@/api': { __esModule: true, default: {} } }
  const source = readFileSync(new URL('../src/stores/activity-center.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(id => imports[id] || require(id), module, module.exports)
  return module.exports.normalizeActivitySnapshot
}

const normalizeActivitySnapshot = loadSnapshotNormalizer()

const SNAPSHOT_KEYS = ['constellation', 'qixi', 'qingMei', 'charity']

function assertRulesUsable(label, rules) {
  assert.ok(rules && typeof rules === 'object', `${label}: rules 必须是对象`)
  assert.ok(Array.isArray(rules.paragraphs), `${label}: rules.paragraphs 必须是数组`)
  assert.ok(Array.isArray(rules.lines), `${label}: rules.lines 必须是数组`)
  assert.ok(rules.paragraphs.every(line => typeof line === 'string'), `${label}: paragraphs 只能含字符串`)
  assert.ok(
    !rules.paragraphs.join('|').includes('[object Object]'),
    `${label}: 不能出现 [object Object]`,
  )
}

// 游戏详情页（CharityRedFlowerView / QixiActivityView / QingMeiBrewTab / ConstellationTab）
// 统一读 activity.rules.paragraphs 与 activity.rules.title，所以这两侧字段必须对得上。
test('activity detail rules expose { title, paragraphs } for every gameplay that renders them', () => {
  const snapshot = normalizeActivitySnapshot({
    constellation: { activityId: '2026072701', rules: { title: '活动说明', paragraphs: ['星宿轮转'] } },
    qixi: { activityId: '2026', rules: { title: '活动说明', paragraphs: ['七夕搭桥'] } },
    qingMei: { activityId: '2026', rules: { title: '活动说明', paragraphs: ['酿造青梅'] } },
    charity: { activityId: '2026', rules: { title: '活动说明', paragraphs: ['收集红花'] } },
  })

  for (const key of SNAPSHOT_KEYS) {
    assert.ok(snapshot[key], `${key}: 快照里应有该活动`)
    assertRulesUsable(key, snapshot[key].rules)
    assert.equal(snapshot[key].rules.paragraphs.length, 1, `${key}: 段落应被保留`)
  }
})

// 星宿活动的静态目录（constellation-2026072701.json）用的是 lines 而不是 paragraphs，
// 归一化必须把 lines 兜底成 paragraphs，否则 ActivityRulesDialog 读 paragraphs.length 会崩。
test('legacy { title, lines } rules are normalized into paragraphs', () => {
  const snapshot = normalizeActivitySnapshot({
    constellation: {
      activityId: '2026072701',
      rules: { title: '活动说明', lines: ['<b>【活动简介】</b>', '星宿共有二十八个，逐日点亮。'] },
    },
  })
  const { rules } = snapshot.constellation
  assertRulesUsable('constellation.lines', rules)
  assert.equal(rules.title, '活动说明')
  assert.deepEqual(rules.paragraphs, ['【活动简介】', '星宿共有二十八个，逐日点亮。'])
  assert.deepEqual(rules.lines, rules.paragraphs)
})

// 后端 unsupported 分支下发 rules: null，组件用 v-if 判断，归一化不能抛错。
test('missing rules degrade to an empty paragraph list instead of throwing', () => {
  const snapshot = normalizeActivitySnapshot({
    constellation: { activityId: '2026072701', rules: null, catalogStatus: 'unsupported' },
    qixi: { activityId: '2026' },
    qingMei: { activityId: '2026' },
    charity: { activityId: '2026' },
  })

  for (const key of SNAPSHOT_KEYS) {
    assert.ok(snapshot[key], `${key}: 快照里应有该活动`)
    assertRulesUsable(key, snapshot[key].rules)
    assert.deepEqual(snapshot[key].rules.paragraphs, [], `${key}: 缺规则时应为空数组`)
  }
})
