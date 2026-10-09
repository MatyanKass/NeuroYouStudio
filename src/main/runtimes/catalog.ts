// Каталог закреплённых сборок движков (вкладка «Движки»). Чистый модуль, без electron.
// SHA256 и размеры взяты из GitHub Releases (assets[].digest).
import type { EngineId } from '@shared/config'
import type { GpuInfo, HardwareInfo } from '@shared/types'

export interface RuntimeFile {
  name: string
  url: string
  sha256: string
  size: number
}

/** Какие CUDA-архитектуры зашиты в сборку (см. ggml-cuda CMakeLists). */
export interface CudaBuild {
  /** Версия CUDA Toolkit, которой собрано: "12.4", "13.4". */
  version: string
  /** Готовый машинный код (SASS): "86", "89", "120a" (суффикс a — только точная архитектура). */
  sass: string[]
  /** PTX (JIT-компиляция драйвером при первом запуске): 75, 80, 90… */
  ptx: number[]
  /** Минимальный драйвер Windows для запуска SASS (minor version compatibility). */
  minDriverSass: number
}

export type RuntimeBackend = 'cuda' | 'cpu' | 'vulkan'
export type CpuFlag = 'avx2' | 'avx512'

export interface RuntimeCatalogEntry {
  id: string
  engine: EngineId
  version: string
  variant: string
  backend: RuntimeBackend
  title: string
  description: string
  files: RuntimeFile[]
  cuda?: CudaBuild
  cpuFlags?: CpuFlag[]
  serverExe: string
  /** Способ установки: zip-архивы (по умолчанию) или Python-окружение TabbyAPI через uv. */
  installer?: 'zip' | 'tabby'
  /** Примерный объём загрузки, если файлы заранее неизвестны (pip-пакеты). */
  estimatedBytes?: number
  /** Минимальная compute capability GPU (×10): 80 = Ampere. */
  minCc?: number
}

const LLAMA_TAG = 'b11538'
const LLAMA_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/`
const IK_TAG = 'main-b5418-b210651'
const IK_BASE = `https://github.com/Thireus/ik_llama.cpp/releases/download/${IK_TAG}/`

const f = (base: string, name: string, size: number, sha256: string): RuntimeFile => ({
  name,
  url: base + name,
  size,
  sha256
})

// Наборы архитектур по умолчанию (CMAKE_CUDA_ARCHITECTURES не задан в release-workflow).
const LLAMA_CUDA12: CudaBuild = { version: '12.4', sass: ['86', '89'], ptx: [50, 61, 70, 75, 80, 90], minDriverSass: 527.41 }
const LLAMA_CUDA13: CudaBuild = { version: '13.4', sass: ['86', '89', '120a', '121a'], ptx: [75, 80, 90], minDriverSass: 580 }
const IK_CUDA12: CudaBuild = { version: '12.8', sass: ['86', '89', '120a'], ptx: [50, 61, 70, 75, 80], minDriverSass: 527.41 }
const IK_CUDA13: CudaBuild = { version: '13.3', sass: ['86', '89', '120a', '121a'], ptx: [75, 80], minDriverSass: 580 }

const IK_CUDART12 = (flavor: string): RuntimeFile =>
  f(IK_BASE, `ik_llama-cudart-${IK_TAG}-bin-win-cuda-12.8-x64-${flavor}.zip`, 563452046,
    '77723c83430f7524fbc53f1dbadea5ee73c9c51459817b71654d4939a8640d1a')
const IK_CUDART13 = (flavor: string): RuntimeFile =>
  f(IK_BASE, `ik_llama-cudart-${IK_TAG}-bin-win-cuda-13.3-x64-${flavor}.zip`, 390970417,
    '1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e')

export const RUNTIME_CATALOG: RuntimeCatalogEntry[] = [
  {
    id: `llamacpp-${LLAMA_TAG}-cuda13.4`,
    engine: 'llamacpp',
    version: LLAMA_TAG,
    variant: 'CUDA 13.4',
    backend: 'cuda',
    title: 'llama.cpp b11538, CUDA 13.4',
    description: 'Для RTX 50xx (Blackwell): готовый код под sm_120. Нужен драйвер NVIDIA R580 или новее.',
    files: [
      f(LLAMA_BASE, `llama-${LLAMA_TAG}-bin-win-cuda-13.4-x64.zip`, 153459410,
        'a18a1585f788d43665af09d1b037615c79d70f827c46c46c5d90390fa7b3616a'),
      f(LLAMA_BASE, 'cudart-llama-bin-win-cuda-13.4-x64.zip', 423535356,
        '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668')
    ],
    cuda: LLAMA_CUDA13,
    serverExe: 'llama-server.exe'
  },
  {
    id: `llamacpp-${LLAMA_TAG}-cuda12.4`,
    engine: 'llamacpp',
    version: LLAMA_TAG,
    variant: 'CUDA 12.4',
    backend: 'cuda',
    title: 'llama.cpp b11538, CUDA 12.4',
    description: 'Для GTX 16xx / RTX 20xx–40xx и более старых драйверов (от 551.61).',
    files: [
      f(LLAMA_BASE, `llama-${LLAMA_TAG}-bin-win-cuda-12.4-x64.zip`, 265219217,
        '631c1397231497dabcdd1eb21ae43ad235093c22c88cc64f09ac3be67285cd6e'),
      f(LLAMA_BASE, 'cudart-llama-bin-win-cuda-12.4-x64.zip', 391443627,
        '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6')
    ],
    cuda: LLAMA_CUDA12,
    serverExe: 'llama-server.exe'
  },
  {
    id: `llamacpp-${LLAMA_TAG}-vulkan`,
    engine: 'llamacpp',
    version: LLAMA_TAG,
    variant: 'Vulkan',
    backend: 'vulkan',
    title: 'llama.cpp b11538, Vulkan',
    description: 'Универсальная GPU-сборка (NVIDIA/AMD/Intel). Обычно медленнее CUDA.',
    files: [
      f(LLAMA_BASE, `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`, 33459184,
        '621ec0ed653ec9d40673be866558d2675eb54907ee4255ecfeb2739f2a6dccf5')
    ],
    serverExe: 'llama-server.exe'
  },
  {
    id: `llamacpp-${LLAMA_TAG}-cpu`,
    engine: 'llamacpp',
    version: LLAMA_TAG,
    variant: 'CPU',
    backend: 'cpu',
    title: 'llama.cpp b11538, только процессор',
    description: 'Только процессор, без видеокарты.',
    files: [
      f(LLAMA_BASE, `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`, 19513109,
        '8d27ba71dfb5c2f0733a048dfe3eea3edc0e31d7b831a25d3610c3db81dc0bec')
    ],
    serverExe: 'llama-server.exe'
  },
  {
    id: 'ikllama-b5418-cuda13.3-avx512',
    engine: 'ikllama',
    version: IK_TAG,
    variant: 'CUDA 13.3, AVX-512',
    backend: 'cuda',
    title: 'ik_llama.cpp b5418, CUDA 13.3, AVX-512',
    description: 'Для RTX 50xx и процессоров с AVX-512. Быстрее при частичной выгрузке в RAM (MoE).',
    files: [
      f(IK_BASE, `ik_llama-${IK_TAG}-bin-win-cuda-13.3-x64-avx512.zip`, 813570576,
        '0287ee8890dfcb90ac729c610549f51cdda36ecd576f427f45d2e8c2567999de'),
      IK_CUDART13('avx512')
    ],
    cuda: IK_CUDA13,
    cpuFlags: ['avx2', 'avx512'],
    serverExe: 'llama-server.exe'
  },
  {
    id: 'ikllama-b5418-cuda13.3-avx2',
    engine: 'ikllama',
    version: IK_TAG,
    variant: 'CUDA 13.3, AVX2',
    backend: 'cuda',
    title: 'ik_llama.cpp b5418, CUDA 13.3, AVX2',
    description: 'Для RTX 50xx. Быстрее при частичной выгрузке в RAM (MoE).',
    files: [
      f(IK_BASE, `ik_llama-${IK_TAG}-bin-win-cuda-13.3-x64-avx2.zip`, 813700793,
        'e85257f74847255390a4b6731e0d21dc7b05a5db86d8c42c8ddb1bfb72bb69f0'),
      IK_CUDART13('avx2')
    ],
    cuda: IK_CUDA13,
    cpuFlags: ['avx2'],
    serverExe: 'llama-server.exe'
  },
  {
    id: 'ikllama-b5418-cuda12.8-avx512',
    engine: 'ikllama',
    version: IK_TAG,
    variant: 'CUDA 12.8, AVX-512',
    backend: 'cuda',
    title: 'ik_llama.cpp b5418, CUDA 12.8, AVX-512',
    description: 'Для GTX 16xx / RTX 20xx–40xx и процессоров с AVX-512.',
    files: [
      f(IK_BASE, `ik_llama-${IK_TAG}-bin-win-cuda-12.8-x64-avx512.zip`, 760941759,
        'f6580944aefe99813d0edf21e757e0dd28ee9d3e32a55e6ac55dd1841cf27eb6'),
      IK_CUDART12('avx512')
    ],
    cuda: IK_CUDA12,
    cpuFlags: ['avx2', 'avx512'],
    serverExe: 'llama-server.exe'
  },
  {
    id: 'ikllama-b5418-cuda12.8-avx2',
    engine: 'ikllama',
    version: IK_TAG,
    variant: 'CUDA 12.8, AVX2',
    backend: 'cuda',
    title: 'ik_llama.cpp b5418, CUDA 12.8, AVX2',
    description: 'Для GTX 16xx / RTX 20xx–40xx.',
    files: [
      f(IK_BASE, `ik_llama-${IK_TAG}-bin-win-cuda-12.8-x64-avx2.zip`, 761065197,
        '53c0e7eedf432b55d1fabccdb9a9e8b7c17b5ff886214a795f8f2955c9d26988'),
      IK_CUDART12('avx2')
    ],
    cuda: IK_CUDA12,
    cpuFlags: ['avx2'],
    serverExe: 'llama-server.exe'
  },
  {
    id: 'ikllama-b5418-cpu-avx512',
    engine: 'ikllama',
    version: IK_TAG,
    variant: 'CPU, AVX-512',
    backend: 'cpu',
    title: 'ik_llama.cpp b5418, процессор с AVX-512',
    description: 'Только процессор с AVX-512.',
    files: [
      f(IK_BASE, `ik_llama-${IK_TAG}-bin-win-cpu-x64-avx512.zip`, 31317050,
        '95f8b6c8a26e4eb583584fdd4037cb65253d71fc217e139186df1bafdbfe3eeb')
    ],
    cpuFlags: ['avx2', 'avx512'],
    serverExe: 'llama-server.exe'
  },
  {
    id: 'ikllama-b5418-cpu-avx2',
    engine: 'ikllama',
    version: IK_TAG,
    variant: 'CPU, AVX2',
    backend: 'cpu',
    title: 'ik_llama.cpp b5418, процессор с AVX2',
    description: 'Только процессор.',
    files: [
      f(IK_BASE, `ik_llama-${IK_TAG}-bin-win-cpu-x64-avx2.zip`, 31445398,
        'b45baeb7a883f870c722738add923e000f4945a8783fb0d007b583efc71ce3d0')
    ],
    cpuFlags: ['avx2'],
    serverExe: 'llama-server.exe'
  },
  {
    id: 'exl3-tabbyapi-884e88c-cu128',
    engine: 'exl3',
    version: 'exllamav3 1.6.0',
    variant: 'CUDA 12.8',
    backend: 'cuda',
    title: 'ExLlamaV3 1.6.0 (TabbyAPI), CUDA 12.8',
    description:
      'Модели EXL3 целиком в видеопамяти: быстрый разбор длинных промптов и лучшее качество на бит. ' +
      'Ставит Python 3.12, PyTorch и ExLlamaV3 в папку приложения (около 3,5 ГБ загрузки, 6 ГБ на диске). Нужна RTX 30xx или новее.',
    files: [],
    installer: 'tabby',
    estimatedBytes: 3_600_000_000,
    minCc: 80,
    // exllamav3 собран с TORCH_CUDA_ARCH_LIST 7.5…12.0+PTX; torch cu128 требует драйвер R570+.
    cuda: { version: '12.8', sass: ['80', '86', '89', '90', '100', '120'], ptx: [120], minDriverSass: 570 },
    serverExe: 'venv/Scripts/python.exe'
  }
]

export function catalogEntry(id: string): RuntimeCatalogEntry | undefined {
  return RUNTIME_CATALOG.find((e) => e.id === id)
}

// ---------- Совместимость ----------

/** "7.5" → 75, "12.0" → 120. */
export function ccToInt(cc: string): number {
  const [maj, min] = cc.split('.')
  const a = Number(maj)
  const b = Number(min ?? 0)
  return Number.isFinite(a) && Number.isFinite(b) ? a * 10 + b : 0
}

const versionNum = (v: string): number => {
  const [a, b] = v.split('.')
  return Number(a ?? 0) + Number(b ?? 0) / 100
}

/** Драйвер Windows → максимальная версия CUDA (если nvidia-smi не сообщил её сам). */
export function driverCudaVersion(driver: string): string {
  const d = Number.parseFloat(driver)
  const table: Array<[number, string]> = [
    [615, '13.4'], [610, '13.3'], [595, '13.2'], [590, '13.1'], [580, '13.0'],
    [575, '12.9'], [570, '12.8'], [560, '12.6'], [555, '12.5'], [551.61, '12.4'],
    [545, '12.3'], [535, '12.2'], [530, '12.1'], [527.41, '12.0']
  ]
  for (const [min, v] of table) if (d >= min) return v
  return '11.0'
}

function sassCovers(sass: string, cc: number): boolean {
  const exact = sass.endsWith('a') || sass.endsWith('f')
  const arch = Number.parseInt(sass, 10)
  if (exact) return arch === cc
  // SASS совместим в пределах мажорной версии вверх по минорной (8.6 → 8.9).
  return Math.floor(arch / 10) === Math.floor(cc / 10) && arch <= cc
}

export interface RuntimeFit {
  compatible: boolean
  reason?: string
  /** Чем больше, тем лучше подходит (для выбора рекомендуемого). -1 = несовместим. */
  score: number
  /** Нужна JIT-компиляция PTX при первом запуске (долго). */
  jit?: boolean
}

function weakestGpu(gpus: GpuInfo[]): GpuInfo | undefined {
  return [...gpus].sort((a, b) => ccToInt(a.computeCap) - ccToInt(b.computeCap))[0]
}

export function evaluateRuntime(
  entry: RuntimeCatalogEntry,
  hw: HardwareInfo,
  platform: NodeJS.Platform = process.platform
): RuntimeFit {
  if (platform !== 'win32') {
    return { compatible: false, reason: 'Сборки рассчитаны на Windows x64', score: -1 }
  }
  if (entry.cpuFlags?.includes('avx512') && !hw.avx512) {
    return { compatible: false, reason: 'Процессор не поддерживает AVX-512', score: -1 }
  }
  if (entry.cpuFlags?.includes('avx2') && !hw.avx2) {
    return { compatible: false, reason: 'Процессор не поддерживает AVX2', score: -1 }
  }
  // Сборка под AVX-512 на AVX-512-процессоре чуть предпочтительнее.
  const cpuBonus = entry.cpuFlags?.includes('avx512') ? 0.5 : 0

  if (entry.backend === 'cpu') return { compatible: true, score: 1 + cpuBonus }
  if (entry.backend === 'vulkan') return { compatible: true, score: hw.gpus.length > 0 ? 2 : 0.5 }

  const cuda = entry.cuda
  const gpu = weakestGpu(hw.gpus)
  if (!cuda || !gpu) return { compatible: false, reason: 'Нужна видеокарта NVIDIA', score: -1 }

  const cc = ccToInt(gpu.computeCap)
  if (entry.minCc && cc < entry.minCc) {
    return {
      compatible: false,
      reason: `Нужна видеокарта NVIDIA RTX 30xx или новее (у ${gpu.name} sm_${cc})`,
      score: -1
    }
  }
  const driver = Number.parseFloat(gpu.driverVersion) || 0
  const driverCuda = versionNum(hw.cudaVersion ?? driverCudaVersion(gpu.driverVersion))
  const buildCuda = versionNum(cuda.version)
  const major = Math.floor(buildCuda)
  // Предпочтение: Blackwell (12.x) → CUDA 13, остальные → CUDA 12.
  const preferred = cc >= 120 ? major >= 13 : major === 12

  if (cuda.sass.some((s) => sassCovers(s, cc))) {
    if (driver < cuda.minDriverSass) {
      return {
        compatible: false,
        reason: `Нужен драйвер NVIDIA ${cuda.minDriverSass} или новее (установлен ${gpu.driverVersion})`,
        score: -1
      }
    }
    return { compatible: true, score: 10 + (preferred ? 5 : 0) + cpuBonus }
  }
  if (cuda.ptx.some((p) => p <= cc)) {
    if (driverCuda < buildCuda) {
      return {
        compatible: false,
        reason: `Для ${gpu.name} (sm_${cc}) нужна JIT-компиляция, а драйвер поддерживает только CUDA ${hw.cudaVersion ?? driverCudaVersion(gpu.driverVersion)} — обновите драйвер NVIDIA или выберите сборку CUDA 12`,
        score: -1
      }
    }
    return { compatible: true, score: 6 + (preferred ? 5 : 0) + cpuBonus, jit: true }
  }
  return { compatible: false, reason: `Видеокарта ${gpu.name} (sm_${cc}) не поддерживается этой сборкой`, score: -1 }
}

/** id лучших совместимых сборок по каждому движку. */
export function recommendedRuntimeIds(
  hw: HardwareInfo,
  catalog = RUNTIME_CATALOG,
  platform: NodeJS.Platform = process.platform
): Set<string> {
  const best = new Map<EngineId, { id: string; score: number }>()
  for (const e of catalog) {
    const fit = evaluateRuntime(e, hw, platform)
    if (!fit.compatible) continue
    const cur = best.get(e.engine)
    if (!cur || fit.score > cur.score) best.set(e.engine, { id: e.id, score: fit.score })
  }
  return new Set([...best.values()].map((b) => b.id))
}
