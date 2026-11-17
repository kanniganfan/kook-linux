// electron-builder afterPack 钩子：打目标格式之前，对已展开的 app 目录做最后清理。
//
// 主要用途是砍掉 resources/app-update.yml。electron-builder 会照着 package.json
// 的 repository 字段自动推断 publish=github，然后在每个包里塞一份指向发布仓库的
// 更新配置。这个移植版必须屏蔽自动更新（官方更新器装的是 Windows 安装包，会盖掉
// 移植版），所以这份文件不该出现在分发物里。
//
// publish 设成 [] 并不能阻止它生成，只能在这里删。
const fs = require('fs')
const path = require('path')

module.exports = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources')
  const drop = ['app-update.yml', 'app-update.yml.blockmap']

  for (const name of drop) {
    const file = path.join(resources, name)
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      console.log(`  • 已移除 resources/${name}（移植版屏蔽自动更新）`)
    }
  }
}
