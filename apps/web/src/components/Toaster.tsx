import type { JSX } from 'react'
import { useEffect } from 'react'
import { Icon } from '../icons'
import { btn, cn } from '../ui'
import { DEFAULT_TOAST_DURATION_MS, useToasts } from '../state/toasts'
import type { Toast } from '../state/toasts'

function ToastItem({ toast }: { toast: Toast }): JSX.Element {
  const dismiss = useToasts((s) => s.dismiss)
  const dismissible = toast.dismissible !== false

  useEffect(() => {
    if (toast.persistent) return
    const timer = window.setTimeout(() => dismiss(toast.id), toast.durationMs ?? DEFAULT_TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [toast, dismiss])

  return <li data-toast-id={toast.id}
    className="pointer-events-auto w-[min(360px,calc(100vw-2rem))] border border-line-strong bg-raised p-3 text-sm text-fg shadow-[0_0_0_1px_var(--color-void),0_8px_24px_rgb(0_0_0/0.35)]">
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">{toast.title}</p>
        {toast.body && <p className="whitespace-pre-wrap text-dim">{toast.body}</p>}
      </div>
      {dismissible && <button type="button" aria-label="Dismiss notification" className={cn(btn.icon, 'grid flex-none place-items-center')}
        onClick={() => dismiss(toast.id)}><Icon icon="x" size={14} /></button>}
    </div>
    {toast.actions && toast.actions.length > 0 && <div className="mt-2.5 flex flex-wrap gap-2">
      {toast.actions.map((action, index) => <button key={`${action.label}:${index}`} type="button"
        className={index === 0 ? btn.primary : btn.ghost}
        onClick={() => {
          action.onClick()
          if (action.dismiss !== false) dismiss(toast.id)
        }}>{action.label}</button>)}
    </div>}
  </li>
}

export function Toaster(): JSX.Element {
  const toasts = useToasts((s) => s.toasts)
  return <section role="status" aria-live="polite" aria-label="Notifications"
    className="pointer-events-none fixed bottom-4 right-4 z-[60]">
    <ol className="flex flex-col items-end gap-2">
      {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} />)}
    </ol>
  </section>
}
