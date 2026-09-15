import type { JSX } from 'react'
import { canStackOnTask } from '@shared/task-stacks'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { hasTaskContent } from '@shared/task-images'
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
import { ProjectBranchSelector } from './ProjectBranchSelector'
import { TaskStyleBadge } from './TaskStyleBadge'
import { TASK_STYLES, TASK_STYLE_LABELS } from '@shared/task-style'
import type { TaskReviewPolicy } from '@shared/types'

const compactSelect = 'min-w-0 field-sizing-content appearance-none bg-transparent py-1.5 pl-2 pr-6 text-sm text-dim outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45'
const styleSelect = compactSelect.replace('pl-2 pr-6', 'pl-1 pr-1')
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
  const agents = useStore((state) => state.agents)
  const startTask = useStore((state) => state.startTask)
  const taskComposerFocusRequest = useStore((state) => state.taskComposerFocusRequest)
  const style = useStore((state) => state.taskComposerStyle)
  const setStyle = useStore((state) => state.setTaskComposerStyle)
  const promptRef = useRef<HTMLTextAreaElement>(null)
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
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
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

  useEffect(() => {
    promptRef.current?.focus()
  }, [taskComposerFocusRequest])

  const submit = async (): Promise<void> => {
    if (!projectId || useStore.getState().activeProjectId !== projectId || !hasTaskContent(prompt, attachments.ready) || attachments.pending || !agent || !model.trim() || loadingEfforts || switchingBranch || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await startTask({
        style,
        reviewPolicy: style === 'work' ? reviewPolicy : 'review_each_issue',
        agentId,
        parentTaskId: style === 'work' ? parentTaskId || undefined : undefined,
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
        setStyle('work')
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
      {style === 'quick' && <p className="-mt-2 mb-3 flex items-center gap-2 text-xs text-warn"><TaskStyleBadge style="quick" /> Runs without a plan or worktree in the current checkout.</p>}
      {style === 'work' && reviewPolicy === 'review_at_task_end' && <p className="-mt-2 mb-3 flex items-center gap-2 text-xs text-warn"><Icon icon="moon-star" size={14} /> Runs through issue reviews automatically. Final merge and push still wait for you.</p>}
      {style === 'work' && parents.length > 0 && <label className="inline-flex items-center gap-2 text-xs text-dim mb-2">
        <Icon icon="layers" size={14} />
        Stack on task
        <select aria-label="Stack on task" className={compactSelect} disabled={busy} value={parentTaskId} onChange={(event) => setParentTaskId(event.target.value)}>
          <option value="">Project branch</option>
          {parents.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
      </label>}
      <form
        ref={composerRef}
        aria-label="Start a task"
        className="@container/composer overflow-hidden border border-line bg-raised shadow-[0_12px_40px_rgba(0,0,0,0.2)] focus-within:border-accent/50 transition-colors"
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
            className="block w-full resize-none bg-transparent px-5 pb-3 pt-4 text-sm leading-relaxed outline-none placeholder:text-dim/60 max-[700px]:min-h-[clamp(10rem,28dvh,12rem)] max-[700px]:px-4"
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
                <li key={image.id} className="w-36 border border-line p-2 text-xs">
                  {image.preview && <img src={image.preview} alt={`Preview of ${image.filename}`} className="h-20 w-full object-contain" />}
                  <p className="truncate" title={image.filename}>{image.filename}</p>
                  {image.status === 'reading' && <p role="status">Reading {image.filename}…</p>}
                  {image.error && <p role="alert" className="text-danger">{image.error}</p>}
                  <button type="button" aria-label={`Remove ${image.filename}`} className="mt-1 text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-accent" onClick={() => attachments.remove(image.id)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          {attachments.pasteError && <p role="alert" className="px-5 pb-3 text-xs text-danger max-[700px]:px-4">{attachments.pasteError}</p>}
          <div className="flex min-w-0 items-center gap-1 px-3 pb-3 pt-1 max-[700px]:px-2">
            <label className="relative flex shrink-0 items-center" title="Task style">
              <span className="sr-only">Task style</span>
              <Icon icon={style === 'quick' ? 'rabbit' : 'anvil'} size={16} className="pointer-events-none absolute left-2 text-dim" aria-hidden="true" />
              <select
                aria-label="Task style"
                className={cn(styleSelect, 'pl-8')}
                value={style}
                onChange={(event) => setStyle(event.target.value as typeof style)}
              >
                {TASK_STYLES.map((option) => <option className="bg-raised text-fg" key={option} value={option}>{TASK_STYLE_LABELS[option]}</option>)}
              </select>
              <Icon icon="chevron-down" size={12} className="pointer-events-none absolute right-2 text-dim" aria-hidden="true" />
            </label>
            {style === 'work' && <label className="relative flex shrink-0 items-center" title={reviewPolicy === 'review_at_task_end' ? 'Run through issue reviews and stop at the final task review' : 'Pause after every issue for review'}>
              <Icon icon={reviewPolicy === 'review_at_task_end' ? 'moon-star' : 'table-of-contents'} size={16} className="pointer-events-none absolute left-2 text-dim" aria-hidden="true" />
              <select
                aria-label="Review policy"
                className={cn(compactSelect, 'pl-8')}
                value={reviewPolicy}
                onChange={(event) => preferences.setReviewPolicy(event.target.value as TaskReviewPolicy)}
              >
                <option className="bg-raised text-fg" value="review_each_issue">Review each step</option>
                <option className="bg-raised text-fg" value="review_at_task_end">Run unattended</option>
              </select>
              <Icon icon="chevron-down" size={12} className="pointer-events-none absolute right-2 text-dim" aria-hidden="true" />
            </label>}
            <ComposerModelPicker
              agentId={agentId}
              agents={agents}
              selectedModels={preferences.modelsByAgent}
              value={model}
              onChange={preferences.setSelection}
            />
            <ComposerOverflowOptions containerRef={composerRef}>
              <label className="relative flex items-center" title="Reasoning effort">
                <Icon icon="brain" size={16} className="pointer-events-none absolute left-2 text-dim" aria-hidden="true" />
                <select
                  aria-label="Reasoning effort"
                  className={cn(compactSelect, 'pl-8')}
                  value={reasoningEffort ?? ''}
                  disabled={loadingEfforts || !reasoningOptions.length}
                  onChange={(event) => setReasoningEffort(agentId, model, event.target.value)}
                >
                  {!reasoningOptions.length && <option value="">{loadingEfforts ? 'Loading efforts…' : catalogue?.error || (model && !capabilities) ? 'Reasoning unavailable' : 'Agent default'}</option>}
                  {reasoningOptions.map((option) => <option className="bg-raised text-fg" key={option.id} value={option.id}>{option.level}</option>)}
                </select>
                <Icon icon="chevron-down" size={12} className="pointer-events-none absolute right-2 text-dim" aria-hidden="true" />
              </label>
            </ComposerOverflowOptions>
            <div className="ml-auto flex shrink-0 items-stretch gap-3 self-stretch pl-2">
              <button
                type="submit"
                aria-label={busy ? 'Starting…' : 'Send'}
                title={busy ? 'Starting…' : 'Send'}
                className="grid w-8 shrink-0 place-items-center bg-accent text-canvas transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-35"
                disabled={!projectId || !hasTaskContent(prompt, attachments.ready) || attachments.pending || !agent || !model.trim() || loadingEfforts || busy || switchingBranch}
              >
                <Icon icon="chevron-up" size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
        </fieldset>
        {error && <p role="alert" className="px-5 pb-4 text-xs text-danger max-[700px]:px-4">{error}</p>}
      </form>
      {projectId && <ProjectBranchSelector key={projectId} projectId={projectId} disabled={busy} onSwitching={setSwitchingBranch} />}
    </div>
  )
}
