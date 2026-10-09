// Скриншоты собранного приложения (npx electron-vite build): node scripts/screenshot.cjs <папка> [раздел…]
// Разделы — подписи кнопок в боковой панели: «Чат», «Мои модели», «Поиск», «Загрузки», «Движки», «Настройки».
const { _electron } = require('playwright')
const path = require('node:path')

;(async () => {
  const out = process.argv[2] || '.'
  const pages = process.argv.slice(3)
  const app = await _electron.launch({ args: [path.resolve(__dirname, '..')] })
  const win = await app.firstWindow()
  win.on('console', (m) => {
    if (m.type() === 'error') console.log('console error:', m.text())
  })
  win.on('pageerror', (e) => console.log('page error:', e.message))
  await win.waitForTimeout(2500)
  if (!pages.length) pages.push('Чат')
  for (const p of pages) {
    await win.locator(`nav button[title="${p}"]`).click()
    await win.waitForTimeout(1200)
    await win.screenshot({ path: path.join(out, `${p}.png`) })
  }
  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
