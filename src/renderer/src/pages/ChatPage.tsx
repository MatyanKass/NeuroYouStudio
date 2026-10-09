import { useEffect } from 'react'
import { ChatList } from '@/components/chat/ChatList'
import { ChatView } from '@/components/chat/ChatView'
import { RightPanel } from '@/components/chat/RightPanel'
import { TopBar } from '@/components/TopBar'
import { initChat } from '@/store/chat'

export function ChatPage(): React.JSX.Element {
  useEffect(() => {
    void initChat()
  }, [])
  return (
    <div className="flex min-h-0 flex-1">
      <ChatList />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <ChatView />
      </div>
      <RightPanel />
    </div>
  )
}
