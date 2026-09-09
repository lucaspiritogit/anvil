import { expect, test, type Locator, type Page } from '@playwright/test'
import { chooseBranch, restoreComposerSelection } from './composer-setup'
import { readFileSync } from 'node:fs'
import { taskImages } from '../task-image-fixture'

interface ClipboardImage {
  filename: string
  mimeType: string
  bytes: number[]
  itemType?: string
  nullFile?: boolean
  read?: 'fail' | 'pending'
  size?: number
}

let samples: ClipboardImage[]
test.beforeAll(async () => {
  samples = (await taskImages()).map((image) => ({ ...image, bytes: Array.from(image.bytes) }))
})

test.beforeEach(async ({ page }) => {
  await restoreComposerSelection(page)
  // Exercise production image CSP while allowing Vite's development script injection.
  const imagePolicy = readFileSync('src/renderer/index.html', 'utf8').match(/img-src[^";]+/)![0]
  await page.route('**/tests/e2e/fixture/', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': imagePolicy } })
  })
  await page.addInitScript(() => {
    const created: string[] = []
    const revoked: string[] = []
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (blob) => { const url = create(blob); created.push(url); return url }
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url) }
    Object.assign(window, { imageUrls: { created, revoked } })
  })
})

async function paste(prompt: Locator, images: ClipboardImage[]): Promise<void> {
  await prompt.evaluate((element, images) => {
    const items = images.map((image) => {
      const file = new File([new Uint8Array(image.bytes)], image.filename, { type: image.mimeType })
      if (image.size !== undefined) Object.defineProperty(file, 'size', { value: image.size })
      if (image.read) {
        const read = file.arrayBuffer.bind(file)
        file.arrayBuffer = async () => {
          if (image.read === 'fail') throw new Error('Clipboard read failed')
          await new Promise<void>((resolve) => window.addEventListener('fixture:read-ready', () => resolve(), { once: true }))
          return read()
        }
      }
      return { kind: 'file', type: image.itemType ?? image.mimeType, getAsFile: () => image.nullFile ? null : file }
    })
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items } })
    element.dispatchEvent(event)
  }, images)
}

async function nativePaste(page: Page, prompt: Locator, text: string, withImage: boolean): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(async ({ text, image }) => {
    const items: Record<string, Blob> = { 'text/plain': new Blob([text], { type: 'text/plain' }) }
    if (image) items['image/png'] = new Blob([new Uint8Array(image.bytes)], { type: 'image/png' })
    await navigator.clipboard.write([new ClipboardItem(items)])
  }, { text, image: withImage ? samples[0] : null })
  await prompt.focus()
  await prompt.press('ControlOrMeta+V')
}

async function expectUrlsReleased(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const urls = (window as unknown as { imageUrls: { created: string[]; revoked: string[] } }).imageUrls
    return urls.created.filter((url) => !urls.revoked.includes(url))
  })).toEqual([])
}

for (const surface of ['overview', 'modal'] as const) {
  test.describe(surface, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/tests/e2e/fixture/')
      await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
      if (surface === 'modal') await page.evaluate(() => window.composerTest.openModal())
    })

    const composer = (page: Page): Locator => page.getByRole('form', { name: 'Start a task' })
    const prompt = (page: Page): Locator => composer(page).getByRole('textbox', { name: 'Task prompt' })
    const send = (page: Page): Locator => composer(page).getByRole('button', { name: 'Send', exact: true })

    test('preserves ordinary text paste and submits text without attachments', async ({ page }) => {
      await expect(send(page)).toBeDisabled()
      await nativePaste(page, prompt(page), 'Text from the clipboard', false)
      await expect(prompt(page)).toHaveValue('Text from the clipboard')
      await send(page).click()
      await expect.poll(() => page.evaluate(() => window.composerTest.starts)).toEqual([
        expect.objectContaining({ prompt: 'Text from the clipboard' })
      ])
      expect(await page.evaluate(() => window.composerTest.starts[0].images)).toBeUndefined()
    })

    test('preserves text insertion and selection when a paste also contains an image', async ({ page }, testInfo) => {
      await prompt(page).fill('Before REPLACE after')
      await prompt(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(7, 14))
      await nativePaste(page, prompt(page), 'clipboard text', true)
      await expect(prompt(page)).toHaveValue('Before clipboard text after')
      await expect(composer(page).getByRole('img')).toHaveCount(1)
      await expect.poll(() => composer(page).getByRole('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
      await page.screenshot({ path: testInfo.outputPath(`mixed-paste-${surface}.png`) })
      await send(page).click()
      await expect.poll(() => page.evaluate(() => window.composerTest.starts[0]?.images?.length)).toBe(1)
      expect(await page.evaluate(() => window.composerTest.starts[0].prompt)).toBe('Before clipboard text after')
    })

    test('sends multiple image formats without text and releases previews after success', async ({ page }) => {
      await paste(prompt(page), samples)
      await expect(composer(page).getByRole('img')).toHaveCount(3)
      await expect(send(page)).toBeEnabled()
      await prompt(page).press('Enter')
      await expect.poll(() => page.evaluate(() => window.composerTest.starts.map((input) => ({
        prompt: input.prompt, images: input.images?.map((image) => ({ ...image, bytes: Array.from(image.bytes) }))
      })))).toEqual([{ prompt: '', images: samples }])
      expect(await page.evaluate(() => window.composerTest.starts[0].images!.every((image) => image.bytes instanceof Uint8Array))).toBe(true)
      await expect(composer(page)).toHaveCount(0)
      await expectUrlsReleased(page)
      await page.evaluate((surface) => surface === 'modal' ? window.composerTest.openModal() : window.composerTest.overview(), surface)
      await expect(prompt(page)).toHaveValue('')
      await expect(composer(page).getByRole('img')).toHaveCount(0)
      await expect(send(page)).toBeDisabled()
    })

    test('names an unnamed clipboard File and makes previews removable', async ({ page }) => {
      await paste(prompt(page), [{ ...samples[0], filename: '' }])
      await expect(composer(page).getByRole('img', { name: 'Preview of pasted-image-1.png' })).toBeVisible()
      await composer(page).getByRole('button', { name: 'Remove pasted-image-1.png' }).click()
      await expect(send(page)).toBeDisabled()
      await expectUrlsReleased(page)
    })

    test('reports unsupported MIME, mismatched MIME, null files, malformed bytes and failed reads', async ({ page }) => {
      await prompt(page).fill('Keep this text')
      const badImages: ClipboardImage[] = [
        { ...samples[0], mimeType: 'image/svg+xml' },
        { ...samples[0], itemType: 'image/jpeg' },
        { ...samples[0], mimeType: 'image/jpeg' },
        { ...samples[0], nullFile: true },
        { ...samples[0], bytes: [1, 2, 3] },
        { ...samples[0], bytes: samples[0].bytes.slice(0, 45) },
        { ...samples[0], read: 'fail' }
      ]
      await paste(prompt(page), badImages)
      await expect(composer(page).getByRole('alert')).toHaveCount(7)
      await expect(prompt(page)).toHaveValue('Keep this text')
      await expect(send(page)).toBeEnabled()
      await send(page).click()
      expect(await page.evaluate(() => window.composerTest.starts[0].images)).toBeUndefined()
    })

    test('enforces count, byte and pixel limits', async ({ page }) => {
      await paste(prompt(page), Array.from({ length: 9 }, () => samples[0]))
      await expect(composer(page).getByRole('img')).toHaveCount(8)
      await expect(composer(page).getByRole('alert')).toContainText('at most 8 images')
      for (let i = 0; i < 8; i++) await composer(page).getByRole('button', { name: /^Remove / }).first().click()
      await paste(prompt(page), [
        { ...samples[0], size: 0 },
        { ...samples[0], size: 10 * 1024 * 1024 + 1 },
        ...Array.from({ length: 3 }, (_, index) => ({ ...samples[0], filename: `large-${index}.png`, size: 10 * 1024 * 1024, read: 'pending' as const }))
      ])
      await expect(composer(page).getByRole('alert')).toHaveCount(3)
      await expect(composer(page).getByRole('alert').last()).toContainText('20 MiB')
      await expect(send(page)).toBeDisabled()
      for (let i = 0; i < 5; i++) await composer(page).getByRole('button', { name: /^Remove / }).first().click()
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 4001
        canvas.height = 4000
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
        const data = new DataTransfer()
        data.items.add(new File([blob], 'huge.png', { type: 'image/png' }))
        document.querySelector('textarea[aria-label="Task prompt"]')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }))
      })
      await expect(composer(page).getByRole('alert')).toContainText('16 million pixels')
      await expect(send(page)).toBeDisabled()
    })

    test('blocks button and keyboard submission during reads and checkout', async ({ page }) => {
      await prompt(page).fill('Wait for the image')
      await paste(prompt(page), [{ ...samples[0], read: 'pending' }])
      await expect(composer(page).getByRole('status')).toContainText('Reading clipboard.png')
      await expect(send(page)).toBeDisabled()
      await prompt(page).press('Enter')
      await expect(prompt(page)).toHaveValue('Wait for the image')
      expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:read-ready')))
      await expect(send(page)).toBeEnabled()
      await page.evaluate(() => {
        window.anvil.projects.checkout = async () => {
          await new Promise<void>((resolve) => window.addEventListener('fixture:checkout-ready', () => resolve(), { once: true }))
          return { currentBranch: 'feature/composer', branches: [{ name: 'feature/composer', checkedOut: true }] }
        }
      })
      await chooseBranch(page.getByRole('button', { name: 'Project branch', exact: true }), 'feature/composer')
      await expect(send(page)).toBeDisabled()
      await prompt(page).press('Enter')
      await expect(prompt(page)).toHaveValue('Wait for the image')
      expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:checkout-ready')))
      await expect(send(page)).toBeEnabled()
      await prompt(page).press('Enter')
      await expect.poll(() => page.evaluate(() => window.composerTest.starts.length)).toBe(1)
    })

    test('retains the prompt and images on failure, then retries unchanged', async ({ page }) => {
      await prompt(page).fill('Retry my screenshot\n@tskc')
      await expect(page.getByRole('option', { name: 'src/TaskComposer.tsx', exact: true })).toBeVisible()
      await prompt(page).press('Enter')
      const draft = 'Retry my screenshot\n@"src/TaskComposer.tsx" '
      await expect(prompt(page)).toHaveValue(draft)
      await paste(prompt(page), [samples[0]])
      await expect(composer(page).getByRole('img')).toHaveCount(1)
      await page.evaluate(() => { window.composerTest.failNextStart = true })
      await prompt(page).press('Enter')
      await expect(composer(page).getByRole('alert')).toHaveText('Task could not be started')
      await expect(prompt(page)).toHaveValue(draft)
      await expect(composer(page).getByRole('img')).toHaveCount(1)
      await prompt(page).press('Enter')
      await expect(composer(page)).toHaveCount(0)
      const [first, second] = await page.evaluate(() => window.composerTest.starts)
      expect(first.prompt).toBe(draft.trim())
      expect(first.fileReferences).toEqual(['src/TaskComposer.tsx'])
      expect(second).toEqual(first)
      await expectUrlsReleased(page)
    })

    test('removing a pending image ignores its late read', async ({ page }) => {
      await paste(prompt(page), [{ ...samples[0], read: 'pending' }])
      await composer(page).getByRole('button', { name: 'Remove clipboard.png' }).click()
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:read-ready')))
      // A completed second read makes the ordering observable without a timed sleep.
      await paste(prompt(page), [samples[1]])
      await expect(composer(page).getByRole('img')).toHaveCount(1)
      await expect(composer(page).getByRole('img')).toHaveAttribute('alt', 'Preview of clipboard.jpeg')
    })

    test('project changes discard ready images and ignore late reads', async ({ page }) => {
      await prompt(page).fill('Old project draft')
      await paste(prompt(page), [samples[0], { ...samples[1], read: 'pending' }])
      await expect(composer(page).getByRole('img')).toHaveCount(1)
      await page.evaluate(() => window.composerTest.selectProject('project-1'))
      await expect(prompt(page)).toHaveValue('')
      await expectUrlsReleased(page)
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:read-ready')))
      await paste(prompt(page), [samples[2]])
      await expect(composer(page).getByRole('img')).toHaveCount(1)
      await send(page).click()
      await expect.poll(() => page.evaluate(() => window.composerTest.starts[0]?.projectId)).toBe('project-1')
      expect(await page.evaluate(() => window.composerTest.starts[0].images?.map((image) => image.filename))).toEqual(['clipboard.webp'])
    })

    test('closing or replacing the draft releases previews and ignores late reads', async ({ page }) => {
      await paste(prompt(page), [samples[0], { ...samples[1], read: 'pending' }])
      await expect(composer(page).getByRole('img')).toHaveCount(1)
      if (surface === 'modal') await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      else await page.getByRole('button', { name: 'Open task: Review sidebar changes', exact: true }).click()
      await expect(composer(page)).toHaveCount(0)
      await expectUrlsReleased(page)
      await page.evaluate((surface) => surface === 'modal' ? window.composerTest.openModal() : window.composerTest.overview(), surface)
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:read-ready')))
      await paste(prompt(page), [samples[2]])
      await expect(composer(page).getByRole('img')).toHaveCount(1)
      await expect(composer(page).getByRole('img')).toHaveAttribute('alt', 'Preview of clipboard.webp')
    })
  })
}
