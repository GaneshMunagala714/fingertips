// ASL words from the camera. MediaPipe pose + both hands per frame -> one segment per sign -> server model
// (SignBart-ASL-2730 via Fingertip). Segmenting rule, made for a laptop camera:
//   a sign starts when a hand comes up into view and moves;
//   it ends when the hands drop out of view, or hold still for ~0.45 s, or after 3.5 s;
//   the phrase ends when the hands stay down for 1.4 s.
const VER = '0.10.14'
const VISION = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

const GONE_MS = 280          // hands out of view this long = sign over
const STILL_MS = 450         // hands still this long = sign over
const STILL_SPEED = 0.0035   // wrist motion per frame (normalized) that counts as still
const MOVE_SPEED = 0.008     // motion needed to start the next sign after a still-ending
const MAX_MS = 3500
const MIN_FRAMES = 8
const PHRASE_MS = 1400

let hands = null, pose = null, loading = null
let stream = null, video = null, running = false, cb = null, watchdog = null, scheduled = false
let lastTs = -1, lastTick = 0
let seg = null               // { frames: [], t0, stillSince }
let preroll = []
let goneSince = 0, armed = true, lastWrist = null, phraseOpen = false

async function load() {
  if (hands && pose) return
  loading ??= (async () => {
    const { FilesetResolver, HandLandmarker, PoseLandmarker } = await import(`${VISION}/vision_bundle.mjs`)
    const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`)
    const make = async (Cls, opts) => {
      try { return await Cls.createFromOptions(files, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }) }
      catch { return await Cls.createFromOptions(files, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }) }
    }
    hands = await make(HandLandmarker, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.45, minHandPresenceConfidence: 0.45, minTrackingConfidence: 0.45 })
    pose = await make(PoseLandmarker, { baseOptions: { modelAssetPath: POSE_MODEL }, runningMode: 'VIDEO', numPoses: 1 })
  })()
  return loading
}

export async function start(videoEl, callbacks) {
  cb = callbacks; video = videoEl
  if (running) return
  running = true
  cb.onState?.({ phase: 'starting' })
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false })
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
  seg = null; preroll = []; goneSince = 0; armed = true; phraseOpen = false
  cb.onState?.({ phase: 'ready' })
  schedule()
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
  seg = null
  cb?.onState?.({ phase: 'off' })
}
export const isOn = () => running

function stopTracks() {
  stream?.getTracks().forEach((t) => t.stop()); stream = null
  if (video) video.srcObject = null
}

function schedule() {
  if (!running || scheduled) return
  scheduled = true
  const go = () => { scheduled = false; tick() }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(go); else requestAnimationFrame(go)
}
function tick() {
  if (!running) return
  lastTick = performance.now()
  try { step() } catch (e) { console.warn('asl: frame skipped', e) }
  schedule()
}

const r4 = (v) => Math.round(v * 1e4) / 1e4
const xyz = (lms) => lms.map((p) => [r4(p.x), r4(p.y), r4(p.z ?? 0)])

function step() {
  if (video.readyState < 2 || !hands) return
  const now = performance.now()
  if (now <= lastTs) return
  lastTs = now
  const h = hands.detectForVideo(video, now)
  const p = pose.detectForVideo(video, now)
  const frame = { pose: p.landmarks?.[0] ? xyz(p.landmarks[0]) : null, lh: null, rh: null }
  const wrists = []
  ;(h.landmarks || []).forEach((lm, i) => {
    const side = h.handedness?.[i]?.[0]?.categoryName === 'Left' ? 'lh' : 'rh'
    frame[frame[side] ? (side === 'lh' ? 'rh' : 'lh') : side] = xyz(lm)
    wrists.push(lm[0])
  })
  const visible = wrists.length > 0

  // wrist speed (average over visible hands, vs the previous frame)
  let speed = 0
  if (visible && lastWrist) speed = Math.hypot(wrists[0].x - lastWrist.x, wrists[0].y - lastWrist.y)
  lastWrist = visible ? wrists[0] : null

  if (!seg) {
    preroll.push(frame); if (preroll.length > 4) preroll.shift()
    if (visible) goneSince = 0
    else { goneSince ||= now; armed = true }
    if (visible && (armed || speed > MOVE_SPEED)) {
      seg = { frames: [...preroll], t0: now, stillSince: 0 }
      armed = false; phraseOpen = true
    } else if (!visible && phraseOpen && now - goneSince > PHRASE_MS) {
      phraseOpen = false
      cb.onPhraseEnd?.()
    }
  } else {
    seg.frames.push(frame)
    if (visible) { goneSince = 0; seg.stillSince = speed < STILL_SPEED ? (seg.stillSince || now) : 0 } else goneSince ||= now
    const dur = now - seg.t0
    const why = !visible && now - goneSince > GONE_MS ? 'dropped'
      : seg.stillSince && now - seg.stillSince > STILL_MS && dur > 600 ? 'still'
      : dur > MAX_MS ? 'long' : null
    if (why) {
      const frames = seg.frames.filter((f) => f.lh || f.rh)
      seg = null
      if (why !== 'dropped') armed = false        // wait for real movement before the next sign
      if (frames.length >= MIN_FRAMES) cb.onSegment?.(frames, why)
    }
  }
  cb.onState?.({ phase: 'ready', visible, signing: !!seg, ms: seg ? now - seg.t0 : 0 })
}
