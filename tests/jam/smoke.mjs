// Real-browser smoke test (Chrome via Playwright). Needs the server running:
//   uvicorn server.main:app --port 8010      then   node tests/jam/smoke.mjs [baseUrl] [shotsDir]
// Uses Chrome's fake camera (a test pattern, no real hands), so hand *detection* can't be asserted here;
// it checks that MediaPipe loads and the camera pipeline runs, and drives the instrument with the keyboard.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8010';
const SHOTS = process.argv[3] || null;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'] });
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera'] });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
const errors = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
};

// ---------------------------------------------------------------- solo, keyboard
const A = await ctxA.newPage(); watch(A, 'A');
await A.goto(`${BASE}/jam`);
check('1 app opens', await A.isVisible('text=Feel the Music'));
await A.click('#keyboardMode');
await sleep(400);
check('studio shows', await A.isVisible('#toolbar'));
check('audio context running', (await A.evaluate(() => window.__jam.ctx.state)) === 'running');

await A.keyboard.press('1');
await sleep(300);
const hud1 = await A.evaluate(() => [document.querySelector('#iChord').textContent, document.querySelector('#iNotes').textContent]);
check('4 chord key selects C major', hud1[0] === 'C' && hud1[1] === 'C4 · E4 · G4', hud1.join(' / '));
const voices1 = await A.evaluate(() => window.__jam.engine.chords.get('p1')?.length);
check('5 chord produces audio voices', voices1 === 3, `${voices1} voices`);
const marks1 = await A.evaluate(() => window.__jam.stage.marks.filter((m) => m.kind === 'note' && m.off == null).map((m) => m.midi));
check('6 visual note marks match chord', JSON.stringify(marks1) === '[60,64,67]', JSON.stringify(marks1));
await sleep(700);
const lvl = await A.evaluate(() => window.__jam.engine.level('p1'));
check('8 measured channel level > 0 while chord sounds', lvl > 0.01, lvl.toFixed(3));

await A.keyboard.press('4');
await sleep(250);
const hud2 = await A.evaluate(() => document.querySelector('#iChord').textContent);
const live = await A.evaluate(() => window.__jam.stage.liveChord.get('p1')?.notes);
check('chord change updates audio + visual structure', hud2 === 'F' && JSON.stringify(live) === '[65,69,72]', `${hud2} ${JSON.stringify(live)}`);
if (SHOTS) await A.screenshot({ path: `${SHOTS}/jam-aurora-chord.png` });

// volume affects sound and visuals together
const before = await A.evaluate(() => window.__jam.stage.amp(window.__jam.stage.liveChord.get('p1').marks[0], window.__jam.clock.now()));
for (let i = 0; i < 5; i++) { await A.keyboard.press('ArrowDown'); await sleep(60); }
await sleep(300);
const after = await A.evaluate(() => [window.__jam.stage.amp(window.__jam.stage.liveChord.get('p1').marks[0], window.__jam.clock.now()), window.__jam.engine.channels.get('p1').volume]);
check('8 volume down shrinks visual amplitude and channel gain', after[0] < before && after[1] < 0.75, `amp ${before.toFixed(3)} -> ${after[0].toFixed(3)}, gain ${after[1].toFixed(2)}`);

// muted: visuals still get data
await A.keyboard.press('m');
await sleep(400);
const muted = await A.evaluate(() => [window.__jam.engine.out.gain.value, window.__jam.engine.level('p1'), window.__jam.stage.liveChord.size]);
check('10 muting silences output but visuals keep measured level', muted[0] < 0.05 && muted[1] > 0.005 && muted[2] === 1, JSON.stringify(muted.map((v) => +v.toFixed(3))));
await A.keyboard.press('m');

// melody
await A.keyboard.press('w');
await A.keyboard.down('a'); await sleep(200);
const mel = await A.evaluate(() => window.__jam.play.melody?.midi);
await A.keyboard.down('d'); await sleep(150);
const mel2 = await A.evaluate(() => window.__jam.play.melody?.midi);
await A.keyboard.up('d'); await A.keyboard.up('a'); await sleep(150);
const mel3 = await A.evaluate(() => [window.__jam.play.melody, window.__jam.engine.held.size]);
check('7 melody keys play scale pitches', mel === 60 && mel2 === 64, `${mel}, ${mel2}`);
check('12 releasing keys leaves no hanging note', mel3[0] === null && mel3[1] === 0, JSON.stringify(mel3));
if (SHOTS) { await A.keyboard.down('j'); await sleep(500); await A.keyboard.up('j'); await A.screenshot({ path: `${SHOTS}/jam-melody.png` }); }

// rhythm + beat
await A.keyboard.press('e');
await A.keyboard.press('Space');
await sleep(300);
await A.click('#loopBtn');
for (const k of ['z', 'c', 'x', 'c']) { await A.keyboard.press(k); await sleep(170); }
await sleep(3200); // > one bar at 96 BPM, so the loop has replayed
const rh = await A.evaluate(() => ({ playing: window.__jam.transport.playing, steps: Object.values(window.__jam.transport.pattern).flat().filter(Boolean).length,
  hits: window.__jam.stage.hits.length, loopHits: window.__jam.stage.hits.filter((h) => h.at > 0).length }));
check('9 beat runs, drum hits land in the grid and loop', rh.playing && rh.steps >= 3 && rh.hits > 4, JSON.stringify(rh));
if (SHOTS) await A.screenshot({ path: `${SHOTS}/jam-rhythm.png` });

// recording
await A.keyboard.press('q');
await A.keyboard.press('r');
for (const k of ['1', '5', '6', '4']) { await A.keyboard.press(k); await sleep(250); }
await A.keyboard.press('0');
await A.keyboard.press('r');
const rec = await A.evaluate(() => window.__jam.recorder.events.map((e) => [e.type, e.chord || e.drum || '', e.time]));
const chordsRec = rec.filter((e) => e[0] === 'chord').map((e) => e[1]);
check('16 recording captures events with timing', chordsRec.join() === 'C,G,Am,F' && rec.every((e, i) => i === 0 || e[2] >= rec[i - 1][2]), chordsRec.join());
await A.click('#playBtn');
await sleep(1600);
const rp = await A.evaluate(() => [...window.__jam.stage.marks].filter((m) => m.key === 'rp1').length);
check('17 replay re-creates the sequence', rp > 0, `${rp} replayed marks`);
const wav = await A.evaluate(async () => (await window.__jam.recorder.renderWav()).size);
check('WAV export renders offline audio', wav > 100000, `${wav} bytes`);
await A.keyboard.press('Space'); // stop beat

for (const theme of ['constellation', 'garden']) {
  await A.selectOption('#themeSel', theme);
  await A.keyboard.press('3'); await sleep(500); await A.keyboard.press('5'); await sleep(700);
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/jam-${theme}.png` });
}
const fps = await A.evaluate(() => window.__jam.stage.fps);
check('18 render loop responsive (headless, software GL)', fps > 20, `${fps.toFixed(0)} fps`);

// reduced motion + high contrast don't break rendering
await A.evaluate(() => { window.__jam.view.reducedMotion = true; window.__jam.view.highContrast = true; });
await sleep(400);
if (SHOTS) await A.screenshot({ path: `${SHOTS}/jam-highcontrast.png` });
await A.evaluate(() => { window.__jam.view.reducedMotion = false; window.__jam.view.highContrast = false; });
check('19 reduced-motion / high-contrast frames render', true);
const hapt = await A.evaluate(() => [document.querySelector('#sHaptics').disabled, document.querySelector('#hapticNote').textContent]);
check('20 haptics not offered on a desktop without vibration', hapt[0] === true, hapt[1].slice(0, 60));

// ---------------------------------------------------------------- multiplayer
await A.click('#inviteBtn');
await sleep(800);
const link = await A.inputValue('#inviteLink');
await A.keyboard.press('Escape');
const B = await ctxB.newPage(); watch(B, 'B');
await B.goto(link);
check('13 invite link opens join screen', await B.isVisible('text=You’re invited'));
await B.click('#keyboardMode');
await sleep(1200);
const ids = [await A.evaluate(() => window.__jam.net.me), await B.evaluate(() => window.__jam.net.me)];
const nPlayers = await A.evaluate(() => window.__jam.net.players.size);
check('13 two browsers in the same room', ids[0] === 'p1' && ids[1] === 'p2' && nPlayers === 2, `${ids} / ${nPlayers} players`);

await B.keyboard.press('q');
await B.keyboard.press('3');
await sleep(500);
const atA = await A.evaluate(() => ({ chord: window.__jam.stage.liveChord.get('p2')?.name, voices: window.__jam.engine.chords.get('p2')?.length }));
check('14 B\'s chord reaches A (sound + visuals)', atA.chord === 'Em' && atA.voices === 3, JSON.stringify(atA));
await A.keyboard.press('q');
await A.keyboard.press('1');
await sleep(500);
const atB = await B.evaluate(() => ({ chord: window.__jam.stage.liveChord.get('p1')?.name, own: window.__jam.stage.liveChord.get('p2')?.name }));
check('15 both play independently, both see both', atB.chord === 'C' && atB.own === 'Em', JSON.stringify(atB));
const lat = await B.evaluate(() => [window.__jam.net.latency, window.__jam.clock.offset]);
check('clock sync measured', lat[0] != null, `one-way ≈ ${lat[0]?.toFixed(1)} ms, offset ${lat[1]?.toFixed(1)} ms (localhost)`);
await B.click('#beatBtn');
await sleep(800);
const tp = await A.evaluate(() => [window.__jam.transport.playing, window.__jam.transport.startAt]);
const tpB = await B.evaluate(() => [window.__jam.transport.playing, window.__jam.transport.startAt]);
check('shared tempo / start-stop across players', tp[0] && tpB[0] && tp[1] === tpB[1], `startAt equal: ${tp[1] === tpB[1]}`);
if (SHOTS) await A.screenshot({ path: `${SHOTS}/jam-multiplayer.png` });
await B.close();
await sleep(600);
const afterLeave = await A.evaluate(() => [window.__jam.engine.chords.has('p2'), window.__jam.stage.liveChord.has('p2'), window.__jam.net.players.size]);
check('leaving player\'s notes are released', !afterLeave[0] && !afterLeave[1] && afterLeave[2] === 1, JSON.stringify(afterLeave));

// ---------------------------------------------------------------- camera pipeline (fake camera)
const C = await ctxA.newPage(); watch(C, 'C');
await C.goto(`${BASE}/jam`);
await C.click('#startSolo');
let cam = '';
for (let i = 0; i < 40; i++) { cam = await C.textContent('#camStatus'); if (cam !== 'Starting camera…') break; await sleep(500); }
check('2/3 camera permission + MediaPipe hand landmarker load', cam === 'Hand tracking on', cam);
await sleep(1500);
const inf = await C.evaluate(() => window.__jam.tracker?.inferMs);
check('3 landmarker runs on frames (fake camera has no hands)', inf > 0, `${inf?.toFixed(1)} ms/frame inference`);
await C.click('#exitBtn');
await sleep(300);
const stopped = await C.evaluate(() => !window.__jam.tracker.stream && !document.querySelector('#video').srcObject);
check('camera released on exit', stopped);

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
