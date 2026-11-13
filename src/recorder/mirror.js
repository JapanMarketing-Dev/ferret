// 録画の対象の画面・ウインドウ（desktopCapturer の ID は URL の source）を映すだけ。音は取らない
;(function () {
  var params = new URLSearchParams(location.search)
  // 複数の画面・ウインドウを同時に録るときは , でつないで届く（@shared/captureComposite の mirrorSourceParam）。並べて映す
  var ids = (params.get('source') || '').split(',').filter(function (s) { return /^(screen|window):[\w:-]+$/.test(s) }).slice(0, 4)
  var id = ids[0] || ''
  var video = document.getElementById('mirror')
  var note = document.getElementById('note')
  if (ids.length > 1) {
    document.body.classList.add('is-grid')
    document.body.style.setProperty('--cols', String(Math.ceil(Math.sqrt(ids.length))))
    ids.slice(1).forEach(function (other) {
      var extra = document.createElement('video')
      extra.autoplay = true
      extra.muted = true
      extra.playsInline = true
      document.body.insertBefore(extra, note)
      start(other, extra, false)
    })
  }
  function fail(err) {
    // 映せない（ウインドウが閉じた・画面収録の許可が無い）。理由の文は main が画面の言語で渡す
    note.textContent = params.get('message') || ''
    note.hidden = false
    video.hidden = true
    if (err) console.warn('mirror: ' + String(err && err.message || err))
  }
  if (!id) return fail(null)
  start(id, video, true)

  /**
   * 1つの画面・ウインドウを video に映す。main（最初のもの）が映せなければ理由の文を出す。
   * 並べているほかのものが映せなければ、その枠だけ暗いままにする（録画は続く）
   */
  function start(sourceId, target, main) {
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 30 } }
    }).then(function (stream) {
      target.srcObject = stream
      stream.getVideoTracks().forEach(function (track) { track.addEventListener('ended', function () { if (main) fail(null) }) })
    }).catch(function (err) { if (main) fail(err); else console.warn('mirror: ' + String(err && err.message || err)) })
  }
})()
