// Hand signs -> replies, in the browser. MediaPipe Gesture Recognizer (Google's canned hand-sign model).
// A sign has to be held steady for HOLD_MS before it fires, and the same sign won't fire twice in a row
// until the hand changes or drops, so a resting hand doesn't keep talking.
const VER = '0.10.14'
const VISION = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`
const MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'
const HOLD_MS = 650
const COOLDOWN_MS = 1200
const MIN_SCORE = 0.5

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
let frames = []            // recent frames: { t, sign, score, hand }
let lastFired = null, lastFireAt = 0, lastTs = -1, lastTick = 0, watchdog = null, absentSince = 0

async function load() {
  if (recognizer) return recognizer
  loading ??= (async () => {
    const { FilesetResolver, GestureRecognizer } = await import(`${VISION}/vision_bundle.mjs`)
    const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`)
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numHands: 1,
      minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4 })
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
  frames = []; lastFired = null
  cb.onState?.({ phase: 'ready' })
  schedule()
  // If Chrome stops delivering video-frame callbacks (window hidden, a decoder hiccup), keep going on a timer.
  clearInterval(watchdog)
  watchdog = setInterval(() => {
    if (!running) return
    if (video.paused) video.play().catch(() => {})
    if (performance.now() - lastTick > 400) tick()
  }, 250)
}

export function stop() {
  running = false
  clearInterval(watchdog); watchdog = null
  stopTracks()
  cb?.onState?.({ phase: 'off' })
}
export const isOn = () => running

function stopTracks() {
  stream?.getTracks().forEach((t) => t.stop()); stream = null
  if (video) video.srcObject = null
}

let scheduled = false
function schedule() {
  if (!running || scheduled) return
  scheduled = true
  const go = () => { scheduled = false; tick() }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(go); else requestAnimationFrame(go)
}

// Vote over the last HOLD_MS of frames instead of demanding an unbroken streak, so one shaky frame
// doesn't restart the hold.
function tick() {
  if (!running) return
  lastTick = performance.now()
  try { step() } catch (e) { console.warn('signs: frame skipped', e) }
  schedule()
}

function step() {
  if (video.readyState < 2 || !recognizer) return
  const now = performance.now()
  if (now <= lastTs) return
  lastTs = now
  const res = recognizer.recognizeForVideo(video, now)
  const g = res.gestures?.[0]?.[0]
  const hand = !!res.landmarks?.length
  const sign = g && g.score >= MIN_SCORE && SIGNS[g.categoryName] ? g.categoryName : null
  frames.push({ t: now, sign, hand })
  while (frames.length && now - frames[0].t > HOLD_MS) frames.shift()

  // which sign dominates the window, and for how long has the window been filling
  const counts = {}
  for (const f of frames) if (f.sign) counts[f.sign] = (counts[f.sign] || 0) + 1
  let best = null, n = 0
  for (const [k, v] of Object.entries(counts)) if (v > n) { best = k; n = v }
  const share = frames.length ? n / frames.length : 0
  const span = frames.length ? now - frames[0].t : 0

  // re-arm: hand gone for 250 ms, or a different sign took over
  if (!hand) { absentSince ||= now; if (now - absentSince > 250) lastFired = null } else absentSince = 0
  if (lastFired && frames.length && (counts[lastFired] || 0) / frames.length < 0.35) lastFired = null   // that sign faded out

  const canFire = best && best !== lastFired && share >= 0.6
  const progress = canFire ? Math.min(1, (span / HOLD_MS) * Math.min(1, share / 0.6)) : 0
  if (canFire && span >= HOLD_MS * 0.9 && frames.length >= 4 && now - lastFireAt > COOLDOWN_MS) {
    lastFired = best; lastFireAt = now
    cb.onSign?.(best, SIGNS[best])
  }
  cb.onState?.({ phase: 'ready', sign: best && share >= 0.4 ? best : null, raw: g ? `${g.categoryName} ${Math.round(g.score * 100)}%` : '',
    hand, progress, fired: best && best === lastFired })
}

// tests only: inject a fake recognizer instead of downloading the model
export function _setRecognizer(r) { recognizer = r; loading = Promise.resolve(r) }
