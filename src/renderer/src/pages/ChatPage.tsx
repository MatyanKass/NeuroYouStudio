import { useEffect } from 'react'
import { ChatList } from '@/components/chat/ChatList'
import { ChatView } from '@/components/chat/ChatView'
import { RightPanel } from '@/components/chat/RightPanel'
import { TopBar } from '@/components/TopBar'
import { useMediaQuery, WIDE_QUERY } from '@/lib/media'
import { initChat } from '@/store/chat'
import { useUi } from '@/store/ui'

export function ChatPage(): React.JSX.Element {
  const wide = useMediaQuery(WIDE_QUERY)
  const listOpen = useUi((s) => s.chatListOpen)
  const drawer = useUi((s) => s.chatDrawer)
  const setDrawer = useUi((s) => s.setChatDrawer)

  useEffect(() => {
    void initChat()
  }, [])

  // В узком окне список чатов выезжает поверх диалога; Esc и клик мимо закрывают его.
  useEffect(() => {
    if (wide || !drawer) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide, drawer, setDrawer])

  return (
    <div className="relative flex min-h-0 flex-1">
      {wide && listOpen && <ChatList />}
      {!wide && drawer && (
        <>
          <div className="absolute inset-0 z-20 bg-black/40" onClick={() => setDrawer(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 z-30 flex shadow-[8px_0_32px_rgba(0,0,0,0.35)]">
            <ChatList onPicked={() => setDrawer(false)} />
          </div>
        </>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <ChatView />
      </div>
      <RightPanel />
    </div>
  )
}
