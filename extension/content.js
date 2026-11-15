// TalkBridge for Google Meet: the panel on the Meet page.
//  * "Open signing window" opens <server>/sign. Signed sentences come back here by postMessage.
//  * Each sentence is fetched as speech (via bg.js -> /api/tts) and handed to inject.js, which mixes it into
//    the microphone Meet is sending and draws it as a caption on the camera. Everyone in the meeting hears and
//    sees it; nobody else installs anything.
//  * You can also type a line to say.
(() => {
  if (window.top !== window || document.getElementById('tb-panel')) return
  let server = 'https://66-135-26-183.sslip.io'
  let signWin = null, wrapped = { audio: false, video: false }, burn = true
  chrome.runtime.sendMessage({ type: 'server' }, (r) => { if (r?.server) server = r.server })
  setTimeout(() => window.postMessage({ talkbridge: 'hello' }, '*'), 0)

  const css = `
  #tb-panel { position: fixed; left: 16px; bottom: 96px; z-index: 2147483000; font: 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #f5f5f7; }
  #tb-panel * { box-sizing: border-box; }
  #tb-panel .tb-fab { border: 0; border-radius: 999px; padding: 10px 16px; background: #0a84ff; color: #fff; font: 600 14px inherit; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
  #tb-panel .tb-card { width: 320px; margin-bottom: 10px; padding: 14px; border-radius: 16px; background: rgba(28,28,30,.96); box-shadow: 0 8px 30px rgba(0,0,0,.45); display: grid; gap: 10px; }
  #tb-panel .tb-card[hidden] { display: none; }
  #tb-panel b { font-size: 15px; }
  #tb-panel .tb-st { font-size: 12px; color: #a1a1a6; } #tb-panel .tb-st.ok { color: #30d158; } #tb-panel .tb-st.bad { color: #ff9f0a; }
  #tb-panel button.tb-b { border: 0; border-radius: 10px; padding: 9px 12px; background: rgba(255,255,255,.14); color: #fff; font: inherit; cursor: pointer; }
  #tb-panel button.tb-b.primary { background: #0a84ff; font-weight: 600; }
  #tb-panel form { display: flex; gap: 6px; }
  #tb-panel input[type=text] { flex: 1; min-width: 0; padding: 9px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,.2); background: transparent; color: #fff; font: inherit; }
  #tb-panel label { display: flex; gap: 6px; align-items: center; font-size: 13px; }
  #tb-panel .tb-last { font-size: 13px; color: #d1d1d6; min-height: 1.3em; }
  #tb-live { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483000; width: min(720px, 92vw);
    padding: 14px 18px; border-radius: 18px; background: rgba(20,20,22,.92); color: #fff; box-shadow: 0 8px 30px rgba(0,0,0,.45);
    font: 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: grid; gap: 6px; pointer-events: none; }
  #tb-live[hidden] { display: none; }
  #tb-live .l1 { font-size: 14px; color: #9fe8c3; font-weight: 600; }
  #tb-live .l1 .gl { display: inline-block; padding: 1px 8px; margin-right: 6px; border-radius: 6px; background: rgba(159,232,195,.16); letter-spacing: .03em; }
  #tb-live .l2 { font-size: 26px; font-weight: 700; letter-spacing: -.01em; min-height: 1.2em; }
  #tb-live .l3 { font-size: 15px; color: #ffd60a; min-height: 1.2em; }
  #tb-live .l3.said { color: #30d158; }`
  const st = document.createElement('style'); st.textContent = css; document.documentElement.append(st)

  const panel = document.createElement('div'); panel.id = 'tb-panel'
  panel.innerHTML = `
    <div class="tb-card" hidden>
      <b>TalkBridge</b>
      <div class="tb-st" data-r="st">Checking your camera and mic…</div>
      <button class="tb-b primary" data-r="sign">Open signing window</button>
      <form data-r="form"><input type="text" data-r="input" placeholder="Type something to say"><button class="tb-b primary">Say</button></form>
      <label><input type="checkbox" data-r="voiceOnly" checked> Voice only: keep my real microphone silent (leave Meet's mic on)</label>
      <label><input type="checkbox" data-r="showLive" checked> Show what I sign at the top of my screen (only I see this)</label>
      <label><input type="checkbox" data-r="burn" checked> Show my sentence as a caption on my camera</label>
      <div class="tb-last" data-r="last"></div>
    </div>
    <button class="tb-fab" data-r="fab">🤟 TalkBridge</button>`
  document.documentElement.append(panel)
  // What you are signing, readable for you (Meet mirrors your self-view, so the camera caption reads backwards to you)
  const live = document.createElement('div'); live.id = 'tb-live'; live.hidden = true; live.setAttribute('aria-live', 'polite')
  live.innerHTML = '<div class="l1"></div><div class="l2"></div><div class="l3"></div>'
  document.documentElement.append(live)
  let liveTimer = null
  function showLive({ l1, l2, l3, said = false }) {
    if (!r('showLive').checked) return
    if (l1 !== undefined) live.querySelector('.l1').innerHTML = l1
    if (l2 !== undefined) live.querySelector('.l2').textContent = l2
    if (l3 !== undefined) { const e = live.querySelector('.l3'); e.textContent = l3; e.className = 'l3' + (said ? ' said' : '') }
    live.hidden = false
    clearTimeout(liveTimer); liveTimer = setTimeout(() => (live.hidden = true), 12000)
  }
  const escH = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  function onSignEvent(d) {
    if (d.kind === 'word') showLive({ l1: `🤟 You signed <span class="gl">${escH(d.sign || d.word.toUpperCase())}</span> = “${escH(d.word)}”`, l2: d.words, l3: '' })
    else if (d.kind === 'unsure') showLive({ l1: `🤟 Not sure: ${escH(d.choices.slice(0, 3).join(' / '))}? Pick one in the signing window`, l3: '' })
    else if (d.kind === 'sentence') showLive({ l3: `Sentence: “${d.options[0]}”` })
    else if (d.kind === 'countdown') showLive({ l3: `Sending “${d.text}” in ${d.n}…` })
    else if (d.kind === 'cancel') showLive({ l3: 'Not sent' })
    else if (d.kind === 'clear') showLive({ l2: '', l3: '' })
    else if (d.kind === 'said') showLive({ l1: '🔊 Spoken to the meeting', l2: '', l3: `“${d.text}”`, said: true })
  }
  const r = (k) => panel.querySelector(`[data-r="${k}"]`)
  const card = panel.querySelector('.tb-card')
  r('fab').onclick = () => { card.hidden = !card.hidden; status() }

  function status() {
    const e = r('st')
    if (wrapped.audio) { e.textContent = 'Ready: your sentences go into your Meet microphone' + (wrapped.video ? ' and camera.' : '.') + (meetMuted() ? ' Meet is muted: TalkBridge unmutes it while speaking.' : ''); e.className = 'tb-st ok' }
    else { e.textContent = 'Not connected to your mic yet. Turn your microphone (and camera) off and on once in Meet, or reload the page and join again.'; e.className = 'tb-st bad' }
  }
  const toPage = (m, transfer) => window.postMessage({ talkbridge: m.type, ...m }, '*', transfer || [])

  // Meet's own mute silences the whole mic track, TalkBridge voice included. If Meet is muted when a sentence is
  // ready, unmute it for the sentence and mute it again afterwards.
  const meetMic = () => [...document.querySelectorAll('[data-is-muted]')].find((b) => /microphone/i.test(b.getAttribute('aria-label') || ''))
  const meetMuted = () => meetMic()?.getAttribute('data-is-muted') === 'true'
  let remute = false
  const sendMicMode = () => toPage({ type: 'micmode', voiceOnly: r('voiceOnly').checked })

  async function say(text) {
    text = String(text || '').trim().slice(0, 400)
    if (!text) return
    r('last').textContent = `Saying: “${text}”`
    showLive({ l1: '🔊 Spoken to the meeting', l2: '', l3: `“${text}”`, said: true })
    toPage({ type: 'caption', text, final: true })
    chrome.runtime.sendMessage({ type: 'tts', text }, (res) => {
      if (!res || res.error) { r('last').textContent = `Shown as caption only (${res?.error || 'voice unavailable'})`; return }
      const bin = atob(res.audio), buf = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
      remute = false
      if (meetMuted()) { meetMic().click(); remute = true }
      setTimeout(() => toPage({ type: 'play', audio: buf.buffer }, [buf.buffer]), remute ? 350 : 0)
      r('last').textContent = `Said: “${text}”`
    })
  }

  r('sign').onclick = () => {
    if (signWin && !signWin.closed) { signWin.focus(); return }
    signWin = window.open(`${server}/sign`, 'talkbridge-sign', 'width=420,height=820')
  }
  r('form').onsubmit = (e) => { e.preventDefault(); say(r('input').value); r('input').value = '' }
  r('burn').onchange = () => { burn = r('burn').checked; toPage({ type: 'burn', on: burn }) }
  r('voiceOnly').onchange = sendMicMode
  r('showLive').onchange = () => { if (!r('showLive').checked) live.hidden = true }

  window.addEventListener('message', (ev) => {
    const d = ev.data
    if (!d || typeof d.talkbridge !== 'string') return
    if (ev.source === window) {                       // from inject.js
      if (d.talkbridge === 'wrapped') { wrapped.audio ||= d.audio; wrapped.video ||= d.video; sendMicMode(); status() }
      if (d.talkbridge === 'played') {
        if (!d.ok) r('last').textContent = 'Your voice could not reach the Meet microphone. Turn your mic off and on once in Meet, then try again.'
        if (remute) setTimeout(() => { if (!meetMuted()) meetMic()?.click(); remute = false }, (d.seconds || 3) * 1000 + 800)
      }
      return
    }
    if (ev.origin !== new URL(server).origin) return  // only the TalkBridge signing window
    if (d.talkbridge === 'event') onSignEvent(d)
    else if (d.talkbridge === 'partial' && d.text) toPage({ type: 'caption', text: d.text, final: false })
    else if (d.talkbridge === 'say') say(d.text)
  })
})()
