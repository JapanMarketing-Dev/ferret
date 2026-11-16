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

  /*
   * 録っている画面の中に、この枠（Ferret の中で映像を映している場所）自身が写っているときは、その場所を塗りつぶす。
   * そのまま映すと、枠の中に枠が映り、無限に重なる（合わせ鏡）。場所は main（browser.ts の updateMirrorMask）が
   * URL のハッシュ "mask=x,y,w,h"（画面に対する 0〜1 の割合。@shared/captureComposite の mirrorMaskParam）で渡す
   */
  var mask = document.createElement('div')
  mask.className = 'self-mask'
  mask.hidden = true
  document.body.appendChild(mask)
  function readMask() {
    var m = /^#mask=([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(location.hash)
    if (!m) return null
    var r = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    for (var i = 0; i < 4; i++) if (!isFinite(r[i]) || r[i] < 0 || r[i] > 1) return null
    return r[2] > 0 && r[3] > 0 ? r : null
  }
  function placeMask() {
    var r = ids.length === 1 ? readMask() : null
    var vw = video.videoWidth
    var vh = video.videoHeight
    if (!r || !vw || !vh || video.hidden) { mask.hidden = true; return }
    // video は object-fit: contain。映像が実際に出ている範囲に合わせる
    var box = video.getBoundingClientRect()
    var scale = Math.min(box.width / vw, box.height / vh)
    var w = vw * scale
    var h = vh * scale
    var left = box.left + (box.width - w) / 2
    var top = box.top + (box.height - h) / 2
    mask.style.left = (left + r[0] * w) + 'px'
    mask.style.top = (top + r[1] * h) + 'px'
    mask.style.width = (r[2] * w) + 'px'
    mask.style.height = (r[3] * h) + 'px'
    mask.hidden = false
  }
  window.addEventListener('hashchange', placeMask)
  window.addEventListener('resize', placeMask)
  video.addEventListener('loadedmetadata', placeMask)
  video.addEventListener('resize', placeMask)
  placeMask()

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
