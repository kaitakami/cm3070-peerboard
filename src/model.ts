import { z } from 'zod'

export const WIDTH = 1600
export const HEIGHT = 1000
const coordinate = z.number().finite().min(0).max(WIDTH)
export const pointSchema = z.tuple([coordinate, z.number().finite().min(0).max(HEIGHT)])
export type Point = z.infer<typeof pointSchema>
const common = {
  id: z.string().uuid(),
  author: z.string().max(80),
  createdAt: z.number().finite().nonnegative(),
  color: z.enum(['#243247', '#d94747', '#3569d4', '#238566', '#bd6b16']),
}
export const elementSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('stroke'), points: z.array(pointSchema).min(1).max(20000) }),
  z.object({ ...common, type: z.literal('note'), x: coordinate, y: z.number().finite().min(0).max(HEIGHT), text: z.string().max(280) }),
])
export type BoardElement = z.infer<typeof elementSchema>
export type Color = BoardElement['color']
export const boardFileSchema = z.object({ format: z.literal('peerboard-v1'), elements: z.array(elementSchema).max(10000) })
export function sortedElements(values: Iterable<unknown>): BoardElement[] {
  const result: BoardElement[] = []
  for (const value of values) {
    const parsed = elementSchema.safeParse(value)
    if (parsed.success) result.push(parsed.data)
  }
  return result.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
export function distanceSquared(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const length = dx * dx + dy * dy
  const fraction = length === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length))
  return (point[0] - start[0] - fraction * dx) ** 2 + (point[1] - start[1] - fraction * dy) ** 2
}
export function simplify(points: Point[], tolerance = 1.2): Point[] {
  if (points.length <= 2) return points.slice()
  const keep = new Set([0, points.length - 1])
  const pending: [number, number][] = [[0, points.length - 1]]
  while (pending.length) {
    const segment = pending.pop()
    if (!segment) break
    const [first, last] = segment
    let furthest = -1
    let distance = tolerance * tolerance
    for (let index = first + 1; index < last; index++) {
      const candidate = distanceSquared(points[index], points[first], points[last])
      if (candidate > distance) { distance = candidate; furthest = index }
    }
    if (furthest !== -1) {
      keep.add(furthest)
      pending.push([first, furthest], [furthest, last])
    }
  }
  return [...keep].sort((a, b) => a - b).map(index => points[index])
}
export function hitTest(elements: BoardElement[], point: Point): BoardElement | undefined {
  return elements.slice().reverse().find(element => {
    if (element.type === 'note') return point[0] >= element.x && point[0] <= element.x + 220 && point[1] >= element.y && point[1] <= element.y + 150
    if (element.points.length === 1) return distanceSquared(point, element.points[0], element.points[0]) < 100
    return element.points.slice(1).some((end, i) => distanceSquared(point, element.points[i], end) < 100)
  })
}
