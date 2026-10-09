# NeuroYouStudio

Аналог LM Studio на Electron + React + TypeScript (интерфейс на русском). Делается для друга
пользователя: целевая машина — RTX 5060 Ti 16 ГБ (Blackwell, sm_120); машина разработки — GTX 1660 6 ГБ
(Turing), без CUDA Toolkit/MSVC/CMake/Rust — движки только готовыми сборками, скачиваются приложением.

## Команды
- `npm run dev` — запуск с HMR; `npm run build` — сборка в `out/`.
- `npm run check` — tsc (node + web) + eslint (`--max-warnings 0`) + vitest. Прогонять перед каждым коммитом.
- `npm run dist` — NSIS-установщик и portable EXE в `release/<версия>/`.
- `node scripts/screenshot.cjs <папка> Чат "Мои модели" …` — скриншоты собранного приложения (Playwright).

## Устройство
- `src/shared/` — контракты: `config.ts` (настройки загрузки/генерации как в LM Studio + `MemoryLayout`),
  `types.ts`, `ipc.ts` (типизированные каналы `IpcInvokeMap`/`IpcEventMap`). Меняйте контракт здесь первым.
- `src/main/` — main-процесс. Регистрация модулей — `modules.ts`; IPC-хелперы `handle`/`emit` — `ipc.ts`.
  - `models/` — парсер GGUF (файл и HTTP Range), EXL3, сканер папки моделей.
  - `memory/planner.ts` — чистая функция раскладки памяти VRAM/RAM по компонентам (профили auto/manual).
  - `engines/` — адаптеры движков, построение аргументов `llama-server`, разбор логов, процесс, менеджер.
  - `runtimes/` — каталог закреплённых сборок движков (URL + SHA256), установка/выбор.
  - `hf/` — поиск/детали Hugging Face, менеджер загрузок с докачкой.
  - `chat/` — диалоги (JSON на диалог), стриминг генерации, политика переполнения контекста.
  - `attachments/` — картинки, извлечение текста pdf/docx, вставка документа целиком или BM25-фрагменты.
- `src/renderer/` — React. Сторы zustand в `store/`, примитивы в `components/ui/`, карта памяти в `components/memory/`.

## Движки
- GGUF, влезает в VRAM → llama.cpp mainline (`win-cuda-13.4` для sm_120, `cuda-12.4` для Turing/старых драйверов).
- GGUF не влезает / MoE с экспертами в RAM → ik_llama.cpp (сборки Thireus). Флаг `-fmoe` не передавать.
- EXL3 → ExLlamaV3 через TabbyAPI (Python 3.12 + torch cu128 через `uv`). Только GPU; на GTX 1660 не проверить.

## Правила
- Строки интерфейса — по-русски, в sentence case; без КАПСА в подписях.
- Цвет в интерфейсе — только у данных (компоненты памяти `--color-mem-*`), акцент (янтарь) — у главных действий.
- Не коммитить модели, сборки движков, архивы, `.env`. Репозиторий приватный (MatyanKass/NeuroYouStudio).
