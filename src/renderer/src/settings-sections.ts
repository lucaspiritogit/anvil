import { Settings01Icon, AiChat02Icon, GitBranchIcon, KeyboardIcon, BrainIcon, ComputerIcon } from '@hugeicons/core-free-icons'

export const SETTINGS_SECTIONS = [
  { id: 'general', icon: Settings01Icon, label: 'General', description: 'Task behavior and project preferences.' },
  { id: 'providers', icon: AiChat02Icon, label: 'Providers', description: 'Choose the default agent and model for your tasks.' },
  { id: 'source-control', icon: GitBranchIcon, label: 'Source control', description: 'Connect GitHub and choose how to handle task branches.' },
  { id: 'shortcuts', icon: KeyboardIcon, label: 'Keyboard shortcuts', description: 'Make Anvil work with your keyboard.' },
  { id: 'memory', icon: BrainIcon, label: 'Memory', description: 'Reuse context from completed tasks in the same project.' },
  { id: 'display', icon: ComputerIcon, label: 'Display', description: 'Adjust text size and the background of your workspace.' }
] as const

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id']
