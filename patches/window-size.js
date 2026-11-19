// WINDOW_SET_SIZE_ORIGIN 的实现主体。
//
// 官方 preload（window.js:129）用 send 调这条通道，参数可能带浮点；这条通道没有返回值，
// 所以非法参数、窗口已销毁都只能静默忽略——但不能静默到「永远什么也没做」，那就是空转。
//
// 抽成独立模块的唯一目的：让「设置窗口尺寸」这段逻辑可以被自动测试直接调用，
// 不必为了验证 4 行代码启动整个客户端。

function applyContentSize(win, width, height, LOG) {
  const w = Math.round(Number(width))
  const h = Math.round(Number(height))
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false
  if (!win) return false
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false

  try {
    win.setContentSize(w, h)
    if (LOG) LOG('[win] 设置内容尺寸', w, 'x', h)
    return true
  } catch (err) {
    if (LOG) LOG('[win] 设置内容尺寸失败', err && err.message)
    return false
  }
}

module.exports = { applyContentSize }
