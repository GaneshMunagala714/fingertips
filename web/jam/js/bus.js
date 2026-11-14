// The canonical musical event model + bus. Every sound, visual, haptic pulse, recording and network
// message is driven by these events, so what you see is exactly what is being played.
//
// MusicEvent {
//   id, playerId, type: 'chord'|'chordOff'|'noteOn'|'noteOff'|'drum'|'expr'|'allOff',
//   t        room-clock ms when it sounds (shared between players)
//   midi     (noteOn/noteOff)   notes, chord, degree (chord)   drum: 'kick'|'snare'|'hat'
//   velocity 0..1   instrument   volume/filter 0..1 (expr)   dur ms (optional)
//   origin: 'local'|'remote'|'replay'
// }
import { clock } from './clock.js';

export const JITTER_MS = 80;
let seq = 0;
const rand = Math.random().toString(36).slice(2, 7);
export const newId = () => `${rand}${(seq++).toString(36)}`;

const handlers = new Set();
const listeners = new Set();   // non-music UI listeners (beat, status)

export const bus = {
  playerId: 'p1',
  on(fn) { handlers.add(fn); return () => handlers.delete(fn); },
  /** Emit a musical event. Fills in id/time/player for local events. */
  emit(ev) {
    if (!ev.id) ev.id = newId();
    if (ev.t == null) ev.t = clock.now();
    if (!ev.playerId) ev.playerId = this.playerId;
    if (!ev.origin) ev.origin = 'local';
    // `at` = room ms when this event actually sounds/appears. Remote events get a short jitter
    // buffer so network wobble doesn't smear their rhythm; anything already late plays immediately.
    const now = clock.now();
    ev.at = Math.max(now, ev.t + (ev.origin === 'remote' ? JITTER_MS : 0));
    ev.dispatchedAt = performance.now();
    for (const h of handlers) {
      try { h(ev); } catch (e) { console.error('event handler failed', e); }
    }
    return ev;
  },
  onSignal(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  signal(name, data) { for (const l of listeners) { try { l(name, data); } catch (e) { console.error(e); } } },
};
