/// <reference types="vite/client" />
import type { AnvilApi } from '../../preload/api'

declare global {
  interface Window {
    anvil: AnvilApi
  }
}

export {}
