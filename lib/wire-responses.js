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
//
// 终态纪律(改动前踩过的坑,别再退回去):
//   上游的事件流只有三种终态——completed / incomplete / failed(+ error 事件)。
//   TCP 层的 end/close/error **不是终态**,那是夭折。夭折时绝对不能补一套
//   message_delta+message_stop:客户端会拿着被截断的答案当成功结果用。
//   同理,工具参数没攒齐的 function_call 不能以 tool_use 正常收尾。

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const stripModelSuffix = m => String(m || '').replace(/\[[^\]]*\]\s*$/, '');

// Anthropic 图片块 → Responses 的 input_image。顶层消息和 tool_result 里的图片共用这一处,
// 免得工具结果里的截图(Claude Code 常见的图片来源)被静默丢掉
function imageUrlOf(source) {
  if (!source || typeof source !== 'object') return '';
  return source.type === 'base64'
    ? `data:${source.media_type || 'image/png'};base64,${source.data || ''}`
    : (source.url || '');
}
function imagePart(source) {
  const url = imageUrlOf(source);
  return url ? { type: 'input_image', image_url: url } : null;
}

// 推理/加密字段对 Anthropic 客户端没有对应物,直接丢掉
function memoryDrop(item) {
  if (item && typeof item === 'object' && 'encrypted_content' in item) delete item.encrypted_content;
}

// 工具参数是 JSON 字符串。空/缺省按零参数工具算;解析不了的一律算"参数不完整"——
// 不能吞掉异常当 {} 放行,那是把截断伪装成一次可执行调用(实测复现过)
function toolArgsOk(raw) {
  try { JSON.parse(String(raw == null ? '' : raw).trim() || '{}'); return true; } catch { return false; }
}
function toolArgsValue(raw) {
  try { return JSON.parse(String(raw == null ? '' : raw).trim() || '{}'); } catch { return {}; }
}

function anthropicToResponses(a, { model, promptCacheKey } = {}) {
  const r = {
    model: stripModelSuffix(model || a.model),
    // 上游恒流式:非流上游要等整篇生成完才发响应头,大上下文压缩类请求(Claude Code 的
    // auto-compact 正是非流+全量历史)会稳定撞首字节超时,客户端再重试、上游照常跑完照常
    // 扣费,一夜烧掉上百刀的死循环就是这么来的。客户端要非流时由调用方收完攒整包再回。
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (promptCacheKey) r.prompt_cache_key = promptCacheKey;
  // /effort 的显式选择交给上游;未指定时不钉默认值,也不把 token 预算猜成强度。
  const effort = a.output_config && a.output_config.effort;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) r.reasoning = { effort };
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
        const part = imagePart(p.source);
        if (part) parts.push(part);
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
        // 工具结果里的图片同样要转:Claude Code 截图类工具的结果就是这种形状。
        // 带图时 output 用内容数组(Responses 允许 string 或 input_text/input_image 数组),
        // 不带图时维持原来的纯字符串形状,免得平白改变已有上游的行为。
        const outs = [];
        const refs = [];
        if (typeof p.content === 'string') outs.push({ type: 'input_text', text: p.content });
        else if (Array.isArray(p.content)) {
          for (const c of p.content) {
            if (!c || typeof c !== 'object') continue;
            if (c.type === 'text') outs.push({ type: 'input_text', text: c.text || '' });
            else if (c.type === 'image' && c.source) { const part = imagePart(c.source); if (part) outs.push(part); }
            else if (c.type === 'tool_reference' && c.tool_name) refs.push(c.tool_name);
          }
        }
        // ToolSearch(工具检索)的结果:tool_reference 在 Anthropic 侧表示"把这些工具的定义加载进来"。
        // Responses 上游没有对应概念——工具本来就全量声明在 tools 里,所以退化成如实写出工具名。
        // 丢掉的话,只含 tool_reference 的 tool_result 会变成一个**空结果**,模型以为搜索什么也没命中,
        // 于是反复重搜(Claude Code 的 ToolSearch 结果正是这种形状)。
        if (refs.length) outs.push({ type: 'input_text', text: refs.join('\n') });
        const withImage = outs.some(o => o.type === 'input_image');
        input.push({ type: 'function_call_output', call_id: p.tool_use_id || '',
          output: withImage ? outs : outs.map(o => o.text || '').filter(Boolean).join('\n') });
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
    // none 必须原样传 none:落到 else 会变成 auto,客户端明确禁止工具的请求反而被允许调工具
    if (a.tool_choice.type === 'any') r.tool_choice = 'required';
    else if (a.tool_choice.type === 'none') r.tool_choice = 'none';
    else if (a.tool_choice.type === 'tool' && a.tool_choice.name) r.tool_choice = { type: 'function', name: a.tool_choice.name };
    else r.tool_choice = 'auto';
  }
  r.max_output_tokens = Math.max(16, Math.min(Number(a.max_tokens) || 32000, 128000));
  return r;
}

// Responses 的 usage.input_tokens **含**缓存命中(Anthropic 的 input_tokens 不含)。
// 不减掉缓存那部分就会按全价计,长会话成本明显偏高。
function usageOf(u) {
  u = u || {};
  const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  return {
    input_tokens: Math.max(0, (u.input_tokens || 0) - cached),
    output_tokens: u.output_tokens || 0,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

// HTTP 200 但其实失败的三种形状:显式 error、status=failed、以及"说是 completed
// 却带着解析不了的工具参数"。调用方据此回 Anthropic error,而不是一条空的正常消息。
function responsesErrorOf(j) {
  if (!j || typeof j !== 'object') return null;
  const msgOf = e => (typeof e === 'string' ? e : (e && (e.message || e.type)) || '');
  if (j.error) return { type: 'api_error', message: String(msgOf(j.error) || '上游返回错误').slice(0, 400) };
  if (j.status === 'failed' || j.status === 'cancelled') {
    return { type: 'api_error', message: String(msgOf(j.error) || `上游以 status=${j.status} 结束了这条响应`).slice(0, 400) };
  }
  if (j.status === 'completed') {
    const bad = (Array.isArray(j.output) ? j.output : []).filter(it => it && it.type === 'function_call' && !toolArgsOk(it.arguments));
    if (bad.length) {
      return { type: 'api_error', message: `上游返回的工具调用参数不完整: ${bad.map(b => b.name || b.call_id || '?').join(', ')}`.slice(0, 400) };
    }
  }
  return null;
}

function responsesToAnthropic(j, model) {
  const content = [];
  let hasTool = false;
  for (const item of (j && j.output) || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      for (const c of item.content || []) if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: c.text });
    } else if (item.type === 'function_call') {
      // 参数解析不了时 input 只能是 {};这种响应应当由 responsesErrorOf 先拦下,
      // 走到这里说明调用方没查——保留形状,但 stop_reason 不会被工具块带偏。
      content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name || '', input: toolArgsValue(item.arguments) });
      hasTool = true;
    }
  }
  // 截断要如实表达:incomplete → max_tokens,不能被工具块顺手改写成 tool_use
  const stop = (j && j.status) === 'incomplete' ? 'max_tokens' : (hasTool ? 'tool_use' : 'end_turn');
  return {
    id: (j && j.id) || `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message', role: 'assistant', model: (j && j.model) || model,
    content, stop_reason: stop, stop_sequence: null,
    usage: usageOf(j && j.usage),
  };
}

// 上游终态事件名 → 我们自己的终态词
const TERMINAL_KINDS = { 'response.completed': 'completed', 'response.incomplete': 'incomplete', 'response.failed': 'failed' };

// Responses 的 SSE 事件流 → Anthropic 的 SSE 事件流。reasoning 事件丢弃。
class AnthropicStream {
  constructor(res, model, { onCommit, onDone, canRetry } = {}) {
    this.res = res; this.model = model;
    this.onCommit = onCommit || null; this.onDone = onDone || null; this.canRetry = canRetry || null;
    this.committed = false; this.pre = []; // 提交前的帧先攒着:发现是错误体还能整条重试
    this.started = false; this.finished = false;
    this.terminal = ''; this.failMessage = ''; this.retryable = false;
    this.index = -1; this.open = null;
    this.tools = new Map(); this.toolCount = 0; this.lastKey = ''; this.alias = new Map();
    this.usage = null; this.stop = 'end_turn';
    this.decoder = new StringDecoder('utf8'); this.buf = '';
  }
  write(text) {
    try { if (!this.res.writableEnded && !this.res.destroyed) this.res.write(text); } catch { /* 客户端已断,丢了 */ }
  }
  send(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (this.committed) this.write(frame); else this.pre.push(frame);
  }
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
  // 只有真的往客户端方向产出内容了才提交(提交后 HTTP 状态就改不了、也不能整条重试)。
  // response.created / output_item.added 这类元事件故意不提交:工具参数可能还要流很久。
  // 冲刷也在这里做:交给 onCommit 的只有"写响应头"这一件事,漏冲刷就会一条帧都发不出去。
  commitNow() {
    if (this.committed) return;
    this.committed = true;
    if (this.onCommit) this.onCommit();
    const pending = this.pre.join('');
    this.pre = [];
    if (pending) this.write(pending);
  }
  maybeCommit() { if (!this.committed) this.commitNow(); }
  openBlock(key, kind, extra = {}) {
    this.closeBlock();
    this.start();
    this.index++;
    this.open = { key, kind, index: this.index };
    this.send('content_block_start', {
      type: 'content_block_start', index: this.index,
      content_block: kind === 'text'
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: extra.id, name: extra.name, input: {} },
    });
  }
  closeBlock() {
    if (!this.open) return;
    this.send('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
  }
  textBlock(key) {
    if (this.open && this.open.kind === 'text' && this.open.key === key) return;
    this.openBlock(key, 'text');
  }
  toolState(key) {
    let st = this.tools.get(key);
    if (!st) { st = { id: '', name: '', args: '', emitted: false, bad: false }; this.tools.set(key, st); }
    return st;
  }
  // 工具块在 output_item.done 时一次性发:Anthropic 的块必须严格串行,而上游的
  // arguments 增量可以交错(实测:两个 function_call 的增量拼进了同一个块,
  // 参数变成 {"p":"a"}{"p":"b"} 的错拼)。攒齐再发就天然不会串,代价是工具参数
  // 不再逐字下行——客户端在 content_block_start 就已拿到工具名与 id。
  emitTool(key) {
    const st = this.tools.get(key);
    if (!st || st.emitted) return;
    st.emitted = true;
    const raw = st.args.trim() || '{}';
    if (!toolArgsOk(raw)) st.bad = true;
    this.openBlock(key, 'tool_use', { id: st.id || `call_${crypto.randomBytes(6).toString('hex')}`, name: st.name || '' });
    this.toolCount++;
    if (raw !== '{}') {
      this.send('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'input_json_delta', partial_json: raw } });
    }
    this.closeBlock();
    this.maybeCommit();
  }
  // 块的归属键:优先 output_index(同一响应内唯一),退到 item_id/call_id,
  // 都没有时归给最近一次 added 的 item——Responses 的 item 严格串行,这样既不会串到
  // 别的工具上,也不会每个 delta 都开一个新块(上游确实有不发 output_index 的)。
  // added 同时带 output_index 和 item id 时把两个称呼记成同一个键:同一个 item 的
  // 后续事件有的只带 id、有的只带 index,别名不统一就会把一次工具调用拆成两个块。
  keyOf(ev, item) {
    const idx = ev && ev.output_index;
    const id = (ev && ev.item_id) || (item && (item.id || item.call_id));
    if (idx !== undefined && idx !== null && idx !== '') {
      const key = `i${idx}`;
      if (id) this.alias.set(String(id), key);
      return key;
    }
    if (id) return this.alias.get(String(id)) || `id:${id}`;
    return this.lastKey || 'i0';
  }
  // 唯一允许发 message_delta/message_stop 的入口,而且只给 completed/incomplete 用
  finishTerminal(kind, { message = '', usage = null, reason = '' } = {}) {
    if (this.finished) return;
    this.finished = true;
    this.terminal = kind;
    if (usage) this.usage = usage;
    if (kind === 'completed' || kind === 'incomplete') {
      // 先验参数再物化:免得坏工具块已经发给客户端了、随后又改口说失败
      for (const st of this.tools.values()) if (!st.emitted && !toolArgsOk(st.args.trim() || '{}')) st.bad = true;
      const bad = [...this.tools.values()].find(t => t.bad);
      // 说是 completed 却给出解析不了的工具参数:这是坏终态,不能当成功
      if (bad && kind === 'completed') {
        kind = 'failed'; this.terminal = 'failed';
        message = `上游返回的工具调用参数不完整(${bad.name || 'tool'}),已按失败处理`;
      } else {
        for (const key of this.tools.keys()) this.emitTool(key); // 没等到 done 的按现有参数物化
      }
    }
    this.maybeCommit();
    this.start();
    if (kind === 'failed' || kind === 'aborted') {
      this.failMessage = String(message || 'upstream failure').slice(0, 400);
      // 只发协议级 error:不补 message_delta/message_stop,不把夭折伪装成正常结束
      this.send('error', { type: 'error', error: { type: 'api_error', message: this.failMessage } });
    } else {
      // 截断优先于工具:max_tokens 是"被砍了",不能被工具块改写成 tool_use
      this.stop = kind === 'incomplete'
        ? (reason === 'max_output_tokens' || !reason ? 'max_tokens' : 'end_turn')
        : (this.toolCount ? 'tool_use' : 'end_turn');
      this.closeBlock();
      const u = usageOf(this.usage);
      this.send('message_delta', {
        type: 'message_delta', delta: { stop_reason: this.stop, stop_sequence: null },
        usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, ...(u.cache_read_input_tokens ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}) },
      });
      this.send('message_stop', { type: 'message_stop' });
    }
    if (this.onDone) this.onDone();
  }
  // 传输层夭折:还没给客户端写过任何字节就允许整条重试,否则如实报错
  abort(message) {
    if (this.finished) return;
    if (!this.committed && this.canRetry && this.canRetry()) {
      this.finished = true; this.terminal = 'aborted'; this.retryable = true;
      this.failMessage = String(message || '');
      if (this.onDone) this.onDone();
      return;
    }
    this.finishTerminal('aborted', { message });
  }
  handle(ev) {
    const t = ev && ev.type;
    if (t === 'response.created' || t === 'response.in_progress') {
      if (ev.response && ev.response.model) this.model = ev.response.model;
      return;
    }
    if (this.finished) return;
    if (TERMINAL_KINDS[t]) {
      const resp = ev.response || {};
      const status = resp.status || '';
      let kind = TERMINAL_KINDS[t];
      // 上游常拿同一个事件名承载 status:completed 事件里写 status=incomplete 是常态
      if (kind === 'completed' && status === 'incomplete') kind = 'incomplete';
      else if (kind === 'completed' && (status === 'failed' || status === 'cancelled')) kind = 'failed';
      const reason = (resp.incomplete_details && resp.incomplete_details.reason)
        || (ev.incomplete_details && ev.incomplete_details.reason) || '';
      const err = (resp.error && (resp.error.message || resp.error.type)) || '';
      this.finishTerminal(kind, { message: err, usage: resp.usage || null, reason });
      return;
    }
    if (t === 'error' || (ev && ev.error && !t)) {
      const msg = (ev.error && (ev.error.message || ev.error.type)) || ev.message || 'upstream failure';
      if (!this.committed && this.canRetry && this.canRetry()) {
        this.finished = true; this.terminal = 'failed'; this.retryable = true; this.failMessage = String(msg);
        if (this.onDone) this.onDone();
        return;
      }
      this.finishTerminal('failed', { message: msg, usage: (ev.response && ev.response.usage) || null });
      return;
    }
    this.start();
    if (t === 'response.output_item.added') {
      const item = ev.item || {};
      const key = this.keyOf(ev, item);
      this.lastKey = key;
      if (item.type === 'function_call') {
        const st = this.toolState(key);
        st.id = st.id || item.call_id || item.id || '';
        st.name = st.name || item.name || '';
      } else if (item.type === 'message') this.textBlock(key);
      // reasoning 等没有 Anthropic 对应物的事件直接忽略
    } else if (t === 'response.output_text.delta') {
      this.textBlock(this.keyOf(ev, null));
      this.send('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: ev.delta || '' } });
      this.maybeCommit();
    } else if (t === 'response.function_call_arguments.delta') {
      this.toolState(this.keyOf(ev, null)).args += ev.delta || '';
    } else if (t === 'response.output_item.done') {
      const item = ev.item || {};
      if (item.type === 'function_call') this.emitTool(this.keyOf(ev, item));
    }
  }
  feed(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buf += text;
    const { events, rest } = parseSseEvents(this.buf);
    this.buf = rest;
    for (const ev of events) {
      this.handle(ev);
      if (this.finished) { this.buf = ''; return; }
    }
  }
}

// 整段 SSE 文本 → 事件数组 + 消费剩的半帧。feed 逐块喂、collectAnthropicMessage 收完整段,
// 两处共用同一套分帧规则(空行分隔,CRLF/CR/LF 都算换行,只认 \n\n 会整条丢掉 CRLF 流)
function parseSseEvents(text) {
  const events = [];
  let buf = text;
  for (;;) {
    const m = /\r\n\r\n|\n\n|\r\r/.exec(buf);
    if (!m) break;
    const raw = buf.slice(0, m.index);
    buf = buf.slice(m.index + m[0].length);
    const data = [];
    for (const line of raw.split(/\r\n|\n|\r/)) {
      if (!line || line[0] === ':') continue; // 注释行(含上游心跳)
      const c = line.indexOf(':');
      if (c === -1) continue;
      if (line.slice(0, c) !== 'data') continue;
      let v = line.slice(c + 1);
      if (v[0] === ' ') v = v.slice(1);
      data.push(v);
    }
    if (!data.length) continue;
    const payload = data.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try { events.push(JSON.parse(payload)); } catch { /* 半截 JSON 忽略 */ }
  }
  return { events, rest: buf };
}

// 一段完整的 Anthropic SSE 响应 → 整包 message 对象。
// 「上游恒流式、客户端要非流」的收尾用:收完的流攒成一条 JSON 消息回给客户端,
// 形状与上游直回非流 JSON 时一致。usage 以 message_delta 的终态值为准(与 message_start 合并)。
function collectAnthropicMessage(text) {
  const msg = { id: '', type: 'message', role: 'assistant', model: '', content: [],
    stop_reason: null, stop_sequence: null, usage: {} };
  for (const ev of parseSseEvents(text).events) {
    const t = ev && ev.type;
    if (t === 'message_start' && ev.message) {
      const { content, usage, ...rest } = ev.message;
      Object.assign(msg, rest);
      if (usage) msg.usage = { ...msg.usage, ...usage };
    } else if (t === 'content_block_start' && ev.content_block) {
      const block = { ...ev.content_block };
      if (block.type === 'tool_use') block.input = '';
      msg.content[ev.index] = block; // 按序号对位,中间空档收尾时压掉
    } else if (t === 'content_block_delta' && ev.delta) {
      const block = msg.content[ev.index];
      if (!block) continue;
      if (ev.delta.type === 'text_delta') block.text = (block.text || '') + (ev.delta.text || '');
      else if (ev.delta.type === 'input_json_delta') block.input = (block.input || '') + (ev.delta.partial_json || '');
    } else if (t === 'message_delta') {
      if (ev.delta) {
        if (ev.delta.stop_reason != null) msg.stop_reason = ev.delta.stop_reason;
        if (ev.delta.stop_sequence !== undefined) msg.stop_sequence = ev.delta.stop_sequence;
      }
      if (ev.usage) msg.usage = { ...msg.usage, ...ev.usage }; // 流末尾这次才是终态真值
    }
  }
  msg.content = msg.content.filter(Boolean);
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      try { block.input = JSON.parse(block.input || '{}'); } catch { block.input = {}; } // 攒不齐按空参数算
    }
  }
  return msg;
}

// 「上游恒流式、客户端要非流」的内存响应端:relayAnthropicStream 只管往 res 写,
// 给它一个能 write/end 的假对象,收完用 text() 把整段 SSE 拿去重建 message
function memorySink() {
  const parts = [];
  return {
    res: {
      headersSent: true, writableEnded: false, destroyed: false,
      write(c) { parts.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; },
      end() { this.writableEnded = true; },
    },
    text: () => Buffer.concat(parts).toString('utf8'),
  };
}

// 上游还没给出任何内容事件前,先攒着不写客户端:这样发现是错误体(5xx 文本/error 事件)
// 还能整条重试;一旦是正常内容就 commit,后面只做转换不再回头。
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
function emitAnthropicSse(res, message, headers = {}, onCommit = null) {
  const stream = new AnthropicStream(res, message.model, {
    onCommit: () => {
      try {
        if (!res.headersSent) res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      } catch {}
      if (onCommit) { try { onCommit(); } catch {} }
    },
  });
  stream.usage = message.usage || null;
  for (const block of message.content || []) {
    if (block.type === 'text') {
      stream.openBlock(`t${stream.index + 1}`, 'text');
      stream.send('content_block_delta', { type: 'content_block_delta', index: stream.index, delta: { type: 'text_delta', text: block.text || '' } });
      stream.closeBlock();
    } else if (block.type === 'tool_use') {
      stream.openBlock(`u${stream.index + 1}`, 'tool_use', { id: block.id, name: block.name });
      stream.toolCount++;
      const raw = JSON.stringify(block.input ?? {});
      if (raw !== '{}') stream.send('content_block_delta', { type: 'content_block_delta', index: stream.index, delta: { type: 'input_json_delta', partial_json: raw } });
      stream.closeBlock();
    }
  }
  stream.finishTerminal(message.stop_reason === 'max_tokens' ? 'incomplete' : 'completed');
  try { if (!res.writableEnded) res.end(); } catch {}
  return stream;
}

function relayAnthropicStream(upRes, res, model, { mayRetry = false, headers = {}, onCommit = null } = {}) {
  return new Promise(resolve => {
    let settled = false, rawPre = '';
    const decoder = new StringDecoder('utf8');
    const commit = () => {
      try {
        if (!res.headersSent) res.writeHead(upRes.statusCode || 200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      } catch {}
      // 到这一步才真的提交给客户端了(之前攒在 pre 里,还能整条重试),外层从这一刻起可以补心跳
      if (onCommit) { try { onCommit(); } catch {} }
    };
    // 收尾顺序要紧:先 resolve(外层在 .then 里结算 usage、写日志、置 finalized),
    // 之后才 res.end()。Node 的 close 走 nextTick 队列,比 promise 微任务还早,所以
    // 外层还要按 writableFinished 兜一道(mixrouter.js 的 res.on('close')),单靠这里
    // 的顺序压不住"成功被记成 client closed"。
    const settle = () => {
      if (settled) return;
      settled = true;
      const retryable = conv.retryable;
      const result = {
        // usage 按 Anthropic 口径交回:input 已扣掉缓存命中,cache_read 单独给(见 usageOf)
        converted: true, usage: conv.usage ? usageOf(conv.usage) : null, model: conv.model,
        retryable,
        aborted: !retryable && (conv.terminal === 'aborted' || conv.terminal === 'failed'),
        detail: conv.failMessage || '',
      };
      try { upRes.destroy(); } catch {} // 终态已定,别再占着上游连接
      resolve(result);
      // 可重试意味着一个字节都没写给客户端:这条 res 还要留给下一次尝试,不能 end 掉
      if (!retryable && !res.writableEnded) { try { res.end(); } catch {} }
    };
    const conv = new AnthropicStream(res, model, {
      onCommit: commit,
      onDone: settle,
      canRetry: () => mayRetry && !conv.committed,
    });
    const transportDead = why => {
      if (settled || conv.finished) return;
      conv.abort(why);
    };
    upRes.on('data', chunk => {
      if (settled || conv.finished) return;
      const text = decoder.write(chunk);
      if (!conv.committed) {
        if (rawPre.length < 8192) rawPre += text;
        // 200 里夹带的错误体(渠道池打满那种):还没给客户端写字节就交给 abort 判可不可重试
        const te = terminalError(rawPre);
        if (te) return conv.abort(te);
      }
      try { conv.feed(text); } catch { /* 半截 JSON 忽略,feed 自己兜 */ }
    });
    upRes.on('end', () => transportDead('上游流没有给出终态就结束了'));
    upRes.on('close', () => transportDead('上游连接中断'));
    upRes.on('error', e => transportDead((e && (e.code || e.message)) || '上游连接错误'));
  });
}

module.exports = { anthropicToResponses, responsesToAnthropic, responsesErrorOf, relayAnthropicStream, emitAnthropicSse, collectAnthropicMessage, memorySink, stripModelSuffix, memoryDrop };
