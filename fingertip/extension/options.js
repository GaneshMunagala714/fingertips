const input = document.getElementById('server')
chrome.storage.sync.get({ server: 'http://localhost:8000' }, (v) => { input.value = v.server })
document.getElementById('save').onclick = () => chrome.storage.sync.set({ server: input.value.trim() }, () => {
  document.getElementById('ok').textContent = 'Saved. Reload your Meet tab.'
})
