import { onTestCleanup } from './test-cleanup'
import { test, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { isCodexLoginUrl, openExternalCodexLogin, createDesktopIpc, isRendererSender, isRendererUrl, openExternalPullRequest, protectRendererWindow } from '../src/client/main/renderer-security'
import { handlers, shell } from './issue-tracker-doubles'
import { rendererContents, rendererEvent, rendererFrame, rendererUrl, rendererWindow } from './renderer-fixture'

test('validates renderer URLs and exact sender frame identity', async () => {
  for (const url of [rendererUrl, `${rendererUrl}#task`]) expect(isRendererUrl(url, rendererUrl)).toBeTruthy()
  for (const url of ['', 'not a url', 'https://example.com', 'http://localhost:5174/', `${rendererUrl}other`, `${rendererUrl}?other`, 'http://localhost:5173.evil.com/', 'file:///tmp/index.html']) {
    expect(isRendererUrl(url, rendererUrl), url).toBe(false)
  }
  const packagedUrl = 'file:///Applications/Anvil.app/Contents/Resources/app.asar/out/renderer/index.html'
  expect(isRendererUrl(`${packagedUrl}#task`, packagedUrl)).toBeTruthy()
  expect(isRendererUrl(packagedUrl.replace('index.html', 'other.html'), packagedUrl)).toBe(false)
  expect(isRendererUrl('file:///tmp/index.html', packagedUrl)).toBe(false)
  expect(isRendererSender(rendererEvent, rendererWindow, rendererUrl)).toBeTruthy()
  expect(isRendererSender(rendererEvent, null, rendererUrl)).toBe(false)
  expect(isRendererSender(rendererEvent, { isDestroyed: () => true } as BrowserWindow, rendererUrl)).toBe(false)
  for (const event of [
    { sender: { ...rendererContents }, senderFrame: rendererFrame },
    { sender: rendererContents, senderFrame: { ...rendererFrame } },
    { sender: rendererContents, senderFrame: null }
  ]) expect(isRendererSender(event as unknown as IpcMainInvokeEvent, rendererWindow, rendererUrl)).toBe(false)
  onTestCleanup(() => { rendererFrame.url = rendererUrl })
  rendererFrame.url = 'https://example.com/'
  expect(isRendererSender(rendererEvent, rendererWindow, rendererUrl)).toBe(false)
  rendererFrame.url = packagedUrl
  expect(isRendererSender(rendererEvent, rendererWindow, packagedUrl)).toBeTruthy()
  rendererFrame.url = rendererUrl
})

test('desktop IPC rejects secondary renderers and malformed shell inputs', async () => {
  const ipc = createDesktopIpc(() => rendererWindow, rendererUrl)
  ipc.handle('desktop:open-path', (path) => path)
  ipc.handle('desktop:pick-project', () => '/project')
  const open = handlers.get('desktop:open-path')!
  expect(open(rendererEvent, '/project')).toBe('/project')
  expect(() => open({ ...rendererEvent, senderFrame: null }, '/project')).toThrow('Unauthorized IPC sender')
  expect(() => open(rendererEvent, { path: '/project' })).toThrow('Invalid desktop request')
  expect(() => handlers.get('desktop:pick-project')!(rendererEvent, '/injected')).toThrow('Invalid desktop request')
})

test('validates PR URLs and blocks navigation, subframes and popups', async () => {
  const opened: string[] = []
  Object.assign(shell, { openExternal: async (url: string) => { opened.push(url) } })
  const prUrl = 'https://github.com/openai/codex/pull/1'
  await openExternalPullRequest(prUrl)
  expect(opened).toStrictEqual([prUrl])
  for (const value of [null, {}, '', 'not a url', 'javascript:alert(1)', 'file:///tmp/test', 'mailto:test@example.com', 'https://example.com', 'https://github.com.evil.com/o/r/pull/1', 'https://user@github.com/o/r/pull/1', 'https://github.com/o/../pull/1', `${prUrl}\n`, `${prUrl}?redirect=evil`, `${prUrl}#fragment`]) {
    await expect(openExternalPullRequest(value)).rejects.toThrow(/Invalid GitHub PR URL/)
  }
  expect(opened).toStrictEqual([prUrl])

  let popup: (details: { url: string }) => { action: string }
  const contents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: (handler: typeof popup) => { popup = handler }
  })
  protectRendererWindow({ webContents: contents } as unknown as BrowserWindow, rendererUrl)
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    for (const url of [rendererUrl, `${rendererUrl}#task`, 'https://example.com/', 'file:///tmp/test', `${rendererUrl}other`]) {
      let prevented = false
      contents.emit(name, { url, isMainFrame: true, preventDefault: () => { prevented = true } }, url, false, true)
      expect(prevented, `${name}: ${url}`).toBe(!isRendererUrl(url, rendererUrl))
    }
  }
  for (const name of ['will-frame-navigate', 'will-redirect']) {
    let prevented = false
    contents.emit(name, { url: rendererUrl, isMainFrame: false, preventDefault: () => { prevented = true } }, rendererUrl, false, false)
    expect(prevented, name).toBeTruthy()
  }
  expect(popup!({ url: prUrl }).action).toBe('deny')
  expect(opened).toStrictEqual([prUrl, prUrl])
  Object.assign(shell, { openExternal: async () => { throw new Error('fixture opener failure') } })
  await expect(openExternalPullRequest(prUrl)).rejects.toThrow(/Could not open the GitHub PR/)
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args) => { warnings.push(args) }
  try {
    expect(popup!({ url: 'javascript:alert(1)' }).action).toBe('deny')
    expect(popup!({ url: prUrl }).action).toBe('deny')
    await new Promise((resolve) => setImmediate(resolve))
    expect(warnings.length).toBe(2)
  } finally {
    console.warn = warn
  }
})


test('Codex browser login allows only canonical HTTPS native account hosts', async () => {
  const opened: string[] = []
  Object.assign(shell, { openExternal: async (url: string) => { opened.push(url) } })
  for (const url of ['https://auth.openai.com/authorize?state=fixture', 'https://chatgpt.com/auth/login']) {
    expect(isCodexLoginUrl(url)).toBe(true)
    await openExternalCodexLogin(url)
  }
  expect(opened).toHaveLength(2)
  for (const url of ['javascript:alert(1)', 'file:///tmp/auth', 'http://auth.openai.com/login', 'https://auth.openai.com.evil.test/', 'https://evil.test/?next=https://auth.openai.com', 'https://user:secret@auth.openai.com/', 'https://auth.openai.com:444/', ' https://auth.openai.com/']) {
    expect(isCodexLoginUrl(url)).toBe(false)
    await expect(openExternalCodexLogin(url)).rejects.toThrow('Invalid Codex sign-in URL')
  }
})
