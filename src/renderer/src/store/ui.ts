import { create } from 'zustand'

export type PageId = 'chat' | 'models' | 'discover' | 'downloads' | 'runtimes' | 'settings'

interface UiState {
  page: PageId
  setPage: (p: PageId) => void
  /** Список чатов в широком окне (колонка слева). */
  chatListOpen: boolean
  /** Список чатов в узком окне (выезжает поверх диалога). */
  chatDrawer: boolean
  setChatListOpen: (v: boolean) => void
  setChatDrawer: (v: boolean) => void
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page }),
  chatListOpen: true,
  chatDrawer: false,
  setChatListOpen: (chatListOpen) => set({ chatListOpen }),
  setChatDrawer: (chatDrawer) => set({ chatDrawer })
}))
