// Sign firing logic with a fake, flickery recognizer: node --test tests/signs/
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.navigator ??= {}
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } }, configurable: true })
const signs = await import('../../web/signs.js')

function run(script, ms) {
  // script(t) -> {name, score} | null (no hand)
  let t0 = performance.now()
  signs._setRecognizer({ recognizeForVideo: () => {
    const g = script(performance.now() - t0)
    return g ? { gestures: [[{ categoryName: g.name, score: g.score }]], landmarks: [[{}]] } : { gestures: [], landmarks: [] }
  } })
  const video = { readyState: 4, paused: false, play: async () => {}, requestVideoFrameCallback: (f) => setTimeout(f, 33) }
  const fired = []
  return new Promise((resolve) => {
    signs.start(video, { onSign: (n) => fired.push([Math.round(performance.now() - t0), n]) })
    setTimeout(() => { signs.stop(); resolve(fired) }, ms)
  })
}

test('a held sign fires once even when every 4th frame flickers to None', async () => {
  let i = 0
  const fired = await run(() => (++i % 4 === 0 ? { name: 'None', score: 0.9 } : { name: 'Thumb_Up', score: 0.7 }), 2500)
  assert.equal(fired.length, 1, JSON.stringify(fired))
  assert.equal(fired[0][1], 'Thumb_Up')
  assert.ok(fired[0][0] < 1200, `fired late: ${fired[0][0]} ms`)
})

test('changing sign fires the new one; dropping the hand re-arms the same sign', async () => {
  const fired = await run((t) => t < 1200 ? { name: 'Thumb_Up', score: 0.8 }
    : t < 2400 ? { name: 'Victory', score: 0.8 }
    : t < 2800 ? null
    : { name: 'Victory', score: 0.8 }, 4200)
  assert.deepEqual(fired.map((f) => f[1]), ['Thumb_Up', 'Victory', 'Victory'])
})

test('a sign flashed briefly does not fire', async () => {
  const fired = await run((t) => (t > 300 && t < 600 ? { name: 'Closed_Fist', score: 0.9 } : { name: 'None', score: 0.9 }), 1800)
  assert.equal(fired.length, 0)
})
