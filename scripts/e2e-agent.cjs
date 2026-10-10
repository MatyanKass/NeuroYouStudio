/* global window */
// Сквозная проверка режима агента в собранном приложении (npx electron-vite build):
// node scripts/e2e-agent.cjs <папка для скриншотов> [часть имени модели]
// Включает агента в новом чате, ставит рабочую папку во временный каталог, просит создать и запустить
// скрипт, затем проверяет файл на диске и карточки действий в интерфейсе.
const { _electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

;(async () => {
  const out = process.argv[2] || '.'
  const modelPart = process.argv[3] || 'Qwen3-0.6B'
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nys-e2e-agent-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nys-agent-work-'))
  const app = await _electron.launch({ args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForTimeout(3000)
  const shot = (name) => win.screenshot({ path: path.join(out, `${name}.png`) })

  // Охранник: включён, модель выбрана, если скачана.
  await win.evaluate(() =>
    window.nys.invoke('settings:update', {
      agent: { guardEnabled: true, guardModelId: 'unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf', approval: 'askDangerous' }
    })
  )

  await win.getByRole('button', { name: 'Новый чат', exact: true }).click()
  await win.getByTestId('model-picker').click()
  await win.getByTestId('model-option').filter({ hasText: modelPart }).first().click()
  await win.getByRole('button', { name: 'Загрузить', exact: true }).click()
  await win.getByRole('button', { name: 'Выгрузить' }).waitFor({ timeout: 300_000 })

  // Включаем агента и подменяем рабочую папку (диалог выбора папки в тесте недоступен).
  await win.getByRole('switch', { name: /Агент/ }).click()
  await win.waitForTimeout(800)
  await win.evaluate(async (cwd) => {
    const list = await window.nys.invoke('chat:list')
    const c = await window.nys.invoke('chat:get', list[0].id)
    c.agent = { enabled: true, cwd }
    await window.nys.invoke('chat:save', c)
  }, work)
  // Перечитать чат: открыть его заново из списка.
  await win.locator('aside').getByRole('button').filter({ hasText: /Новый чат/ }).first().click().catch(() => undefined)
  await win.waitForTimeout(800)
  await shot('a1-agent-on')

  // Режим NYS_DENY_TEST: просим удалить папку вне рабочей и запрещаем — папка должна уцелеть.
  const denyTest = process.env.NYS_DENY_TEST === '1'
  const victim = denyTest ? fs.mkdtempSync(path.join(os.tmpdir(), 'nys-victim-')) : ''
  if (denyTest) fs.writeFileSync(path.join(victim, 'keep.txt'), 'не удалять')
  const box = win.getByLabel('Сообщение')
  await box.fill(
    denyTest
      ? `Удали папку ${victim} целиком командой Remove-Item -Recurse -Force.`
      : 'Создай файл hello.py, который печатает слово Привет, и запусти его командой python hello.py.'
  )
  await box.press('Enter')

  // Ждём завершения ответа (статистика) или подтверждения.
  const deadline = Date.now() + 600_000
  for (;;) {
    if (Date.now() > deadline) throw new Error('агент не закончил за 10 минут')
    const allow = win.getByRole('button', { name: /^(Разрешить|Всё равно разрешить)$/ })
    if (await allow.count()) {
      await shot('a2-approval')
      if (denyTest) {
        console.log('APPROVAL requested — запрещаю')
        await win.getByRole('button', { name: 'Запретить', exact: true }).first().click()
      } else {
        console.log('APPROVAL requested — разрешаю')
        await allow.first().click()
      }
    }
    if (await win.getByText(/ток\/с/).count()) break
    await win.waitForTimeout(1000)
  }
  await win.waitForTimeout(1000)
  await shot('a3-done')

  if (denyTest) console.log('VICTIM SURVIVED:', fs.existsSync(path.join(victim, 'keep.txt')))
  const file = path.join(work, 'hello.py')
  console.log('FILE EXISTS:', fs.existsSync(file), fs.existsSync(file) ? JSON.stringify(fs.readFileSync(file, 'utf8')) : '')
  const cards = await win.locator('text=/Записан файл|Команда|Изменён файл|Прочитан файл/').count()
  console.log('TOOL CARDS:', cards)
  const conv = await win.evaluate(async () => {
    const list = await window.nys.invoke('chat:list')
    return window.nys.invoke('chat:get', list[0].id)
  })
  const v = conv.messages.at(-1).versions.at(-1)
  for (const t of v.turns ?? [])
    for (const c of t.toolCalls)
      console.log('TOOL', c.name, c.status, c.guard ? `${c.guard.by}:${c.guard.level} ${c.guard.reason}` : '', (c.result ?? '').slice(0, 120).replace(/\s+/g, ' '))
  console.log('ERRORS:', JSON.stringify(errors))
  await win.getByRole('button', { name: 'Выгрузить' }).click()
  await app.close()
  fs.rmSync(profile, { recursive: true, force: true })
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
