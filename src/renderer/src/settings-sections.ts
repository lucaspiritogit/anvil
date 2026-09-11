export const SETTINGS_SECTIONS = [
  { id: 'general', icon: 'settings', label: 'General', description: 'Task behavior and project preferences.' },
  { id: 'providers', icon: 'bot', label: 'Providers', description: 'Choose the default agent and model for your tasks.' },
  { id: 'source-control', icon: 'git-branch', label: 'Source control', description: 'Connect GitHub and choose how to handle task branches.' },
  { id: 'shortcuts', icon: 'keyboard', label: 'Keyboard shortcuts', description: 'Make Anvil work with your keyboard.' },
  { id: 'memory', icon: 'brain', label: 'Memory', description: 'Reuse context from completed tasks in the same project.' },
  { id: 'display', icon: 'monitor', label: 'Display', description: 'Adjust text size and the background of your workspace.' }
] as const

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]['id']
