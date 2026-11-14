// Meet extension (signer-only). Isolated-world content script. Product name: APP_NAME below.
const APP_NAME = 'Fingertip'   // mirrors app/src/brand.ts
// 1. Injects inject.js into the page so the mic can carry Sign2Speak's voice.
// 2. Adds a "Sign2Speak" button that opens the signing panel (your Sign2Speak server's /#meet).
// 3. When the panel sends a sentence: post it to Meet chat, and play its voice into the mic.
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
    const [chat] = await Promise.all([S2S.postChat(text), S2S.speak(text)])
    if (!chat) console.warn('[Sign2Speak] could not find Meet chat; the message was not posted')
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
