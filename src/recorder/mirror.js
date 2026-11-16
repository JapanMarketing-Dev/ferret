// 録画の対象の画面・ウインドウ（desktopCapturer の ID）を映すだけ。音は取らない
//
// 映すものは URL のハッシュ "src=…&msg=…&mask=…" で届く（@shared/captureComposite の mirrorHash。main の browser.ts が渡す）。
// 録る対象を切り替えても、ページは読み込み直さずハッシュだけが替わる。新しい映像の最初の1枚が出てから入れ替えるので、
// 切り替えの間も前の映像が出たまま（黒くならない。2026-11-16、録る対象の切り替えでチカチカした）。
// 最初の映像が出たら題名を mirror-ready、映せなければ mirror-failed にする（main はそれを見て初めてビューを出す）。
;(function () {
  var ID = /^(screen|window):[\w:-]+$/
  var MAX_SOURCES = 4
  var note = document.getElementById('note')
  /** いま出している映像の組（stage は映像を並べる要素、key は映しているものの ID をつないだもの） */
  var shown = null
  /** 用意している新しい映像の組（最初の1枚が出たら shown と入れ替える） */
  var pending = null

  var mask = document.createElement('div')
  mask.className = 'self-mask'
  mask.hidden = true
  document.body.appendChild(mask)

  function readState() {
    var hash = new URLSearchParams(location.hash.slice(1))
    var ids = (hash.get('src') || '').split(',').filter(function (s) { return ID.test(s) }).slice(0, MAX_SOURCES)
    return { ids: ids, message: hash.get('msg') || '', mask: readMask(hash.get('mask')) }
  }

  function readMask(value) {
    var m = /^([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(value || '')
    if (!m) return null
    var r = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    for (var i = 0; i < 4; i++) if (!isFinite(r[i]) || r[i] < 0 || r[i] > 1) return null
    return r[2] > 0 && r[3] > 0 ? r : null
  }

  function stopSet(set) {
    if (!set) return
    set.dead = true
    set.videos.forEach(function (video) {
      var stream = video.srcObject
      if (stream) stream.getTracks().forEach(function (track) { track.stop() })
      video.srcObject = null
    })
    if (set.stage.parentNode) set.stage.parentNode.removeChild(set.stage)
  }

  function signal(title) {
    if (document.title !== title) document.title = title
  }

  /** 映せない（ウインドウが閉じた・画面収録の許可が無い）。理由の文は main が画面の言語で渡す */
  function showFailure(message, err) {
    stopSet(shown)
    shown = null
    note.textContent = message
    note.hidden = false
    placeMask()
    signal('mirror-failed')
    if (err) console.warn('mirror: ' + String((err && err.message) || err))
  }

  /** 新しい組を出す。前の組は、新しいものが出てから片付ける */
  function reveal(set) {
    if (set.dead || pending !== set) return
    pending = null
    var old = shown
    shown = set
    set.stage.classList.remove('is-pending')
    note.hidden = true
    stopSet(old)
    placeMask()
    signal('mirror-ready')
  }

  /**
   * 最初の1枚が届いたら呼ぶ（readyState が HAVE_CURRENT_DATA 以上。loadeddata）。
   * requestVideoFrameCallback は使わない: 画面に描かれたときにしか呼ばれず、ビューも組も隠している間は来ない
   */
  function onFirstFrame(video, done) {
    if (video.readyState >= 2) { done(); return }
    video.addEventListener('loadeddata', function once() { video.removeEventListener('loadeddata', once); done() })
  }

  function startSet(ids, message) {
    stopSet(pending)
    var stage = document.createElement('div')
    stage.className = 'stage is-pending' + (ids.length > 1 ? ' is-grid' : '')
    stage.style.setProperty('--cols', String(Math.ceil(Math.sqrt(ids.length))))
    document.body.insertBefore(stage, note)
    var set = { key: ids.join(','), stage: stage, videos: [], dead: false }
    pending = set
    ids.forEach(function (sourceId, index) {
      var video = document.createElement('video')
      video.autoplay = true
      video.muted = true
      video.playsInline = true
      if (index === 0) video.addEventListener('resize', placeMask)
      stage.appendChild(video)
      set.videos.push(video)
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 30 } }
      }).then(function (stream) {
        if (set.dead) { stream.getTracks().forEach(function (track) { track.stop() }); return }
        video.srcObject = stream
        stream.getVideoTracks().forEach(function (track) {
          track.addEventListener('ended', function () { if (index === 0 && shown === set) showFailure(message, null) })
        })
        // 並べて映すときも、最初のもの（main）が出たら入れ替える。ほかは出たものから映る
        if (index === 0) onFirstFrame(video, function () { reveal(set) })
      }).catch(function (err) {
        if (set.dead) return
        // main が映せなければ理由の文を出す。並べているほかのものが映せなければ、その枠だけ暗いままにする（録画は続く）
        if (index === 0) { stopSet(set); if (pending === set) pending = null; showFailure(message, err) }
        else console.warn('mirror: ' + String((err && err.message) || err))
      })
    })
  }

  /*
   * 録っている画面の中に、この枠（Ferret の中で映像を映している場所）自身が写っているときは、その場所を塗りつぶす。
   * そのまま映すと、枠の中に枠が映り、無限に重なる（合わせ鏡）。場所はハッシュの mask（画面に対する 0〜1 の割合）
   */
  function placeMask() {
    var state = readState()
    var video = shown && shown.videos.length === 1 ? shown.videos[0] : null
    var r = state.mask
    var vw = video ? video.videoWidth : 0
    var vh = video ? video.videoHeight : 0
    if (!r || !vw || !vh) { mask.hidden = true; return }
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

  function apply() {
    var state = readState()
    var key = state.ids.join(',')
    if (!key) { showFailure(state.message, null); return }
    if ((shown && shown.key === key && !pending) || (pending && pending.key === key)) { placeMask(); return }
    if (shown && shown.key === key && pending) { stopSet(pending); pending = null; placeMask(); return }
    startSet(state.ids, state.message)
    placeMask()
  }

  window.addEventListener('hashchange', apply)
  window.addEventListener('resize', placeMask)
  apply()
})()
