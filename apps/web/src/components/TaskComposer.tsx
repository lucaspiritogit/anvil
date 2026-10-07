import type { JSX } from 'react'
import { canStackOnTask } from '@anvil/protocol/task-stacks'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { hasTaskContent } from '@anvil/protocol/task-images'
import { useStore } from '../state/store'
import { useAgentModels } from '../state/agent-models'
import { useComposerPreferences } from '../state/composer-preferences'
import { ComposerFilePicker } from './ComposerFilePicker'
import { useComposerFileMentions } from '../state/composer-file-mentions'
import { useTaskComposerDraft } from '../state/task-composer-drafts'
import { useComposerImages } from '../state/composer-images'
import { cn } from '../ui'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerOverflowOptions } from './ComposerOverflowOptions'
import { ComposerOptionTooltip } from './ComposerOptionTooltip'
import { MenuSelect } from './MenuSelect'
import { ProjectBranchSelector } from './ProjectBranchSelector'
import { TASK_STYLES, TASK_STYLE_LABELS } from '@anvil/protocol/task-style'
import type { TaskCheckoutMode, TaskReviewPolicy } from '@anvil/protocol/types'

const REVIEW_DESCRIPTIONS: Record<TaskReviewPolicy, string> = {
  review_each_issue: 'Pause after every step to review its changes before continuing.',
  review_at_task_end: 'Runs unattended until the final review. Merge and push still wait for you.'
}
const successDuration = 1800
export function TaskComposer(): JSX.Element {
  const projectId = useStore((state) => state.activeProjectId)
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const draftKey = JSON.stringify([workspaceId, projectId])
  return <TaskComposerDraft key={draftKey} projectId={projectId} draftKey={draftKey} />
}

function TaskComposerDraft({ projectId, draftKey }: { projectId: string | null; draftKey: string }): JSX.Element {
  const tasks = useStore((state) => state.tasks)
  const [parentTaskId, setParentTaskId] = useState('')
  const parents = tasks.filter((task) => task.projectId === projectId && canStackOnTask(task))
  const parentBranch = parents.find((task) => task.id === parentTaskId)?.branchName
  const agents = useStore((state) => state.agents)
  const startTask = useStore((state) => state.startTask)
  const taskComposerFocusRequest = useStore((state) => state.taskComposerFocusRequest)
  const style = useStore((state) => projectId ? state.taskComposerStyle : 'quick')
  const setStyle = useStore((state) => state.setTaskComposerStyle)
  const isRepository = useStore((state) => projectId ? state.gitStatusByProject[projectId]?.isRepository : false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const preferences = useComposerPreferences()
  const reviewPolicy = preferences.reviewPolicy ?? 'review_each_issue'
  const agent = agents.find((candidate) => candidate.id === preferences.agentId)
  const agentId = agent?.id ?? ''
  const model = preferences.modelsByAgent[agentId] ?? ''
  const draft = useTaskComposerDraft(draftKey)
  const { prompt, setPrompt } = draft
  const attachments = useComposerImages()
  const mentions = useComposerFileMentions(projectId, prompt, setPrompt, promptRef, draft)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [busy, setBusy] = useState(false)
  const [switchingBranch, setSwitchingBranch] = useState(false)
  const [checkoutMode, setCheckoutMode] = useState<TaskCheckoutMode>('local')
  const [startBase, setStartBase] = useState<string>()
  const [error, setError] = useState<string | null>(null)
  const [showSuccess, setShowSuccess] = useState(false)
  const [created, setCreated] = useState<{ title: string; project: string; offscreen: boolean } | null>(null)
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restorePromptFocus = useRef(false)
  const submitting = useRef(false)
  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current)
  }, [])
  useEffect(() => {
    if (busy || (!showSuccess && !error) || !restorePromptFocus.current) return
    restorePromptFocus.current = false
    if (document.activeElement === document.body) promptRef.current?.focus()
  }, [busy, showSuccess, error])
  const catalogue = useAgentModels(agentId)
  const capabilities = catalogue?.reasoningByModel?.[model]
  const loadingEfforts = Boolean(agentId) && !catalogue
  const reasoningOptions = loadingEfforts || catalogue?.error ? [] : capabilities?.options ?? []
  const savedEffort = preferences.reasoningByAgentModel[JSON.stringify([agentId, model])]
  const reasoningEffort = reasoningOptions.find((option) => option.id === savedEffort)?.id
    ?? reasoningOptions.find((option) => option.id === capabilities?.default)?.id
    ?? reasoningOptions[0]?.id
  const setReasoningEffort = preferences.setReasoningEffort

  useEffect(() => {
    if (reasoningEffort && savedEffort !== reasoningEffort) setReasoningEffort(agentId, model, reasoningEffort)
  }, [agentId, model, reasoningEffort, savedEffort, setReasoningEffort])

  useEffect(() => { setSwitchingBranch(false) }, [projectId])
  useEffect(() => {
    if (parentTaskId && !tasks.some((task) => task.id === parentTaskId && canStackOnTask(task))) setParentTaskId('')
  }, [tasks, parentTaskId])

  useLayoutEffect(() => {
    const prompt = promptRef.current
    if (!prompt) return
    prompt.focus()
    prompt.setSelectionRange(prompt.value.length, prompt.value.length)
  }, [taskComposerFocusRequest])

  const isolated = Boolean(projectId) && (style === 'work' || checkoutMode === 'worktree')
  const styleDescriptions: Record<typeof style, string> = {
    work: 'Delegate planned work on a task branch. Changes wait for you to merge them.',
    quick: !projectId
      ? 'Ask a question or start a task without a project.'
      : checkoutMode === 'worktree'
        ? 'Ask a question or make a focused change in an isolated worktree.'
        : 'Ask a question or make a focused change in the current checkout.'
  }
  const styleDescription = styleDescriptions[style]
  const reviewDescription = REVIEW_DESCRIPTIONS[reviewPolicy]
  const submit = async (): Promise<void> => {
    if (useStore.getState().activeProjectId !== projectId || !hasTaskContent(prompt, attachments.ready) || attachments.pending || !agent || !model.trim() || loadingEfforts || switchingBranch || (isolated && isRepository === false) || submitting.current) return
    submitting.current = true
    restorePromptFocus.current = document.activeElement === promptRef.current
    if (successTimer.current) clearTimeout(successTimer.current)
    successTimer.current = null
    setShowSuccess(false)
    setBusy(true)
    setError(null)
    try {
      const task = await startTask({
        projectId,
        style,
        reviewPolicy: style === 'work' ? reviewPolicy : 'review_each_issue',
        agentId,
        checkoutMode: projectId ? style === 'quick' ? checkoutMode : undefined : 'local',
        parentTaskId: style === 'work' ? parentTaskId || undefined : undefined,
        ...(isolated && !parentTaskId && startBase ? { startBase } : {}),
        prompt: prompt.trim(),
        ...(mentions.references.length ? { fileReferences: mentions.references } : {}),
        model: model.trim() || undefined,
        ...(attachments.ready.length ? { images: attachments.ready } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
      })
      draft.clearSubmitted()
      if (mounted.current) {
        attachments.reset()
        setParentTaskId('')
        setStyle('quick')
        const project = useStore.getState().projects.find((entry) => entry.id === task?.projectId)?.name ?? 'no project'
        setCreated(task ? { title: task.title, project, offscreen: false } : null)
        setShowSuccess(true)
        if (task) window.setTimeout(() => {
          if (!mounted.current) return
          const row = document.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`)
          const bounds = row?.getBoundingClientRect()
          const visible = Boolean(bounds && bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight)
          if (!visible) setCreated((current) => current && { ...current, offscreen: true })
        }, 80)
        successTimer.current = setTimeout(() => {
          successTimer.current = null
          setShowSuccess(false)
        }, successDuration)
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <div>
      {preferences.saveError && <p role="alert" className="text-danger">{preferences.saveError}. Change a task option to retry saving.</p>}
      {style === 'work' && isRepository === false && <p role="alert" className="-mt-2 mb-3 text-xs text-danger">Work requires a Git repository so Anvil can create an isolated branch and worktree.</p>}
      {style === 'quick' && checkoutMode === 'worktree' && isRepository === false && <p role="alert" className="-mt-2 mb-3 text-xs text-danger">An isolated worktree requires a Git repository. Use the current checkout instead.</p>}
      {style === 'work' && parents.length > 0 && <div className="mb-2 inline-flex items-center gap-2 font-mono text-xs text-dim">
        <Icon icon="layers" size={14} aria-hidden="true" />
        <span aria-hidden="true">Stack on task</span>
        <MenuSelect
          label="Stack on task"
          disabled={busy}
          value={parentTaskId}
          options={[{ value: '', label: 'Project branch' }, ...parents.map((task) => ({ value: task.id, label: task.title }))]}
          onChange={setParentTaskId}
        />
      </div>}
      <ProjectBranchSelector
        key={projectId ?? 'no-project'}
        projectId={projectId}
        style={style}
        checkoutMode={style === 'quick' ? checkoutMode : 'worktree'}
        onCheckoutModeChange={setCheckoutMode}
        parentBranch={parentBranch}
        startBase={startBase}
        disabled={busy}
        onStartBaseChange={setStartBase}
        onTransitioning={setSwitchingBranch}
      />
      <div className="corner-marks p-1.5">
      <form
        ref={composerRef}
        aria-label="Start a task"
        className={cn('@container/composer relative overflow-hidden border border-line-strong bg-raised focus-within:border-accent/60 transition-colors', showSuccess && 'task-composer-success')}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <fieldset disabled={busy} className="min-w-0">
          <textarea
            aria-label="Task prompt"
            ref={promptRef}
            rows={5}
            className="block w-full resize-none bg-transparent px-5 pb-3 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-faint max-[700px]:min-h-[clamp(10rem,28dvh,12rem)] max-[700px]:px-4"
            placeholder={style === 'work' ? 'Describe the work you want done' : 'Ask a question or describe a focused change'}
            value={prompt}
            onChange={(event) => { setPrompt(event.target.value); mentions.syncSelection() }}
            onSelect={mentions.syncSelection}
            onBlur={mentions.dismiss}
            onCompositionStart={() => mentions.setComposing(true)}
            onCompositionEnd={() => { mentions.setComposing(false); mentions.syncSelection() }}
            aria-autocomplete="list"
            aria-controls={mentions.open ? mentions.id : undefined}
            aria-expanded={mentions.open}
            aria-activedescendant={mentions.open && !mentions.loading && mentions.paths[mentions.selected] ? `${mentions.id}-${mentions.selected}` : undefined}
            onPaste={(event) => {
              // Leave the default text insertion intact, including mixed text/image paste.
              attachments.paste(event.clipboardData.items)
            }}
            onKeyDown={(event) => {
              if (event.defaultPrevented || mentions.onKeyDown(event)) return
              if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (!event.repeat) void submit()
              }
            }}
          />
          {mentions.open && <ComposerFilePicker id={mentions.id} paths={mentions.paths} selected={mentions.selected} loading={mentions.loading} result={mentions.result} onChoose={mentions.choose} onRetry={mentions.retry} />}
          {attachments.images.length > 0 && (
            <ul aria-label="Image attachments" className="flex flex-wrap gap-3 px-5 pb-3 max-[700px]:px-4">
              {attachments.images.map((image) => (
                <li key={image.id} className="w-36 border border-line-strong bg-overlay p-2 text-xs">
                  {image.preview && <img src={image.preview} alt={`Preview of ${image.filename}`} className="h-20 w-full object-contain" />}
                  <p className="truncate" title={image.filename}>{image.filename}</p>
                  {image.status === 'reading' && <p role="status">Reading {image.filename}…</p>}
                  {image.error && <p role="alert" className="text-danger">{image.error}</p>}
                  <button type="button" aria-label={`Remove ${image.filename}`} className="mt-1 text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent" onClick={() => attachments.remove(image.id)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          {attachments.attachmentError && <p role="alert" className="px-5 pb-3 text-xs text-danger max-[700px]:px-4">{attachments.attachmentError}</p>}
          <div className="flex min-w-0 items-center gap-1.5 border-t border-dashed border-line px-3 py-2.5 max-[700px]:px-2">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                attachments.attach(Array.from(event.currentTarget.files ?? []))
                event.currentTarget.value = ''
              }}
            />
            <ComposerOptionTooltip title={TASK_STYLE_LABELS[style]} description={styleDescription} disabled={busy}>
              {(tooltipId) => (
                <MenuSelect
                  label="Task style"
                  aside="⇧ tab cycles"
                  describedBy={tooltipId}
                  value={style}
                  options={TASK_STYLES.map((option) => ({
                    value: option,
                    label: TASK_STYLE_LABELS[option],
                    icon: option === 'quick' ? 'rabbit' : 'anvil',
                    description: !projectId && option === 'work' ? 'Needs a project.' : styleDescriptions[option],
                    disabled: !projectId && option === 'work'
                  }))}
                  onChange={setStyle}
                />
              )}
            </ComposerOptionTooltip>
            {style === 'work' && <ComposerOptionTooltip title={reviewPolicy === 'review_at_task_end' ? 'Review at the end' : 'Review each step'} description={reviewDescription} disabled={busy}>
              {(tooltipId) => (
                <MenuSelect<TaskReviewPolicy>
                  label="Review policy"
                  describedBy={tooltipId}
                  value={reviewPolicy}
                  options={[
                    { value: 'review_each_issue', label: 'Review each step', icon: 'table-of-contents', description: REVIEW_DESCRIPTIONS.review_each_issue },
                    { value: 'review_at_task_end', label: 'Review at the end', icon: 'moon-star', description: REVIEW_DESCRIPTIONS.review_at_task_end }
                  ]}
                  onChange={preferences.setReviewPolicy}
                />
              )}
            </ComposerOptionTooltip>}
            <ComposerModelPicker
              agentId={agentId}
              agents={agents}
              selectedModels={preferences.modelsByAgent}
              value={model}
              onChange={preferences.setSelection}
            />
            <ComposerOverflowOptions containerRef={composerRef}>
              <MenuSelect
                label="Reasoning effort"
                title="Thinking"
                aside={model.trim() || undefined}
                icon="brain"
                value={reasoningEffort ?? ''}
                placeholder={loadingEfforts ? 'Loading efforts…' : catalogue?.error || (model && !capabilities) ? 'Reasoning unavailable' : 'Agent default'}
                disabled={loadingEfforts || !reasoningOptions.length}
                options={reasoningOptions.map((option, index) => ({ value: option.id, label: option.level, meter: { level: index + 1, max: reasoningOptions.length } }))}
                onChange={(effort) => setReasoningEffort(agentId, model, effort)}
              />
            </ComposerOverflowOptions>
            <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
              <button
                type="button"
                aria-label="Attach image"
                title="Attach image"
                className="grid h-8 w-9 shrink-0 place-items-center border border-line-strong bg-overlay text-dim transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-faint"
                disabled={busy}
                onClick={() => imageInputRef.current?.click()}
              >
                <Icon icon="paperclip" size={17} aria-hidden="true" />
              </button>
              <button
                type="submit"
                aria-label={busy ? 'Starting…' : 'Send'}
                title={busy ? 'Starting…' : 'Send'}
                className="flex h-8 shrink-0 items-center gap-2 bg-accent px-2.5 text-[13px] font-semibold text-canvas transition-[filter,background-color] enabled:hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-overlay disabled:text-faint @max-[420px]/composer:px-2"
                disabled={!hasTaskContent(prompt, attachments.ready) || attachments.pending || !agent || !model.trim() || loadingEfforts || busy || switchingBranch || (isolated && isRepository === false)}
              >
                <span aria-hidden="true" className="@max-[420px]/composer:hidden">Start</span>
                <span aria-hidden="true" className="bg-canvas/20 px-1 font-mono text-[11px] font-medium">↵</span>
              </button>
            </div>
          </div>
        </fieldset>
        {error && <p role="alert" className="px-5 pb-4 text-xs text-danger max-[700px]:px-4">{error}</p>}
      </form>
      </div>
      {showSuccess && created?.offscreen && <p aria-hidden="true" className="task-created-stamp mt-2 truncate px-1 font-mono text-[11px] text-dim">
        <span className="text-ember-400">› </span>{created.title} <span className="text-ember-400">created</span> · queued in {created.project}
      </p>}
      {showSuccess && <p role="status" aria-label="Task created" className="sr-only">{created ? `Task created: ${created.title}, queued in ${created.project}` : 'Task created'}</p>}
    </div>
  )
}
