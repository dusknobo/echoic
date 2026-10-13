// Own the preview lifecycle so local and CI runs use the same built frontend.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const browser = process.argv[2] || 'chromium';
if (!['chromium', 'webkit'].includes(browser)) throw new Error('Expected chromium or webkit');
const base = process.env.ECHOIC_QA_BASE_URL || 'http://127.0.0.1:18767';
let server;
let child;
const stop = () => { child?.kill(); server?.kill(); };
process.on('SIGINT', () => { stop(); process.exit(130); });
process.on('SIGTERM', () => { stop(); process.exit(143); });
(async () => {
  try {
    if (!process.env.ECHOIC_QA_BASE_URL) {
      if (!fs.existsSync(path.join(root, 'backend/static/index.html'))) {
        throw new Error('Build the frontend first: npm --prefix frontend run build');
      }
      server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '18767', '--strictPort'], {
        cwd: path.join(root, 'frontend'), stdio: ['ignore', 'pipe', 'inherit'],
      });
      server.stdout.pipe(process.stdout);
      // Observe our child's ready message before probing the port; an unrelated
      // server on 18767 must not accidentally satisfy the readiness check.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 20000);
        let output = '';
        const fail = error => { clearTimeout(timer); reject(error); };
        server.once('error', fail);
        server.once('exit', () => fail(new Error('Preview exited before becoming ready')));
        server.stdout.on('data', chunk => {
          output += chunk.toString();
          if (output.replace(/\x1b\[[0-9;]*m/g, '').includes('Local:')) { clearTimeout(timer); resolve(); }
        });
      });
      const deadline = Date.now() + 20000;
      while (true) {
        if (server.exitCode !== null) throw new Error('Preview exited before becoming ready');
        try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
        if (Date.now() >= deadline) throw new Error('Preview startup timed out');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    child = spawn(process.execPath, [path.join(__dirname, 'qa_mobile.cjs')], {
      cwd: root, stdio: 'inherit', env: { ...process.env, ECHOIC_QA_BASE_URL: base, ECHOIC_QA_BROWSER: browser },
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally { stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
