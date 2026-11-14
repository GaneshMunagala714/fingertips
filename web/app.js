// TalkBridge browser app: a phone-style dialer + call screen. Captions in, approved replies out.
// No secrets here; all keys stay on the server. Contacts and recents live only in this browser.
const $ = (id) => document.getElementById(id)
const QUICK = ['Yes.', 'No.', 'One moment, please.', 'Could you repeat that, please?', 'Thank you!', 'Thank you, goodbye!']
const LIVE = new Set(['queued', 'initiated', 'ringing', 'in-progress'])
const OVER = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled'])
const STATUS_TEXT = { queued: 'calling…', initiated: 'calling…', ringing: 'ringing…', completed: 'Call ended',
  busy: 'Busy', 'no-answer': 'No answer', failed: 'Call failed', canceled: 'Call canceled' }
const SIZES = [['18', 'Small'], ['22', 'Medium'], ['28', 'Large'], ['34', 'Extra large']]
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']]
const PERSON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.6" r="4.2" fill="currentColor"/><path d="M3.8 21c.9-4.6 4.2-7 8.2-7s7.3 2.4 8.2 7" fill="currentColor"/></svg>'

const state = { status: 'idle', started: null, relay: false, turns: [], to: '', error: '' }
let pendingConfirm = null
let screen = 'home'           // 'home' | 'call'
let endedAt = null
let logged = false            // this call already written to recents

// ------------------------------------------------------------- storage
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}
let contacts = store.get('tb.contacts', [])
let recents = store.get('tb.recents', [])

// ------------------------------------------------------------- numbers & names
const clean = (n) => String(n || '').replace(/[^\d+]/g, '')
function e164(n) {
  let d = clean(n)
  if (!d) return ''
  if (!d.startsWith('+')) d = d.length === 10 ? `+1${d}` : d.length === 11 && d[0] === '1' ? `+${d}` : `+${d}`
  return d
}
function pretty(n) {
  const d = e164(n)
  const m = d.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : d || n
}
const findContact = (n) => { const d = e164(n); return d ? contacts.find((c) => e164(c.num) === d) : null }
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const AV_COLORS = ['#5e5ce6', '#bf5af2', '#ff9f0a', '#30b0c7', '#ff375f', '#32d74b', '#64d2ff', '#ac8e68']
function avatarFor(el, contact) {
  if (contact) {
    let h = 0; for (const ch of contact.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    el.textContent = initials(contact.name); el.style.background = AV_COLORS[h % AV_COLORS.length]
  } else { el.innerHTML = PERSON; el.style.background = '#636366' }
}

// Twilio errors, in words a person can act on.
function friendlyError(msg) {
  const s = String(msg || '')
  if (/21215|geo.?permission|not authorized to call/i.test(s)) return "This account isn't allowed to call that country. Check the country code."
  if (/21211|21217|not a valid phone|invalid.*number/i.test(s)) return "That doesn't look like a real phone number. Check it and try again."
  if (/21219|21608|unverified|trial account/i.test(s)) return 'Trial account: this number has to be verified in Twilio before you can call it.'
  if (/21214|cannot be reached|unreachable/i.test(s)) return "That number can't be reached right now."
  if (/country code/i.test(s)) return 'Add the country code, like +1 413 555 0123.'
  if (/already active/i.test(s)) return "You're already on a call."
  if (/wait a few seconds/i.test(s)) return 'Give it a few seconds before calling again.'
  if (/PUBLIC_URL|public url/i.test(s)) return "The server isn't reachable from the internet yet (public URL missing)."
  if (/Error 5\d\d/.test(s)) return "Couldn't place the call. Try again in a moment."
  return s.replace(/^Twilio refused the call:\s*/i, '').replace(/^HTTP \d+ error:?\s*/i, '').slice(0, 160)
}

// ------------------------------------------------------------- server link
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onmessage = (e) => onEvent(JSON.parse(e.data))
  ws.onclose = () => { setTimeout(connect, 1000) }   // reconnects; the server sends a full snapshot
}

function onEvent(m) {
  switch (m.type) {
    case 'snapshot':
      Object.assign(state, { status: m.status, started: m.started, relay: m.relay, turns: m.turns })
      if (m.to) state.to = m.to
      $('partial').textContent = m.partial || ''
      if (LIVE.has(state.status)) { logged = false; openCall() }
      renderTurns(); renderCall(); break
    case 'status':
      if (m.to) state.to = m.to
      if (m.error) state.error = friendlyError(m.error)
      setStatus(m.status, m.started); break
    case 'relay':
      state.relay = m.connected; renderCall(); break
    case 'partial':
      $('partial').textContent = m.text; break
    case 'turn':
      state.turns.push(m.turn)
      if (m.turn.who === 'them') { $('partial').textContent = ''; refreshSuggestions() }
      renderTurns(); renderCall(); break
    case 'interrupted': {
      const t = state.turns.findLast((x) => x.who === 'me' && x.text === m.turn.text)
      if (t) Object.assign(t, m.turn)
      renderTurns(); break
    }
    case 'error':
      if (screen === 'call') { state.error = friendlyError(m.message); renderCall() } else showDialMsg(m.message)
      break
  }
}

function setStatus(st, started) {
  const wasLive = LIVE.has(state.status)
  state.status = st
  if (started) state.started = started
  if (LIVE.has(st) && screen !== 'call') openCall()
  if (OVER.has(st) && (wasLive || screen === 'call')) {
    endedAt = Date.now() / 1000
    $('partial').textContent = ''
    logRecent()
  }
  renderCall()
}

// ------------------------------------------------------------- HOME: tabs
function showTab(name) {
  for (const t of ['keypad', 'contacts', 'recents']) $(`tab-${t}`).hidden = t !== name
  for (const b of document.querySelectorAll('.tabbar button')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current')
  }
  if (name === 'contacts') renderContacts()
  if (name === 'recents') renderRecents()
  store.set('tb.tab', name)
}

// keypad
function buildKeypad() {
  for (const [d, l] of KEYS) {
    const b = document.createElement('button')
    b.className = 'key'; b.type = 'button'; b.setAttribute('aria-label', d)
    b.innerHTML = `<b>${d}</b><small>${l}</small>`
    let hold = null
    b.addEventListener('pointerdown', () => { if (d === '0') hold = setTimeout(() => { hold = 'plus'; typeKey('+') }, 550) })
    b.addEventListener('click', () => { if (hold === 'plus') { hold = null; return } clearTimeout(hold); hold = null; typeKey(d) })
    $('keypad').append(b)
  }
}
function typeKey(d) { $('to').value += d; onNumberInput() }
function onNumberInput() {
  const v = $('to').value
  const c = findContact(v)
  $('toName').textContent = c ? c.name : ''
  $('backspace').hidden = !v
  $('addFromKeypad').hidden = !(clean(v).replace('+', '').length >= 7 && !c)
  showDialMsg('')
}
function showDialMsg(m) { $('dialMsg').textContent = m ? friendlyError(m) : '' }

// contacts
function renderContacts() {
  const q = $('search').value.trim().toLowerCase()
  const list = contacts
    .filter((c) => !q || c.name.toLowerCase().includes(q) || clean(c.num).includes(clean(q) || '~'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const ul = $('contactList'); ul.innerHTML = ''
  if (!list.length) {
    const li = document.createElement('li'); li.className = 'empty'
    li.textContent = contacts.length ? 'No matches.' : 'No contacts yet. Tap + to add someone you call often.'
    ul.append(li); return
  }
  for (const c of list) {
    const li = document.createElement('li')
    const who = document.createElement('button'); who.className = 'who'; who.setAttribute('aria-label', `Call ${c.name}`)
    const av = document.createElement('span'); av.className = 'mini'; avatarFor(av, c)
    const txt = document.createElement('span')
    txt.innerHTML = '<span class="nm"></span><span class="sub"></span>'
    txt.querySelector('.nm').textContent = c.name; txt.querySelector('.sub').textContent = pretty(c.num)
    who.append(av, txt); who.onclick = () => dial(c.num)
    const info = document.createElement('button'); info.className = 'icon-btn info'; info.setAttribute('aria-label', `Edit ${c.name}`)
    info.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v5.5M12 7.6v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    info.onclick = () => editContact(c)
    li.append(who, info); ul.append(li)
  }
}

let editing = null
function editContact(c, num = '') {
  editing = c || null
  $('contactTitle').textContent = c ? 'Edit contact' : 'New contact'
  $('cName').value = c ? c.name : ''
  $('cNum').value = c ? c.num : num
  $('cErr').textContent = ''
  $('cDelete').hidden = !c
  $('contactDlg').showModal()
  ;(c || !num ? $('cName') : $('cName')).focus()
}
function saveContact(e) {
  e.preventDefault()
  const name = $('cName').value.trim(), num = e164($('cNum').value)
  if (!name) { $('cErr').textContent = 'Add a name.'; return }
  if (!/^\+\d{8,15}$/.test(num)) { $('cErr').textContent = 'Use the full number with country code, like +1 413 555 0123.'; return }
  const dup = contacts.find((c) => e164(c.num) === num && c !== editing)
  if (dup) { $('cErr').textContent = `That number is already saved as ${dup.name}.`; return }
  if (editing) Object.assign(editing, { name, num })
  else contacts.push({ id: crypto.randomUUID(), name, num })
  store.set('tb.contacts', contacts)
  $('contactDlg').close()
  renderContacts(); renderRecents(); onNumberInput(); renderCall()
}

// recents
function logRecent() {
  if (logged || !state.to) return
  logged = true
  const dur = state.started && endedAt ? Math.max(0, Math.round(endedAt - state.started)) : 0
  recents.unshift({ num: state.to, at: Date.now(), status: state.status, dur })
  recents = recents.slice(0, 50)
  store.set('tb.recents', recents)
}
function when(ts) {
  const d = new Date(ts), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
function renderRecents() {
  const ul = $('recentList'); ul.innerHTML = ''
  $('clearRecents').hidden = !recents.length
  if (!recents.length) {
    const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Calls you make show up here.'
    ul.append(li); return
  }
  for (const r of recents) {
    const c = findContact(r.num)
    const li = document.createElement('li')
    const who = document.createElement('button'); who.className = 'who'; who.setAttribute('aria-label', `Call ${c ? c.name : pretty(r.num)}`)
    const av = document.createElement('span'); av.className = 'mini'; avatarFor(av, c)
    const txt = document.createElement('span')
    txt.innerHTML = '<span class="nm"></span><span class="sub"></span>'
    const nm = txt.querySelector('.nm'); nm.textContent = c ? c.name : pretty(r.num)
    const ok = r.status === 'completed' && r.dur > 0
    if (!ok) nm.classList.add('missed')
    txt.querySelector('.sub').textContent = ok ? `Outgoing · ${mmss(r.dur)}` : (STATUS_TEXT[r.status] || 'Not connected')
    who.append(av, txt); who.onclick = () => dial(r.num)
    const w = document.createElement('span'); w.className = 'when'; w.textContent = when(r.at)
    li.append(who, w)
    if (!c) {
      const add = document.createElement('button'); add.className = 'icon-btn info'; add.setAttribute('aria-label', 'Save to contacts')
      add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
      add.onclick = () => editContact(null, r.num)
      li.append(add)
    }
    ul.append(li)
  }
}

// ------------------------------------------------------------- CALL SCREEN
function openCall() {
  screen = 'call'
  $('home').hidden = true
  $('callScreen').hidden = false
  renderCall()
}
function closeCall() {
  screen = 'home'
  state.turns = []; state.error = ''; state.started = null; endedAt = null
  $('partial').textContent = ''
  $('callScreen').hidden = true
  $('home').hidden = false
  chips($('sugs'), []); $('sugs').innerHTML = '<span class="fine">Suggestions appear after they speak.</span>'; $('aiSrc').textContent = ''
  renderTurns()
  showTab(store.get('tb.tab', 'keypad'))
}

function renderCall() {
  if (screen !== 'call') return
  const s = state.status
  const c = findContact(state.to)
  avatarFor($('avatar'), c)
  $('callName').textContent = c ? c.name : (state.to ? pretty(state.to) : 'Calling')
  $('callSub').textContent = c ? `mobile  ${pretty(state.to)}` : 'Unknown'
  $('saveCallerBtn').hidden = !!c || !state.to

  const live = LIVE.has(s), over = OVER.has(s) || s === 'idle'
  const connected = s === 'in-progress'
  const cs = $('callScreen')
  cs.classList.toggle('connected', connected)
  cs.classList.toggle('over', over && !live)
  cs.classList.toggle('had-talk', state.turns.length > 0)
  $('ended').hidden = !(over && !live)
  $('hangBtn').disabled = !live

  const st = $('status')
  st.classList.toggle('pulse', s === 'queued' || s === 'initiated' || s === 'ringing')
  st.classList.toggle('bad', !!state.error || ['failed', 'busy', 'no-answer'].includes(s))
  if (state.error) st.textContent = state.error
  else if (connected) st.textContent = `${clock()}${state.relay ? '' : ' · connecting captions…'}`
  else if (over && state.started && endedAt) st.textContent = `Call ended · ${mmss(endedAt - state.started)}`
  else st.textContent = STATUS_TEXT[s] || (s === 'idle' ? 'Call ended' : s)
}
const clock = () => state.started ? mmss(Math.max(0, Date.now() / 1000 - state.started)) : '0:00'

function renderTurns() {
  const ol = $('turns')
  ol.innerHTML = ''
  if (!state.turns.length) {
    const li = document.createElement('li'); li.className = 'empty'
    li.textContent = 'Their words appear here as they talk. Tap a reply and it\'s spoken to them.'
    ol.append(li)
  }
  for (const t of state.turns) {
    const li = document.createElement('li')
    li.className = `turn ${t.who}${t.state === 'cut off' ? ' cut' : ''}`
    li.setAttribute('aria-label', t.who === 'them' ? 'They said' : 'You said')
    const txt = document.createElement('span'); txt.textContent = t.text
    li.append(txt)
    if (t.who === 'me') {
      const st = document.createElement('span'); st.className = 'state'
      st.textContent = t.state === 'cut off' ? 'Cut off: they talked over it' : 'Spoken'
      li.append(st)
      if (t.state === 'cut off' && LIVE.has(state.status)) {
        const again = document.createElement('button'); again.textContent = 'Say it again'
        again.onclick = () => sayIt(t.text); li.append(again)
      }
    }
    ol.append(li)
  }
  ol.scrollTop = ol.scrollHeight
}

function chips(el, items, onPick) {
  el.innerHTML = ''
  for (const text of items) {
    const b = document.createElement('button'); b.textContent = text
    b.onclick = () => onPick(text); el.append(b)
  }
}

// ------------------------------------------------------------- actions
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.detail || `Error ${r.status}`)
  return data
}

async function dial(number) {
  const to = e164(number ?? $('to').value)
  if (!to) { showDialMsg('Add the country code, like +1 413 555 0123.'); return }
  showDialMsg('')
  Object.assign(state, { to, status: 'queued', turns: [], started: null, relay: false, error: '' })
  endedAt = null; logged = false
  openCall()
  try { await api('/api/call', { to }) } catch (e) {
    state.error = friendlyError(e.message)
    if (!OVER.has(state.status)) state.status = 'failed'
    endedAt = Date.now() / 1000
    renderCall()
  }
}

async function sayIt(text, confirmed = false, requestId = crypto.randomUUID()) {
  text = text.trim()
  if (!text) return
  try {
    const r = await api('/api/say', { text, request_id: requestId, confirmed })
    if (r.needs_confirm) {
      pendingConfirm = { text, requestId }
      $('confirmText').textContent = text
      $('confirm').showModal()
      return
    }
    if ($('draft').value.trim() === text) { $('draft').value = ''; growDraft() }
  } catch (e) { flash(friendlyError(e.message)) }
}
function flash(msg) {
  const keep = state.error
  state.error = msg; renderCall()
  setTimeout(() => { if (state.error === msg) { state.error = keep; renderCall() } }, 3500)
}

async function refreshSuggestions(hint = '') {
  $('aiSrc').textContent = '…'
  try {
    const r = await api('/api/suggest', { hint })
    $('aiSrc').textContent = `· ${r.source}, ${r.ms} ms${r.dropped.length ? `, ${r.dropped.length} unsafe dropped` : ''}`
    chips($('sugs'), r.replies, hint ? (t) => { $('draft').value = t; growDraft(); $('draft').focus() } : (t) => sayIt(t))
    return r
  } catch (e) { $('aiSrc').textContent = '' }
}

function growDraft() { const d = $('draft'); d.style.height = 'auto'; d.style.height = `${Math.min(d.scrollHeight, 120)}px` }

function setSize(v) {
  document.documentElement.style.setProperty('--cap', `${v}px`)
  $('size').value = v
  $('sizeLbl').textContent = (SIZES.find(([x]) => x === v) || SIZES[1])[1]
  store.set('tb.cap', v)
}

// ------------------------------------------------------------- wiring
buildKeypad()
chips($('quick'), QUICK, (t) => sayIt(t))
for (const b of document.querySelectorAll('.tabbar button')) b.onclick = () => showTab(b.dataset.tab)
$('to').addEventListener('input', onNumberInput)
$('to').addEventListener('keydown', (e) => { if (e.key === 'Enter') dial() })
$('backspace').onclick = () => { $('to').value = $('to').value.slice(0, -1); onNumberInput() }
$('callBtn').onclick = () => dial()
$('addFromKeypad').onclick = () => editContact(null, $('to').value)
$('newContactBtn').onclick = () => editContact(null)
$('search').addEventListener('input', renderContacts)
$('clearRecents').onclick = () => { recents = []; store.set('tb.recents', recents); renderRecents() }
$('contactForm').addEventListener('submit', saveContact)
$('cCancel').onclick = () => $('contactDlg').close()
$('cDelete').onclick = () => {
  contacts = contacts.filter((c) => c !== editing); store.set('tb.contacts', contacts)
  $('contactDlg').close(); renderContacts(); renderRecents(); onNumberInput()
}

$('hangBtn').onclick = () => api('/api/hangup').catch(() => {})
$('callAgain').onclick = () => dial(state.to)
$('closeCall').onclick = closeCall
$('saveCallerBtn').onclick = () => editContact(null, state.to)
$('sizeBtn').onclick = () => {
  const i = SIZES.findIndex(([v]) => v === $('size').value)
  setSize(SIZES[(i + 1) % SIZES.length][0])
}
$('sendBtn').onclick = () => sayIt($('draft').value)
$('expandBtn').onclick = () => refreshSuggestions($('draft').value)
$('draft').addEventListener('input', growDraft)
$('draft').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sayIt($('draft').value) }
})
$('confirmYes').onclick = () => { $('confirm').close(); if (pendingConfirm) sayIt(pendingConfirm.text, true, pendingConfirm.requestId); pendingConfirm = null }
$('confirmNo').onclick = () => { $('confirm').close(); pendingConfirm = null }
$('settingsBtn').onclick = () => $('settingsDlg').showModal()
$('settingsClose').onclick = () => $('settingsDlg').close()
$('size').onchange = (e) => setSize(e.target.value)
setSize(String(store.get('tb.cap', '22')))

setInterval(() => { if (state.status === 'in-progress' && !state.error) renderCall() }, 500)

fetch('/api/health').then((r) => r.json()).then((h) => {
  const bits = [h.twilio ? 'Twilio ready' : 'Twilio not set up',
    h.public_url ? 'Public URL ready' : 'Public URL missing',
    h.gemini.configured ? (h.gemini.ok ? `Gemini ready (${h.gemini.model})` : `Gemini unreachable (${h.gemini.model})`) : 'Gemini off (rules only)']
  $('health').innerHTML = ''
  for (const b of bits) { const d = document.createElement('div'); d.textContent = b; $('health').append(d) }
}).catch(() => {})

showTab(store.get('tb.tab', 'keypad'))
onNumberInput()
connect()
