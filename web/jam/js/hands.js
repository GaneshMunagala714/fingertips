// Webcam hand tracking with MediaPipe Hand Landmarker (runs locally in the browser; video never leaves
// the device). Produces smoothed, stabilized per-hand features for the gesture mapper.
const VISION_VER = '0.10.14';
const VISION = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const TIPS = [4, 8, 12, 16, 20];
const PIPS = [3, 6, 10, 14, 18];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export const tuning = {
  swapHands: false,
  pinchOn: 0.33,     // pinch closes below this (thumb-index distance / hand size)
  pinchOff: 0.48,    // ...and opens above this (hysteresis)
  stableMs: 140,     // a finger count must hold this long before it counts
  lossMs: 350,       // hand missing this long = released
};

/** Per-hand state with temporal smoothing and gesture confirmation. */
class HandState {
  constructor(side) {
    this.side = side;
    this.present = false;
    this.lastSeen = 0;
    this.x = 0.5; this.y = 0.5; this.vx = 0; this.vy = 0;
    this.tilt = 0; this.openness = 0;
    this.pinch = false; this.pinchRatio = 1;
    this.rawCount = -1; this.candidate = -1; this.candidateSince = 0;
    this.count = -1;              // confirmed finger count (stable)
    this.fingers = [false, false, false, false, false];
    this.lm = null;
    this.tip = { x: 0.5, y: 0.5 }; // index fingertip (smoothed), for pointing at on-screen targets
  }

  update(lm, t) {
    const wrist = lm[0];
    const size = dist(lm[0], lm[9]) || 0.1;
    const palm = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + lm[i].x / 5, y: a.y + lm[i].y / 5 }), { x: 0, y: 0 });
    // fingers: tip further from wrist than the middle joint (with a margin); thumb measured against index base
    const f = [dist(lm[4], lm[5]) / size > 0.62 && dist(lm[4], lm[17]) > dist(lm[3], lm[17])];
    for (let i = 1; i < 5; i++) f.push(dist(lm[TIPS[i]], wrist) > dist(lm[PIPS[i]], wrist) * 1.12);
    const count = f.filter(Boolean).length;
    const dt = this.present ? Math.max(1, t - this.lastSeen) : 16;
    const a = 0.45; // EMA smoothing factor
    const nx = this.present ? this.x + (palm.x - this.x) * a : palm.x;
    const ny = this.present ? this.y + (palm.y - this.y) * a : palm.y;
    this.vx = this.present ? 0.7 * this.vx + 0.3 * ((nx - this.x) / dt) * 1000 : 0;
    this.vy = this.present ? 0.7 * this.vy + 0.3 * ((ny - this.y) / dt) * 1000 : 0;
    this.x = nx; this.y = ny;
    const tilt = Math.atan2(lm[9].x - wrist.x, -(lm[9].y - wrist.y)); // 0 = upright, + = leaning right
    this.tilt = this.present ? this.tilt + (tilt - this.tilt) * 0.35 : tilt;
    this.openness = TIPS.reduce((s, i) => s + dist(lm[i], palm), 0) / 5 / size;
    this.tip = this.present ? { x: this.tip.x + (lm[8].x - this.tip.x) * 0.5, y: this.tip.y + (lm[8].y - this.tip.y) * 0.5 } : { x: lm[8].x, y: lm[8].y };
    this.pinchRatio = dist(lm[4], lm[8]) / size;
    if (!this.pinch && this.pinchRatio < tuning.pinchOn) this.pinch = true;
    else if (this.pinch && this.pinchRatio > tuning.pinchOff) this.pinch = false;
    this.fingers = f;
    this.rawCount = count;
    if (count !== this.candidate) { this.candidate = count; this.candidateSince = t; }
    if (t - this.candidateSince >= tuning.stableMs) this.count = this.candidate;
    this.lm = lm;
    this.present = true;
    this.lastSeen = t;
  }

  checkLoss(t) {
    if (this.present && t - this.lastSeen > tuning.lossMs) {
      this.present = false; this.pinch = false; this.count = -1; this.candidate = -1; this.lm = null;
      return true;
    }
    return false;
  }
}

export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.stream = null;
    this.video = null;
    this.hands = { left: new HandState('left'), right: new HandState('right') };
    this.inferMs = 0;
    this.running = false;
    this._lastVideoTime = -1;
    this.onLoss = null; // (side) => void
  }

  async start(video) {
    this.video = video;
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    video.srcObject = this.stream;
    await video.play();
    const { FilesetResolver, HandLandmarker } = await import(`${VISION}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5 });
    try { this.landmarker = await HandLandmarker.createFromOptions(files, opts('GPU')); }
    catch (_) { this.landmarker = await HandLandmarker.createFromOptions(files, opts('CPU')); }
    this.running = true;
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    try { this.landmarker?.close(); } catch (_) {}
    this.landmarker = null;
    for (const h of Object.values(this.hands)) { h.present = false; h.pinch = false; h.count = -1; h.lm = null; }
  }

  /** Run detection on the current video frame (call once per animation frame). Returns true if new data. */
  detect() {
    if (!this.running || !this.landmarker || this.video.readyState < 2) return false;
    const t = performance.now();
    if (this.video.currentTime === this._lastVideoTime) { this._checkLoss(t); return false; }
    this._lastVideoTime = this.video.currentTime;
    const res = this.landmarker.detectForVideo(this.video, t);
    this.inferMs = this.inferMs * 0.9 + (performance.now() - t) * 0.1;
    const found = (res.landmarks || []).map((lm, i) => {
      const mirrored = lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })); // show like a mirror
      const label = res.handedness?.[i]?.[0]?.categoryName;
      // MediaPipe labels assume a pre-mirrored image; our input isn't mirrored, so the label is flipped.
      let side = label === 'Left' ? 'right' : 'left';
      if (tuning.swapHands) side = side === 'left' ? 'right' : 'left';
      return { lm: mirrored, side, x: mirrored[0].x };
    });
    if (found.length === 2) {
      // two hands: trust screen position over the classifier (more stable)
      found.sort((a, b) => a.x - b.x);
      found[0].side = tuning.swapHands ? 'right' : 'left';
      found[1].side = tuning.swapHands ? 'left' : 'right';
    }
    for (const f of found) this.hands[f.side].update(f.lm, t);
    this._checkLoss(t);
    return true;
  }

  _checkLoss(t) {
    for (const h of Object.values(this.hands)) if (h.checkLoss(t) && this.onLoss) this.onLoss(h.side);
  }
}
