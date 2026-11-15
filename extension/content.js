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
  #tb-panel .tb-last { font-size: 13px; color: #d1d1d6; min-height: 1.3em; }`
  const st = document.createElement('style'); st.textContent = css; document.documentElement.append(st)

  const panel = document.createElement('div'); panel.id = 'tb-panel'
  panel.innerHTML = `
    <div class="tb-card" hidden>
      <b>TalkBridge</b>
      <div class="tb-st" data-r="st">Checking your camera and mic…</div>
      <button class="tb-b primary" data-r="sign">Open signing window</button>
      <form data-r="form"><input type="text" data-r="input" placeholder="Type something to say"><button class="tb-b primary">Say</button></form>
      <label><input type="checkbox" data-r="voiceOnly" checked> Voice only: keep my real microphone silent (leave Meet's mic on)</label>
      <label><input type="checkbox" data-r="burn" checked> Show my sentence as a caption on my camera</label>
      <div class="tb-last" data-r="last"></div>
    </div>
    <button class="tb-fab" data-r="fab">🤟 TalkBridge</button>`
  document.documentElement.append(panel)
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
    if (d.talkbridge === 'partial' && d.text) toPage({ type: 'caption', text: d.text, final: false })
    else if (d.talkbridge === 'say') say(d.text)
  })
})()
