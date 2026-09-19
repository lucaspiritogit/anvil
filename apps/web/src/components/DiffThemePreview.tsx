import type { JSX } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import type { DiffThemes } from '@anvil/protocol/diff-themes'

const SAMPLE_PATCH = [
  'diff --git a/src/greeting.ts b/src/greeting.ts',
  'index 3f1a2b4..9c8d7e6 100644',
  '--- a/src/greeting.ts',
  '+++ b/src/greeting.ts',
  '@@ -1,5 +1,6 @@',
  ' export function greet(name: string): string {',
  "-  return 'Hello, ' + name",
  '+  const cleaned = name.trim()',
  '+  return `Hello, ${cleaned}!`',
  ' }',
  ' ',
  '-export const VERSION = 1',
  '+export const VERSION = 2'
].join('\n')

function PreviewPane({ themes, scheme }: { themes: DiffThemes; scheme: 'dark' | 'light' }): JSX.Element {
  return (
    <figure className="min-w-0 overflow-hidden border border-line">
      <figcaption className="flex items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-[11px] font-medium text-dim">
        <span className="uppercase tracking-wide">{scheme}</span>
        <code className="min-w-0 truncate font-mono text-fg">{themes[scheme]}</code>
      </figcaption>
      <PatchDiff
        patch={SAMPLE_PATCH}
        disableWorkerPool
        options={{
          theme: themes,
          themeType: scheme,
          diffStyle: 'unified',
          overflow: 'wrap',
          disableFileHeader: true
        }}
      />
    </figure>
  )
}

export function DiffThemePreview({ themes }: { themes: DiffThemes }): JSX.Element {
  return (
    <div className="grid min-w-0 gap-4 min-[560px]:grid-cols-2">
      <PreviewPane themes={themes} scheme="dark" />
      <PreviewPane themes={themes} scheme="light" />
    </div>
  )
}