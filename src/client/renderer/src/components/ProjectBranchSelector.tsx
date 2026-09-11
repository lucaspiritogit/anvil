import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import type { ProjectBranches } from '@shared/types'
import { useStore } from '../state/store'
import { ChoicePickerDialog } from './ChoicePickerDialog'

interface Props {
  projectId: string
  disabled: boolean
  onSwitching: (switching: boolean) => void
}

export function ProjectBranchSelector({ projectId, disabled, onSwitching }: Props): JSX.Element {
  const projectName = useStore((state) => state.projects.find((project) => project.id === projectId)?.name ?? '')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const isRepository = useStore((state) => state.gitStatusByProject[projectId]?.isRepository)
  const loadGitStatus = useStore((state) => state.loadGitStatus)
  const [branches, setBranches] = useState<ProjectBranches | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const error = checkoutError ?? branchError
  const [switching, setSwitching] = useState(false)
  const changing = useRef(false)
  const request = useRef(0)

  const refresh = async (): Promise<void> => {
    if (changing.current || !isRepository) return
    const version = ++request.current
    try {
      const result = await window.anvil.projects.branches(projectId)
      if (version === request.current) {
        setBranches(result)
        setBranchError(null)
      }
    } catch (error) {
      if (version === request.current) setBranchError(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    let active = true
    void loadGitStatus(projectId).catch((error: unknown) => {
      if (active) setBranchError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [projectId, loadGitStatus])

  useEffect(() => {
    void refresh()
    const update = (): void => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', update)
    const unsubscribe = window.anvil.projects.onChanged(update)
    const timer = window.setInterval(update, 5000)
    return () => {
      ++request.current
      window.removeEventListener('focus', update)
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [projectId, isRepository])

  const checkout = async (branchName: string): Promise<void> => {
    if (changing.current || disabled || branchName === branches?.currentBranch || branches?.branches.find((branch) => branch.name === branchName)?.checkedOut) return
    changing.current = true
    const version = ++request.current
    setSwitching(true)
    onSwitching(true)
    setCheckoutError(null)
    try {
      const result = await window.anvil.projects.checkout({ projectId, branchName })
      if (version === request.current) setBranches(result)
    } catch (error) {
      if (version === request.current) setCheckoutError(error instanceof Error ? error.message : String(error))
    } finally {
      changing.current = false
      if (version === request.current) {
        setSwitching(false)
        onSwitching(false)
        void refresh()
      }
    }
  }

  const current = branches?.currentBranch ?? ''
  const branchLabel = current || (branches ? 'Detached HEAD' : error ? 'Branch unavailable' : 'Loading branch…')
  return (
    <div className="mb-3 flex min-w-0 flex-col items-start gap-2">
      <div className="flex max-w-full items-center gap-3 text-xs text-fg">
        <span data-testid="composer-project-name" title={projectName} className="min-w-0 max-w-[50%] truncate font-medium">{projectName}</span>
        {isRepository !== false && <button
          ref={triggerRef}
          type="button"
          aria-label="Project branch"
          aria-description={branchLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`${branchLabel}. New tasks start from this branch.`}
          className="inline-flex min-w-0 items-center gap-1 py-1 text-xs text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60 aria-disabled:cursor-wait aria-disabled:opacity-60"
          disabled={disabled || !branches}
          aria-disabled={switching}
          onClick={() => {
            if (changing.current) return
            void refresh()
            setOpen(true)
          }}
        >
          <span className="truncate">{branchLabel}</span>
          <Icon icon="chevron-down" size={12} className="shrink-0" aria-hidden="true" />
        </button>}
      </div>
      {open && isRepository !== false && <ChoicePickerDialog
        anchorRef={triggerRef}
        label="Choose branch"
        noun="branches"
        value={current}
        choices={[
          ...(current && !branches?.branches.some((branch) => branch.name === current) ? [{ id: current, label: current }] : []),
          ...(branches?.branches.map((branch) => ({
            id: branch.name,
            label: branch.name,
            disabled: branch.checkedOut && branch.name !== current,
            description: branch.checkedOut && branch.name !== current ? 'In use by another worktree' : undefined
          })) ?? [])
        ]}
        onClose={() => setOpen(false)}
        onSelect={(name) => { setOpen(false); void checkout(name) }}
      />}
      {switching && <p role="status" className="text-xs text-dim">Switching branch…</p>}
      {error && <p role="alert" className="max-w-full rounded-md bg-black/85 px-3 py-2 text-xs text-white shadow-lg">{error}</p>}
    </div>
  )
}
