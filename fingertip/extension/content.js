// Meet extension (signer-only). Isolated-world content script. Product name: APP_NAME below.
const APP_NAME = 'Fingertip'   // mirrors app/src/brand.ts
// 1. Injects inject.js into the page so the mic can carry Sign2Speak's voice.
// 2. Adds a "Sign2Speak" button that opens the signing panel (your Sign2Speak server's /#meet).
// 3. When the panel sends a sentence: show it in a local caption box (only you see it), post it to
//    Meet chat, and play its voice into the mic. The box says which of those actually worked.
//    Meet's chat markup isn't a public API: the selectors below are best-effort and may need updating.

const S2S = {
  server: 'http://localhost:8000',
  panel: null,

  chatButton: () => document.querySelector('button[aria-label*="Chat with everyone" i], button[aria-label*="chat" i][aria-label*="everyone" i]'),
  chatBox: () => document.querySelector('textarea[aria-label*="Send a message" i], textarea[aria-label*="message" i], div[contenteditable="true"][aria-label*="message" i]'),
  sendButton: () => document.querySelector('button[aria-label*="Send a message" i], button[aria-label*="send" i]'),

  async postChat(text) {
    let box = S2S.chatBox()
    if (!box) {
      S2S.chatButton()?.click()
      for (let i = 0; i < 20 && !box; i++) {
        await new Promise((r) => setTimeout(r, 100))
        box = S2S.chatBox()
      }
    }
    if (!box) return false
    box.focus()
    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(box, text)
    } else {
      box.textContent = text
    }
    box.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
    await new Promise((r) => setTimeout(r, 50))
    const send = S2S.sendButton()
    if (send && !send.disabled) send.click()
    else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
    return true
  },

  async speak(text) {
    try {
      const r = await fetch(`${S2S.server}/api/tts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      })
      if (!r.ok) return false
      const audio = await r.arrayBuffer()   // WAV
      window.postMessage({ s2s: 'play', audio }, '*', [audio])
      return true
    } catch {
      return false
    }
  },

  openPanel() {
    if (S2S.panel && !S2S.panel.closed) { S2S.panel.focus(); return }
    S2S.panel = window.open(`${S2S.server}/#meet`, 'sign2speak', 'width=380,height=700')
  },

  addButton() {
    if (document.getElementById('s2s-open')) return
    const b = document.createElement('button')
    b.id = 's2s-open'
    b.textContent = APP_NAME
    b.setAttribute('aria-label', `Open ${APP_NAME} panel`)
    Object.assign(b.style, {
      position: 'fixed', right: '16px', bottom: '96px', zIndex: 2147483647, padding: '12px 18px',
      borderRadius: '12px', border: '0', background: '#2457D6', color: '#fff', font: '700 15px system-ui',
      cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.3)',
    })
    b.addEventListener('click', S2S.openPanel)
    document.body.appendChild(b)
  },

  onMessage: async (e) => {
    if (e.origin !== new URL(S2S.server).origin) return
    const m = e.data
    if (!m || m.source !== 'sign2speak' || m.type !== 'send' || typeof m.text !== 'string') return
    const text = m.text.slice(0, 500)
    const item = Captions.add(text)
    const [chat, voice] = await Promise.all([S2S.postChat(text), S2S.speak(text)])
    Captions.mark(item, chat, voice)
    if (!chat) console.warn('[Fingertip] could not find Meet chat; the message was not posted')
  },
}

// Local captions: only YOU see this box. It shows each sentence you sent and, honestly,
// whether it reached the meeting chat and/or the mic. Movable, resizable text, minimize, hide.
const Captions = {
  root: null, list: null, size: 20, max: 4,

  build() {
    if (Captions.root) return
    const r = document.createElement('div')
    r.id = 'fingertip-captions'
    r.setAttribute('role', 'log')
    r.setAttribute('aria-live', 'polite')
    r.setAttribute('aria-label', `${APP_NAME} captions (only you see this)`)
    Object.assign(r.style, {
      position: 'fixed', left: '50%', bottom: '120px', transform: 'translateX(-50%)', zIndex: 2147483646,
      width: 'min(720px, 90vw)', background: 'rgba(12,14,20,.88)', color: '#fff', borderRadius: '14px',
      font: '500 14px system-ui', boxShadow: '0 6px 24px rgba(0,0,0,.4)', display: 'none',
    })
    const bar = document.createElement('div')
    Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px',
      cursor: 'move', borderBottom: '1px solid rgba(255,255,255,.15)', userSelect: 'none' })
    const title = document.createElement('span')
    title.textContent = `${APP_NAME} · only you see this box`
    Object.assign(title.style, { flex: '1', opacity: '.8', fontSize: '12px' })
    bar.appendChild(title)
    const btn = (label, aria, fn) => {
      const b = document.createElement('button')
      b.textContent = label
      b.setAttribute('aria-label', aria)
      Object.assign(b.style, { background: 'rgba(255,255,255,.12)', color: '#fff', border: '0',
        borderRadius: '8px', padding: '4px 9px', font: '700 13px system-ui', cursor: 'pointer' })
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn() })
      bar.appendChild(b)
      return b
    }
    btn('A−', 'Smaller caption text', () => Captions.resize(-2))
    btn('A+', 'Larger caption text', () => Captions.resize(2))
    const minBtn = btn('–', 'Minimize captions', () => {
      const hidden = Captions.list.style.display === 'none'
      Captions.list.style.display = hidden ? 'block' : 'none'
      minBtn.textContent = hidden ? '–' : '+'
      minBtn.setAttribute('aria-label', hidden ? 'Minimize captions' : 'Expand captions')
    })
    btn('×', 'Hide captions until the next sentence', () => { r.style.display = 'none' })
    const list = document.createElement('div')
    Object.assign(list.style, { padding: '8px 14px 12px' })
    r.append(bar, list)
    document.body.appendChild(r)
    Captions.root = r
    Captions.list = list
    Captions.drag(bar)
    try { Captions.size = Number(localStorage.getItem('fingertip-caption-size')) || 20 } catch {}
  },

  drag(handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return
      const b = Captions.root.getBoundingClientRect()
      Object.assign(Captions.root.style, { transform: 'none', left: `${b.left}px`, top: `${b.top}px`, bottom: 'auto' })
      on = true; sx = e.clientX; sy = e.clientY; ox = b.left; oy = b.top
      handle.setPointerCapture(e.pointerId)
    })
    handle.addEventListener('pointermove', (e) => {
      if (!on) return
      const x = Math.max(0, Math.min(window.innerWidth - 120, ox + e.clientX - sx))
      const y = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy))
      Object.assign(Captions.root.style, { left: `${x}px`, top: `${y}px` })
    })
    handle.addEventListener('pointerup', () => { on = false })
  },

  resize(d) {
    Captions.size = Math.max(14, Math.min(40, Captions.size + d))
    try { localStorage.setItem('fingertip-caption-size', String(Captions.size)) } catch {}
    for (const t of Captions.list.querySelectorAll('[data-text]')) t.style.fontSize = `${Captions.size}px`
  },

  add(text) {
    Captions.build()
    Captions.root.style.display = 'block'
    const row = document.createElement('div')
    Object.assign(row.style, { margin: '6px 0' })
    const t = document.createElement('div')
    t.dataset.text = '1'
    t.textContent = text
    Object.assign(t.style, { fontSize: `${Captions.size}px`, fontWeight: '600', lineHeight: '1.3' })
    const s = document.createElement('div')
    s.textContent = 'Sending…'
    Object.assign(s.style, { fontSize: '12px', opacity: '.75', marginTop: '2px' })
    row.append(t, s)
    Captions.list.appendChild(row)
    while (Captions.list.children.length > Captions.max) Captions.list.firstChild.remove()
    // Older lines fade so the newest is the obvious one (text + opacity, not colour alone).
    ;[...Captions.list.children].forEach((c, i, all) => { c.style.opacity = i === all.length - 1 ? '1' : '.55' })
    return s
  },

  mark(statusEl, chat, voice) {
    const parts = [chat ? '✓ Posted in meeting chat' : '✗ Not posted: Meet chat not found',
      voice ? '✓ Spoken into your mic' : '· Not spoken (meeting voice not set up)']
    statusEl.textContent = parts.join('   ')
  },
}

;(function init() {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    const s = document.createElement('script')
    s.src = chrome.runtime.getURL('inject.js')
    ;(document.head || document.documentElement).appendChild(s)
    s.onload = () => s.remove()
    chrome.storage?.sync.get({ server: S2S.server }, (v) => { S2S.server = v.server.replace(/\/$/, '') })
  }
  window.addEventListener('message', S2S.onMessage)
  const ready = () => S2S.addButton()
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
})()
