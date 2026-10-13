const fs = require('node:fs');
const path = require('node:path');

// Install Playwright normally, or point ECHOIC_PLAYWRIGHT_MODULE at an existing
// module. ECHOIC_BROWSER_PATH optionally chooses an installed browser executable.
const { chromium, webkit } = require(process.env.ECHOIC_PLAYWRIGHT_MODULE || 'playwright');

function isExecutableFile(candidate) {
  if (!candidate) return false;
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function browserExecutablePath() {
  const requested = process.env.ECHOIC_BROWSER_PATH?.trim();
  if (requested) {
    if (!isExecutableFile(requested)) {
      throw new Error('ECHOIC_BROWSER_PATH must point to an existing browser executable.');
    }
    return requested;
  }
  const windowsRoots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA];
  const candidates = windowsRoots.filter(Boolean).map(directory => path.join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  candidates.push(
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge/msedge',
  );
  return candidates.find(isExecutableFile);
}

async function launchBrowser(options = {}) {
  const browser = process.env.ECHOIC_QA_BROWSER || 'chromium';
  if (browser === 'webkit') {
    if (process.env.ECHOIC_BROWSER_PATH || options.executablePath || options.args?.length) {
      throw new Error('WebKit requires its Playwright build; Chromium/Edge paths and flags are not supported.');
    }
    return webkit.launch({ headless: true, ...options });
  }
  if (browser !== 'chromium') throw new Error('ECHOIC_QA_BROWSER must be chromium or webkit.');
  const executablePath = browserExecutablePath();
  // Without an installed Edge, omit executablePath so Playwright selects its
  // bundled Chromium (install it with: npx playwright install chromium).
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), ...options });
}

module.exports = { launchBrowser };
