'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

function run(args, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mixctl'), ...args], {
      env: { ...process.env, MIXUI_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('mixctl route zcode sends protocol and describes registration rather than active-session switching', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, live: { base_url: 'http://127.0.0.1:8787/v1' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  for (const wire of ['anthropic', 'responses', 'chat']) {
    const result = await run(['route', 'zcode', wire], port);
    assert.equal(result.code, 0);
    assert.match(result.output, /已注册路由接入:ZCode/);
    assert.match(result.output, /未修改当前会话或默认模型/);
    assert.deepEqual(requests.pop(), { path: '/api/router/zcode', body: { wire_api: wire } });
  }
  await run(['route', 'zcode'], port);
  assert.equal(requests.pop().body.wire_api, 'anthropic');
  await run(['route', 'claude'], port);
  assert.deepEqual(requests.pop(), { path: '/api/router/claude', body: {} });
  const invalid = await run(['route', 'zcode', 'invalid'], port);
  assert.match(invalid.output, /协议必须/);
  assert.equal(requests.length, 0);
});
