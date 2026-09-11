import { afterEach, vi } from 'vitest'
import { cleanupTestResources } from './test-cleanup'

// Unit suites have no application database or Electron runtime dependencies.
afterEach(async () => {
  try {
    await cleanupTestResources()
  } finally {
    vi.restoreAllMocks()
    if (vi.isFakeTimers()) vi.clearAllTimers()
    vi.useRealTimers()
  }
})
