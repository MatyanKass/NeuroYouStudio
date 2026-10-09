// Сквозная проверка собранного приложения: выбрать модель, загрузить, спросить, дождаться ответа.
// node scripts/e2e-chat.cjs <папка для скриншотов> [часть имени модели] [профиль памяти]
const { _electron } = require('playwright')
const path = require('node:path')

;(async () => {
  const out = process.argv[2] || '.'
  const modelPart = process.argv[3] || 'Qwen3-0.6B'
  const memProfile = process.argv[4] || ''
  // Отдельный временный профиль: тестовые чаты не попадают в настоящие данные пользователя.
  const profile = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'nys-e2e-chat-'))
  const app = await _electron.launch({ args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.waitForTimeout(3000)
  const shot = (name) => win.screenshot({ path: path.join(out, `${name}.png`) })

  // Новый чат и выбор модели
  await win.getByRole('button', { name: 'Новый чат', exact: true }).click()
  await win.getByTestId('model-picker').click()
  await win.getByTestId('model-option').filter({ hasText: modelPart }).first().click()
  await win.waitForTimeout(1500)

  if (memProfile) {
    await win.getByRole('tab', { name: 'Память' }).click()
    await win.getByRole('radio', { name: new RegExp(memProfile) }).click()
    await win.waitForTimeout(1200)
  }
  await shot('1-selected')

  await win.getByRole('button', { name: 'Загрузить', exact: true }).click()
  await win.getByRole('button', { name: 'Выгрузить' }).waitFor({ timeout: 300_000 })
  await win.waitForTimeout(1500)
  await shot('2-loaded')

  const box = win.locator('textarea').last()
  await box.fill(process.argv[5] || 'Привет! Ответь одним коротким предложением: сколько будет 2+2?')
  await box.press('Enter')
  await win.getByText(/ток\/с/).first().waitFor({ timeout: 300_000 })
  await win.waitForTimeout(800)
  await shot('3-answer')

  const answer = await win.locator('.md').last().innerText()
  console.log('ANSWER:', answer.slice(0, 300))
  const stats = await win.getByText(/ток\/с/).first().innerText()
  console.log('STATS:', stats)

  await win.getByRole('tab', { name: 'Память' }).click()
  await win.waitForTimeout(1000)
  await shot('4-memory')

  await win.getByRole('button', { name: 'Выгрузить' }).click()
  await win.getByRole('button', { name: 'Загрузить', exact: true }).waitFor({ timeout: 60_000 })
  console.log('ERRORS:', JSON.stringify(errors))
  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
