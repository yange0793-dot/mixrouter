'use strict';
// Anthropic Messages ⇄ OpenAI Responses 转换层。
//
// 存在意义:有些网关的模型只挂在 Codex(Responses)型通道上——例如 anyrouter 的
// gpt-6-astra,/v1/messages 直接 404「当前 API 不支持所选模型」。给 Claude 组渠道
// 标 wire_api='responses' 后,由 mixrouter 在进程内把 Anthropic 请求翻成 Responses
// 发上去,再把响应/SSE 翻回 Anthropic,不必再挂一个本地转换代理。
//
// 上游对 Codex 型通道还有形状要求(实测):body.include 必须恰好是
// ["reasoning.encrypted_content"],且 prompt_cache_key 非空——新版按真实 Codex
// 客户端的行为补齐。prompt_cache_key 会被 new-api 用来做渠道亲和(TTL 1h),
// 坏渠道一旦钉上整小时都失败,所以调用方可以按"同会话换一代"的方式轮换它。

const crypto = require('crypto');

const stripModelSuffix = m => String(m || '').replace(/\[[^\]]*\]\s*$/, '');

// 推理/加密字段对 Anthropic 客户端没有对应物,直接丢掉
function memoryDrop(item) {
  if (item && typeof item === 'object' && 'encrypted_content' in item) delete item.encrypted_content;
}

function anthropicToResponses(a, { model, promptCacheKey } = {}) {
  const r = {
    model: stripModelSuffix(model || a.model),
    stream: !!a.stream,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (promptCacheKey) r.prompt_cache_key = promptCacheKey;
  let instructions = '';
  if (typeof a.system === 'string') instructions = a.system;
  else if (Array.isArray(a.system)) {
    instructions = a.system.map(b => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : '')).filter(Boolean).join('\n\n');
  }
  if (instructions) r.instructions = instructions;

  const input = [];
  for (const msg of Array.isArray(a.messages) ? a.messages : []) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      if (msg.content) input.push({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: msg.content }] });
      continue;
    }
    let parts = [];
    const flush = () => { if (parts.length) { input.push({ type: 'message', role, content: parts }); parts = []; } };
    for (const p of Array.isArray(msg.content) ? msg.content : []) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text') parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: p.text || '' });
      else if (p.type === 'image' && p.source) {
        const url = p.source.type === 'base64'
          ? `data:${p.source.media_type || 'image/png'};base64,${p.source.data || ''}`
          : p.source.url;
        if (url) parts.push({ type: 'input_image', image_url: url });
      } else if (p.type === 'tool_use') {
        flush();
        input.push({
          type: 'function_call',
          call_id: p.id || `call_${crypto.randomBytes(8).toString('hex')}`,
          name: p.name || '',
          arguments: JSON.stringify(p.input ?? {}),
        });
      } else if (p.type === 'tool_result') {
        flush();
        let out = '';
        if (typeof p.content === 'string') out = p.content;
        else if (Array.isArray(p.content)) out = p.content.map(c => (c && c.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
        input.push({ type: 'function_call_output', call_id: p.tool_use_id || '', output: out });
      }
    }
    flush();
  }
  r.input = input;
  if (Array.isArray(a.tools) && a.tools.length) {
    r.tools = a.tools.filter(t => t && t.name).map(t => ({
      type: 'function', name: t.name, description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    }));
  }
  if (a.tool_choice && typeof a.tool_choice === 'object') {
    if (a.tool_choice.type === 'any') r.tool_choice = 'required';
    else if (a.tool_choice.type === 'tool' && a.tool_choice.name) r.tool_choice = { type: 'function', name: a.tool_choice.name };
    else r.tool_choice = 'auto';
  }
  r.max_output_tokens = Math.max(16, Math.min(Number(a.max_tokens) || 32000, 128000));
  return r;
}

function responsesToAnthropic(j, model) {
  const content = [];
  let stop = j && j.status === 'incomplete' ? 'max_tokens' : 'end_turn';
  for (const item of (j && j.output) || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: c.text });
    } else if (item.type === 'function_call') {
      let input = {};
      try { input = JSON.parse(item.arguments || '{}'); } catch {}
      content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name || '', input });
      stop = 'tool_use';
    }
  }
  const u = (j && j.usage) || {};
  return {
    id: (j && j.id) || `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message', role: 'assistant', model: (j && j.model) || model,
    content, stop_reason: stop, stop_sequence: null,
    usage: {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      ...(u.input_tokens_details && u.input_tokens_details.cached_tokens
        ? { cache_read_input_tokens: u.input_tokens_details.cached_tokens } : {}),
    },
  };
}

// Responses 的 SSE 事件流 → Anthropic 的 SSE 事件流。reasoning 事件丢弃。
class AnthropicStream {
  constructor(res, model) {
    this.res = res; this.model = model;
    this.started = false; this.finished = false;
    this.index = -1; this.open = null;
    this.usage = null; this.stop = 'end_turn'; this.buf = '';
    this.pendingId = ''; this.pendingName = '';
  }
  send(event, data) { this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  start() {
    if (this.started) return;
    this.started = true;
    this.send('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant',
        model: this.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  ensure(kind) {
    if (this.open === kind) return;
    this.closeBlock();
    this.start();
    this.index++;
    this.open = kind;
    this.send('content_block_start', {
      type: 'content_block_start', index: this.index,
      content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: this.pendingId, name: this.pendingName, input: {} },
    });
  }
  closeBlock() {
    if (!this.open) return;
    this.send('content_block_stop', { type: 'content_block_stop', index: this.index });
    if (this.open === 'tool_use') this.stop = 'tool_use';
    this.open = null;
  }
  handle(ev) {
    const t = ev.type;
    if (t === 'response.created') { if (ev.response && ev.response.model) this.model = ev.response.model; return; }
    this.start();
    if (t === 'response.output_item.added') {
      const item = ev.item || {};
      if (item.type === 'function_call') { this.pendingId = item.call_id || item.id || ''; this.pendingName = item.name || ''; this.ensure('tool_use'); }
      else if (item.type === 'message') this.ensure('text');
    } else if (t === 'response.output_text.delta') {
      this.ensure('text');
      this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: ev.delta || '' } });
    } else if (t === 'response.function_call_arguments.delta') {
      this.ensure('tool_use');
      this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: ev.delta || '' } });
    } else if (t === 'response.output_item.done') {
      this.closeBlock();
    } else if (t === 'response.completed') {
      if (ev.response) {
        this.usage = ev.response.usage || null;
        if (ev.response.status === 'incomplete') this.stop = 'max_tokens';
      }
      this.finish();
    } else if (t === 'response.failed' || t === 'error') {
      const msg = (ev.response && ev.response.error && ev.response.error.message) || (ev.error && ev.error.message) || ev.message || 'upstream failure';
      this.send('error', { type: 'error', error: { type: 'api_error', message: String(msg).slice(0, 400) } });
      this.finish();
    }
  }
  feed(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n\n')) !== -1) {
      const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2);
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        this.handle(ev);
      }
    }
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.closeBlock();
    this.start();
    const u = this.usage || {};
    this.send('message_delta', {
      type: 'message_delta', delta: { stop_reason: this.stop, stop_sequence: null },
      usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 },
    });
    this.send('message_stop', { type: 'message_stop' });
    try { if (!this.res.writableEnded) this.res.end(); } catch {}
  }
}

// 上游还没给出任何内容事件前,先攒着不写客户端:这样发现是错误体(5xx 文本/error 事件)
// 还能整条重试;一旦是正常内容就 commit,后面只做转换不再回头。
const CONTENT_RE = /"type":"(response\.output_item\.added|response\.output_text\.delta|response\.completed)"/;
// 200 状态一样可能夹带错误(渠道池打满等),这些在 commit 之前要认出来
const TERMINAL_PATTERNS = ['Could not find an existing deployment', '"type":"response.failed"', '"type":"error"'];

function terminalError(buffer) {
  for (const p of TERMINAL_PATTERNS) {
    if (buffer.includes(p)) {
      const m = buffer.match(/"message":"([^"]{0,120})"/);
      return m ? m[1] : p;
    }
  }
  return null;
}

// 客户端要流、上游却整包回 JSON 时,把完整消息摊成 Anthropic SSE 序列,别让客户端干等
function emitAnthropicSse(res, message, headers = {}) {
  const stream = new AnthropicStream(res, message.model);
  stream.usage = message.usage || null;
  stream.start();
  let idx = 0;
  for (const block of message.content || []) {
    stream.index = idx;
    if (block.type === 'text') {
      stream.send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      stream.send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: block.text || '' } });
      stream.send('content_block_stop', { type: 'content_block_stop', index: idx });
    } else if (block.type === 'tool_use') {
      stream.send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      stream.send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
      stream.send('content_block_stop', { type: 'content_block_stop', index: idx });
    }
    idx++;
  }
  stream.stop = message.stop_reason === 'max_tokens' ? 'max_tokens' : (message.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn');
  stream.open = null;
  stream.finish();
  return stream;
}

function relayAnthropicStream(upRes, res, model, { mayRetry = false, headers = {} } = {}) {
  return new Promise(resolve => {
    let committed = false, settled = false, buffer = '';
    const conv = new AnthropicStream(res, model);
    const commit = () => {
      if (committed) return;
      committed = true;
      res.writeHead(upRes.statusCode, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      conv.feed(buffer);
      buffer = '';
      upRes.on('data', c => { try { conv.feed(c.toString('utf8')); } catch { /* 半截 JSON 忽略,feed 自己兜 */ } });
      upRes.on('end', () => conv.finish());
      upRes.on('close', () => conv.finish());
      upRes.on('error', () => conv.finish());
    };
    const done = () => ({ converted: true, usage: conv.usage, model: conv.model });
    upRes.on('data', chunk => {
      if (committed || settled) return;
      buffer += chunk.toString('utf8');
      const te = terminalError(buffer);
      if (te) {
        if (mayRetry) { settled = true; upRes.destroy(); return resolve({ retryable: true, detail: te }); }
        settled = true; commit(); conv.finish(); return resolve(done());
      }
      if (buffer.length > 4096 || CONTENT_RE.test(buffer)) commit();
    });
    upRes.on('end', () => { if (settled) return; settled = true; commit(); conv.finish(); resolve(done()); });
    upRes.on('close', () => { if (settled) return; settled = true; commit(); conv.finish(); resolve(done()); });
    upRes.on('error', () => {
      if (settled) return;
      settled = true;
      if (!committed && mayRetry) return resolve({ retryable: true });
      commit(); conv.finish(); resolve(done());
    });
  });
}

module.exports = { anthropicToResponses, responsesToAnthropic, relayAnthropicStream, emitAnthropicSse, stripModelSuffix, memoryDrop };
