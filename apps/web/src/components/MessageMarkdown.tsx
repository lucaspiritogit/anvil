import { memo, type JSX, type ReactNode } from 'react'
import { cn } from '../ui'

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'table'; header: string[]; align: Array<'left' | 'center' | 'right' | null>; rows: string[][] }
  | { kind: 'rule' }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?/
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < row.length; index++) {
    const char = row[index]
    if (char === '\\' && row[index + 1] === '|') {
      current += '|'
      index++
    } else if (char === '|') {
      cells.push(current.trim())
      current = ''
    } else current += char
  }
  cells.push(current.trim())
  return cells
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
    || (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-'))
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body: string[] = []
      index++
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) body.push(lines[index++])
      index++
      blocks.push({ kind: 'code', language: fence[2], text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      index++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index++
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length && lines[index].trim() && QUOTE.test(lines[index])) body.push(lines[index++].replace(QUOTE, ''))
      blocks.push({ kind: 'quote', blocks: parseBlocks(body.join('\n')) })
      continue
    }
    const next = lines[index + 1]
    if (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-')) {
      const header = splitRow(line)
      const align = splitRow(next).map((cell) => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null
      })
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) rows.push(splitRow(lines[index++]))
      blocks.push({ kind: 'table', header, align, rows })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2])
      const baseIndent = item[1].length
      const items: string[][] = []
      while (index < lines.length) {
        const current = lines[index]
        const match = LIST_ITEM.exec(current)
        if (match && match[1].length <= baseIndent + 1 && /\d/.test(match[2]) === ordered) {
          items.push([match[3]])
          index++
          continue
        }
        if (!current.trim()) {
          const following = lines[index + 1]
          if (following !== undefined && /^\s{2,}\S/.test(following)) {
            items[items.length - 1].push('')
            index++
            continue
          }
          break
        }
        if (/^\s{2,}\S/.test(current) || (!match && !startsBlock(current, lines[index + 1]))) {
          items[items.length - 1].push(current.replace(/^\s{1,4}/, ''))
          index++
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number.parseInt(item[2], 10) : 1, items: items.map((body) => parseBlocks(body.join('\n'))) })
      continue
    }
    const body: string[] = [line]
    index++
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index], lines[index + 1])) body.push(lines[index++])
    blocks.push({ kind: 'paragraph', text: body.join('\n') })
  }
  return blocks
}

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<?(https?:\/\/[^\s<>]*[^\s<>.,;:!?"')\]])>?|\\([\\`*_{}[\]()#+\-.!|~>])/g

function safeHref(url: string): string | null {
  return /^(https?:|mailto:)/i.test(url) ? url : null
}

function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let count = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(text.slice(last, start))
    const key = `${keyPrefix}-${count++}`
    const [, ticks, code, strong, strongAlt, strike, em, emAlt, label, url, autolink, escaped] = match
    if (ticks) nodes.push(<code key={key} className="rounded-sm border border-line bg-raised px-1 py-px font-mono text-[0.88em] text-ember-300">{code.replace(/^ (.+) $/, '$1')}</code>)
    else if (strong ?? strongAlt) nodes.push(<strong key={key} className="font-semibold text-fg">{renderInline(strong ?? strongAlt, key)}</strong>)
    else if (strike) nodes.push(<del key={key} className="text-dim">{renderInline(strike, key)}</del>)
    else if (em ?? emAlt) nodes.push(<em key={key} className="italic">{renderInline(em ?? emAlt, key)}</em>)
    else if (label) {
      const href = safeHref(url)
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer" className="text-ember-400 underline decoration-ember-800 underline-offset-2 hover:text-ember-300">{renderInline(label, key)}</a> : match[0])
    } else if (autolink) nodes.push(<a key={key} href={autolink} target="_blank" rel="noreferrer" className="text-ember-400 underline decoration-ember-800 underline-offset-2 hover:text-ember-300 [overflow-wrap:anywhere]">{autolink}</a>)
    else if (escaped) nodes.push(escaped)
    else nodes.push(match[0])
    last = start + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes.flatMap((node, index) => typeof node === 'string' ? splitBreaks(node, `${keyPrefix}-t${index}`) : [node])
}

function splitBreaks(text: string, key: string): ReactNode[] {
  const parts = text.split('\n')
  return parts.flatMap((part, index) => index === 0 ? [part] : [<br key={`${key}-${index}`} />, part])
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[15px] font-semibold',
  2: 'text-[14px] font-semibold',
  3: 'text-[13px] font-semibold',
  4: 'text-[13px] font-medium',
  5: 'text-[12px] font-medium uppercase tracking-wide',
  6: 'text-[12px] font-medium text-dim'
}

const ALIGN_CLASS = { left: 'text-left', center: 'text-center', right: 'text-right' }

function renderBlocks(blocks: Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`
    switch (block.kind) {
      case 'paragraph':
        return <div key={key}>{renderInline(block.text, key)}</div>
      case 'heading':
        return <div key={key} role="heading" aria-level={block.level} className={cn('text-fg', HEADING_CLASS[block.level])}>{renderInline(block.text, key)}</div>
      case 'code':
        return <pre key={key} className="overflow-x-auto border border-line bg-raised px-2.5 py-1.5 font-mono text-[12px] leading-[18px] text-soft whitespace-pre">
          <code data-language={block.language || undefined}>{block.text}</code>
        </pre>
      case 'quote':
        return <blockquote key={key} className="space-y-1.5 border-l-2 border-line-strong pl-3 text-dim">{renderBlocks(block.blocks, key)}</blockquote>
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul'
        return <Tag key={key} start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={cn('space-y-0.5 pl-5', block.ordered ? 'list-decimal marker:text-dim' : 'list-disc marker:text-faint')}>
          {block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`} className="space-y-1 pl-0.5">{renderBlocks(item, `${key}-${itemIndex}`)}</li>)}
        </Tag>
      }
      case 'table':
        return <div key={key} className="overflow-x-auto">
          <table className="border-collapse text-[12px]">
            <thead>
              <tr>{block.header.map((cell, cellIndex) => <th key={cellIndex} className={cn('border border-line bg-raised px-2 py-1 font-semibold text-fg', ALIGN_CLASS[block.align[cellIndex] ?? 'left'])}>{renderInline(cell, `${key}-h${cellIndex}`)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => <tr key={rowIndex}>
                {block.header.map((_, cellIndex) => <td key={cellIndex} className={cn('border border-line px-2 py-1 align-top', ALIGN_CLASS[block.align[cellIndex] ?? 'left'])}>{renderInline(row[cellIndex] ?? '', `${key}-${rowIndex}-${cellIndex}`)}</td>)}
              </tr>)}
            </tbody>
          </table>
        </div>
      case 'rule':
        return <hr key={key} className="border-0 border-t border-dashed border-line-strong" />
    }
  })
}

export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }): JSX.Element {
  return <>{renderBlocks(parseBlocks(text), 'm')}</>
})
