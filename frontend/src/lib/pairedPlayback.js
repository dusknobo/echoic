/** Keep two players together without restarting the shorter, finished track. */
export function createPairedPlayback({ getPlayers, onPhaseChange = () => {}, onError = () => {}, shouldPauseStalePlayer = () => true }) {
  let phase = null
  let players = []
  let finished = new Set()
  let revision = 0
  let rate = 1

  function setPhase(next) {
    phase = next
    onPhaseChange(next)
  }

  function safePause(player) {
    try { player?.pause() } catch { /* A replaced WaveSurfer may already be destroyed. */ }
  }

  function wantsToPlay(player) {
    return phase === 'playing' && players.includes(player) && !finished.has(player)
  }

  function reconcileStalePlayer(player) {
    if (!wantsToPlay(player) && shouldPauseStalePlayer(player)) safePause(player)
  }

  function stop() {
    revision++
    const previous = players
    players = []
    finished = new Set()
    setPhase(null)
    previous.forEach(safePause)
  }

  function fail(error, operation) {
    if (operation !== revision) return
    stop()
    onError(error)
  }

  function playRemaining() {
    const operation = ++revision
    setPhase('playing')
    // Start both play() calls in this turn, before awaiting either promise.
    for (const player of players) {
      if (finished.has(player)) continue
      try {
        const request = player.play()
        Promise.resolve(request).then(() => {
          if (operation !== revision) reconcileStalePlayer(player)
        }, error => {
          if (operation === revision) fail(error, operation)
          else reconcileStalePlayer(player)
        })
      } catch (error) {
        fail(error, operation)
        break
      }
    }
  }

  function toggle() {
    if (phase === 'playing') {
      revision++
      setPhase('paused')
      players.forEach(safePause)
      return
    }
    if (phase === 'paused') {
      playRemaining()
      return
    }
    const next = getPlayers()
    if (next.length !== 2 || next.some(player => !player || !(player.getDuration() > 0))) return
    stop()
    players = next
    try {
      players.forEach(player => { player.pause(); player.seekTo(0); player.setPlaybackRate(rate) })
      playRemaining()
    } catch (error) {
      stop()
      onError(error)
    }
  }

  function finish(player) {
    if (!phase || !players.includes(player)) return false
    finished.add(player)
    if (finished.size === players.length) stop()
    return true
  }

  function setRate(next) {
    rate = Number.isFinite(next) && next > 0 ? next : 1
    try { players.forEach(player => player.setPlaybackRate(rate)) }
    catch (error) { stop(); onError(error) }
  }

  return { toggle, stop, finish, setRate, wantsToPlay, getPhase: () => phase }
}
