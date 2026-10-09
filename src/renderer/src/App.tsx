import { Sidebar } from './components/Sidebar'
import { useUi } from './store/ui'

export function App(): React.JSX.Element {
  const page = useUi((s) => s.page)
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="grid flex-1 place-items-center text-fg-muted">Раздел: {page}</div>
      </main>
    </div>
  )
}
