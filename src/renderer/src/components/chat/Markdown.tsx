import { Check, Copy } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { HighlighterCore } from 'shiki/core'
import { useSettings } from '@/store/app'

// Подсветка кода: shiki с JS-движком регулярок (без WASM), языки грузятся по требованию.

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Set<string>()

const ALIASES: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  'c++': 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  jsonc: 'json',
  luau: 'lua',
  text: 'plaintext',
  txt: 'plaintext'
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript')
      ])
      return createHighlighterCore({
        themes: [import('shiki/themes/github-dark-default.mjs'), import('shiki/themes/github-light-default.mjs')],
        langs: [],
        engine: createJavaScriptRegexEngine()
      })
    })()
  }
  return highlighterPromise
}

async function highlight(code: string, langRaw: string, dark: boolean): Promise<string | null> {
  const lang = ALIASES[langRaw] ?? langRaw
  if (!lang || lang === 'plaintext') return null
  const h = await getHighlighter()
  if (!loadedLangs.has(lang)) {
    const { bundledLanguages } = await import('shiki/langs')
    const loader = (bundledLanguages as Record<string, unknown>)[lang]
    if (!loader) return null
    await h.loadLanguage(loader as Parameters<HighlighterCore['loadLanguage']>[0])
    loadedLangs.add(lang)
  }
  return h.codeToHtml(code, { lang, theme: dark ? 'github-dark-default' : 'github-light-default' })
}

function CodeBlock({ code, lang }: { code: string; lang: string }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Тема входит в зависимости: после переключения светлая/тёмная блок кода перекрашивается.
  const theme = useSettings((s) => s.settings?.theme)
  useEffect(() => {
    let alive = true
    // Во время стриминга не подсвечиваем на каждый токен.
    const t = setTimeout(() => {
      const dark = document.documentElement.dataset.theme !== 'light'
      highlight(code, lang, dark)
        .then((h) => alive && setHtml(h))
        .catch(() => alive && setHtml(null))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [code, lang, theme])

  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="my-3 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel-2">
      <div className="flex items-center justify-between border-b border-line px-3 py-1 text-[12px] text-fg-faint">
        <span>{lang || 'текст'}</span>
        <button onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-raised hover:text-fg">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="shiki m-0 overflow-x-auto px-4 py-3 font-mono text-[0.86em] leading-[1.55]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const m = /language-([\w+#-]+)/.exec(className ?? '')
    const text = String(children ?? '')
    // Блок кода — если указан язык или есть перевод строки.
    if (m || text.includes('\n')) {
      return <CodeBlock code={text.replace(/\n$/, '')} lang={(m?.[1] ?? '').toLowerCase()} />
    }
    return <code>{children}</code>
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

/** LaTeX в стиле \( \) и \[ \] → $ $ и $$ $$ (модели часто пишут так). */
function normalizeMath(src: string): string {
  return src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$${inner}$`)
}

export const Markdown = memo(function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  )
})
