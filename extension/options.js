const DEFAULT_SERVER = 'https://66-135-26-183.sslip.io'
const el = document.getElementById('server'), msg = document.getElementById('msg')
chrome.storage.sync.get('server').then(({ server }) => { el.value = server || DEFAULT_SERVER })
document.getElementById('save').onclick = async () => {
  const v = el.value.trim().replace(/\/+$/, '')
  try {
    const origin = new URL(v).origin
    if (origin !== DEFAULT_SERVER) {
      const ok = await chrome.permissions.request({ origins: [origin + '/*'] })
      if (!ok) { msg.textContent = 'Permission needed for that server.'; return }
    }
    await chrome.storage.sync.set({ server: v }); msg.textContent = 'Saved. Reload your Meet tab.'
  } catch { msg.textContent = 'Not a valid URL.' }
}
