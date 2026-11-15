// TalkBridge for Google Meet: page-side script. Adapted from the Fingertip meeting extension by Shruti
// (Shrutibrahma/HackUMass-26, extension/inject.js), used with permission.
// Runs in the meeting page's MAIN world at document_start (manifest "world": "MAIN"), before Meet/Zoom ask for
// the camera. It wraps getUserMedia so that:
//   * video: every camera frame gets the signer's approved caption drawn into it. The meeting then sends that
//     video to everyone, so remote attendees see the captions with nothing installed on their side.
//   * audio: approved TalkBridge speech is mixed into the microphone track (optional "Voice it").
// Messages come from the extension's content script via window.postMessage:
//   {talkbridge:'caption', text, final}   {talkbridge:'burn', on}   {talkbridge:'play', audio:ArrayBuffer}
(() => {
  if (window.__talkbridgeInject || !navigator.mediaDevices?.getUserMedia) return
  window.__talkbridgeInject = true
  const md = navigator.mediaDevices
  const realGUM = md.getUserMedia.bind(md)

  const cap = { text: '', final: true, at: 0, burn: true }
  const FINAL_MS = 7000
  let audioCtx = null

  // ------------------------------------------------------------------ caption drawing
  function wrap(ctx, text, maxW, maxLines) {
    const words = text.split(/\s+/)
    const lines = []
    let line = ''
    for (const w of words) {
      const t = line ? line + ' ' + w : w
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w } else line = t
    }
    if (line) lines.push(line)
    // Keep the most recent words if it is too long (like live captions do).
    return lines.slice(-maxLines)
  }

  function drawCaption(ctx, W, H) {
    if (!cap.burn || !cap.text) return
    if (cap.final && performance.now() - cap.at > FINAL_MS) return
    const fs = Math.max(16, Math.round(H * 0.06))
    ctx.font = `${cap.final ? 700 : 500} ${fs}px system-ui, -apple-system, Segoe UI, sans-serif`
    const pad = Math.round(fs * 0.55)
    const lines = wrap(ctx, cap.text, W * 0.86, 2)
    const lh = Math.round(fs * 1.25)
    const boxH = lines.length * lh + pad * 1.4
    const boxW = Math.min(W * 0.92, Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2)
    const x = (W - boxW) / 2
    const y = H - boxH - Math.round(H * 0.05)
    ctx.fillStyle = 'rgba(0,0,0,0.78)'
    const r = Math.round(fs * 0.45)
    ctx.beginPath()
    ctx.moveTo(x + r, y); ctx.arcTo(x + boxW, y, x + boxW, y + boxH, r); ctx.arcTo(x + boxW, y + boxH, x, y + boxH, r)
    ctx.arcTo(x, y + boxH, x, y, r); ctx.arcTo(x, y, x + boxW, y, r); ctx.closePath(); ctx.fill()
    ctx.fillStyle = cap.final ? '#ffffff' : 'rgba(255,255,255,0.72)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y + pad * 0.7 + i * lh))
    // Small tag so viewers know where the text comes from.
    const tf = Math.max(10, Math.round(fs * 0.42))
    ctx.font = `700 ${tf}px system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    const tag = cap.final ? 'CC · signed via TalkBridge' : 'CC · signing…'
    const tw = ctx.measureText(tag).width + tf
    ctx.fillRect(x, y - tf * 1.7, tw, tf * 1.5)
    ctx.fillStyle = '#9fe8c3'
    ctx.fillText(tag, x + tf / 2, y - tf * 1.45)
  }

  function overlaysActive() {
    return cap.burn && cap.text && !(cap.final && performance.now() - cap.at > FINAL_MS)
  }

  // ------------------------------------------------------------------ video compositor
  function captionTrack(src) {
    // Preferred: insertable streams, frame-accurate and not throttled by timers.
    if (typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function'
        && typeof OffscreenCanvas === 'function') {
      try {
        const proc = new MediaStreamTrackProcessor({ track: src })
        const gen = new MediaStreamTrackGenerator({ kind: 'video' })
        let canvas = null
        let ctx = null
        const ts = new TransformStream({
          transform(frame, ctrl) {
            if (!overlaysActive()) { ctrl.enqueue(frame); return }
            const W = frame.displayWidth
            const H = frame.displayHeight
            if (!canvas || canvas.width !== W || canvas.height !== H) { canvas = new OffscreenCanvas(W, H); ctx = canvas.getContext('2d') }
            ctx.drawImage(frame, 0, 0, W, H)
            drawCaption(ctx, W, H)
            const out = new VideoFrame(canvas, { timestamp: frame.timestamp })
            frame.close()
            ctrl.enqueue(out)
          },
        })
        proc.readable.pipeThrough(ts).pipeTo(gen.writable).catch(() => {})
        // Stopping the meeting's track must release the real camera.
        const stop = gen.stop.bind(gen)
        gen.stop = () => { try { src.stop() } catch { /* already */ } stop() }
        Object.defineProperty(gen, 'label', { value: src.label })
        gen.getSettings = () => src.getSettings()
        gen.getCapabilities = () => src.getCapabilities?.() ?? {}
        gen.getConstraints = () => src.getConstraints()
        gen.applyConstraints = (c) => src.applyConstraints(c)
        window.__talkbridgeMode = 'insertable-streams'
        return gen
      } catch (e) {
        console.warn('[TalkBridge] insertable streams failed, using canvas', e)
      }
    }
    // Fallback: canvas capture.
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([src])
    video.play().catch(() => {})
    const s = src.getSettings()
    const canvas = document.createElement('canvas')
    canvas.width = s.width || 1280
    canvas.height = s.height || 720
    const ctx = canvas.getContext('2d')
    const out = canvas.captureStream(s.frameRate || 30).getVideoTracks()[0]
    const tick = () => {
      if (out.readyState === 'ended') { src.stop(); return }
      if (video.videoWidth) {
        if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight }
        ctx.drawImage(video, 0, 0)
        drawCaption(ctx, canvas.width, canvas.height)
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick)
      else requestAnimationFrame(tick)
    }
    tick()
    window.__talkbridgeMode = 'canvas'
    return out
  }

  // ------------------------------------------------------------------ audio mixer
  // Outgoing mic = (real mic x micGain) + TalkBridge voice. "Voice only" (default) keeps the real mic silent, so
  // you can leave Meet's mic ON and people hear only your signed sentences. Every mic track Meet opens gets a mix.
  const mixes = new Set()
  let voiceOnly = true
  function mixedAudio(stream) {
    audioCtx ||= new AudioContext()
    const real = stream.getAudioTracks()[0]
    const dest = audioCtx.createMediaStreamDestination()
    const micGain = audioCtx.createGain(); micGain.gain.value = voiceOnly ? 0 : 1
    audioCtx.createMediaStreamSource(new MediaStream([real])).connect(micGain).connect(dest)
    const voice = audioCtx.createGain(); voice.gain.value = 1.4
    voice.connect(dest)
    const mix = { micGain, voice, track: dest.stream.getAudioTracks()[0] }
    mixes.add(mix)
    const out = mix.track
    // look like the real microphone to the meeting app (device id, label) and release it when stopped
    const stop = out.stop.bind(out)
    out.stop = () => { try { real.stop() } catch {} mixes.delete(mix); stop() }
    Object.defineProperty(out, 'label', { value: real.label })
    out.getSettings = () => real.getSettings()
    out.getCapabilities = () => real.getCapabilities?.() ?? {}
    out.getConstraints = () => real.getConstraints()
    out.applyConstraints = (c) => real.applyConstraints(c)
    return [out]
  }

  md.getUserMedia = async (constraints) => {
    const stream = await realGUM(constraints)
    try {
      const v = stream.getVideoTracks()
      const a = stream.getAudioTracks()
      const videoOut = v.length ? [captionTrack(v[0])] : []
      const audioOut = a.length ? mixedAudio(stream) : []
      const out = new MediaStream([...audioOut, ...videoOut])
      window.__talkbridgeWrapped = (window.__talkbridgeWrapped || 0) + 1
      window.postMessage({ talkbridge: 'wrapped', video: !!v.length, audio: !!a.length, mode: window.__talkbridgeMode || '' }, '*')
      return out
    } catch (e) {
      console.warn('[TalkBridge] could not add captions; using the plain camera', e)
      return stream
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || typeof event.data.talkbridge !== 'string') return
    const m = event.data
    if (m.talkbridge === 'caption') {
      cap.text = String(m.text || '').slice(0, 240)
      cap.final = m.final !== false
      cap.at = performance.now()
    } else if (m.talkbridge === 'burn') {
      cap.burn = !!m.on
    } else if (m.talkbridge === 'micmode') {
      voiceOnly = !!m.voiceOnly
      for (const x of mixes) x.micGain.gain.value = voiceOnly ? 0 : 1
    } else if (m.talkbridge === 'play' && m.audio) {
      try {
        audioCtx ||= new AudioContext()
        if (audioCtx.state !== 'running') await audioCtx.resume()
        const buf = await audioCtx.decodeAudioData(m.audio)
        const live = [...mixes].filter((x) => x.track.readyState === 'live')
        const s = audioCtx.createBufferSource()
        s.buffer = buf
        for (const x of live) s.connect(x.voice)
        const monitor = audioCtx.createGain()
        monitor.gain.value = 0.18
        s.connect(monitor).connect(audioCtx.destination)
        s.start()
        window.postMessage({ talkbridge: 'played', ok: live.length > 0, tracks: live.length, state: audioCtx.state, seconds: buf.duration }, '*')
      } catch (e) {
        console.warn('[TalkBridge] meeting voice playback failed', e)
        window.postMessage({ talkbridge: 'played', ok: false, error: String(e) }, '*')
      }
    }
  })
})()
