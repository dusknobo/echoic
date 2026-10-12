const { launchBrowser } = require('./qa_support.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.ECHOIC_QA_BASE_URL || 'http://127.0.0.1:18767';
const qa = path.resolve(__dirname, '../.runtime/qa');
fs.mkdirSync(qa, { recursive: true });
function makeWav(seconds = 4) {
  const rate = 16000, size = rate * seconds * 2, buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF'); buffer.writeUInt32LE(size + 36, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(size, 40);
  for (let i = 0; i < size / 2; i++) buffer.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 240 * i / rate)), 44 + 2 * i);
  return buffer;
}
const wav = makeWav();
const inputPath = path.join(qa, 'mobile-input.wav');
fs.writeFileSync(inputPath, wav);
const tokens = ['The', 'weather', 'is', 'getting', 'colder.'];
const sentence = { index: 0, text: tokens.join(' '), start: 0, end: 3,
  words: tokens.map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.4 })) };
const audio = { id: 900001, title: '手机布局与录音验证：较长课程标题 mobile recording practice', language: 'en', duration: 4,
  sentences: [sentence, { ...sentence, index: 1, text: 'A second sentence for navigation.' }], created_at: '2026-10-11T00:00:00Z', collection_id: null };
const publicSettings = { enabled: true, analysis_provider: 'qwen', providers: Object.fromEntries(['tencent', 'azure', 'iflytek', 'openai', 'gemini', 'qwen', 'local'].map(id => [id, { configured: true, errors: [], endpoint: '', model: '', api_key_set: false }])) };
const score = { accuracy_score: 78, fluency_score: 82, completeness_score: 100, word_scores: tokens.map(word => ({ word, accuracy_score: 78 })) };
async function fixtures(context, state = {}) {
  state.records = []; state.uploads = []; state.markers = []; state.oral = [];
  await context.route(base + '/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const json = data => route.fulfill({ json: data });
    if (p.endsWith('/stream')) return route.fulfill({ body: wav, contentType: 'audio/wav' });
    if (p === '/api/audio/') return json([audio]);
    if (p === '/api/audio/' + audio.id) return json(audio);
    if (/\/phonemes$/.test(p)) return json(tokens.map(word => ({ word, ipa: '/test/' })));
    if (p === '/api/collections/') return json([]);
    if (p === '/api/stats/summary') return json({ today: { count: 1 }, week: { count: 1 }, total: { count: 1 }, streak: 1 });
    if (p === '/api/stats/heatmap') return json([{ date: '2026-10-11', count: 1 }]);
    if (p === '/api/stats/recent') return json([{ record_id: 1, audio_file_id: audio.id, audio_title: audio.title, sentence_text: sentence.text, created_at: audio.created_at, accuracy_score: 78 }]);
    if (p === '/api/gallery/') return json({ sources: [], programs: [], episodes: [] });
    if (p === '/api/ai/settings') return json(publicSettings);
    if (/\/analyses$/.test(p)) return json([]);
    if (/\/history$/.test(p)) return json(state.records);
    if (/\/save$/.test(p)) {
      const body = req.postDataBuffer().toString('latin1');
      state.uploads.push({ filename: body.match(/filename="([^"]+)"/)?.[1], mime: body.match(/Content-Type: ([^\r\n]+)/)?.[1] });
      if (state.failSave) { state.failSave = false; return route.fulfill({ status: 503, json: { detail: '模拟上传失败' } }); }
      const record = { id: 900100 + state.records.length, sentence_index: 0, created_at: audio.created_at, accuracy_score: null };
      state.records.unshift(record); return json(record);
    }
    if (/\/score$/.test(p)) return json({ ...state.records[0], ...score });
    if (/\/markers$/.test(p)) {
      if (req.method() === 'POST') { const marker = { id: state.markers.length + 1, ...req.postDataJSON() }; state.markers.push(marker); return json(marker); }
      return json(state.markers);
    }
    if (p === '/api/oral/attempts' && req.method() === 'POST') {
      state.oral.push(req.postDataBuffer().toString('latin1').match(/filename="([^"]+)"/)?.[1]);
      if (state.failOral) { state.failOral = false; return route.fulfill({ status: 503, json: { detail: '模拟口语上传失败' } }); }
      return json({ id: 900200, ...score });
    }
    if (p === '/api/oral/attempts') return json([]);
    if (p.startsWith('/api/dictionary/en/')) return json({ word: 'weather', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'The state of the atmosphere.', examples: [], synonyms: [] }] }] });
    return json([]);
  });
  return state;
}
async function noHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth, root: document.documentElement.scrollWidth,
    main: (() => { const element = document.querySelector('main'); return { client: element.clientWidth, scroll: element.scrollWidth }; })(),
  }));
  assert(dimensions.root <= dimensions.width + 1, label + ': viewport overflow ' + JSON.stringify(dimensions));
  assert(dimensions.main.scroll <= dimensions.main.client + 1, label + ': main overflow ' + JSON.stringify(dimensions));
}
(async () => {
  let browser;
  try {
    browser = await launchBrowser({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + inputPath] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', permissions: ['microphone'] });
    const state = await fixtures(context);
    await context.addInitScript(() => {
      window.qaStreams = []; window.qaMedia = []; window.qaPlays = [];
      const mediaPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function(...args) {
        if (!qaMedia.includes(this)) qaMedia.push(this);
        qaPlays.push({ id: qaMedia.indexOf(this), at: performance.now() });
        return mediaPlay.apply(this, args);
      };
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        if (window.qaHoldPermission) await new Promise(resolve => { window.qaResolvePermission = resolve; });
        const stream = await original(...args); window.qaStreams.push(stream); return stream;
      };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    const paths = ['/', '/speaking', '/listening/' + audio.id, '/speaking/' + audio.id + '?time=0', '/oral', '/oral/read_aloud', '/settings', '/gallery'];
    for (const width of (process.env.ECHOIC_QA_SKIP_LAYOUT ? [] : [320, 360, 390, 768, 1280])) {
      await page.setViewportSize({ width, height: width >= 768 ? 960 : 844 });
      for (const pathname of paths) {
        await page.goto(base + pathname); await page.waitForTimeout(200);
        await noHorizontalOverflow(page, width + ' ' + pathname);
        if (width < 768) {
          const smallFields = await page.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), textarea, select').evaluateAll(elements => elements.filter(element => element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 16).map(element => element.tagName));
          assert.deepEqual(smallFields, [], 'Mobile form text should remain at least 16px: ' + pathname);
        }
        if (width === 390 && ['/settings', '/speaking/' + audio.id + '?time=0', '/listening/' + audio.id].includes(pathname))
          await page.screenshot({ path: path.join(qa, 'mobile-' + (pathname.startsWith('/settings') ? 'settings' : pathname.startsWith('/listening') ? 'listening' : 'practice') + '.png'), fullPage: true });
      }
    }
    if (!process.env.ECHOIC_QA_SKIP_LAYOUT) console.log('PASS: 40 page/viewport layout checks.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/listening/' + audio.id);
    const play = page.getByRole('button', { name: '播放 (P)', exact: true });
    await play.click(); await page.waitForTimeout(250);
    await page.evaluate(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }); });
    const mark = page.getByRole('button', { name: '标记此刻', exact: true });
    const box = await mark.boundingBox(); assert(box.height >= 44, 'Mark button should be thumb-friendly');
    await mark.click(); assert.equal(await page.locator('audio').evaluate(element => element.paused), false, 'Touch mark must not pause');
    assert.equal(state.markers.length, 1);
    await page.goto(base + '/speaking/' + audio.id + '?time=0');
    const record = () => page.getByRole('button', { name: '点击开始录音', exact: true });
    await record().waitFor();
    state.failSave = true;
    await record().click(); await page.waitForTimeout(1400);
    if (!await page.getByRole('button', { name: '完成录音', exact: true }).count()) {
      await page.screenshot({ path: path.join(qa, 'mobile-record-debug.png'), fullPage: true });
      console.log('Capture start state:', await page.locator('body').innerText(), errors, await page.evaluate(() => ({ streams: qaStreams.length, visibility: document.visibilityState, secure: isSecureContext })));
    }
    await page.getByRole('button', { name: '完成录音', exact: true }).click();
    await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
    assert.equal(state.uploads.length, 1); assert.match(state.uploads[0].filename, /\.webm$/); assert.match(state.uploads[0].mime, /audio\/webm/);
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('已保存'));
    assert.equal(state.uploads.length, 2); assert.equal(state.records.length, 1);
    assert(await page.evaluate(() => qaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), 'Mic released after finish');
    await page.screenshot({ path: path.join(qa, 'mobile-recorded.png'), fullPage: true });
    // Playback compatibility must survive the new mobile recording path.
    await page.evaluate(() => { qaPlays = []; });
    await page.getByRole('button', { name: '原音与录音同时播放', exact: true }).click();
    await page.waitForFunction(() => qaPlays.length === 2 && qaMedia.filter(audio => !audio.paused).length === 2);
    const pairCalls = await page.evaluate(() => qaPlays);
    assert(pairCalls[1].at - pairCalls[0].at < 100, 'Both tracks start together');
    await page.getByRole('button', { name: '暂停同时播放', exact: true }).filter({ hasText: '暂停同时播放' }).click();
    assert(await page.evaluate(() => qaMedia.every(audio => audio.paused)), 'Both tracks pause');
    await page.getByRole('button', { name: '继续同时播放', exact: true }).filter({ hasText: '继续同时播放' }).click();
    await page.getByRole('button', { name: '原音与录音同时播放', exact: true }).waitFor();
    assert(await page.evaluate(() => qaMedia.every(audio => audio.paused)), 'Finishing pair never loops original');
    await page.evaluate(() => { qaPlays = []; });
    await page.getByRole('button', { name: '原声/录音对比', exact: true }).click();
    await page.waitForFunction(() => qaPlays.length === 2);
    const abCalls = await page.evaluate(() => qaPlays);
    assert(abCalls[1].at - abCalls[0].at > 500, 'A/B stays sequential');
    await page.waitForFunction(() => qaMedia.every(audio => audio.paused));
    // A pending permission response must not revive recording after navigation.
    await page.goto(base + '/speaking/' + audio.id + '?time=0'); await record().waitFor();
    await page.evaluate(() => { window.qaHoldPermission = true; });
    await record().click();
    await page.waitForFunction(() => typeof window.qaResolvePermission === 'function');
    await page.locator('nav[aria-label="手机主导航"]').getByRole('link', { name: '设置', exact: true }).click();
    await page.evaluate(() => { window.qaHoldPermission = false; window.qaResolvePermission(); });
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => qaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), 'Late mic stream must be released');
    // Backgrounding and device loss retain playable partial audio, then release the mic.
    for (const reason of ['background', 'device-ended']) {
      await page.goto(base + '/speaking/' + audio.id + '?time=0'); await record().waitFor();
      await record().click(); await page.getByRole('button', { name: '完成录音', exact: true }).waitFor();
      await page.waitForTimeout(1100);
      await page.evaluate(reason => {
        if (reason === 'background') {
          Object.defineProperty(document, 'hidden', { value: true, configurable: true });
          document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;
        } else {
          const track = qaStreams.at(-1).getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended'));
        }
      }, reason);
      await page.getByRole('alert').filter({ hasText: reason === 'background' ? /后台/ : /连接已中断/ }).waitFor();
      await page.getByText('录音已保存', { exact: true }).waitFor();
      assert(await page.evaluate(() => qaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))));
      await page.getByRole('button', { name: '播放录音', exact: true }).click();
      await page.waitForFunction(() => qaMedia.some(audio => !audio.paused));
    }
    // Permission denial needs a recoverable, visible message.
    await page.goto(base + '/speaking/' + audio.id + '?time=0'); await record().waitFor();
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError')); });
    await record().click(); await page.getByRole('alert').filter({ hasText: /麦克风|权限/ }).waitFor();
    // Oral submission errors retain the recording for retry.
    await page.goto(base + '/oral/read_aloud');
    await page.locator('textarea').fill(sentence.text);
    state.failOral = true;
    await page.getByRole('button', { name: '开始录音', exact: true }).click(); await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '停止录音', exact: true }).click();
    const submit = page.getByRole('button', { name: '提交评分', exact: true });
    await submit.click(); await submit.waitFor(); assert.equal(state.oral.length, 1);
    await submit.click(); await page.waitForTimeout(250); assert.equal(state.oral.length, 2);
    assert.deepEqual(errors, []);
    console.log('PASS: nonpausing touch marker, real WebM capture and save retry, simultaneous playback/pause/resume, A/B, late-permission cancellation, background/device interruption with playable partial audio, denied mic guidance and oral retry. All API writes mocked; no paid AI requests.');
  } finally { await browser?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
