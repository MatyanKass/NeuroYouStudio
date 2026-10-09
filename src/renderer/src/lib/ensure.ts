// Страницам нужны настройки и сведения о железе. Обычно их загружает initStores при старте;
// если он не успел или упал, страница дозагружает их сама и показывает ошибку с повтором.
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, HardwareInfo } from '@shared/types'
import { useHardware, useSettings } from '@/store/app'
import { call } from './api'
import { friendlyError } from './text'

const GRACE_MS = 700

export function useSettingsLoaded(): { settings: AppSettings | null; error: string | null; reload: () => void } {
  const settings = useSettings((s) => s.settings)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    setError(null)
    call('settings:get')
      .then((s) => useSettings.setState({ settings: s }))
      .catch((e: unknown) => setError(friendlyError(e)))
  }, [])
  useEffect(() => {
    if (settings) return
    const t = setTimeout(() => {
      if (!useSettings.getState().settings) reload()
    }, GRACE_MS)
    return () => clearTimeout(t)
  }, [settings, reload])
  return { settings, error: settings ? null : error, reload }
}

export function useHardwareInfo(): { info: HardwareInfo | null; error: string | null; reload: () => void } {
  const info = useHardware((s) => s.info)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    setError(null)
    call('hardware:get')
      .then((hw) => useHardware.setState({ info: hw }))
      .catch((e: unknown) => setError(friendlyError(e)))
  }, [])
  useEffect(() => {
    if (info) return
    const t = setTimeout(() => {
      if (!useHardware.getState().info) reload()
    }, GRACE_MS)
    return () => clearTimeout(t)
  }, [info, reload])
  return { info, error: info ? null : error, reload }
}
