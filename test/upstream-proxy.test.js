'use strict';
// 出站 CONNECT 代理:http 隧道、TLS 隧道(开启证书校验)、代理拒连与不可用时明确报错。
// 生产流量经 MIXR_UPSTREAM_PROXY 出站(fake-IP 环境里上游域名直连会被 TLS 重置)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createProxyAgents, upstreamAgent } = require('../lib/upstream-proxy');

function mockProxy({ refuse = false } = {}) {
  const tunnels = [];
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    tunnels.push({ authority: req.url, auth: req.headers['proxy-authorization'] || '' });
    if (refuse) { clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    const target = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(clientSocket); clientSocket.pipe(target);
    });
    const kill = () => { target.destroy(); clientSocket.destroy(); };
    target.on('error', kill); clientSocket.on('error', kill);
  });
  return { server, tunnels };
}
const listen = server => new Promise(ok => server.listen(0, '127.0.0.1', ok));
// keep-alive 隧道会让 server.close() 一直等连接,先掐掉现役连接
const close = server => { try { server.closeAllConnections(); } catch {} return new Promise(ok => server.close(ok)); };
const fetchThrough = (url, agent, extra = {}) => new Promise((resolve, reject) => {
  const transport = url.startsWith('https:') ? https : http;
  const req = transport.get(url, { agent, ...extra }, res => {
    let text = ''; res.on('data', c => text += c);
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
});

test('CONNECT 隧道:明文上游经代理转发,CONNECT 目标与凭据正确;代理拒连时报错不静默直连', async t => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('tunnel-ok');
  });
  await listen(upstream);
  const { server: proxy, tunnels } = mockProxy();
  await listen(proxy);
  t.after(async () => { await Promise.all([close(upstream), close(proxy)]); });

  const url = `http://127.0.0.1:${upstream.address().port}/v1/messages`;
  const agents = createProxyAgents(`http://user:p%40ss@127.0.0.1:${proxy.address().port}`);
  process.env.MIXR_UPSTREAM_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  t.after(() => { delete process.env.MIXR_UPSTREAM_PROXY; });

  let r = await fetchThrough(url, agents.http);
  assert.equal(r.text, 'tunnel-ok');
  assert.equal(tunnels.length, 1);
  assert.equal(tunnels[0].authority, `127.0.0.1:${upstream.address().port}`);
  assert.equal(tunnels[0].auth, 'Basic ' + Buffer.from('user:p@ss').toString('base64'));
  assert.equal(hits[0].host, `127.0.0.1:${upstream.address().port}`, '隧道内请求保留真实 Host');
  // 同一 agent 复用隧道 socket:第二次请求不再新建 CONNECT
  await fetchThrough(url, agents.http);
  assert.equal(tunnels.length, 1, '连接复用,不重复 CONNECT');

  const refusal = mockProxy({ refuse: true });
  await listen(refusal.server);
  t.after(() => close(refusal.server));
  const refused = createProxyAgents(`http://127.0.0.1:${refusal.server.address().port}`);
  await assert.rejects(fetchThrough(url, refused.http), /CONNECT 403/);

  await close(proxy);
  await assert.rejects(upstreamAgent('http:') ? fetchThrough(url, upstreamAgent('http:')) : Promise.reject(new Error('no agent')),
    /ECONNREFUSED|CONNECT/, '代理挂掉后明确失败,不回落直连');
});

test('CONNECT 隧道:TLS 上游(自签 CA 校验开启)与 IP 主机无 SNI', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (spawnSync('openssl', ['version']).status !== 0) return t.skip('本机没有 openssl,跳过 TLS 隧道用例');
  // 本机 openssl 是 LibreSSL(不认 -extfile),SAN 走配置文件
  const cfg = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(cfg, ['[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
    '[dn]', 'CN = mixr-proxy-test', '[v3]', 'subjectAltName = IP:127.0.0.1,DNS:localhost',
    'basicConstraints = CA:TRUE', ''].join('\n'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-days', '2', '-config', cfg], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const upstream = https.createServer({
    key: fs.readFileSync(path.join(dir, 'key.pem')),
    cert: fs.readFileSync(path.join(dir, 'cert.pem')),
  }, (req, res) => { res.writeHead(200); res.end('tls-tunnel-ok'); });
  await listen(upstream);
  const { server: proxy, tunnels } = mockProxy();
  await listen(proxy);
  t.after(async () => { await Promise.all([close(upstream), close(proxy)]); });

  const url = `https://127.0.0.1:${upstream.address().port}/v1/responses`;
  const agents = createProxyAgents(`http://127.0.0.1:${proxy.address().port}`,
    { https: { ca: fs.readFileSync(path.join(dir, 'cert.pem')) } });
  const r = await fetchThrough(url, agents.https);
  assert.equal(r.text, 'tls-tunnel-ok');
  assert.equal(tunnels[0].authority, `127.0.0.1:${upstream.address().port}`);
  // 证书未被信任时明确失败(不静默降级)
  await assert.rejects(fetchThrough(url, createProxyAgents(`http://127.0.0.1:${proxy.address().port}`).https),
    /self.signed|unable to verify|CERT/i);
});
