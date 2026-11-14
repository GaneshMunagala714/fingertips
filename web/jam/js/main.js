// App wiring: welcome -> studio, the frame loop, UI controls, settings, tour, rooms, recording.
import { bus } from './bus.js';
import { clock } from './clock.js';
import { AudioEngine, INSTRUMENTS } from './audio.js';
import { transport } from './transport.js';
import { HandTracker, tuning } from './hands.js';
import { play, fromHands, onHandLost, bindKeyboard, playChord, stopChord, noteOn, noteOff, drum, setExpr, allOff, setMode, ladder } from './controls.js';
import { Stage, view, PLAYER_STYLE } from './visuals.js';
import { net } from './net.js';
import { recorder } from './recorder.js';
import { haptics, patternFor } from './haptics.js';
import { KEYS, midiToName, diatonicChord, roman } from './theory.js';

const $ = (id) => document.getElementById(id);
const MODE_LABEL = { chord: 'Chords', melody: 'Melody', rhythm: 'Rhythm' };
const ICON = {
  play: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.3-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5Z" fill="currentColor"/></svg>',
  stop: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/></svg>',
  rec:  '<svg class="ic rec-dot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.6" fill="currentColor"/></svg>',
};
const setBtn = (el, icon, label) => { el.innerHTML = `${ICON[icon]}<span>${label}</span>`; };
const shapeMark = (shape, hue) => `<i class="shape ${shape}" style="--h:${hue}" aria-hidden="true"></i>`;

let ctx = null, engine = null, tracker = null;
let running = false, audioOn = true, cameraWanted = true;
const metrics = { dispatch: 0, lead: 0, netDelay: null };
const params = new URLSearchParams(location.search);
const inviteRoom = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || null;

const stage = new Stage($('stage'), () => engine);

// ------------------------------------------------------------------ audio

function ensureAudio() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  // ask for the smallest output buffer the device allows; fall back where a number isn't accepted
  try { ctx = new AC({ latencyHint: 0 }); } catch (_) { ctx = new AC({ latencyHint: 'interactive' }); }
  clock.ctx = ctx;
  engine = new AudioEngine(ctx);
  transport.engine = engine;
  engine.setMuted(!audioOn);
}

// ------------------------------------------------------------------ the event pipeline

bus.on((ev) => {
  const key = ev.origin === 'replay' ? 'r' + ev.playerId : ev.playerId;
  if (engine) {
    try {
      // your own gestures play the instant they're recognised; only remote, replayed or
      // quantised events go through the room clock
      const immediate = ev.origin === 'local' && ev.at - clock.now() < 3;
      const when = immediate ? 0 : clock.toAudio(ev.at);
      engine.handle(ev, when, key);
      if (ev.origin === 'local' && ev.type !== 'expr' && tracker?.running && performance.now() - tracker.frameCapture < 300) {
        metrics.m2s = performance.now() - tracker.frameCapture + ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
      }
      metrics.lead = Math.max(0, (when - ctx.currentTime) * 1000);
    } catch (e) { console.error('audio failed for event', ev, e); }
  }
  stage.handle(ev);
  recorder.capture(ev);
  if (ev.type === 'noteOn' || ev.type === 'chord' || ev.type === 'drum') {
    const d = ev.at - clock.now();
    d > 5 ? setTimeout(() => feel(ev, key), d) : feel(ev, key);
  }
  net.forward(ev);
  metrics.dispatch = performance.now() - ev.dispatchedAt;
  if (ev.origin === 'remote') metrics.netDelay = ev.netDelay;
  if (ev.origin === 'local') tour.onEvent(ev);
  if (ev.origin === 'local' && ev.type === 'chord') announce(`${ev.chord} chord: ${ev.notes.map(midiToName).join(', ')}`);
});

// ------------------------------------------------------------------ haptics, felt and seen

function feel(ev, key) {
  const pattern = patternFor(ev);
  if (!pattern.length) return;
  const hue = PLAYER_STYLE[key.replace(/^r/, '')]?.hue ?? 34;
  if (haptics.notes) haptics.play(pattern, hue);
  if (!haptics.visual) return;
  const o = hapticOrigin(ev);
  const strong = (ev.type === 'drum' && ev.drum === 'kick') || (ev.type === 'chord' && ev.origin === 'local');
  stage.ripple(o.x, o.y, key, pattern, strong);
}

/** Where a pulse should appear: the hand that played it, else the note's spot on the now line. */
function hapticOrigin(ev) {
  const H = ev.origin === 'local' && tracker?.running ? tracker.hands : null;
  let hand = null;
  if (H) {
    if (ev.type === 'chord') hand = play.oneHand ? (H.right.present ? H.right : H.left) : H.left;
    else if (ev.type === 'noteOn') hand = H.right.present ? H.right : H.left;
    else if (ev.type === 'drum') hand = [H.left, H.right].find((h) => h.present && h.pinch) || null;
  }
  if (hand?.present) return { x: hand.x * innerWidth, y: hand.y * innerHeight };
  if (ev.type === 'drum') return { x: stage.X0, y: stage.bottom };
  const midi = ev.type === 'chord' ? ev.notes[Math.floor(ev.notes.length / 2)] : ev.midi;
  return { x: stage.X0, y: stage.y(midi) };
}

const patternHistory = [JSON.stringify(transport.pattern)];
let restoring = false;
const beatDot = $('beatDot');

bus.onSignal((name, data) => {
  switch (name) {
    case 'beat': {
      const d = Math.max(0, data.at - clock.now());
      setTimeout(() => {
        stage.onBeat(data);
        beatDot.className = 'beat-dot ' + (data.downbeat ? 'down' : 'on');
        setTimeout(() => (beatDot.className = 'beat-dot'), 110);
        if (haptics.beats) haptics.play(patternFor({ type: 'beat', downbeat: data.downbeat }), null);
      }, d);
      break;
    }
    case 'transport': updateTransportUI(); break;
    case 'room-transport':
      if (data.playing) transport.set(true, data.tempo, data.startAt);
      else { transport.tempo = data.tempo; transport.set(false, data.tempo); }
      break;
    case 'mode': updateModeUI(); announce(`${MODE_LABEL[data]} mode`); break;
    case 'net': updateNetUI(data); break;
    case 'peer-join': toast(`${PLAYER_STYLE[data.id]?.name || data.id} joined the jam (${data.role})`); break;
    case 'peer-leave':
      engine?.allOff(data); stage.releasePlayer(data);
      toast(`${PLAYER_STYLE[data]?.name || data} left — their notes were released`);
      break;
    case 'net-error': toast(`Room: ${data}`); break;
    case 'rec': updateRecUI(data); break;
    case 'pattern':
      if (!restoring) { patternHistory.push(JSON.stringify(data)); if (patternHistory.length > 50) patternHistory.shift(); }
      break;
  }
});

// ------------------------------------------------------------------ start / stop

async function start({ camera = cameraWanted, room = null, tour: withTour = false } = {}) {
  ensureAudio();
  try { await ctx.resume(); } catch (_) {}
  $('welcome').hidden = true;
  $('studio').hidden = false;
  running = true;
  setExpr({ volume: play.volume, filter: play.filter }, true);
  buildPads();
  updateModeUI(); updateTransportUI();
  if (room) joinRoom(room);
  if (camera) startCamera(); else { setPads(true); $('previewBox').hidden = true; $('camBtn').setAttribute('aria-pressed', 'false'); }
  if (withTour) tour.open(0);
  else toast(camera ? 'Raise a hand — your fingers pick the chord' : 'Keys 1–5 play chords · A–L melody · Z X C drums');
}

async function startCamera() {
  $('camBtn').setAttribute('aria-pressed', 'true');
  $('previewBox').hidden = false;
  $('camStatus').textContent = 'Starting camera…';
  try {
    tracker = tracker || new HandTracker();
    tracker.onLoss = (side) => onHandLost(side);
    const video = $('video');
    await tracker.start(video);
    $('camStatus').textContent = 'Hand tracking on';
    // run detection the moment each camera frame is decoded, not on the next screen refresh
    if (video.requestVideoFrameCallback) {
      const onFrame = (_now, meta) => {
        if (!tracker?.running) return;
        if (tracker.detect(meta?.captureTime)) fromHands(tracker.hands, performance.now());
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
  } catch (e) {
    console.warn('camera / hand tracking unavailable', e);
    tracker?.stop();
    $('camStatus').textContent = 'Camera unavailable';
    $('camBtn').setAttribute('aria-pressed', 'false');
    toast('Camera or hand tracking unavailable — keyboard and touch pads are on');
    setPads(true);
  }
}
function stopCamera() {
  tracker?.stop();
  onHandLost('left'); onHandLost('right');
  $('camStatus').textContent = 'Camera off';
  $('previewBox').hidden = true;
  $('camBtn').setAttribute('aria-pressed', 'false');
}

function exitStudio() {
  allOff();
  if (net.state !== 'off') net.sendRaw({ type: 'transport', playing: false, tempo: transport.tempo });
  transport.set(false, transport.tempo);
  recorder.stopReplay(); recorder.stop();
  stopCamera();
  net.disconnect();
  tour.close();
  running = false;
  $('studio').hidden = true;
  $('welcome').hidden = false;
  history.replaceState(null, '', '/jam');
}

// ------------------------------------------------------------------ rooms

function newRoomCode() { return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join(''); }
let roleApplied = false;
function joinRoom(code) {
  roleApplied = false;
  net.connect(code);
  history.replaceState(null, '', `/jam?room=${code}`);
}
function inviteLink() { return `${location.origin}/jam?room=${net.room}`; }

function updateNetUI(d) {
  const pill = $('netPill');
  const label = { off: 'Solo', connecting: 'Connecting…', reconnecting: 'Reconnecting…', connected: `Room ${d.room}` }[d.state];
  pill.textContent = label;
  pill.className = 'pill ' + (d.state === 'connected' ? 'ok' : d.state === 'off' ? '' : 'warn');
  const list = $('players');
  list.innerHTML = '';
  for (const p of d.players) {
    const s = PLAYER_STYLE[p.id];
    const el = document.createElement('span');
    el.style.borderColor = `hsl(${s.hue},85%,62%)`;
    el.innerHTML = `${shapeMark(s.shape, s.hue)}${s.name}${p.id === d.me ? ' (you)' : ''} · ${p.role} · ${INSTRUMENTS[p.instrument]?.label || p.instrument}`;
    list.appendChild(el);
  }
  if (d.state === 'connected' && !roleApplied) {
    roleApplied = true;
    const mine = d.players.find((p) => p.id === d.me);
    if (mine) {
      if (mine.instrument !== 'drums') { allOff(); play.instrument = mine.instrument; $('instSel').value = mine.instrument; }
      setMode({ Harmony: 'chord', Melody: 'melody', Rhythm: 'rhythm' }[mine.role] || 'chord');
      toast(`You are ${PLAYER_STYLE[d.me].name} (${PLAYER_STYLE[d.me].shape}) · ${mine.role}`);
    }
  }
  if (d.state === 'connected') tour.onNet(d.players.length);
}

// ------------------------------------------------------------------ frame loop

let last = performance.now(), lastHud = 0;
const dwell = { el: null, since: 0, cooldown: 0 };

function loop(t) {
  const dt = Math.min(100, t - last); last = t;
  if (running && tracker?.running) {
    if (tracker.detect()) fromHands(tracker.hands, t);
    stage.hands = tracker.hands;
    handleDwell(t);
    if (tour.step === 0 && Object.values(tracker.hands).some((h) => h.present && h.count >= 4)) tour.complete(0);
  } else stage.hands = null;
  stage.mode = running ? play.mode : null;
  if (play.mode === 'melody') {
    const lad = ladder();
    stage.ladder = lad;
    stage.melodyIdx = play.melody ? lad.indexOf(play.melody.midi) : play.melodyIdx;
  }
  stage.frame(dt);
  if (running) haptics.drawStrip($('hapticStrip'));
  if (running && t - lastHud > 100) {
    lastHud = t; updateHud(); drawPreview();
    const tbTop = $('toolbar').getBoundingClientRect().top;
    $('pads').style.bottom = `${innerHeight - tbTop + 8}px`;
    const tops = [tbTop];
    if (!$('pads').hidden) tops.push($('pads').getBoundingClientRect().top);
    stage.setInset(innerHeight - Math.min(...tops) + 8);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function handleDwell(t) {
  const tips = Object.values(tracker.hands).filter((h) => h.present).map((h) => ({ x: h.tip.x * innerWidth, y: h.tip.y * innerHeight }));
  let hit = null;
  if (t > dwell.cooldown) {
    for (const el of document.querySelectorAll('[data-dwell]')) {
      const r = el.getBoundingClientRect();
      if (tips.some((p) => p.x >= r.left - 6 && p.x <= r.right + 6 && p.y >= r.top - 6 && p.y <= r.bottom + 6)) { hit = el; break; }
    }
  }
  if (hit !== dwell.el) { if (dwell.el) dwell.el.style.setProperty('--dwell', 0); dwell.el = hit; dwell.since = t; }
  if (hit) {
    const p = Math.min(1, (t - dwell.since) / 1000);
    hit.style.setProperty('--dwell', p);
    if (p >= 1) { hit.click(); hit.style.setProperty('--dwell', 0); dwell.el = null; dwell.cooldown = t + 1500; }
  }
}

function drawPreview() {
  const cv = $('previewCanvas');
  if ($('previewBox').hidden) return;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!tracker?.running) return;
  const bones = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  for (const hand of Object.values(tracker.hands)) {
    if (!hand.lm) continue;
    g.strokeStyle = hand.side === 'left' ? '#ffd27a' : '#7ee3ff'; g.lineWidth = 2;
    for (const [a, b] of bones) { g.beginPath(); g.moveTo(hand.lm[a].x * w, hand.lm[a].y * h); g.lineTo(hand.lm[b].x * w, hand.lm[b].y * h); g.stroke(); }
    g.fillStyle = '#fff'; g.font = '700 12px Inter'; g.fillText(`${hand.side === 'left' ? 'L' : 'R'} ${hand.count < 0 ? '' : hand.count}`, hand.lm[0].x * w, hand.lm[0].y * h + 14);
  }
}

// ------------------------------------------------------------------ HUD

function updateHud() {
  $('iMode').textContent = MODE_LABEL[play.mode] + (play.oneHand ? ' · one hand' : '');
  const c = play.chord;
  $('iChord').textContent = c ? c.name : '—';
  $('iNotes').textContent = c ? c.notes.map(midiToName).join(' · ') : '—';
  $('iPitch').textContent = play.melody ? midiToName(play.melody.midi) : '—';
  $('iVol').textContent = Math.round(play.volume * 100) + '%';
  $('iVolBar').style.width = play.volume * 100 + '%';
  $('iTone').textContent = play.filter > 0.75 ? 'bright' : play.filter > 0.45 ? 'warm' : 'dark';
  $('iToneBar').style.width = play.filter * 100 + '%';
  $('iTempo').textContent = `${transport.tempo} BPM · ${transport.playing ? 'playing' : 'stopped'}`;
  $('iInst').textContent = INSTRUMENTS[play.instrument].label;
  let hint = '';
  if (tracker?.running) {
    const H = tracker.hands, any = H.left.present || H.right.present;
    if (!any) hint = 'Raise your hands into view of the camera.';
    else if (play.mode === 'chord') hint = play.oneHand ? 'Fingers = chord, height = volume.' : 'Left fingers = chord. Right height = volume, tilt = tone, pinch = hold.';
    else if (play.mode === 'melody') hint = 'Slide left/right to pick a note, pinch to play.';
    else hint = 'Pinch in the kick / snare / hi-hat zone.';
  }
  $('handHint').textContent = hint;
  if (!$('stats').hidden) {
    const al = ctx ? `${Math.round((ctx.baseLatency || 0) * 1000)} + ${Math.round((ctx.outputLatency || 0) * 1000)} ms (browser-reported, not measured)` : '—';
    $('stats').textContent = [
      `camera inference   ${tracker?.running ? tracker.inferMs.toFixed(1) + ' ms/frame' : 'off'}`,
      `gesture hold       ${tuning.stableMs} ms (setting)`,
      `event dispatch     ${metrics.dispatch.toFixed(2)} ms`,
      `audio scheduled    +${metrics.lead.toFixed(0)} ms ahead`,
      `audio output       ${al}`,
      `camera → sound     ${metrics.m2s != null ? metrics.m2s.toFixed(0) + ' ms (frame captured → audio out)' : '—'}`,
      `render             ${stage.fps.toFixed(0)} fps · draw ${(stage.drawMs || 0).toFixed(1)} ms · q ${stage.quality.toFixed(1)}`,
      `network one-way    ${net.latency != null ? net.latency.toFixed(0) + ' ms (½ RTT)' : 'solo'}`,
      `last remote event  ${metrics.netDelay != null ? metrics.netDelay.toFixed(0) + ' ms after sent' : '—'}`,
    ].join('\n');
  }
}

let lastAnnounce = 0;
function announce(text) {
  const now = performance.now();
  if (now - lastAnnounce < 700) return;
  lastAnnounce = now;
  $('announce').textContent = text;
}
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ------------------------------------------------------------------ touch / mouse pads

function setPads(on) { $('pads').hidden = !on; $('padsBtn').setAttribute('aria-pressed', String(on)); }

function buildPads() {
  const row = $('chordPads');
  row.innerHTML = '';
  for (let d = 1; d <= 7; d++) {
    const c = diatonicChord(play.key, d, { seventh: play.sevenths });
    const b = document.createElement('button');
    b.className = 'pad'; b.dataset.degree = d;
    b.innerHTML = `${c.name}<small>${roman(d)} · key ${d}</small>`;
    b.setAttribute('aria-label', `Play ${c.name} chord`);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); playChord(d); });
    b.addEventListener('click', (e) => { if (e.detail === 0) playChord(d); }); // keyboard activation
    row.appendChild(b);
  }
  const stop = document.createElement('button');
  stop.className = 'pad'; stop.innerHTML = 'Stop<small>key 0</small>'; stop.setAttribute('aria-label', 'Stop chord');
  stop.addEventListener('click', () => stopChord());
  row.appendChild(stop);
  const strip = $('melodyStrip');
  const lad = ladder();
  strip.innerHTML = lad.map((m) => `<span>${midiToName(m)}</span>`).join('');
  strip.setAttribute('aria-valuemax', lad.length - 1);
}

{
  const strip = $('melodyStrip');
  const idxAt = (e) => { const r = strip.getBoundingClientRect(); const lad = ladder(); return Math.max(0, Math.min(lad.length - 1, Math.floor(((e.clientX - r.left) / r.width) * lad.length))); };
  const hl = (i) => [...strip.children].forEach((s, j) => s.classList.toggle('on', j === i));
  let down = false;
  strip.addEventListener('pointerdown', (e) => { down = true; strip.setPointerCapture(e.pointerId); const i = idxAt(e); play.melodyIdx = i; noteOn(ladder()[i], 0.8); hl(i); strip.setAttribute('aria-valuenow', i); });
  strip.addEventListener('pointermove', (e) => { if (!down) return; const i = idxAt(e); if (i !== play.melodyIdx) { play.melodyIdx = i; noteOn(ladder()[i], 0.8); hl(i); } });
  const up = () => { if (!down) return; down = false; noteOff(); hl(-1); };
  strip.addEventListener('pointerup', up); strip.addEventListener('pointercancel', up);
  strip.addEventListener('keydown', (e) => {
    const lad = ladder();
    let i = +strip.getAttribute('aria-valuenow');
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') i = Math.min(lad.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') i = Math.max(0, i - 1);
    else if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault(); e.stopPropagation();
    strip.setAttribute('aria-valuenow', i); strip.setAttribute('aria-valuetext', midiToName(lad[i]));
    play.melodyIdx = i; noteOn(lad[i], 0.8); hl(i);
    setTimeout(() => { if (play.melody?.midi === lad[i]) { noteOff(); hl(-1); } }, 350);
  });
  document.querySelectorAll('.pad.drum').forEach((b) => {
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); drum(b.dataset.drum, 0.85, 'pad-' + b.dataset.drum); });
    b.addEventListener('click', (e) => { if (e.detail === 0) drum(b.dataset.drum, 0.85, 'pad-' + b.dataset.drum); });
  });
  $('padVol').addEventListener('input', (e) => setExpr({ volume: +e.target.value }));
  $('padTone').addEventListener('input', (e) => setExpr({ filter: +e.target.value }));
}

// ------------------------------------------------------------------ toolbar

function setTransport(playing, tempo = transport.tempo) {
  tempo = Math.max(40, Math.min(200, tempo));
  if (net.state === 'connected') net.sendRaw({ type: 'transport', playing, tempo });
  else transport.set(playing, tempo);
  if (!playing) { transport.tempo = tempo; updateTransportUI(); }
}
function updateTransportUI() {
  setBtn($('beatBtn'), transport.playing ? 'stop' : 'play', 'Beat');
  $('beatBtn').setAttribute('aria-pressed', String(transport.playing));
  $('tempoVal').textContent = transport.tempo;
}
function updateModeUI() {
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === play.mode)));
}
function updateRecUI(s) {
  $('recBtn').setAttribute('aria-pressed', String(s.recording));
  setBtn($('recBtn'), s.recording ? 'stop' : 'rec', s.recording ? 'Stop' : 'Record');
  $('playBtn').disabled = !s.count || s.recording;
  setBtn($('playBtn'), s.replaying ? 'stop' : 'play', s.replaying ? 'Stop' : 'Replay');
  $('saveBtn').disabled = !s.count;
}

document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); tour.onMode(b.dataset.mode); }));
$('beatBtn').onclick = () => setTransport(!transport.playing);
$('tempoDown').onclick = () => setTransport(transport.playing, transport.tempo - 4);
$('tempoUp').onclick = () => setTransport(transport.playing, transport.tempo + 4);
$('loopBtn').onclick = () => {
  transport.loopArmed = !transport.loopArmed;
  $('loopBtn').setAttribute('aria-pressed', String(transport.loopArmed));
  if (transport.loopArmed && !transport.playing) setTransport(true);
  toast(transport.loopArmed ? 'Loop recording: drum hits are written into the bar' : 'Loop recording off');
};
$('undoBtn').onclick = () => {
  if (patternHistory.length < 2) { toast('Nothing to undo'); return; }
  patternHistory.pop();
  restoring = true;
  const prev = JSON.parse(patternHistory[patternHistory.length - 1]);
  for (const k in prev) transport.pattern[k] = prev[k];
  bus.signal('pattern', transport.pattern);
  restoring = false;
};
$('recBtn').onclick = () => (recorder.recording ? recorder.stop() : recorder.start());
$('playBtn').onclick = () => (recorder.replaying ? recorder.stopReplay() : recorder.replay());
$('saveBtn').onclick = () => openSave();
$('instSel').onchange = (e) => {
  allOff();
  play.instrument = e.target.value;
  setExpr({}, true);
  net.sendRaw({ type: 'role', instrument: play.instrument });
  toast(`Instrument: ${INSTRUMENTS[play.instrument].label}`);
};
$('themeSel').onchange = (e) => { view.theme = e.target.value; };
$('inviteBtn').onclick = () => {
  if (!net.room) joinRoom(newRoomCode());
  $('inviteLink').value = inviteLink();
  $('inviteDlg').showModal();
};
$('copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText($('inviteLink').value); toast('Link copied'); }
  catch (_) { $('inviteLink').select(); toast('Select the link and copy it'); }
};
$('leaveRoom').onclick = () => { net.disconnect(); bus.playerId = 'p1'; history.replaceState(null, '', '/jam'); $('inviteDlg').close(); toast('Left the room — solo mode'); };
$('padsBtn').onclick = () => setPads($('pads').hidden);
$('camBtn').onclick = () => (tracker?.running ? stopCamera() : startCamera());
$('muteBtn').onclick = () => toggleMute();
$('helpBtn').onclick = () => $('helpDlg').showModal();
$('settingsBtn').onclick = () => $('settingsDlg').showModal();
$('exitBtn').onclick = () => exitStudio();

function toggleMute() {
  audioOn = !audioOn;
  engine?.setMuted(!audioOn);
  $('muteBtn').textContent = audioOn ? 'Sound on' : 'Muted';
  $('muteBtn').setAttribute('aria-pressed', String(!audioOn));
  $('welcomeAudio').textContent = `Audio: ${audioOn ? 'on' : 'off'}`;
  toast(audioOn ? 'Sound on' : 'Muted — every note, chord and beat is still shown');
}

// global shortcuts (music keys live in controls.js)
const dialogOpen = () => !!document.querySelector('dialog[open]');
bindKeyboard(() => running && !dialogOpen());
addEventListener('keydown', (e) => {
  if (!running || dialogOpen() || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === ' ' && e.target.tagName !== 'BUTTON') { e.preventDefault(); setTransport(!transport.playing); }
  else if (k === 'm') toggleMute();
  else if (k === 'r') recorder.recording ? recorder.stop() : recorder.start();
  else if (k === 'v') { const order = ['aurora', 'constellation', 'garden']; view.theme = order[(order.indexOf(view.theme) + 1) % 3]; $('themeSel').value = view.theme; toast($('themeSel').selectedOptions[0].text); }
  else if (k === '?') $('helpDlg').showModal();
});
addEventListener('pagehide', () => { allOff(); tracker?.stop(); });

// ------------------------------------------------------------------ save / export

function download(blob, name) {
  const a = document.createElement('a');
  a.href = typeof blob === 'string' ? blob : URL.createObjectURL(blob);
  a.download = name; a.click();
  if (typeof blob !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
function openSave() {
  const s = recorder.status();
  const players = new Set(recorder.events.map((e) => e.playerId)).size;
  $('saveInfo').textContent = `${s.count} musical events · ${s.seconds.toFixed(1)} s · ${players} player${players === 1 ? '' : 's'}`;
  renderLocalList();
  $('saveDlg').showModal();
}
function renderLocalList() {
  const ul = $('localList'); ul.innerHTML = '';
  for (const item of recorder.listLocal()) {
    const li = document.createElement('li'); const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn sm ghost';
    b.textContent = `${item.name} · ${item.data.events.length} events · ${new Date(item.savedAt).toLocaleString()}`;
    b.onclick = () => { recorder.load(item.data); $('saveDlg').close(); recorder.replay(); };
    li.appendChild(b); ul.appendChild(li);
  }
}
$('savePng').onclick = () => download(stage.snapshot(), `jam-artwork-${stamp()}.png`);
$('saveJson').onclick = () => download(new Blob([JSON.stringify(recorder.toJSON(), null, 1)], { type: 'application/json' }), `jam-composition-${stamp()}.json`);
$('saveWav').onclick = async () => {
  const b = $('saveWav'); b.disabled = true; b.textContent = 'Rendering…';
  try { download(await recorder.renderWav(), `jam-audio-${stamp()}.wav`); }
  catch (e) { toast('Audio export failed: ' + e.message); }
  finally { b.disabled = false; b.textContent = 'Export audio (WAV)'; }
};
$('saveLocal').onclick = () => { toast(recorder.saveLocal(`Piece ${stamp()}`) ? 'Saved in this browser' : 'Could not save in this browser'); renderLocalList(); };
$('loadJson').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { recorder.load(JSON.parse(await f.text())); toast('Composition loaded — press Replay'); openSave(); }
  catch (err) { toast('Could not open: ' + err.message); }
};
$('clearRec').onclick = () => { recorder.clear(); $('saveDlg').close(); };

// ------------------------------------------------------------------ settings

{
  const sk = $('sKey');
  sk.innerHTML = KEYS.map((k) => `<option>${k}</option>`).join('');
  const bindCheck = (id, fn) => $(id).addEventListener('change', (e) => fn(e.target.checked));
  $('sReduced').checked = view.reducedMotion;
  bindCheck('sLabels', (v) => (view.labels = v));
  bindCheck('sReduced', (v) => (view.reducedMotion = v));
  bindCheck('sSimple', (v) => { view.simplified = v; if (v) { view.labels = true; $('sLabels').checked = true; } });
  bindCheck('sContrast', (v) => { view.highContrast = v; document.body.classList.toggle('hc', v); stage.sprites.clear(); });
  bindCheck('sCursors', (v) => (view.showCursors = v));
  bindCheck('sStats', (v) => ($('stats').hidden = !v));
  bindCheck('sOneHand', (v) => { play.oneHand = v; allOff(); });
  bindCheck('sChromatic', (v) => { play.chromatic = v; noteOff(); buildPads(); });
  bindCheck('sSevenths', (v) => { play.sevenths = v; buildPads(); });
  bindCheck('sQuantize', (v) => (transport.quantize = v));
  bindCheck('sClick', (v) => (transport.click = v));
  bindCheck('sSwap', (v) => (tuning.swapHands = v));
  const hapticMode = () => { $('hapticMode').textContent = [haptics.visual && 'visible', haptics.enabled && 'vibration'].filter(Boolean).join(' + ') || 'off'; };
  bindCheck('sHaptics', (v) => { haptics.enabled = v; hapticMode(); });
  bindCheck('sHapticVisual', (v) => { haptics.visual = v; hapticMode(); });
  bindCheck('sHapticBeats', (v) => (haptics.beats = v));
  $('sIntensity').addEventListener('input', (e) => { view.intensity = +e.target.value; stage._seedParticles(); });
  sk.addEventListener('change', (e) => { allOff(); play.key = e.target.value; buildPads(); });
  $('sScale').addEventListener('change', (e) => { noteOff(); play.scale = e.target.value; buildPads(); });
  $('sPinch').addEventListener('input', (e) => { tuning.pinchOn = +e.target.value; tuning.pinchOff = +e.target.value + 0.15; });
  $('sStable').addEventListener('input', (e) => { tuning.stableMs = +e.target.value; $('sStableOut').textContent = `${e.target.value} ms`; });
  $('sMaster').addEventListener('input', (e) => engine?.setMasterVolume(+e.target.value));
  const hapticState = () => {
    const ok = haptics.available();
    $('sHaptics').disabled = !ok;
    if (!ok) { $('sHaptics').checked = false; haptics.enabled = false; }
    $('hapticNote').textContent = haptics.describe();
  };
  hapticState();
  addEventListener('gamepadconnected', hapticState);
  addEventListener('gamepaddisconnected', hapticState);
}

// ------------------------------------------------------------------ guided tour

const STEPS = [
  { title: 'Open your hand', body: 'Raise a hand in front of the camera and spread your fingers. The ring on screen follows it and shows how many fingers it sees. No camera? Press Next.' },
  { title: 'Select a chord', body: 'Hold up 1–5 fingers on your LEFT hand (or press keys 1–5). The chord’s notes appear on the right as connected, labelled stars: C major is C, E and G.' },
  { title: 'Raise your other hand', body: 'Lift your RIGHT hand higher to play louder, lower to play softer (or the Up / Down arrow keys). Watch the ribbons widen and glow as the sound grows, and feel each chord roll under your hand.' },
  { title: 'Play a melody', body: 'Switch to Melody (point at the button for a second, or press W). Slide left/right along the note strip and pinch to play. Higher notes appear higher.' },
  { title: 'Add a beat', body: 'Press Beat (or Space). Switch to Rhythm (E) and pinch in the kick / snare / hi-hat zones, or press Z X C. Hits land on the beat grid below.' },
  { title: 'Invite a friend', body: 'Press “Invite friend” and send the link. Their notes join your canvas with their own colour and shape — you play together in real time.' },
];
const tour = {
  step: -1, done: new Set(), startVol: null,
  open(i) { this.step = i; $('tutorial').hidden = false; this.render(); },
  close() { this.step = -1; $('tutorial').hidden = true; },
  render() {
    const s = STEPS[this.step];
    $('tutStep').textContent = `Step ${this.step + 1} of ${STEPS.length}`;
    $('tutTitle').textContent = s.title; $('tutBody').textContent = s.body;
    $('tutorial').classList.toggle('done', this.done.has(this.step));
    $('tutBack').disabled = this.step === 0;
    $('tutNext').textContent = this.step === STEPS.length - 1 ? 'Finish' : 'Next';
    if (this.step === 2) this.startVol = play.volume;
  },
  next() { if (this.step >= STEPS.length - 1) this.close(); else { this.step++; this.render(); } },
  complete(i) {
    if (this.step !== i || this.done.has(i)) return;
    this.done.add(i); this.render();
    setTimeout(() => { if (this.step === i) this.next(); }, 1300);
  },
  onEvent(ev) {
    if (this.step < 0) return;
    if (this.step === 0) this.complete(0);
    if (ev.type === 'chord') this.complete(1);
    if (ev.type === 'expr' && this.step === 2 && this.startVol != null && Math.abs(ev.volume - this.startVol) > 0.15) this.complete(2);
    if (ev.type === 'noteOn') this.complete(3);
    if (ev.type === 'drum') this.complete(4);
  },
  onMode() {},
  onNet(n) { if (n >= 2) this.complete(5); },
};
$('tutNext').onclick = () => tour.next();
$('tutBack').onclick = () => { if (tour.step > 0) { tour.step--; tour.render(); } };
$('tutClose').onclick = () => tour.close();

// ------------------------------------------------------------------ welcome

updateTransportUI();
setBtn($('recBtn'), 'rec', 'Record');
setBtn($('playBtn'), 'play', 'Replay');

if (inviteRoom) {
  $('joinBanner').hidden = false;
  $('joinBanner').textContent = `You’re invited to jam in room ${inviteRoom}`;
  $('startSolo').textContent = 'Join the jam';
}
$('useCamera').addEventListener('change', (e) => (cameraWanted = e.target.checked));
$('startSolo').onclick = () => start({ room: inviteRoom });
$('startJam').onclick = async () => {
  await start({ room: inviteRoom || newRoomCode() });
  $('inviteLink').value = inviteLink();
  $('inviteDlg').showModal();
};
$('startExplore').onclick = () => start({ room: inviteRoom, tour: true });
$('keyboardMode').onclick = () => { cameraWanted = false; $('useCamera').checked = false; start({ camera: false, room: inviteRoom }); };
$('welcomeSettings').onclick = () => $('settingsDlg').showModal();
$('welcomeAudio').onclick = () => toggleMute();

// Debug / test hook (read-only handles; used by the smoke tests and the stats panel).
window.__jam = { bus, play, transport, net, recorder, stage, view, clock, get engine() { return engine; }, get ctx() { return ctx; }, get tracker() { return tracker; } };
