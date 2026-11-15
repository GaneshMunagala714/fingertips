// Service worker: talks to the TalkBridge server for the meeting page (no CORS needed from here).
const DEFAULT_SERVER = 'https://66-135-26-183.sslip.io'
const server = async () => ((await chrome.storage.sync.get('server')).server || DEFAULT_SERVER).replace(/\/+$/, '')

function b64(buf) {
  let s = ''; const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    const base = await server()
    if (msg.type === 'server') return reply({ server: base })
    if (msg.type === 'tts') {
      const r = await fetch(`${base}/api/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: msg.text }) })
      if (!r.ok) return reply({ error: `voice failed (${r.status})` })
      return reply({ audio: b64(await r.arrayBuffer()) })
    }
    reply({ error: 'unknown' })
  })().catch((e) => reply({ error: String(e) }))
  return true
})
