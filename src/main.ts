import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WIDTH, HEIGHT, boardFileSchema, elementSchema, hitTest, simplify, sortedElements } from './model'
import type { BoardElement, Color, Point } from './model'
import './style.css'

function required(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing element: ${id}`)
  return element
}
function pageElements() {
  const canvas = required('board')
  const editor = required('note-editor')
  const noteText = required('note-text')
  const importInput = required('import-input')
  if (!(canvas instanceof HTMLCanvasElement) || !(editor instanceof HTMLDialogElement) || !(noteText instanceof HTMLTextAreaElement) || !(importInput instanceof HTMLInputElement)) throw new Error('Invalid page structure')
  return { canvas, editor, noteText, importInput }
}
const { canvas, editor, noteText, importInput } = pageElements()
const context = canvas.getContext('2d')
if (!context) throw new Error('Canvas is unavailable')
const ctx = context
const roomCandidate = location.hash.slice(1)
const roomId = /^[a-zA-Z0-9-]{8,80}$/.test(roomCandidate) ? roomCandidate : crypto.randomUUID()
history.replaceState(null, '', `#${roomId}`)
required('room').textContent = roomId.slice(0, 8)
const doc = new Y.Doc()
const elements = doc.getMap<unknown>('elements')
const persistence = new IndexeddbPersistence(`peerboard:${roomId}`, doc)
const signalUrl = import.meta.env.VITE_SIGNALING_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:4444`
const provider = new WebrtcProvider(`peerboard-${roomId}`, doc, {
  signaling: [signalUrl],
  maxConns: 3,
  filterBcConns: false,
})
let offline = false
let tool: 'draw' | 'note' | 'erase' = 'draw'
let color: Color = '#243247'
let activeStroke: { pointerId: number; points: Point[]; color: Color } | null = null
let editing: { kind: 'new'; x: number; y: number } | { kind: 'existing'; element: Extract<BoardElement, { type: 'note' }> } | null = null
let renderScheduled = false
let digestVersion = 0
let cachedElements: BoardElement[] = []

function announce(message: string) { required('message').textContent = message }
function drawStroke(points: Point[], strokeColor: string) {
  if (points.length === 0) return
  ctx.strokeStyle = strokeColor
  ctx.fillStyle = strokeColor
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  if (points.length === 1) {
    ctx.arc(points[0][0], points[0][1], 1.5, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.moveTo(points[0][0], points[0][1])
    for (const [x, y] of points.slice(1)) ctx.lineTo(x, y)
    ctx.stroke()
  }
}
function drawNote(element: Extract<BoardElement, { type: 'note' }>) {
  ctx.fillStyle = '#fff0b3'
  ctx.fillRect(element.x, element.y, 220, 150)
  ctx.fillStyle = element.color
  ctx.fillRect(element.x, element.y, 220, 4)
  ctx.save()
  ctx.beginPath()
  ctx.rect(element.x + 12, element.y + 12, 196, 126)
  ctx.clip()
  ctx.fillStyle = '#243247'
  ctx.font = '18px system-ui'
  const lines: string[] = []
  for (const paragraph of element.text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      if (line && ctx.measureText(candidate).width > 194) { lines.push(line); line = '' }
      for (const character of (line ? ` ${word}` : word)) {
        if (ctx.measureText(line + character).width > 194) { lines.push(line); line = '' }
        line += character
      }
    }
    lines.push(line)
  }
  lines.slice(0, 5).forEach((line, index) => {
    let visible = line
    if (index === 4 && lines.length > 5) {
      while (ctx.measureText(visible + '...').width > 194) visible = visible.slice(0, -1)
      visible += '...'
    }
    ctx.fillText(visible, element.x + 12, element.y + 32 + index * 23)
  })
  ctx.restore()
}
function render() {
  renderScheduled = false
  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const width = Math.round(rect.width * ratio)
  const height = Math.round(rect.height * ratio)
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
  ctx.setTransform(width / WIDTH, 0, 0, height / HEIGHT, 0, 0)
  ctx.clearRect(0, 0, WIDTH, HEIGHT)
  for (const element of cachedElements) {
    if (element.type === 'stroke') drawStroke(element.points, element.color)
    else drawNote(element)
  }
  if (activeStroke) drawStroke(activeStroke.points, activeStroke.color)
}
function requestRender() {
  if (!renderScheduled) { renderScheduled = true; requestAnimationFrame(render) }
}
async function updateBoard() {
  cachedElements = sortedElements(elements.values())
  required('element-count').textContent = String(cachedElements.length)
  required('invalid-count').textContent = String(elements.size - cachedElements.length)
  requestRender()
  const version = ++digestVersion
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(cachedElements)))
  if (version !== digestVersion) return
  required('fingerprint').textContent = Array.from(new Uint8Array(buffer)).map(n => n.toString(16).padStart(2, '0')).join('')
  const list = required('notes-list')
  list.replaceChildren()
  for (const element of cachedElements) {
    if (element.type !== 'note') continue
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = element.text || 'Empty note'
    button.addEventListener('click', () => openNote({ kind: 'existing', element }))
    list.append(button)
  }
}
function point(event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect()
  return [Math.max(0, Math.min(WIDTH, (event.clientX - rect.left) * WIDTH / rect.width)), Math.max(0, Math.min(HEIGHT, (event.clientY - rect.top) * HEIGHT / rect.height))]
}
function openNote(target: NonNullable<typeof editing>) {
  editing = target
  noteText.value = target.kind === 'existing' ? target.element.text : ''
  required('note-title').textContent = target.kind === 'existing' ? 'Edit sticky note' : 'New sticky note'
  editor.showModal()
  noteText.focus()
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || activeStroke) return
  const position = point(event)
  if (tool === 'note') {
    const hit = hitTest(cachedElements, position)
    openNote(hit?.type === 'note' ? { kind: 'existing', element: hit } : { kind: 'new', x: Math.min(position[0], WIDTH - 220), y: Math.min(position[1], HEIGHT - 150) })
    return
  }
  if (tool === 'erase') {
    const hit = hitTest(cachedElements, position)
    if (hit) elements.delete(hit.id)
    return
  }
  activeStroke = { pointerId: event.pointerId, points: [position], color }
  canvas.setPointerCapture(event.pointerId)
  requestRender()
})
canvas.addEventListener('pointermove', event => {
  if (!activeStroke || event.pointerId !== activeStroke.pointerId) return
  if (activeStroke.points.length < 20000) activeStroke.points.push(point(event))
  requestRender()
})
canvas.addEventListener('pointerup', event => {
  if (!activeStroke || event.pointerId !== activeStroke.pointerId) return
  const stroke: BoardElement = { id: crypto.randomUUID(), type: 'stroke', points: simplify(activeStroke.points), color: activeStroke.color, author: String(doc.clientID), createdAt: Date.now() }
  activeStroke = null
  elements.set(stroke.id, stroke)
})
canvas.addEventListener('pointercancel', () => { activeStroke = null; requestRender() })
canvas.addEventListener('lostpointercapture', () => { activeStroke = null; requestRender() })
required('save-note').addEventListener('click', () => {
  if (!editing) return
  const text = noteText.value.trim()
  if (!text) { noteText.setCustomValidity('Write a note before saving.'); noteText.reportValidity(); return }
  if (editing.kind === 'existing' && !elements.has(editing.element.id)) { editor.close(); announce('This note was deleted by a collaborator. Your edit was not saved.'); return }
  const note: BoardElement = editing.kind === 'existing' ? { ...editing.element, text } : { type: 'note', id: crypto.randomUUID(), x: editing.x, y: editing.y, text, color, author: String(doc.clientID), createdAt: Date.now() }
  elements.set(note.id, note)
  editor.close()
})
noteText.addEventListener('input', () => noteText.setCustomValidity(''))
required('cancel-note').addEventListener('click', () => editor.close())
editor.addEventListener('close', () => { editing = null })
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
  button.addEventListener('click', () => {
    const next = button.dataset.tool
    if (next !== 'draw' && next !== 'note' && next !== 'erase') return
    tool = next
    for (const other of document.querySelectorAll('[data-tool]')) other.setAttribute('aria-pressed', String(other === button))
    canvas.style.cursor = tool === 'draw' ? 'crosshair' : 'pointer'
    announce(tool === 'note' ? 'Click the board to add a note, or click an existing note to edit it.' : tool === 'erase' ? 'Click a stroke or note to erase it for everyone.' : 'Draw on the board. Completed strokes are shared with connected peers.')
  })
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-color]')) {
  button.addEventListener('click', () => {
    const parsed = elementSchema.options[0].shape.color.safeParse(button.dataset.color)
    if (!parsed.success) return
    color = parsed.data
    for (const other of document.querySelectorAll('[data-color]')) other.setAttribute('aria-pressed', String(other === button))
  })
}
function updateConnection() {
  const count = provider.room ? [...provider.room.webrtcConns.values()].filter(connection => connection.connected).length : 0
  required('peer-count').textContent = String(count)
  required('connection').textContent = offline ? 'Offline editing' : count ? `${count} ${count === 1 ? 'peer' : 'peers'} connected` : 'Waiting for peers'
  required('connection').dataset.state = offline ? 'offline' : count ? 'connected' : 'waiting'
}
required('offline').addEventListener('click', () => {
  offline = !offline
  if (offline) provider.disconnect()
  else provider.connect()
  required('offline').textContent = offline ? 'Reconnect' : 'Work offline'
  announce(offline ? 'Changes stay on this browser. Reconnect to merge with peers.' : 'Looking for peers. Offline changes will merge when a connection is established.')
  updateConnection()
})
required('share').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); announce('Board link copied. Anyone with the link can join and edit.') }
  catch { announce(`Copy the address from your browser: ${location.href}`) }
})
required('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ format: 'peerboard-v1', elements: cachedElements }, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `peerboard-${roomId.slice(0, 8)}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  announce('Board exported. Keep the file as a backup.')
})
required('import').addEventListener('click', () => importInput.click())
importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0]
  importInput.value = ''
  if (!file) return
  if (file.size > 10_000_000) { announce('Import failed: files must be smaller than 10 MB.'); return }
  try {
    const parsed = boardFileSchema.safeParse(JSON.parse(await file.text()))
    if (!parsed.success) { announce('Import failed: this is not a valid PeerBoard file.'); return }
    doc.transact(() => { for (const element of parsed.data.elements) if (!elements.has(element.id)) elements.set(element.id, element) })
    announce('Board imported. Existing elements with the same ID were kept.')
  } catch { announce('Import failed: this is not a valid JSON file.') }
})
required('clear').addEventListener('click', () => {
  const dialog = required('clear-dialog')
  if (dialog instanceof HTMLDialogElement) dialog.showModal()
})
required('cancel-clear').addEventListener('click', () => {
  const dialog = required('clear-dialog')
  if (dialog instanceof HTMLDialogElement) dialog.close()
})
required('confirm-clear').addEventListener('click', () => {
  doc.transact(() => elements.clear())
  const dialog = required('clear-dialog')
  if (dialog instanceof HTMLDialogElement) dialog.close()
  announce('The currently known elements were cleared for all peers. Concurrent new edits may still arrive.')
})
required('new-board').addEventListener('click', () => { location.hash = crypto.randomUUID() })
window.addEventListener('hashchange', () => location.reload())
new ResizeObserver(requestRender).observe(canvas)
elements.observe(() => { void updateBoard() })
provider.on('peers', updateConnection)
provider.on('synced', updateConnection)
setInterval(updateConnection, 500)
persistence.whenSynced.then(() => { required('storage').textContent = 'Saved in this browser'; void updateBoard() }).catch(() => { required('storage').textContent = 'Storage unavailable. Export a backup.' })
void updateBoard()
updateConnection()
