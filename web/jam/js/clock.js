// Room clock: wall-clock ms corrected by the server offset (NTP-style ping). Solo mode uses offset 0.
// Converts room time <-> AudioContext time so beats and remote events land on the audio clock.
export const clock = {
  offset: 0,            // serverTime - localTime (ms)
  rtt: null,            // last measured round trip (ms)
  ctx: null,            // AudioContext once started
  _anchor: null,        // { audio: ctx.currentTime, room: ms } re-taken periodically to avoid drift
  now() { return Date.now() + this.offset; },
  setSample(clientSent, serverTime, clientRecv) {
    const rtt = clientRecv - clientSent;
    const off = serverTime - (clientSent + clientRecv) / 2;
    // keep the sample with the smallest rtt in a sliding window; simple smoothing
    if (this.rtt == null || rtt < this.rtt * 1.5) {
      this.offset = this.rtt == null ? off : this.offset * 0.7 + off * 0.3;
    }
    this.rtt = this.rtt == null ? rtt : this.rtt * 0.7 + rtt * 0.3;
    this._anchor = null;
  },
  /** Room ms -> AudioContext seconds. */
  toAudio(roomMs) {
    if (!this.ctx) return 0;
    const a = this.ctx.currentTime;
    if (!this._anchor || Math.abs((a - this._anchor.audio) * 1000 - (this.now() - this._anchor.room)) > 30) {
      this._anchor = { audio: a, room: this.now() };
    }
    return this._anchor.audio + (roomMs - this._anchor.room) / 1000;
  },
  toRoom(audioSec) {
    if (!this.ctx) return this.now();
    if (!this._anchor) this.toAudio(this.now());
    return this._anchor.room + (audioSec - this._anchor.audio) * 1000;
  },
};
