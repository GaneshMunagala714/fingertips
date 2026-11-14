// Haptics you can feel AND see.
//
// Phone haptics usually play a fixed buzz, or a track someone authored ahead of time. Here every
// pulse is generated live from the music event that caused it, so the touch has the same shape as
// the sound:
//   kick  = one deep thump          snare = a sharp double tap        hat = a light tick
//   chord = a rolled tap per note, low to high (you feel how many notes, and the order)
//   melody = pitch sets the texture: low notes long and heavy, high notes short and light
// In a jam, a friend's notes reach your device too, so you feel their part as well as your own.
//
// Most screens can't vibrate (laptops, iPhone browsers), so each pattern is also drawn: rings at the
// hand that played it (one ring per pulse, thickness = strength) and a tactile strip in the side panel.
//
// Device output, where the platform allows it:
//   navigator.vibrate          Android Chrome / Firefox (on/off only; strength is shown as pulse length)
//   Gamepad vibrationActuator  Chrome with a rumble controller (real strength control)
//   iOS 18+ Safari             toggling a hidden switch control gives one system tick per pulse
//                              (best effort; Apple exposes no web haptics API)
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

const DRUM_PATTERNS = {
  kick:  [{ d: 0, ms: 40, amp: 1.0 }],
  snare: [{ d: 0, ms: 14, amp: 0.8 }, { d: 36, ms: 12, amp: 0.55 }],
  hat:   [{ d: 0, ms: 6, amp: 0.35 }],
};

/** A haptic pattern for one music event: [{ d: delay ms, ms: length, amp: 0..1, midi? }]. */
export function patternFor(ev) {
  const v = ev.velocity ?? 0.8;
  switch (ev.type) {
    case 'drum':
      return (DRUM_PATTERNS[ev.drum] || DRUM_PATTERNS.kick).map((p) => ({ ...p, amp: p.amp * (0.5 + 0.5 * v) }));
    case 'chord':
      return [...ev.notes].sort((a, b) => a - b).map((midi, i) => ({ d: i * 30, ms: 16, amp: clamp(v * (1 - i * 0.12), 0.2), midi }));
    case 'noteOn': {
      const k = clamp((ev.midi - 48) / 36);
      return [{ d: 0, ms: Math.round(30 - k * 20), amp: clamp(v * (1 - k * 0.5), 0.2), midi: ev.midi }];
    }
    case 'beat':
      return [{ d: 0, ms: ev.downbeat ? 30 : 12, amp: ev.downbeat ? 0.9 : 0.4 }];
    default:
      return [];
  }
}

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const haptics = {
  enabled: false,   // device vibration (off until the player turns it on)
  visual: true,     // visible haptics (rings + tactile strip), on for everyone
  beats: true,
  notes: true,
  history: [],      // { t, ms, amp, hue } for the tactile strip
  _iosLabel: null,

  supported() {
    return {
      vibrate: typeof navigator.vibrate === 'function' && /Android/i.test(navigator.userAgent),
      gamepad: !!this._pad(),
      ios: isIOS,
    };
  },
  available() { const s = this.supported(); return s.vibrate || s.gamepad || s.ios; },
  describe() {
    const s = this.supported();
    if (s.vibrate) return 'Phone vibration available. Each sound has its own pattern: thump, double tap, tick, rolled chord.';
    if (s.gamepad) return 'Controller rumble available, with real strength control.';
    if (s.ios) return 'iPhone: one system tick per pulse (best effort, iOS 18+). Visible haptics show the full pattern.';
    return 'This device has no vibration motor the browser can use. Visible haptics show every pulse on screen instead.';
  },
  _pad() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    return pads.find((p) => p.vibrationActuator) || null;
  },

  /** Play a pattern on the device and log it for the tactile strip. */
  play(pattern, hue = null) {
    if (!pattern.length) return;
    const now = performance.now();
    for (const p of pattern) this.history.push({ t: now + p.d, ms: p.ms, amp: p.amp, hue });
    if (this.history.length > 120) this.history.splice(0, this.history.length - 120);
    if (!this.enabled) return;
    const s = this.supported();
    if (s.vibrate) {
      // vibrate() takes [on, off, on, ...]; weaker pulses get a shorter on-time
      const seq = [];
      let cursor = 0;
      for (const p of pattern) {
        const gap = Math.max(0, p.d - cursor);
        if (seq.length) seq.push(gap); else if (gap) seq.push(0, gap);
        const on = Math.max(5, Math.round(p.ms * (0.4 + 0.6 * p.amp)));
        seq.push(on);
        cursor = p.d + on;
      }
      navigator.vibrate(seq);
    }
    const pad = this._pad();
    if (pad) for (const p of pattern) {
      setTimeout(() => pad.vibrationActuator.playEffect?.('dual-rumble',
        { duration: p.ms, strongMagnitude: p.amp, weakMagnitude: p.amp / 2 }).catch(() => {}), p.d);
    }
    if (s.ios) for (const p of pattern) setTimeout(() => this._iosTick(), p.d);
  },

  _iosTick() {
    if (!this._iosLabel) {
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.setAttribute('switch', ''); input.tabIndex = -1;
      label.appendChild(input);
      document.body.appendChild(label);
      this._iosLabel = label;
    }
    this._iosLabel.click();
  },

  /** Draw the tactile strip: the last 2.4 s of pulses, newest on the right. */
  drawStrip(canvas) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const now = performance.now(), span = 2400, mid = h / 2;
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(0, mid - 0.5, w, 1);
    for (const p of this.history) {
      const age = now - p.t;
      if (age < 0 || age > span) continue;
      const x = w - (age / span) * w;
      const bw = Math.max(2, (p.ms / span) * w * 2.2);
      const bh = Math.max(2, p.amp * (h - 4));
      const fresh = Math.max(0, 1 - age / 300);
      const alpha = 0.35 + 0.65 * (1 - age / span);
      g.fillStyle = p.hue == null ? `rgba(245,245,247,${alpha * 0.45})` : `hsla(${p.hue},90%,${62 + fresh * 18}%,${alpha})`;
      roundRect(g, x - bw, mid - bh / 2, bw, bh, Math.min(bw, bh) / 2);
    }
  },
};

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
}
