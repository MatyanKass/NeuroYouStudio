import { useEffect, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { useUi } from './store/ui'
import { initStores } from './store/app'
import { ChatPage } from './pages/ChatPage'
import { ModelsPage } from './pages/ModelsPage'
import { DiscoverPage } from './pages/DiscoverPage'
import { DownloadsPage } from './pages/DownloadsPage'
import { RuntimesPage } from './pages/RuntimesPage'
import { SettingsPage } from './pages/SettingsPage'

export function App(): React.JSX.Element {
  const page = useUi((s) => s.page)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    initStores().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {error && <div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-[13px] text-danger">{error}</div>}
        {page === 'chat' && <ChatPage />}
        {page === 'models' && <ModelsPage />}
        {page === 'discover' && <DiscoverPage />}
        {page === 'downloads' && <DownloadsPage />}
        {page === 'runtimes' && <RuntimesPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
