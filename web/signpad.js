// Signing panel shared by the video call (/v/<room>) and the Meet signing window (/sign).
// Sign one ASL word at a time (web/asl.js + /api/asl/classify) -> words -> drop your hands -> /api/sentence ->
// 3-second "Sending…" countdown (cancel / sign again / type to stop) -> onSay(sentence).
// Typing works too. Same behaviour as signing on a phone call.
import * as asl from '/static/asl.js'

const CSS = `
.sp { display: grid; gap: 10px; font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--sp-fg, #f5f5f7); }
.sp-tag { font-size: 13px; color: var(--sp-dim, #a1a1a6); min-height: 1.3em; }
.sp-tag.rec { color: #ff9f0a; } .sp-tag.fired { color: #30d158; } .sp-tag.err { color: #ff453a; }
.sp-words { min-height: 44px; padding: 10px 12px; border-radius: 12px; background: var(--sp-field, rgba(255,255,255,.08)); font-size: 18px; font-weight: 600; }
.sp-words:empty::before { content: attr(data-empty); color: var(--sp-dim, #a1a1a6); font-weight: 400; font-size: 15px; }
.sp-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sp-row[hidden] { display: none; }
.sp-lbl { font-size: 12px; color: var(--sp-dim, #a1a1a6); text-transform: uppercase; letter-spacing: .04em; width: 100%; }
.sp button { font: inherit; border: 0; border-radius: 999px; padding: 8px 14px; cursor: pointer; background: var(--sp-chip, rgba(255,255,255,.14)); color: inherit; }
.sp button:hover { filter: brightness(1.15); }
.sp button.primary { background: #0a84ff; color: #fff; font-weight: 600; }
.sp button.warn { background: #ff453a; color: #fff; }
.sp form { display: flex; gap: 8px; }
.sp input { flex: 1; min-width: 0; font: inherit; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--sp-line, rgba(255,255,255,.18)); background: transparent; color: inherit; }
`

export function createSignPad({ container, video, stream = null, onSay, onPartial = () => {}, getHeard = () => '', vocab = 'top200' }) {
  if (!document.getElementById('sp-css')) {
    const st = document.createElement('style'); st.id = 'sp-css'; st.textContent = CSS; document.head.append(st)
  }
  container.innerHTML = `
    <div class="sp">
      <div class="sp-tag" data-r="tag">Signing is off</div>
      <div class="sp-words" data-r="words" data-empty="Signed words appear here"></div>
      <div class="sp-row" data-r="choicesRow" hidden><span class="sp-lbl">Did you sign</span><span class="sp-row" data-r="choices"></span></div>
      <div class="sp-row" data-r="sugRow" hidden><span class="sp-lbl">Say</span><span class="sp-row" data-r="sugs"></span></div>
      <div class="sp-row" data-r="countRow" hidden><span data-r="count"></span><button class="warn" data-r="cancel">Cancel sending</button></div>
      <div class="sp-row"><button class="primary" data-r="toggle">Start signing</button><button data-r="clear">Clear</button>
        <label style="font-size:13px;display:flex;gap:6px;align-items:center"><input type="checkbox" data-r="auto" style="flex:none"> Send automatically</label></div>
      <form data-r="form"><input data-r="input" placeholder="Or type what to say" autocomplete="off"><button class="primary">Say</button></form>
    </div>`
  const r = (k) => container.querySelector(`[data-r="${k}"]`)
  const words = []
  let timer = null, firedUntil = 0, on = false, pending = 0
  const auto = r('auto')
  try { auto.checked = localStorage.getItem('tb.autosend') !== 'false' } catch { auto.checked = true }
  auto.onchange = () => { try { localStorage.setItem('tb.autosend', auto.checked) } catch {} }

  const tag = (t, cls = '', hold = 0) => { const e = r('tag'); e.textContent = t; e.className = `sp-tag ${cls}`; if (hold) firedUntil = performance.now() + hold }
  const renderWords = () => { r('words').textContent = words.join(' '); onPartial(words.join(' ')) }
  const chips = (row, box, items, pick) => {
    box.innerHTML = ''; row.hidden = !items.length
    for (const t of items) { const b = document.createElement('button'); b.textContent = t; b.onclick = () => pick(t); box.append(b) }
  }
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null } r('countRow').hidden = true }
  const say = (text) => {
    text = text.trim(); if (!text) return
    cancel(); words.length = 0; renderWords()
    chips(r('sugRow'), r('sugs'), [], null); chips(r('choicesRow'), r('choices'), [], null)
    tag(`Said: “${text}”`, 'fired', 2500)
    onSay(text)
  }
  const add = (w) => { cancel(); words.push(w); renderWords(); chips(r('choicesRow'), r('choices'), [], null); chips(r('sugRow'), r('sugs'), [], null) }

  async function onSegment(frames, why, meta = {}) {
    cancel(); pending++
    tag('Recognizing…', '', 900)
    try {
      const res = await fetch('/api/asl/classify', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ frames, vocab, why, ...meta }) }).then((x) => x.json())
      if (!res.ok) { tag(res.reason === 'too short' ? 'Too quick, sign again' : res.reason, 'err', 1400); return }
      if (res.unsure) {
        chips(r('choicesRow'), r('choices'), res.choices.map((c) => c.word), add)
        tag(`Not sure: ${res.choices.slice(0, 2).map((c) => c.word).join(' or ')}?`, '', 1800)
      } else { add(res.word); tag(`“${res.word}”`, 'fired', 1400) }
    } catch { tag('Sign server error', 'err', 1400) } finally { pending-- }
  }

  async function onPhraseEnd() {
    if (!words.length || pending) return
    const text = words.join(' ')
    tag('Making a sentence…', '', 1500)
    let replies = []
    try {
      const res = await fetch('/api/sentence', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ words: text, heard: getHeard() }) }).then((x) => x.json())
      replies = res.replies || []
    } catch {}
    if (words.join(' ') !== text) return            // kept signing meanwhile
    chips(r('sugRow'), r('sugs'), replies.length ? replies : [text], say)
    if (!auto.checked) { tag('Tap a sentence to say it', '', 2500); return }
    const target = replies[0] || text
    let n = 3
    r('countRow').hidden = false
    const tick = () => {
      if (n === 0) { timer = null; say(target); return }
      r('count').textContent = `Sending “${target}” in ${n}…`; tag('', '', 1100)
      n--; timer = setTimeout(tick, 1000)
    }
    tick()
  }

  function onState(st) {
    if (performance.now() < firedUntil) return
    if (st.phase === 'starting') tag('Starting camera…')
    else if (st.phase === 'loading') tag('Loading signs…')
    else if (st.phase === 'error') tag(st.message, 'err')
    else if (st.phase === 'off') tag('Signing is off')
    else if (st.signing) tag('Reading your sign…', 'rec')
    else tag(st.visible ? 'Sign one word, then pause' : 'Raise your hands to sign')
  }

  r('cancel').onclick = () => { cancel(); tag('Not sent. Tap a sentence, or keep signing.', '', 2500) }
  r('clear').onclick = () => { cancel(); words.length = 0; renderWords(); chips(r('sugRow'), r('sugs'), [], null); chips(r('choicesRow'), r('choices'), [], null) }
  r('form').onsubmit = (e) => { e.preventDefault(); const v = r('input').value; r('input').value = ''; say(v) }
  r('input').oninput = cancel
  const start = async () => {
    on = true; r('toggle').textContent = 'Stop signing'
    await asl.start(video, { stream, onState, onSegment, onPhraseEnd })
  }
  const stop = () => { on = false; r('toggle').textContent = 'Start signing'; asl.stop() }
  r('toggle').onclick = () => (on ? stop() : start())
  return { start, stop, say, isOn: () => on }
}
