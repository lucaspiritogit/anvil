/// <reference types="vite/client" />
import type { AnvilApi } from '@anvil/client-api'

declare global {
  interface Window {
    anvil: AnvilApi
  }
}

export {}
