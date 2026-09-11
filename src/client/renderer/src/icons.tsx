import type { JSX, SVGProps } from 'react'
import archive from './icons/archive.svg?raw'
import ban from './icons/ban.svg?raw'
import bellRing from './icons/bell-ring.svg?raw'
import bot from './icons/bot.svg?raw'
import brainCircuit from './icons/brain-circuit.svg?raw'
import brain from './icons/brain.svg?raw'
import check from './icons/check.svg?raw'
import chevronDown from './icons/chevron-down.svg?raw'
import chevronUp from './icons/chevron-up.svg?raw'
import coffee from './icons/coffee.svg?raw'
import copy from './icons/copy.svg?raw'
import folderPlus from './icons/folder-plus.svg?raw'
import folder from './icons/folder.svg?raw'
import gitBranch from './icons/git-branch.svg?raw'
import keyboard from './icons/keyboard.svg?raw'
import layers from './icons/layers.svg?raw'
import loader from './icons/loader.svg?raw'
import monitor from './icons/monitor.svg?raw'
import pencil from './icons/pencil.svg?raw'
import search from './icons/search.svg?raw'
import settings from './icons/settings.svg?raw'
import sparkles from './icons/sparkles.svg?raw'
import waypoints from './icons/waypoints.svg?raw'
import x from './icons/x.svg?raw'

// Only bundled artwork enters this map. Inline SVG keeps currentColor and sizing
// consistent with the surrounding controls without an icon runtime dependency.
function body(svg: string): string {
  const start = svg.indexOf('<svg')
  const end = svg.indexOf('>', start)
  const stroke = svg.slice(start, end).includes('stroke="currentColor"') ? 'currentColor' : 'none'
  // Preserve the export's root stroke so transparent background rects stay invisible.
  return `<g stroke="${stroke}">${svg.slice(end + 1, svg.lastIndexOf('</svg>'))}</g>`
}

const artwork = {
  archive: body(archive),
  ban: body(ban),
  'bell-ring': body(bellRing),
  bot: body(bot),
  'brain-circuit': body(brainCircuit),
  brain: body(brain),
  check: body(check),
  'chevron-down': body(chevronDown),
  'chevron-up': body(chevronUp),
  'chevron-left': `<g transform="rotate(90 12 12)">${body(chevronDown)}</g>`,
  'chevron-right': `<g transform="rotate(-90 12 12)">${body(chevronDown)}</g>`,
  coffee: body(coffee),
  copy: body(copy),
  'folder-plus': body(folderPlus),
  folder: body(folder),
  'git-branch': body(gitBranch),
  keyboard: body(keyboard),
  layers: body(layers),
  loader: body(loader),
  monitor: body(monitor),
  pencil: body(pencil),
  search: body(search),
  settings: body(settings),
  sparkles: body(sparkles),
  waypoints: body(waypoints),
  x: body(x)
}

export type IconName = keyof typeof artwork

// Keep this prop stable across renders. Replacing the SVG children on input blur
// would remove the pointer target between mousedown and mouseup and lose clicks.
const markup = Object.fromEntries(
  Object.entries(artwork).map(([name, html]) => [name, { __html: html }])
) as Record<IconName, { __html: string }>

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'dangerouslySetInnerHTML'> & {
  icon: IconName
  size?: number
}

export function Icon({ icon, size = 24, ...props }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
      dangerouslySetInnerHTML={markup[icon]}
    />
  )
}
