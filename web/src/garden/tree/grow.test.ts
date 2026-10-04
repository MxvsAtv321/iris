import { describe, expect, it } from 'vitest'
import { growTree, CROWN, SLOTS } from './grow'

describe('growTree', () => {
  const tree = growTree(7)

  it('grows the same tree every time for the same seed', () => {
    const again = growTree(7)
    expect(again.chains.length).toBe(tree.chains.length)
    expect(again.slots[123]).toEqual(tree.slots[123])
  })

  it('has room for thousands of leaves', () => {
    expect(tree.slots.length).toBe(SLOTS)
  })

  it('has a massive trunk that starts at the ground', () => {
    const trunk = tree.chains[0]
    expect(trunk.points[0][1]).toBe(0)
    expect(trunk.radii[0]).toBeGreaterThan(4.5)
  })

  it('spreads a crown far wider than it is tall', () => {
    const xs = tree.slots.map((s) => s.p[0])
    const ys = tree.slots.map((s) => s.p[1])
    const width = Math.max(...xs) - Math.min(...xs)
    const height = Math.max(...ys) - Math.min(...ys)
    expect(width).toBeGreaterThan(36)
    expect(width).toBeGreaterThan(height * 1.8)
    expect(Math.min(...ys)).toBeGreaterThan(CROWN.floor - 3)
  })

  it('reaches both sides, for the two great limbs', () => {
    const left = tree.slots.filter((s) => s.p[0] < -8).length
    const right = tree.slots.filter((s) => s.p[0] > 8).length
    expect(left).toBeGreaterThan(3000)
    expect(right).toBeGreaterThan(3000)
  })

  it('tapers every branch toward its tip', () => {
    for (const c of tree.chains) {
      expect(c.radii[c.radii.length - 1]).toBeLessThanOrEqual(c.radii[1] + 1e-6)
      expect(c.points.length).toBe(c.radii.length)
      expect(c.points.length).toBe(c.along.length)
    }
  })
})
