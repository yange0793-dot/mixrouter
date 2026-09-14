'use strict';
// 端到端超时预算的**行为**回归。每一条都钉一个以前真的会出事的方向:
//   - 上游不发响应头:流式请求要按"流式首字节"预算早收,而不是陪着耗满整个总预算
//   - 非流式上游给了头却永远不结束 body:总 deadline 到点就收,不干等到客户端自己的本地超时
//   - 上游一滴一滴地发字节:空闲看门狗永远轮不到它,**以前流式压根没有总计时器**(isSse ? null),
//     这种流能一直拖着,而客户端 300s 早就放弃并重发了
//   - 上游沉默时补 SSE 注释,让客户端的字节流空闲计时器知道连接还活着
//   - 补注释**只能在响应提交之后**:提交前写一个字节就毁掉了"整条重试"的前提
// 全部走本地桩,不连真实上游。
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-budget-'));
process.env.MIXR_DATA_DIR = TMP;
process.env.MIXR_CLAUDE_SETTINGS = path.join(TMP, 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(TMP, 'config.toml');
// 把预算压到毫秒级,好在测试里真的等到"超时"那一刻(默认值见 health.test.js 的不变量断言)
process.env.MIXR_TOTAL_DEADLINE_MS = '900';
// 非流式首字节给足(要等模型整篇生成完),流式给很短:两者必须真的分开,否则这条预算没意义
process.env.MIXR_FIRST_HEADER_TIMEOUT_MS = '4000';
process.env.MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS = '400';
process.env.MIXR_STREAM_IDLE_TIMEOUT_MS = '60000'; // 会被总 deadline 夹住,滴流场景下它也轮不到
process.env.MIXR_NONSTREAM_TOTAL_TIMEOUT_MS = '60000';
process.env.MIXR_SSE_KEEPALIVE_MS = '120';

// ---------------------------------------------------------------- 桩上游
// mode 决定上游怎么"坏":noHeaders / quietBody / drip / commitThenSlow / responsesSlowError
let mode = 'ok';
let slowErrorLeft = 0;
const sockets = new Set();
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    const sse = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    if (mode === 'noHeaders') return; // 收了请求就是不回,一直挂着
    if (mode === 'quietBody') {
      // 头给了、body 开了个头就永远不结束。必须真的写点东西:只 writeHead 的话 Node 不会把响应头
      // 发出去,路由器那边连响应都还没收到,量的就成了首字节超时而不是这里要测的那一段
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.write('{"id":"msg_partial","content":[');
    }
    if (mode === 'drip') {
      // 一直有字节,但永远不结束:空闲看门狗被每次字节重置,只有总 deadline 收得住它
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const t = setInterval(() => { try { res.write('data: 滴\n\n'); } catch {} }, 150);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (mode === 'commitThenSlow') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 前半段\n\n'); // 这一下就把客户端那条响应提交了
      const t = setTimeout(() => { try { res.write('data: 后半段\n\n'); res.end(); } catch {} }, 500);
      res.on('close', () => clearTimeout(t));
      return;
    }
    if (mode === 'responsesSlowError' && slowErrorLeft > 0 && req.url.includes('/responses')) {
      slowErrorLeft--;
      // 200 的皮里包错误:先吐一行心跳(真实上游都会立刻发字节,不发的话 socket 空闲超时会先收掉它),
      // 沉默 250ms 再吐错误帧——这 250ms 就是"提交前"的窗口
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': upstream-open\n\n');
      const t = setTimeout(() => {
        try { res.write('data: {"type":"error","error":{"message":"渠道池打满"}}\n\n'); res.end(); } catch {}
      }, 250);
      res.on('close', () => clearTimeout(t));
      return;
    }
    if (req.url.includes('/responses')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse({ type: 'response.created', response: { id: 'r1', model: body.model } });
      sse({ type: 'response.output_text.delta', output_index: 0, delta: '转换流内容' });
      sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"直通内容"}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

let mod, proxySrv, uiSrv, proxyPort, uiPort, upPort;

function rawRequest(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const creq = http.request({
      hostname: '127.0.0.1', port, method, path: reqPath,
      headers: { ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, cres => {
      const cs = [];
      cres.on('data', c => cs.push(c));
      cres.on('end', () => resolve({ status: cres.statusCode, headers: cres.headers, text: Buffer.concat(cs).toString('utf8') }));
      cres.on('error', reject);
    });
    creq.on('error', reject);
    if (data) creq.write(data);
    creq.end();
  });
}

// 对 /v1/messages 发一条请求。客户端自己有硬超时:万一实现里某段预算没生效,
// 这里会明确报"没收住",而不是把整个测试挂死(以前正是挂死)。
function ask(model, { stream = false, clientTimeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model, max_tokens: 32, stream, messages: [{ role: 'user', content: 'x' }] });
    const creq = http.request({
      hostname: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, cres => {
      const cs = [];
      cres.on('data', c => cs.push(c));
      cres.on('end', () => resolve({ status: cres.statusCode, text: Buffer.concat(cs).toString('utf8'), ms: Date.now() - t0 }));
      cres.on('error', reject);
    });
    const t0 = Date.now();
    creq.setTimeout(clientTimeoutMs, () => creq.destroy(new Error(`${clientTimeoutMs}ms 内没收住(预算没生效?)`)));
    creq.on('error', reject);
    creq.end(data);
  });
}

function lastRequestLog() {
  const lines = fs.readFileSync(path.join(TMP, 'logs', 'requests.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('setup:直通与转换两个渠道 + 桩上游', async () => {
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  upPort = server.address().port;
  server.unref();
  fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'providers.json'), JSON.stringify({
    version: 2, current: { claude: 'pa', codex: null },
    claude: [
      { id: 'pa', name: '直通', base_url: `http://127.0.0.1:${upPort}`, api_key: 'sk-a', enabled: true, models: ['claude-direct'] },
      { id: 'pr', name: '转换', base_url: `http://127.0.0.1:${upPort}`, api_key: 'sk-r', enabled: true, models: ['claude-conv'], wire_api: 'responses' },
    ],
    codex: [],
  }));
  fs.writeFileSync(path.join(TMP, 'routes.json'), JSON.stringify({
    rules: [
      { id: 'r-direct', match: 'claude-direct', provider: 'pa', model: 'claude-direct', enabled: true },
      { id: 'r-conv', match: 'claude-conv', provider: 'pr', model: 'claude-conv', enabled: true },
    ],
    default: { provider: 'pa', model: 'claude-direct' },
  }));
  mod = require('../mixrouter.js');
  proxySrv = await mod.listen(0, mod.proxyHandler);
  uiSrv = await mod.listen(0, mod.apiHandler);
  proxyPort = proxySrv.address().port;
  uiPort = uiSrv.address().port;
  proxySrv.unref(); uiSrv.unref();
});

test('预算表:三段都被总 deadline 夹住', async () => {
  const s = JSON.parse((await rawRequest(uiPort, 'GET', '/api/health')).text).settings;
  assert.strictEqual(s.total_deadline_ms, 900);
  assert.strictEqual(s.stream_first_header_timeout_ms, 400, '流式首字节预算要单独生效');
  assert.strictEqual(s.first_header_timeout_ms, 900, '非流式给的 4000ms 必须被总 deadline 夹到 900');
  for (const k of ['first_header_timeout_ms', 'stream_first_header_timeout_ms', 'stream_idle_timeout_ms', 'nonstream_total_timeout_ms']) {
    assert.ok(s[k] > 0 && s[k] <= s.total_deadline_ms, `${k}=${s[k]} 必须落在总 deadline ${s.total_deadline_ms} 里面`);
  }
});

test('流式:上游一直不发响应头,按流式首字节预算收,不等非流式那一档', async () => {
  mode = 'noHeaders';
  const r = await ask('claude-direct', { stream: true });
  mode = 'ok';
  assert.strictEqual(r.status, 502);
  const log = lastRequestLog();
  assert.strictEqual(log.err_class, 'timeout');
  assert.ok(log.err.includes('首字节超时'), `实际:${log.err}`);
  // 非流式那一档是 4000ms:必须按流式的 400ms 收,而不是陪着等到非流式的预算
  assert.ok(r.ms < 700, `要在流式首字节预算(400ms)附近收,实际 ${r.ms}ms`);
});

test('非流式:上游给了头却永远不结束 body,到点就收并如实记 timeout', async () => {
  mode = 'quietBody';
  const r = await ask('claude-conv', { stream: false });
  mode = 'ok';
  // 转换路径要整包读完才可能回错误码,所以这里状态是明确的 5xx,不是干等
  assert.ok(r.status >= 500, `该给个失败状态,实际 ${r.status}`);
  const log = lastRequestLog();
  assert.strictEqual(log.err_class, 'timeout');
  assert.ok(r.ms < 2000, `必须被总 deadline 收住,实际 ${r.ms}ms`);
});

test('流式:上游一滴一滴地发字节,也只有总 deadline 收得住', async () => {
  mode = 'drip';
  const r = await ask('claude-direct', { stream: true });
  mode = 'ok';
  const log = lastRequestLog();
  // 每次字节都会重置空闲看门狗,所以这一条只可能是总 deadline 干的
  assert.strictEqual(log.err_class, 'timeout');
  assert.ok(log.err.includes('总预算'), `实际:${log.err}`);
  assert.ok(r.ms < 2000, `实际 ${r.ms}ms`);
  assert.ok(r.text.includes('滴'), '已经转出去的字节收不回来,但这条流必须被截断收尾');
});

test('已提交的流:上游沉默时补 SSE 注释,客户端不会按字节流空闲判超时', async () => {
  mode = 'commitThenSlow';
  const r = await ask('claude-direct', { stream: true });
  mode = 'ok';
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('前半段') && r.text.includes('后半段'), `上游恢复后内容要照常送达,实际:${r.text}`);
  const ka = r.text.indexOf(': keep-alive');
  assert.ok(ka >= 0, `沉默 500ms 必须补注释,实际:${r.text}`);
  assert.ok(ka > r.text.indexOf('前半段'), '注释只能在响应提交之后补');
  const log = lastRequestLog();
  assert.strictEqual(log.err, '', `这是正常完成,不该记错误:${log.err}`);
});

test('提交前的沉默不补注释:整条重试的前提不被字节流破坏', async () => {
  slowErrorLeft = 1;
  mode = 'responsesSlowError';
  const r = await ask('claude-conv', { stream: true });
  mode = 'ok';
  assert.strictEqual(r.status, 200, `实际:${r.status} ${r.text}`);
  assert.ok(r.text.includes('event: message_start') && r.text.includes('event: message_stop'),
    `换一代 key 重试后要正常产出,实际:${r.text}`);
  assert.ok(r.text.includes('转换流内容'));
  assert.ok(!r.text.includes('渠道池打满'), '被重试掉的错误不该漏给客户端');
  const ka = r.text.indexOf(': keep-alive');
  if (ka >= 0) assert.ok(ka > r.text.indexOf('event: message_start'), '提交前一个字节都不能写,否则重试就打不出去了');
});

after(() => {
  for (const s of sockets) { try { s.destroy(); } catch {} }
  try { server.close(); } catch {}
});
