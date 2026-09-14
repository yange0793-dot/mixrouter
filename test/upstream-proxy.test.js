'use strict';
// 出站 CONNECT 代理:http 隧道、TLS 隧道(开启证书校验)、代理拒连/不可用时明确报错、环回直连。
// 生产流量经 MIXR_UPSTREAM_PROXY 出站(fake-IP 环境里上游域名直连会被 TLS 重置),
// 本机渠道(本地模型、mock 上游)则必须直连——隧道用例因此打本机非环回地址。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createProxyAgents, upstreamAgent, bypassed } = require('../lib/upstream-proxy');

const lanIP = () => {
  for (const list of Object.values(os.networkInterfaces()))
    for (const entry of list || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  return '';
};
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
const listen = (server, host = '127.0.0.1') => new Promise(ok => server.listen(0, host, ok));
// keep-alive 隧道会让 server.close() 一直等连接,先掐掉现役连接
const close = server => { try { server.closeAllConnections(); } catch {} return new Promise(ok => server.close(ok)); };
const fetchThrough = (url, agent) => new Promise((resolve, reject) => {
  const transport = url.startsWith('https:') ? https : http;
  const req = transport.get(url, { agent }, res => {
    let text = ''; res.on('data', c => text += c);
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
});

test('CONNECT 隧道:上游经代理转发,CONNECT 目标与凭据正确;连接复用;代理拒连时报错不静默直连', async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4,隧道用例无法构造');
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('tunnel-ok');
  });
  await listen(upstream, '0.0.0.0');
  const { server: proxy, tunnels } = mockProxy();
  await listen(proxy);
  t.after(async () => { await Promise.all([close(upstream), close(proxy)]); });

  const port = upstream.address().port;
  const url = `http://${host}:${port}/v1/messages`;
  const agents = createProxyAgents(`http://user:p%40ss@127.0.0.1:${proxy.address().port}`);
  process.env.MIXR_UPSTREAM_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  t.after(() => { delete process.env.MIXR_UPSTREAM_PROXY; });

  let r = await fetchThrough(url, agents.http);
  assert.equal(r.text, 'tunnel-ok');
  assert.equal(tunnels.length, 1);
  assert.equal(tunnels[0].authority, `${host}:${port}`);
  assert.equal(tunnels[0].auth, 'Basic ' + Buffer.from('user:p@ss').toString('base64'));
  assert.equal(hits[0].host, `${host}:${port}`, '隧道内请求保留真实 Host');
  // 同一 agent 复用隧道 socket:第二次请求不再新建 CONNECT
  await fetchThrough(url, agents.http);
  assert.equal(tunnels.length, 1, '连接复用,不重复 CONNECT');

  const refusal = mockProxy({ refuse: true });
  await listen(refusal.server);
  t.after(() => close(refusal.server));
  const refused = createProxyAgents(`http://127.0.0.1:${refusal.server.address().port}`);
  await assert.rejects(fetchThrough(url, refused.http), /CONNECT 403/);

  await close(proxy);
  assert.equal(typeof upstreamAgent('http:'), 'object');
  await assert.rejects(fetchThrough(url, upstreamAgent('http:')), /ECONNREFUSED|CONNECT/,
    '代理挂掉后明确失败,不回落直连');
});

test('环回上游不走隧道:挂上出站代理后本机渠道照常直连', async t => {
  const upstream = http.createServer((req, res) => { res.writeHead(200); res.end('local-direct'); });
  await listen(upstream);
  t.after(() => close(upstream));
  const port = upstream.address().port;
  // 代理指向一个没人听的端口:环回请求若走隧道就会失败
  const agents = createProxyAgents('http://127.0.0.1:9');
  assert.equal((await fetchThrough(`http://127.0.0.1:${port}/v1/messages`, agents.http)).text, 'local-direct');
  assert.equal((await fetchThrough(`http://localhost:${port}/v1/messages`, agents.http)).text, 'local-direct');
  // 绕过表:环回恒绕过;MIXR_UPSTREAM_PROXY_BYPASS 里的域名(支持 . 后缀)也直连
  // (只验判定函数:本机 fake-IP 环境里不存在域名会被劫持,DNS 断言会挂)
  assert.equal(bypassed('localhost'), true);
  assert.equal(bypassed('127.0.0.1'), true);
  assert.equal(bypassed('[::1]'), true);
  assert.equal(bypassed('api.deepseek.com'), false);
  process.env.MIXR_UPSTREAM_PROXY_BYPASS = 'bypass.test, .internal.corp';
  t.after(() => { delete process.env.MIXR_UPSTREAM_PROXY_BYPASS; });
  assert.equal(bypassed('bypass.test'), true);
  assert.equal(bypassed('a.internal.corp'), true);
  assert.equal(bypassed('notinternal.corp'), false);
});

test('CONNECT 隧道:TLS 上游(自签 CA 校验开启)与 IP 主机无 SNI', async t => {
  const host = lanIP();
  if (!host) return t.skip('本机没有非环回 IPv4,隧道用例无法构造');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (spawnSync('openssl', ['version']).status !== 0) return t.skip('本机没有 openssl,跳过 TLS 隧道用例');
  // 本机 openssl 是 LibreSSL(不认 -extfile),SAN 走配置文件
  const cfg = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(cfg, ['[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
    '[dn]', 'CN = mixr-proxy-test', '[v3]', `subjectAltName = IP:${host},IP:127.0.0.1,DNS:localhost`,
    'basicConstraints = CA:TRUE', ''].join('\n'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-days', '2', '-config', cfg], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const ca = fs.readFileSync(path.join(dir, 'cert.pem'));

  const upstream = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: ca },
    (req, res) => { res.writeHead(200); res.end('tls-tunnel-ok'); });
  await listen(upstream, '0.0.0.0');
  const { server: proxy, tunnels } = mockProxy();
  await listen(proxy);
  t.after(async () => { await Promise.all([close(upstream), close(proxy)]); });

  const port = upstream.address().port;
  const url = `https://${host}:${port}/v1/responses`;
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const r = await fetchThrough(url, createProxyAgents(proxyUrl, { https: { ca } }).https);
  assert.equal(r.text, 'tls-tunnel-ok');
  assert.equal(tunnels[0].authority, `${host}:${port}`);
  // 证书未被信任时明确失败(不静默降级)
  await assert.rejects(fetchThrough(url, createProxyAgents(proxyUrl).https), /self.signed|unable to verify|CERT/i);
  // 环回 + TLS:直连路径也要能建起会话(绕过隧道,证书由 ca 信任)
  const local = await fetchThrough(`https://127.0.0.1:${port}/v1/responses`,
    createProxyAgents('http://127.0.0.1:9', { https: { ca } }).https);
  assert.equal(local.text, 'tls-tunnel-ok');
});
