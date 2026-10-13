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

const http = require('node:http');
const https = require('node:https');
const isUpload = pathname => /\/save$/.test(pathname) || pathname === '/api/oral/attempts';

// Read the actual HTTP body. WebKit's inspector can omit Blob bytes from
// request.postDataBuffer(), so protocol interception is not an upload oracle.
async function readUpload(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const form = await new Request('http://localhost' + request.url, {
    method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: Buffer.concat(chunks),
  }).formData();
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Missing multipart recording file');
  return { filename: file.name, mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
}

async function startUploadServer(frontendBase, handleUpload) {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/api/oral/attempts') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('[]'); return;
    }
    if (request.method === 'POST' && isUpload(pathname)) {
      try {
        const result = await handleUpload(pathname, await readUpload(request));
        response.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result.json));
      } catch (error) {
        console.error('Upload fixture failed:', error);
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Upload fixture failed' }));
      }
      return;
    }
    // Unknown API writes cannot escape to a user's backend.
    if (pathname.startsWith('/api/')) { response.writeHead(404); response.end(); return; }
    const target = new URL(request.url, frontendBase);
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: request.method }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

module.exports = { installMP4Capture, startUploadServer, isUpload };
