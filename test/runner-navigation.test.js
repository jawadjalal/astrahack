import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { launchBrowser, attach } from '../src/cdp.js';
import { navigate } from '../src/runner.js';

const chrome = process.env.ASTRAHACK_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('navigation reports explicit browser failure without waiting for content', async () => {
  let evaluated = false;
  const cdp = { send: async () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }), eval: async () => { evaluated = true; } };
  await assert.rejects(navigate(cdp, 'https://invalid.test/'), /Navigation failed: net::ERR_NAME_NOT_RESOLVED/);
  assert.equal(evaluated, false);
});

test('real Chrome accepts rendered content while a remote script keeps the parser loading', { skip: !existsSync(chrome) }, async () => {
  let scriptRequested = false;
  const server = createServer((request, response) => {
    if (request.url === '/stalled-script.js') { scriptRequested = true; return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Stalled script fixture</title><h1>Ready to use</h1><button>Explore</button><script src="/stalled-script.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  let cdp;
  try {
    browser = await launchBrowser({ executable: chrome });
    cdp = await attach(browser.port);
    const started = Date.now();
    await navigate(cdp, `http://127.0.0.1:${server.address().port}/`);
    assert.equal(scriptRequested, true);
    assert.equal(await cdp.eval('document.readyState'), 'loading');
    assert.equal(await cdp.eval('document.querySelector("h1").innerText'), 'Ready to use');
    assert.ok(Date.now() - started < 10000, 'Rendered UI should not wait for the stalled script');
  } finally {
    cdp?.close();
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
