// Optional beat/note haptics, only where the platform actually supports it.
// - navigator.vibrate: Android Chrome/Firefox (not iOS Safari, not most desktops)
// - Gamepad vibrationActuator: Chrome with a rumble-capable controller connected
export const haptics = {
  enabled: false,
  beats: true,
  notes: false,
  supported() {
    return { vibrate: typeof navigator.vibrate === 'function' && /Android/i.test(navigator.userAgent),
             gamepad: !!this._pad() };
  },
  available() { const s = this.supported(); return s.vibrate || s.gamepad; },
  describe() {
    const s = this.supported();
    if (s.vibrate) return 'Phone vibration available';
    if (s.gamepad) return 'Controller rumble available';
    return 'No vibration hardware detected on this device (desktop browsers and iPhone Safari cannot vibrate). The visual pulse still shows every beat.';
  },
  _pad() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    return pads.find((p) => p.vibrationActuator) || null;
  },
  pulse(ms, strong = 0.6) {
    if (!this.enabled) return;
    const s = this.supported();
    if (s.vibrate) navigator.vibrate(ms);
    const pad = this._pad();
    if (pad) pad.vibrationActuator.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: strong / 2 }).catch(() => {});
  },
  beat(downbeat) { if (this.beats) this.pulse(downbeat ? 45 : 18, downbeat ? 0.9 : 0.4); },
  note() { if (this.notes) this.pulse(12, 0.3); },
};
