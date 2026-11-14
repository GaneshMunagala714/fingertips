// Runs in Meet's own page (not the extension's isolated world), before Meet asks for the mic.
// Wraps getUserMedia so Meet's mic track = your real mic + Sign2Speak's voice. Nothing else changes.
(() => {
  if (window.__s2sMixer) return
  const md = navigator.mediaDevices
  const real = md.getUserMedia.bind(md)
  let ctx = null
  let voiceGain = null
  md.getUserMedia = async (constraints) => {
    const stream = await real(constraints)
    if (!constraints || !constraints.audio || !stream.getAudioTracks().length) return stream
    ctx = ctx || new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(dest)
    voiceGain = ctx.createGain()
    voiceGain.gain.value = 1
    voiceGain.connect(dest)
    const mixed = new MediaStream([...dest.stream.getAudioTracks(), ...stream.getVideoTracks()])
    return mixed
  }
  window.__s2sMixer = true
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.s2s !== 'play' || !e.data.audio) return
    try {
      ctx = ctx || new AudioContext()
      const buf = await ctx.decodeAudioData(e.data.audio)
      const src = ctx.createBufferSource()
      src.buffer = buf
      if (voiceGain) src.connect(voiceGain)          // into the meeting
      const local = ctx.createGain()                 // and quietly for the signer's own check
      local.gain.value = 0.25
      src.connect(local).connect(ctx.destination)
      src.start()
    } catch (err) {
      console.warn('[Sign2Speak] could not play voice', err)
    }
  })
})()
