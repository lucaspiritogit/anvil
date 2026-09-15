import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ProjectBranches, TaskCheckoutMode } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { ChoicePickerDialog } from './ChoicePickerDialog'
import { ProjectPicker } from './ProjectPicker'

interface Props {
  projectId: string | null
  parentBranch?: string
  checkoutMode: TaskCheckoutMode
  startBase?: string
  disabled: boolean
  onCheckoutChange: (mode: TaskCheckoutMode, startBase?: string) => void
  onTransitioning: (transitioning: boolean) => void
}

type OpenPicker = 'project' | 'location' | 'branch' | null

const triggerClass = 'inline-flex min-w-0 max-w-full items-center gap-1.5 px-2 py-1.5 text-sm text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-45 aria-disabled:cursor-wait aria-disabled:opacity-45'

export function ProjectBranchSelector({ projectId, parentBranch, checkoutMode, startBase, disabled,
  onCheckoutChange, onTransitioning }: Props): JSX.Element {
  const projects = useStore((state) => state.projects)
  const project = projects.find((project) => project.id === projectId)
  const selectProject = useStore((state) => state.selectProject)
  const addProject = useStore((state) => state.addProject)
  const isRepository = useStore((state) => projectId ? state.gitStatusByProject[projectId]?.isRepository : false)
  const loadGitStatus = useStore((state) => state.loadGitStatus)
  const [open, setOpen] = useState<OpenPicker>(null)
  const projectRef = useRef<HTMLButtonElement>(null)
  const locationRef = useRef<HTMLButtonElement>(null)
  const branchRef = useRef<HTMLButtonElement>(null)
  const [branches, setBranches] = useState<ProjectBranches | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const error = checkoutError ?? branchError
  const [transitioning, setTransitioning] = useState(false)
  const changing = useRef(false)
  const request = useRef(0)

  const setTransition = (value: boolean): void => {
    setTransitioning(value)
    onTransitioning(value)
  }

  const refresh = async (): Promise<void> => {
    if (changing.current || !projectId || !isRepository) return
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
    if (!projectId) return
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

  useEffect(() => {
    if (parentBranch && checkoutMode !== 'worktree') onCheckoutChange('worktree')
    else if (isRepository === false && checkoutMode !== 'local' && !parentBranch) onCheckoutChange('local')
  }, [parentBranch, isRepository, checkoutMode, onCheckoutChange])

  useEffect(() => {
    if (checkoutMode !== 'worktree' || parentBranch || startBase || !branches) return
    onCheckoutChange('worktree', branches.defaultWorktreeBase?.ref)
  }, [checkoutMode, parentBranch, startBase, branches, onCheckoutChange])

  const checkout = async (branchName: string): Promise<void> => {
    if (!projectId || changing.current || disabled || branchName === branches?.currentBranch || branches?.branches.find((branch) => branch.name === branchName)?.checkedOut) return
    changing.current = true
    const version = ++request.current
    setTransition(true)
    setCheckoutError(null)
    try {
      const result = await window.anvil.projects.checkout({ projectId, branchName })
      if (version === request.current) setBranches(result)
    } catch (error) {
      if (version === request.current) setCheckoutError(error instanceof Error ? error.message : String(error))
    } finally {
      changing.current = false
      if (version === request.current) {
        setTransition(false)
        void refresh()
      }
    }
  }

  const chooseLocation = (mode: TaskCheckoutMode): void => {
    setOpen(null)
    if (mode === 'local') onCheckoutChange('local')
    else onCheckoutChange('worktree', branches?.defaultWorktreeBase?.ref)
  }

  const focusProjectTrigger = (): void => {
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-project-selector]')?.focus())
  }

  const chooseProject = (id: string): void => {
    selectProject(id)
    focusProjectTrigger()
  }

  const add = async () => {
    const added = await addProject()
    if (added) focusProjectTrigger()
    return added
  }

  const current = branches?.currentBranch ?? ''
  const localBranchLabel = !projectId || isRepository === false ? 'No Git branch'
    : current || (branches ? 'Detached HEAD' : error ? 'Branch unavailable' : 'Loading branch…')
  const base = branches?.worktreeBases?.find((candidate) => candidate.ref === startBase)
    ?? (!startBase ? branches?.defaultWorktreeBase : null) ?? null
  const baseLabel = parentBranch ?? base?.name ?? (startBase ? 'unavailable branch' : branches ? 'default branch' : 'Loading base…')
  const branchLabel = checkoutMode === 'local' ? localBranchLabel : `Branch from ${baseLabel}`
  const locationLabel = checkoutMode === 'local' ? 'Local checkout' : 'New worktree'
  const controlsDisabled = disabled || transitioning
  const branchDisabled = disabled || !projectId || !isRepository || !branches || Boolean(parentBranch)

  return (
    <div className="mb-3 min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-sm text-fg">
        <button
          ref={projectRef}
          data-project-selector
          type="button"
          aria-label="Project"
          aria-description={project ? `${project.name}, ${project.path}` : 'Choose a project'}
          aria-haspopup="dialog"
          aria-expanded={open === 'project'}
          title={project?.path ?? 'Choose or add a project'}
          className={triggerClass}
          disabled={controlsDisabled}
          onClick={() => setOpen('project')}
        >
          <Icon icon="folder" size={15} className="shrink-0" aria-hidden="true" />
          <span data-testid="composer-project-name" className="max-w-56 truncate font-medium text-fg">{project?.name ?? 'Choose project'}</span>
          <Icon icon="chevron-down" size={12} className="shrink-0" aria-hidden="true" />
        </button>
        <button
          ref={locationRef}
          type="button"
          aria-label="Execution location"
          aria-description={locationLabel}
          aria-haspopup="dialog"
          aria-expanded={open === 'location'}
          title={locationLabel}
          className={triggerClass}
          disabled={controlsDisabled || !projectId}
          onClick={() => setOpen('location')}
        >
          <Icon icon={checkoutMode === 'local' ? 'monitor' : 'layers'} size={15} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{locationLabel}</span>
          <Icon icon="chevron-down" size={12} className="shrink-0" aria-hidden="true" />
        </button>
        <button
          ref={branchRef}
          type="button"
          aria-label="Project branch"
          aria-description={branchLabel}
          aria-haspopup="dialog"
          aria-expanded={open === 'branch'}
          title={checkoutMode === 'local' ? `${branchLabel}. Local tasks use this checkout.` : `${branchLabel}. New worktrees start from this ref.`}
          className={triggerClass}
          disabled={branchDisabled}
          aria-disabled={transitioning}
          onClick={() => {
            if (transitioning) return
            void refresh()
            setOpen('branch')
          }}
        >
          <Icon icon="git-branch" size={14} className="shrink-0" aria-hidden="true" />
          <span className="max-w-64 truncate">{branchLabel}</span>
          <Icon icon="chevron-down" size={12} className="shrink-0" aria-hidden="true" />
        </button>
      </div>
      {open === 'project' && <ProjectPicker
        anchorRef={projectRef}
        projects={projects}
        value={projectId}
        onChange={chooseProject}
        onAdd={add}
        onBusyChange={setTransition}
        onClose={() => setOpen(null)}
      />}
      {open === 'location' && <ChoicePickerDialog
        anchorRef={locationRef}
        label="Choose execution location"
        noun="execution locations"
        value={checkoutMode}
        choices={[
          {
            id: 'local', label: 'Local checkout', description: parentBranch ? 'Stacked tasks require a new worktree' : 'Work in the project’s current checkout',
            icon: <Icon icon="monitor" size={16} className="shrink-0 text-dim" aria-hidden="true" />, disabled: Boolean(parentBranch)
          },
          {
            id: 'worktree', label: 'New worktree', description: isRepository === false ? 'Requires a Git repository' : isRepository === undefined ? 'Checking repository…' : 'Create an isolated checkout for this task',
            icon: <Icon icon="layers" size={16} className="shrink-0 text-dim" aria-hidden="true" />, disabled: isRepository !== true
          }
        ]}
        onClose={() => setOpen(null)}
        onSelect={(mode) => chooseLocation(mode as TaskCheckoutMode)}
      />}
      {open === 'branch' && checkoutMode === 'local' && <ChoicePickerDialog
        anchorRef={branchRef}
        label="Choose local branch"
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
        onClose={() => setOpen(null)}
        onSelect={(name) => { setOpen(null); void checkout(name) }}
      />}
      {open === 'branch' && checkoutMode === 'worktree' && <ChoicePickerDialog
        anchorRef={branchRef}
        label="Choose worktree base"
        noun="base branches"
        value={base?.ref ?? ''}
        choices={(branches?.worktreeBases ?? []).map((candidate) => ({
          id: candidate.ref,
          label: candidate.name,
          description: candidate.remote ? 'Remote branch' : 'Local branch'
        }))}
        onClose={() => setOpen(null)}
        onSelect={(ref) => { setOpen(null); onCheckoutChange('worktree', ref) }}
      />}
      {transitioning && <p role="status" className="px-2 pt-1 text-xs text-dim">Updating checkout…</p>}
      {error && <p role="alert" className="mx-2 mt-1 max-w-full rounded-md bg-black/85 px-3 py-2 text-xs text-white shadow-lg">{error}</p>}
    </div>
  )
}
