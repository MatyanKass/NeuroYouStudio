// Сквозной обход интерфейса собранного приложения (npx electron-vite build) в отдельном профиле:
// все разделы, выбор модели, вкладки правой панели, память авто/вручную, сохранение настройки генерации
// после перезагрузки окна, чаты (создать/переименовать/удалить), ответ, перегенерация, правка, ветка,
// вложение .txt, светлая тема. Скриншоты при 1440×900 и 1000×640.
// node scripts/e2e-ui.cjs <папка для скриншотов вне репозитория> [часть имени модели]
/* global document, window */
const { _electron } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const out = path.resolve(process.argv[2] || '.')
const modelPart = process.argv[3] || 'Qwen3-0.6B'
const PAGES = ['Чат', 'Мои модели', 'Поиск', 'Загрузки', 'Движки', 'Настройки']
const SIZES = [
  [1440, 900],
  [1000, 640]
]

let step = 0
const log = (...a) => console.log(`[${String(++step).padStart(2, '0')}]`, ...a)
const fail = (msg) => {
  throw new Error(msg)
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const profile = fs.mkdtempSync(path.join(out, 'profile-'))
  const app = await _electron.launch({ args: [path.resolve(__dirname, '..'), `--user-data-dir=${profile}`] })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  const resize = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
    // Ждём, пока страница увидит новую ширину (медиазапросы и раскладка).
    await win.waitForFunction((w) => Math.abs(window.outerWidth - w) < 40, w)
    await win.waitForTimeout(300)
  }
  const shot = async (name) => {
    await win.waitForTimeout(250)
    await win.screenshot({ path: path.join(out, `${name}.png`) })
  }
  const nav = (title) => win.locator(`nav button[title="${title}"]`).click()
  const tab = (name) => win.getByRole('tab', { name, exact: true }).click()
  const messages = () => win.getByTestId('message')
  const waitStats = async (n) => {
    await win.waitForFunction((n) => document.querySelectorAll('[data-testid="msg-stats"]').length >= n, n, {
      timeout: 300_000
    })
    // Генерация закончилась — composer снова показывает «Отправить».
    await win.getByRole('button', { name: 'Отправить', exact: true }).waitFor({ timeout: 60_000 })
  }
  const lastAnswer = async () => (await messages().filter({ has: win.locator('.md') }).last().locator('.md').innerText()).trim()
  const msgButton = (msg, label) => msg.getByRole('button', { name: label, exact: true })

  await win.waitForLoadState('domcontentloaded')
  await win.getByTestId('model-picker').waitFor()
  await win.waitForTimeout(1500)

  // 1. Все разделы в двух размерах окна.
  for (const [w, h] of SIZES) {
    await resize(w, h)
    for (const p of PAGES) {
      await nav(p)
      await win.waitForTimeout(700)
      await shot(`page-${w}-${p}`)
    }
  }
  await resize(1440, 900)
  await nav('Чат')
  log('разделы сняты')

  // 2. Выбор модели.
  await win.getByTestId('model-picker').click()
  await win.getByTestId('model-option').first().waitFor()
  await shot('chat-picker-open')
  const option = win.getByTestId('model-option').filter({ hasText: modelPart }).first()
  if (!(await option.count())) fail(`Модель «${modelPart}» не найдена в списке`)
  await option.click()
  await win.waitForTimeout(1200)
  log('модель выбрана')

  // 3. Вкладки правой панели.
  for (const t of ['Генерация', 'Загрузка', 'Память']) {
    await tab(t)
    const sel = await win.getByRole('tab', { name: t, exact: true }).getAttribute('aria-selected')
    if (sel !== 'true') fail(`вкладка ${t} не выбрана`)
    await shot(`panel-${t}`)
  }
  log('вкладки переключаются')

  // 4. Память: вручную ↔ авто, профиль.
  await win.getByRole('button', { name: 'Вручную', exact: true }).click()
  await win.getByRole('slider', { name: 'Слоёв на GPU' }).waitFor()
  if ((await win.getByRole('button', { name: 'Вручную', exact: true }).getAttribute('aria-pressed')) !== 'true')
    fail('«Вручную» не нажата')
  await shot('memory-manual')
  await win.getByRole('button', { name: 'Автоподбор', exact: true }).click()
  await win.getByRole('radio', { name: /Экономия видеопамяти/ }).click()
  await win.waitForTimeout(800)
  if ((await win.getByRole('radio', { name: /Экономия видеопамяти/ }).getAttribute('aria-checked')) !== 'true')
    fail('профиль не выбран')
  await shot('memory-profile-saveVram')
  await win.getByRole('radio', { name: /Максимальная скорость/ }).click()
  log('память: авто/вручную и профиль')

  // 5. Настройка генерации переживает перезагрузку окна.
  await tab('Генерация')
  const temp = win.getByRole('textbox', { name: 'Температура' })
  await temp.fill('0.35')
  await temp.press('Enter')
  // Рассуждения выключаем: маленькой модели так быстрее и предсказуемее.
  await win.getByRole('button', { name: 'Рассуждения', exact: true }).click()
  const think = win.getByRole('switch', { name: 'Разрешить рассуждения' })
  if ((await think.getAttribute('aria-checked')) === 'true') await think.click()
  await win.waitForTimeout(1000)
  await win.reload()
  await win.getByTestId('model-picker').waitFor()
  await win.waitForTimeout(1500)
  await tab('Генерация')
  const tempAfter = await win.getByRole('textbox', { name: 'Температура' }).inputValue()
  if (tempAfter !== '0.35') fail(`температура после перезагрузки: ${tempAfter}`)
  await win.getByRole('button', { name: 'Рассуждения', exact: true }).click()
  if ((await win.getByRole('switch', { name: 'Разрешить рассуждения' }).getAttribute('aria-checked')) !== 'false')
    fail('выключатель рассуждений не сохранился')
  log('температура 0.35 и рассуждения сохранились после перезагрузки')

  // 6. Отправка без модели блокируется.
  await win.getByRole('button', { name: 'Новый чат', exact: true }).click()
  const box = win.getByRole('textbox', { name: 'Сообщение' })
  await box.fill('Без модели')
  await box.press('Enter')
  await win.getByText('Сначала загрузите модель', { exact: false }).first().waitFor({ timeout: 5000 })
  if ((await messages().count()) !== 0) fail('сообщение ушло без загруженной модели')
  await shot('chat-send-without-model')
  await win.getByRole('button', { name: 'Закрыть сообщение об ошибке' }).click()
  await box.fill('')
  log('отправка без модели заблокирована')

  // 7. Загрузка модели.
  await win.getByRole('button', { name: 'Загрузить', exact: true }).click()
  await win.getByRole('button', { name: 'Выгрузить' }).waitFor({ timeout: 300_000 })
  await win.waitForTimeout(1000)
  await tab('Память')
  await shot('chat-loaded')
  log('модель загружена')

  // 8. Ответ, перегенерация, версии.
  await box.fill('Сколько будет 2+2? Ответь одним числом.')
  await box.press('Enter')
  await waitStats(1)
  log('ответ:', await lastAnswer())
  const answer = messages().filter({ has: win.locator('.md') }).last()
  await answer.hover()
  await msgButton(answer, 'Перегенерировать').click()
  await win.getByText('2 / 2', { exact: true }).waitFor({ timeout: 300_000 })
  await waitStats(1)
  await shot('chat-regenerated')
  await msgButton(answer, 'Предыдущая версия').click()
  await win.getByText('1 / 2', { exact: true }).waitFor()
  log('перегенерация: версии 1 / 2 и 2 / 2')

  // 9. Правка вопроса с повторной отправкой.
  const userMsg = win.locator('[data-testid="message"][data-role="user"]').last()
  await userMsg.hover()
  await msgButton(userMsg, 'Изменить').click()
  await win.getByRole('textbox', { name: 'Текст сообщения' }).fill('Сколько будет 3+3? Ответь одним числом.')
  await win.getByRole('button', { name: 'Сохранить и отправить', exact: true }).click()
  await win.waitForTimeout(500)
  await waitStats(1)
  const edited = await lastAnswer()
  log('после правки:', edited)
  if ((await messages().count()) !== 2) fail(`после правки сообщений ${await messages().count()}, ожидалось 2`)
  if (await win.getByText('2 / 2', { exact: true }).count()) fail('после правки остались версии старого ответа')
  await shot('chat-edited')

  // 10. Ветка.
  const chatsBefore = await win.getByTestId('chat-item').count()
  const answer2 = messages().last()
  await answer2.hover()
  await msgButton(answer2, 'Ветка: новый чат до этого сообщения').click()
  await win.getByTestId('chat-item').filter({ hasText: '(ветка)' }).first().waitFor()
  if ((await win.getByTestId('chat-item').count()) !== chatsBefore + 1) fail('ветка не создала чат')
  const current = win.locator('[data-testid="chat-item"][aria-current="true"]')
  if (!(await current.innerText()).includes('(ветка)')) fail('ветка не открылась')
  log('ветка создана и открыта')

  // 11. Переименование и удаление чата.
  await current.hover()
  await current.getByRole('button', { name: 'Переименовать' }).click()
  const title = win.getByRole('textbox', { name: 'Название чата' })
  await title.fill('Проверочный чат')
  await title.press('Enter')
  await win.getByTestId('chat-item').filter({ hasText: 'Проверочный чат' }).waitFor()
  await shot('chat-renamed')
  const renamed = win.getByTestId('chat-item').filter({ hasText: 'Проверочный чат' })
  await renamed.hover()
  await renamed.getByRole('button', { name: 'Удалить' }).click()
  await renamed.getByRole('button', { name: 'Удалить?' }).click()
  await win.waitForFunction(
    () => ![...document.querySelectorAll('[data-testid="chat-item"]')].some((e) => e.textContent.includes('Проверочный чат')),
    null,
    { timeout: 10_000 }
  )
  if ((await win.getByTestId('chat-item').count()) !== chatsBefore) fail('чат не удалился')
  log('чат переименован и удалён')

  // 12b. Действия с диалогом во время генерации: правка заблокирована, переключение туда-обратно,
  // переименование и удаление не воскрешают диалог после конца стрима.
  await win.getByRole('button', { name: 'Новый чат', exact: true }).click()
  await box.fill('Напиши длинный рассказ о море, не меньше 400 слов.')
  await box.press('Enter')
  await win.getByRole('button', { name: 'Остановить генерацию' }).waitFor()
  const streamUser = win.locator('[data-testid="message"][data-role="user"]').last()
  if (!(await msgButton(streamUser, 'Изменить').isDisabled())) fail('правка во время генерации не заблокирована')
  await win.getByTestId('chat-item').filter({ hasText: 'Сколько будет' }).first().click()
  await win.waitForTimeout(700)
  await win.getByTestId('chat-item').filter({ hasText: 'Напиши длинный' }).first().click()
  await win.waitForTimeout(700)
  await shot('chat-streaming')
  const streaming = win.locator('[data-testid="chat-item"][aria-current="true"]')
  await streaming.hover()
  await streaming.getByRole('button', { name: 'Переименовать' }).click()
  await win.getByRole('textbox', { name: 'Название чата' }).fill('Морской рассказ')
  await win.getByRole('textbox', { name: 'Название чата' }).press('Enter')
  const sea = win.getByTestId('chat-item').filter({ hasText: 'Морской рассказ' })
  await sea.hover()
  await sea.getByRole('button', { name: 'Удалить' }).click()
  await sea.getByRole('button', { name: 'Удалить?' }).click()
  await win.getByRole('button', { name: 'Отправить', exact: true }).waitFor({ timeout: 60_000 })
  await win.waitForTimeout(2000)
  const left = await win.getByTestId('chat-item').allInnerTexts()
  if (left.some((t) => /Морской рассказ|Напиши длинный/.test(t))) fail(`удалённый во время генерации чат вернулся: ${left}`)
  log('во время генерации: правка заблокирована, удалённый чат не воскрес')

  // 12. Вложение .txt (диалог выбора файлов подменяем в main).
  const txt = path.join(out, 'code-word.txt')
  fs.writeFileSync(txt, 'Служебная заметка.\nКодовое слово для проверки: ФИАЛКА.\nКонец заметки.\n', 'utf8')
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, txt)
  await win.getByRole('button', { name: 'Новый чат', exact: true }).click()
  await win.getByRole('button', { name: 'Прикрепить файлы или изображения' }).click()
  await win.getByText('code-word.txt').first().waitFor()
  await box.fill('Какое кодовое слово указано в прикреплённом файле? Ответь одним словом.')
  await box.press('Enter')
  await waitStats(1)
  const fileAnswer = await lastAnswer()
  log('ответ по файлу:', fileAnswer)
  if (!/фиалк/i.test(fileAnswer)) fail('ответ не ссылается на содержимое файла')
  await shot('chat-attachment')

  // 13. Узкое окно: список чатов прячется и выезжает по кнопке.
  await resize(1000, 640)
  if (await win.getByTestId('chat-item').count()) fail('в узком окне список чатов не спрятан')
  await win.getByRole('button', { name: 'Показать список чатов' }).click()
  await win.getByTestId('chat-item').first().waitFor()
  await shot('chat-1000-drawer')
  await win.getByTestId('chat-item').filter({ hasText: 'Сколько будет' }).first().click()
  await win.waitForFunction(() => !document.querySelector('[data-testid="chat-item"]'))
  await win.waitForTimeout(300)
  await shot('chat-1000-other-chat')
  await win.getByRole('button', { name: 'Показать список чатов' }).click()
  await win.getByTestId('chat-item').filter({ hasText: 'кодовое слово' }).first().click()
  log('узкое окно: список чатов в выезжающей панели')
  for (const t of ['Генерация', 'Загрузка', 'Память']) {
    await tab(t)
    await shot(`chat-1000-${t}`)
  }
  const overflow = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 0) fail(`горизонтальное переполнение ${overflow}px при 1000×640`)
  await resize(1440, 900)

  // 14. Светлая тема и обратно.
  await nav('Настройки')
  await win.getByRole('radio', { name: 'Светлая', exact: true }).click()
  await win.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  for (const p of PAGES) {
    await nav(p)
    await win.waitForTimeout(600)
    await shot(`light-${p}`)
  }
  await nav('Чат')
  await tab('Память')
  await shot('light-chat-memory')
  await nav('Настройки')
  await win.getByRole('radio', { name: 'Тёмная', exact: true }).click()
  await win.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  log('тема: светлая и обратно')

  await nav('Чат')
  await win.getByRole('button', { name: 'Выгрузить' }).click()
  await win.getByRole('button', { name: 'Загрузить', exact: true }).waitFor({ timeout: 60_000 })
  await app.close()

  const real = errors.filter((e) => !/Autofill\./.test(e))
  console.log('ERRORS:', JSON.stringify(real))
  if (real.length) process.exit(1)
  console.log('OK')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
