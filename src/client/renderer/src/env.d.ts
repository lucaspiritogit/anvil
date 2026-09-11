/// <reference types="vite/client" />
import type { AnvilApi } from '../../preload'

declare global {
  interface Window {
    anvil: AnvilApi
  }
}

export {}
