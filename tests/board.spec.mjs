import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { simplify, distanceSquared } from '../src/model.ts'

async function peers(browser, count = 2, room = randomUUID()) {
  const contexts = await Promise.all(Array.from({ length: count }, () => browser.newContext({ viewport: { width: 1440, height: 1100 } })))
  const pages = await Promise.all(contexts.map(async context => {
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:5174/#${room}`)
    await expect(page.locator('#storage')).toHaveText('Saved in this browser')
    return page
  }))
  for (const page of pages) await expect(page.locator('#peer-count')).toHaveText(String(count - 1), { timeout: 30000 })
  return { pages, close: () => Promise.all(contexts.map(context => context.close())) }
}
async function draw(page, x = 200, y = 220) {
  await page.getByRole('button', { name: 'Draw', exact: true }).click()
  const box = await page.locator('#board').boundingBox()
  await page.mouse.move(box.x + x * box.width / 1600, box.y + y * box.height / 1000)
  await page.mouse.down()
  await page.mouse.move(box.x + (x + 160) * box.width / 1600, box.y + (y + 70) * box.height / 1000, { steps: 20 })
  await page.mouse.up()
}
async function note(page, text, x = 550, y = 250) {
  await page.getByRole('button', { name: 'Sticky note', exact: true }).click()
  const box = await page.locator('#board').boundingBox()
  await page.locator('#board').click({ position: { x: x * box.width / 1600, y: y * box.height / 1000 } })
  await page.getByLabel('Your note').fill(text)
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
}
async function sameState(pages, count) {
  for (const page of pages) await expect(page.locator('#element-count')).toHaveText(String(count))
  await expect.poll(async () => {
    const hashes = await Promise.all(pages.map(page => page.locator('#fingerprint').textContent()))
    return hashes.every(hash => /^[a-f0-9]{64}$/.test(hash) && hash === hashes[0])
  }).toBe(true)
}
async function exportBoard(page) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export board', exact: true }).click()
  const download = await downloadPromise
  return JSON.parse(await readFile(await download.path(), 'utf8'))
}

test('Ramer–Douglas–Peucker preserves endpoints and bounded error', () => {
  const points = Array.from({ length: 301 }, (_, x) => [x, 100 + Math.sin(x / 20) * 40])
  const output = simplify(points)
  expect(output[0]).toEqual([0, 100])
  expect(output.at(-1)).toEqual(points.at(-1))
  expect(output.length).toBeLessThan(60)
  for (const point of points) expect(Math.min(...output.slice(1).map((end, index) => distanceSquared(point, output[index], end)))).toBeLessThanOrEqual(1.2 ** 2 + 1e-8)
  expect(simplify([])).toEqual([])
  expect(simplify([[1, 2]])).toEqual([[1, 2]])
})

test('four independent WebRTC peers converge after concurrent drawings and notes', async ({ browser }) => {
  const group = await peers(browser, 4)
  try {
    await Promise.all(group.pages.map((page, index) => draw(page, 120 + index * 200, 150 + index * 100)))
    await sameState(group.pages, 4)
    await Promise.all(group.pages.map((page, index) => note(page, `Peer ${index + 1}: plan a shared idea`, 200 + index * 270, 600)))
    await sameState(group.pages, 8)
    const data = await exportBoard(group.pages[0])
    expect(data.elements.filter(e => e.type === 'stroke')).toHaveLength(4)
    expect(data.elements.filter(e => e.type === 'note').map(e => e.text).sort()).toEqual([1,2,3,4].map(i => `Peer ${i}: plan a shared idea`))
    await group.pages[0].screenshot({ path: 'evidence/four-peer-board.png', fullPage: true })
  } finally { await group.close() }
})

test('partitioned edits merge after reconnect and late join receives complete state', async ({ browser }) => {
  const group = await peers(browser)
  let extra
  try {
    const [a, b] = group.pages
    await draw(a)
    await sameState([a,b], 1)
    await b.getByRole('button', { name: 'Work offline', exact: true }).click()
    await expect(b.locator('#connection')).toHaveText('Offline editing')
    await Promise.all([draw(a, 500, 100), note(b, 'Created while disconnected')])
    await expect(a.locator('#element-count')).toHaveText('2')
    await expect(b.locator('#element-count')).toHaveText('2')
    expect(await a.locator('#fingerprint').textContent()).not.toBe(await b.locator('#fingerprint').textContent())
    await b.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await sameState([a,b], 3)
    extra = await browser.newContext()
    const c = await extra.newPage()
    await c.goto(a.url())
    await sameState([a,b,c], 3)
    await expect(c.locator('#peer-count')).toHaveText('2')
  } finally { if (extra) await extra.close(); await group.close() }
})

test('concurrent versions of one note converge to one complete value', async ({ browser }) => {
  const group = await peers(browser)
  try {
    const [a,b] = group.pages
    await note(a, 'Original note')
    await sameState([a,b], 1)
    await b.getByRole('button', { name: 'Work offline', exact: true }).click()
    await Promise.all([note(a, 'Version written by A'), note(b, 'Version written by B')])
    await b.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await sameState([a,b], 1)
    const [left,right] = await Promise.all([exportBoard(a),exportBoard(b)])
    expect(left).toEqual(right)
    expect(['Version written by A','Version written by B']).toContain(left.elements[0].text)
  } finally { await group.close() }
})

test('erasing an existing stroke merges with a concurrent new stroke', async ({ browser }) => {
  const group = await peers(browser)
  try {
    const [a,b] = group.pages
    await draw(a)
    await sameState([a,b], 1)
    await b.getByRole('button', { name: 'Work offline', exact: true }).click()
    await a.getByRole('button', { name: 'Erase', exact: true }).click()
    const box = await a.locator('#board').boundingBox()
    await a.locator('#board').click({ position: { x: 280 * box.width / 1600, y: 255 * box.height / 1000 } })
    await expect(a.locator('#element-count')).toHaveText('0')
    await draw(b, 800, 700)
    await b.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await sameState([a,b], 1)
    const data = await exportBoard(a)
    expect(data.elements[0].points[0][0]).toBeGreaterThan(790)
  } finally { await group.close() }
})

test('browser persistence survives reload and separate rooms remain isolated', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    const a = await context.newPage()
    await a.goto(`http://127.0.0.1:5174/#${randomUUID()}`)
    await expect(a.locator('#storage')).toHaveText('Saved in this browser')
    await note(a, 'Keep this across reloads')
    const before = await exportBoard(a)
    await a.reload()
    await expect(a.locator('#element-count')).toHaveText('1')
    expect(await exportBoard(a)).toEqual(before)
    const b = await context.newPage()
    await b.goto(`http://127.0.0.1:5174/#${randomUUID()}`)
    await expect(b.locator('#storage')).toHaveText('Saved in this browser')
    await draw(b)
    await expect(b.locator('#element-count')).toHaveText('1')
    expect((await exportBoard(b)).elements[0].type).toBe('stroke')
    expect(await exportBoard(a)).toEqual(before)
  } finally { await context.close() }
})

test('import validates files, exports round-trip, and clear requires confirmation', async ({ page }) => {
  await page.goto(`/#${randomUUID()}`)
  await note(page, 'Export and restore this')
  const data = await exportBoard(page)
  await page.getByRole('button', { name: 'Clear board', exact: true }).click()
  await page.getByRole('button', { name: 'Keep board', exact: true }).click()
  await expect(page.locator('#element-count')).toHaveText('1')
  await page.getByRole('button', { name: 'Clear board', exact: true }).click()
  await page.getByRole('button', { name: 'Clear for everyone', exact: true }).click()
  await expect(page.locator('#element-count')).toHaveText('0')
  await page.locator('#import-input').setInputFiles({ name: 'board.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) })
  await expect(page.locator('#element-count')).toHaveText('1')
  expect(await exportBoard(page)).toEqual(data)
  await page.locator('#import-input').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"peerboard-v1","elements":[{"type":"stroke"}]}') })
  await expect(page.locator('#message')).toContainText('Import failed')
  expect(await exportBoard(page)).toEqual(data)
})

test('local WebRTC note propagation measurements retain raw observations', async ({ browser }) => {
  const group = await peers(browser)
  try {
    const [a,b] = group.pages
    const values = []
    for (let index = 0; index < 20; index++) {
      await a.getByRole('button', { name: 'Sticky note', exact: true }).click()
      const box = await a.locator('#board').boundingBox()
      await a.locator('#board').click({ position: { x: 30 + (index % 5) * 135, y: 30 + Math.floor(index / 5) * 100 } })
      await a.getByLabel('Your note').fill(`Latency sample ${index + 1}`)
      const started = performance.now()
      await a.getByRole('button', { name: 'Save note', exact: true }).click()
      await expect.poll(async () => b.locator('#notes-list').textContent(), { intervals: [5,10,20,50] }).toContain(`Latency sample ${index + 1}`)
      values.push(performance.now() - started)
    }
    const sorted = values.slice().sort((a,b) => a-b)
    await writeFile('evidence/latency.json', JSON.stringify({ date: new Date().toISOString(), environment: 'Two isolated Chromium contexts on one machine, direct WebRTC; browser-driver Save click to the remote note appearing in the DOM. Includes automation, hashing and polling overhead. Not a pure network latency measurement.', sampleCount: values.length, milliseconds: values, medianMs: (sorted[9]+sorted[10])/2, p95Ms: sorted[18] }, null, 2))
  } finally { await group.close() }
})
