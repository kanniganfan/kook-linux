// Linux 覆盖层：只负责把「谁在说话」画出来，数据由主进程推过来
const wrap = document.getElementById('wrap')
let cfg = { position: { isRight: false, isBottom: false }, scale: 1, displayType: 1 }
let users = []

function applyCfg() {
  wrap.classList.toggle('right', !!(cfg.position && cfg.position.isRight))
  wrap.classList.toggle('bottom', !!(cfg.position && cfg.position.isBottom))
  const av = Math.max(20, Math.round(32 * (Number(cfg.scale) || 1)))
  wrap.style.setProperty('--av', av + 'px')
}

function render() {
  wrap.innerHTML = ''
  const list = (users || []).filter((u) => u && (cfg.displayType === 1 || u.talking))
  if (!list.length) {
    const d = document.createElement('div')
    d.className = 'empty'
    wrap.appendChild(d)
    return
  }
  for (const u of list.slice(0, 8)) {
    const card = document.createElement('div')
    card.className = 'card' + (u.talking ? ' talk' : '')
    const img = document.createElement('img')
    img.className = 'avatar'
    if (u.avatar) img.src = u.avatar
    else img.style.background = u.color || '#5865f2'
    const nm = document.createElement('div')
    nm.className = 'name'
    nm.textContent = u.name || ''
    card.appendChild(img)
    card.appendChild(nm)
    if (u.talking) {
      const dot = document.createElement('div')
      dot.className = 'dot'
      card.appendChild(dot)
    }
    wrap.appendChild(card)
  }
}

if (window.overlayAPI) {
  window.overlayAPI.onConfig((c) => { cfg = c || cfg; applyCfg(); render() })
  window.overlayAPI.onUsers((u) => { users = u || []; render() })
} else {
  // 直接开在浏览器里调试时，给两条假数据看看效果
  users = [{ name: 'KANNI', talking: true }, { name: '小助手', talking: false, color: '#3ba55d' }]
  applyCfg(); render()
}
applyCfg(); render()
