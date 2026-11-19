// WINDOW_SET_SIZE_ORIGIN 的回归测试。
// 纯 Node 运行，不需要 Electron：被测的是参数校验与窗口调用契约。
//   node tests/window-size.test.js
const assert = require('assert')
const { applyContentSize } = require('../patches/window-size.js')

let pass = 0
const cases = []
function test(name, fn) {
  try {
    fn()
    pass++
    cases.push('  ok   ' + name)
  } catch (e) {
    cases.push('  FAIL ' + name + ' → ' + e.message)
  }
}

function fakeWin(destroyed) {
  const calls = []
  return {
    calls,
    isDestroyed: () => !!destroyed,
    setContentSize: (w, h) => calls.push([w, h]),
  }
}

test('正常尺寸：四舍五入后调用 setContentSize', () => {
  const win = fakeWin(false)
  assert.strictEqual(applyContentSize(win, 1280.4, 720.6), true)
  assert.deepStrictEqual(win.calls, [[1280, 721]])
})

test('字符串数字也接受（preload 可能传字符串）', () => {
  const win = fakeWin(false)
  assert.strictEqual(applyContentSize(win, '1024', '768'), true)
  assert.deepStrictEqual(win.calls, [[1024, 768]])
})

test('0 / 负数 / NaN / undefined 一律忽略，不调窗口', () => {
  for (const [w, h] of [[0, 100], [100, 0], [-1, 100], ['abc', 100], [undefined, 100], [NaN, 100]]) {
    const win = fakeWin(false)
    assert.strictEqual(applyContentSize(win, w, h), false, `${w}x${h} 应被拒`)
    assert.deepStrictEqual(win.calls, [], `${w}x${h} 不应调用 setContentSize`)
  }
})

test('窗口不存在 / 已销毁：忽略且不抛异常', () => {
  assert.strictEqual(applyContentSize(null, 100, 100), false)
  assert.strictEqual(applyContentSize(undefined, 100, 100), false)
  const dead = fakeWin(true)
  assert.strictEqual(applyContentSize(dead, 100, 100), false)
  assert.deepStrictEqual(dead.calls, [])
})

test('setContentSize 抛错时返回 false，不向上冒泡', () => {
  const win = { isDestroyed: () => false, setContentSize: () => { throw new Error('boom') } }
  assert.strictEqual(applyContentSize(win, 100, 100), false)
})

test('成功与失败各打一条日志', () => {
  const logs = []
  applyContentSize(fakeWin(false), 800, 600, (...a) => logs.push(a.join(' ')))
  applyContentSize(null, 800, 600, (...a) => logs.push(a.join(' ')))
  assert.ok(logs.some((l) => l.includes('设置内容尺寸 800 x 600')), logs.join('|'))
  assert.ok(!logs.some((l) => l.includes('失败')), '正常路径不该有失败日志')
})

console.log(cases.join('\n'))
console.log(`\n${pass}/${cases.length} 通过`)
process.exit(pass === cases.length ? 0 : 1)
