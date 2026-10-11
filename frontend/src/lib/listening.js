const SHORTCUTS = new Set(['Space', 'KeyM', 'Semicolon', 'KeyP'])

export function ignoresListeningShortcut(event) {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return true
  const target = event.target
  return !!(target?.isContentEditable || target?.closest?.(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"]',
  ))
}

// Capture keyup too: Space must not activate a focused play/delete button.
export function bindListeningShortcuts(target, { mark, togglePlayback }) {
  const held = new Set()
  function keydown(event) {
    if (!SHORTCUTS.has(event.code) || ignoresListeningShortcut(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat || held.has(event.code)) return
    held.add(event.code)
    if (event.code === 'KeyP') togglePlayback()
    else mark()
  }
  function keyup(event) {
    if (!held.has(event.code)) return
    event.preventDefault()
    event.stopPropagation()
    held.delete(event.code)
  }
  function blur() { held.clear() }
  target.addEventListener('keydown', keydown, true)
  target.addEventListener('keyup', keyup, true)
  target.addEventListener('blur', blur)
  return () => {
    target.removeEventListener('keydown', keydown, true)
    target.removeEventListener('keyup', keyup, true)
    target.removeEventListener('blur', blur)
  }
}

// Reading a timestamp is deliberately independent of all playback operations.
export function readMarkerTime(audio) {
  if (!audio || audio.readyState < 1 || !Number.isFinite(audio.currentTime)) return null
  return Math.max(0, Math.round(audio.currentTime * 1000) / 1000)
}

export function sentenceAtTime(sentences, time) {
  if (!sentences.length || !Number.isFinite(time)) return null
  return sentences.find(sentence => time >= sentence.start && time <= sentence.end)
    ?? [...sentences].reverse().find(sentence => sentence.start <= time)
    ?? sentences[0]
}


// Use the ASR word boundaries without changing the marker's original timestamp.
// A short gap can be a word boundary; a long silence must stay unassigned.
export function wordAtTime(sentences, time) {
  if (!Array.isArray(sentences) || !Number.isFinite(time) || time < 0) return null
  const words = []
  for (const sentence of sentences) {
    if (!Array.isArray(sentence?.words)) continue
    sentence.words.forEach((word, wordIndex) => {
      if (typeof word?.word !== 'string' || !word.word.trim()
        || !Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < 0 || word.end <= word.start) return
      words.push({ word: word.word, start: word.start, end: word.end, wordIndex, sentence })
    })
  }
  words.sort((a, b) => a.start - b.start || a.end - b.end)
  const exact = words.find(word => word.start <= time && time < word.end)
  if (exact) return { ...exact, match: 'exact' }

  let closest = null
  let closestDistance = Infinity
  for (const word of words) {
    const distance = Math.min(Math.abs(time - word.start), Math.abs(time - word.end))
    // The chronological order keeps the preceding word when distances tie.
    if (distance < closestDistance) {
      closest = word
      closestDistance = distance
    }
  }
  return closestDistance <= 0.75 ? { ...closest, match: 'nearby' } : null
}

export function formatListeningTime(seconds, digits = 1) {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const scale = 10 ** digits
  const units = Math.round(value * scale)
  const minutes = Math.floor(units / (60 * scale))
  const rest = ((units % (60 * scale)) / scale).toFixed(digits).padStart(digits + 3, '0')
  return `${minutes}:${rest}`
}

// A POST can commit even when its response is lost. Reconcile by the stable
// client UUID before writing the remaining pending queue back to localStorage.
export function reconcileMarkers(previous, remote) {
  const pending = previous.filter(marker => marker.status !== 'saved')
  const pendingByClientId = new Map(pending.map(marker => [marker.localId, marker]))
  const saved = new Map(previous.filter(marker => marker.status === 'saved').map(marker => [marker.id, marker]))
  for (const marker of remote) {
    const matched = marker.client_id ? pendingByClientId.get(marker.client_id) : null
    saved.set(marker.id, {
      ...saved.get(marker.id), ...marker,
      ...(matched ? { localId: matched.localId } : {}),
      status: 'saved',
    })
  }
  const savedClientIds = new Set([...saved.values()].map(marker => marker.client_id || marker.localId).filter(Boolean))
  return [...saved.values(), ...pending.filter(marker => !savedClientIds.has(marker.localId))]
}
