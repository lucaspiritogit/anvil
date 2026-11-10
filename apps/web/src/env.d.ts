/// <reference types="vite/client" />
import type { AnvilApi } from '@anvil/client-api'

declare global {
  const __ANVIL_BUILD_SHA__: string
  const __ANVIL_BUILD_VERSION__: string
  const __ANVIL_RELEASE_BUILD__: boolean

  interface Window {
    anvil: AnvilApi
  }
}

export {}
