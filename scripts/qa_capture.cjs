// Native WebKit encoder + synthetic input. This does NOT test OS microphone access.
async function installMP4Capture(context) {
  await context.addInitScript(() => {
    const Recorder = window.MediaRecorder;
    const supported = Recorder?.isTypeSupported?.bind(Recorder);
    window.qaNativeMP4 = !!supported?.('audio/mp4');
    if (!window.qaNativeMP4) return;
    // Modern WebKit may prefer WebM. Restrict capability discovery, leaving the
    // constructor, encoding, dataavailable, pause/resume and stop native.
    Recorder.isTypeSupported = type => type.startsWith('audio/mp4') && supported(type);
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      oscillator.frequency.value = 240;
      oscillator.connect(destination);
      oscillator.start();
      await audio.resume();
      const track = destination.stream.getAudioTracks()[0];
      const stop = track.stop.bind(track);
      let stopped = false;
      track.stop = () => {
        stop();
        if (!stopped) {
          stopped = true;
          oscillator.stop();
          void audio.close();
        }
      };
      return destination.stream;
    };
  });
}

async function readUpload(request) {
  const form = await new Request(request.url(), {
    method: 'POST', headers: { 'content-type': request.headers()['content-type'] }, body: request.postDataBuffer(),
  }).formData();
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Missing multipart recording file');
  return { filename: file.name, mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
}

module.exports = { installMP4Capture, readUpload };
