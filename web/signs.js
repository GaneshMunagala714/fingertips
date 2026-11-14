// Hand signs -> replies, in the browser. MediaPipe Gesture Recognizer (Google's canned hand-sign model).
// A sign has to be held steady for HOLD_MS before it fires, and the same sign won't fire twice in a row
// until the hand changes or drops, so a resting hand doesn't keep talking.
const VER = '0.10.14'
const VISION = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`
const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
const HOLD_MS = 700
const COOLDOWN_MS = 1200
const MIN_SCORE = 0.62

export const SIGNS = {
  Thumb_Up: { label: 'Thumb up', say: 'Yes.' },
  Thumb_Down: { label: 'Thumb down', say: 'No.' },
  Open_Palm: { label: 'Open palm', say: 'One moment, please.' },
  Pointing_Up: { label: 'Point up', say: 'Could you repeat that, please?' },
  Victory: { label: 'Two fingers', say: 'Thank you!' },
  ILoveYou: { label: 'I love you (ASL)', say: 'Thank you, goodbye!' },
  Closed_Fist: { label: 'Fist', say: null, hint: 'Says the top suggestion' },
}

let recognizer = null, loading = null, stream = null, video = null, running = false, cb = null
let held = null, since = 0, lastFired = null, lastFireAt = 0, lastTs = -1

async function load() {
  if (recognizer) return recognizer
  loading ??= (async () => {
    const { FilesetResolver, GestureRecognizer } = await import(`${VISION}/vision_bundle.mjs`)
    const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`)
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numHands: 1,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 })
    try { recognizer = await GestureRecognizer.createFromOptions(files, opts('GPU')) }
    catch { recognizer = await GestureRecognizer.createFromOptions(files, opts('CPU')) }
    return recognizer
  })()
  return loading
}

export async function start(videoEl, callbacks) {
  cb = callbacks; video = videoEl
  if (running) return
  running = true
  cb.onState?.({ phase: 'starting' })
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false })
    if (!running) { stopTracks(); return }
    video.srcObject = stream
    await video.play().catch(() => {})
    cb.onState?.({ phase: 'loading' })
    await load()
  } catch (e) {
    running = false; stopTracks()
    cb.onState?.({ phase: 'error', message: e?.name === 'NotAllowedError' ? 'Camera blocked. Allow it in the address bar.' : `Camera unavailable (${e?.message || e})` })
    return
  }
  if (!running) return
  held = null; lastFired = null
  cb.onState?.({ phase: 'ready' })
  tick()
}

export function stop() {
  running = false
  stopTracks()
  cb?.onState?.({ phase: 'off' })
}
export const isOn = () => running

function stopTracks() {
  stream?.getTracks().forEach((t) => t.stop()); stream = null
  if (video) video.srcObject = null
}

function tick() {
  if (!running) return
  const next = () => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick))
  if (video.readyState < 2) return next()
  const now = performance.now()
  if (now <= lastTs) return next()
  lastTs = now
  let res
  try { res = recognizer.recognizeForVideo(video, now) } catch { return next() }
  const g = res.gestures?.[0]?.[0]
  const hand = !!res.landmarks?.length
  const cur = g && g.score >= MIN_SCORE && SIGNS[g.categoryName] ? g.categoryName : null
  if (cur !== held) { held = cur; since = now }
  if (cur !== lastFired) lastFired = null          // the hand changed or dropped: that sign can fire again
  const canFire = held && held !== lastFired
  const progress = canFire ? Math.min(1, (now - since) / HOLD_MS) : 0
  if (canFire && progress >= 1 && now - lastFireAt > COOLDOWN_MS) {
    lastFired = held; lastFireAt = now
    cb.onSign?.(held, SIGNS[held])
  }
  cb.onState?.({ phase: 'ready', sign: held, score: g?.score || 0, hand, progress, fired: held && held === lastFired })
  next()
}
