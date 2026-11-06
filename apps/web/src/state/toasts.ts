import { create } from 'zustand'

export interface ToastAction {
  label: string
  onClick: () => void
  dismiss?: boolean
}

export interface Toast {
  id: string
  title: string
  body?: string
  actions?: ToastAction[]
  persistent?: boolean
  dismissible?: boolean
  durationMs?: number
}

interface ToastState {
  toasts: Toast[]
  show: (toast: Toast) => string
  dismiss: (id: string) => void
  clear: () => void
}

export const DEFAULT_TOAST_DURATION_MS = 6000

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show: (toast) => {
    set((state) => {
      const index = state.toasts.findIndex((entry) => entry.id === toast.id)
      if (index === -1) return { toasts: [...state.toasts, toast] }
      const toasts = state.toasts.slice()
      toasts[index] = toast
      return { toasts }
    })
    return toast.id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  clear: () => set({ toasts: [] })
}))

export function showToast(toast: Toast): string {
  return useToasts.getState().show(toast)
}

export function dismissToast(id: string): void {
  useToasts.getState().dismiss(id)
}
