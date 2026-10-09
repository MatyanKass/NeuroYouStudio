import { create } from 'zustand'

export type PageId = 'chat' | 'models' | 'discover' | 'downloads' | 'runtimes' | 'settings'

interface UiState {
  page: PageId
  setPage: (p: PageId) => void
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page })
}))
