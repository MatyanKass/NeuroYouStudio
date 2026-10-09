import type { NysApi } from '../shared/ipc'

declare global {
  interface Window {
    nys: NysApi
  }
}

export {}
