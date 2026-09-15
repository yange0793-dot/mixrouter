'use strict';
// Anthropic Messages ⇄ OpenAI Chat Completions 转换层。
//
// 存在意义:有些站只开 chat/completions——例如基元律动(tokenrhythm.studio)的
// glm-5.3-flash,/v1/messages 与 /v1/responses 都直接 400「当前模型不支持该协议」,
// 只有 /v1/chat/completions 能用。给 Claude 组渠道标 wire_api='chat' 后,由 mixrouter
// 在进程内把 Anthropic 请求翻成 chat 发上去,再把响应/SSE 翻回 Anthropic,不必再挂
// 一个本地转换代理。
//
// 与 wire-responses.js 共用 AnthropicStream:终态纪律(传输层 end/close 不是终态,夭折
// 绝不补 message_stop)、块严格串行、提交前整条重试、工具参数攒齐再发都在那里,这里
// 只做 chat 事件 → AnthropicStream 调用的映射。
//
// 两条已知取舍:
//   - thinking 的 signature 是空串占位:转发的是上游明文思考,没有真签名。客户端回传的
//     thinking 块会被 anthropicToChat 丢弃,不会带着占位签名回上游。
//   - 工具结果里的图片降级为占位文本:chat 的 role:'tool' 消息只收字符串内容。

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const {
  AnthropicStream, stripModelSuffix, imageUrlOf, toolArgsOk, toolArgsValue,
} = require('./wire-responses');

const randId = p => p + crypto.randomBytes(8).toString('hex');

// ---------------------------------------------------------------- 请求方向(Anthropic → chat)
// tool_result 的内容压成字符串:chat 的 role:'tool' 消息只收字符串(数组形状各家网关支持
// 不一),图片降级为占位说明;ToolSearch 的 tool_reference 如实写出工具名(与 wire-responses
// 同一条降级:丢掉的话模型以为搜到 0 个工具,会反复重搜)。
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = [], refs = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text') texts.push(c.text || '');
    else if (c.type === 'image') texts.push('[图片:当前协议的工具结果不能携带图片,此处只保留文字]');
    else if (c.type === 'tool_reference' && c.tool_name) refs.push(c.tool_name);
  }
  if (refs.length) texts.push(refs.join('\n'));
  return texts.join('\n');
}

// Anthropic 的工具选择 → chat 形状。none 必须原样传 none:落到 else 会变成 auto,
// 客户端明确禁止工具的请求反而被允许调工具(与 wire-responses 同一条纪律)。
function toolChoiceOf(tc) {
  if (!tc || typeof tc !== 'object') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

function anthropicToChat(a, { model } = {}) {
  const messages = [];
  let sys = '';
  if (typeof a.system === 'string') sys = a.system;
  else if (Array.isArray(a.system)) {
    sys = a.system.map(b => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : '')).filter(Boolean).join('\n\n');
  }
  if (sys) messages.push({ role: 'system', content: sys });

  for (const msg of Array.isArray(a.messages) ? a.messages : []) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      if (msg.content) messages.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    const parts = [];      // text/image 块(按原序;有图时 content 用数组形状)
    const toolCalls = [];  // assistant 侧 tool_use → 同一条 assistant 消息的 tool_calls
    const toolMsgs = [];   // user 侧 tool_result → 独立的 role:'tool' 消息
    for (const p of msg.content) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text') parts.push({ type: 'text', text: p.text || '' });
      else if (p.type === 'image' && p.source) {
        const url = imageUrlOf(p.source);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      } else if (p.type === 'tool_use') {
        toolCalls.push({ id: p.id || randId('call_'), type: 'function',
          function: { name: p.name || '', arguments: JSON.stringify(p.input ?? {}) } });
      } else if (p.type === 'tool_result') {
        toolMsgs.push({ role: 'tool', tool_call_id: p.tool_use_id || '', content: toolResultText(p.content) });
      }
      // thinking / redacted_thinking / cache_control 等对 chat 没有对应物,忽略
    }
    // tool 消息先出:OpenAI 要求它紧跟对应的 assistant(tool_calls),不能排在用户补充文本后面
    for (const tm of toolMsgs) messages.push(tm);
    const contentOf = () => (parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts);
    if (role === 'assistant' && toolCalls.length) {
      // text 与 tool_calls 是同一条 OpenAI 助手消息;只有工具调用时 content 给空串(部分网关不收 null)
      messages.push({ role: 'assistant', content: parts.length ? contentOf() : '', tool_calls: toolCalls });
    } else if (parts.length) {
      messages.push({ role, content: contentOf() });
    }
  }
  if (!messages.some(m => m.role === 'user')) messages.push({ role: 'user', content: '(empty request)' });

  const out = {
    model: stripModelSuffix(model || a.model),
    messages,
    // 上游恒流式:非流上游要等整篇生成完才发响应头,大上下文压缩类请求会稳定撞首字节
    // 超时再被客户端重试、上游照常跑完照常扣费(与 wire-responses 同一条).客户端要非流时
    // 由调用方收完攒整包再回。
    stream: true,
    // 统计需要 usage,得主动要(OpenAI 流式默认不发;个别站不认这个字段会忽略,usage 记 0)
    stream_options: { include_usage: true },
  };
  if (a.max_tokens) out.max_tokens = Math.max(16, Math.min(Number(a.max_tokens) || 32000, 128000));
  else out.max_tokens = 32000;
  if (a.temperature != null) out.temperature = a.temperature;
  if (a.top_p != null) out.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) out.stop = a.stop_sequences;
  if (Array.isArray(a.tools) && a.tools.length) {
    const tools = a.tools.filter(t => t && t.name).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
    if (tools.length) {
      out.tools = tools;
      if (a.tool_choice) out.tool_choice = toolChoiceOf(a.tool_choice);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 响应方向
// chat 的 prompt_tokens **含**缓存命中(Anthropic 的 input_tokens 不含)。
// 不减掉缓存那部分就会按全价计,长会话成本明显偏高(与 wire-responses.usageOf 同理)。
function usageOf(u) {
  u = u || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
    output_tokens: u.completion_tokens || 0,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

// HTTP 200 但其实失败的形状:显式 error、以及"说是正常结束却带着解析不了的工具参数"。
// 调用方据此回 Anthropic error,而不是一条空的正常消息。
function chatErrorOf(j) {
  if (!j || typeof j !== 'object') return null;
  const msgOf = e => (typeof e === 'string' ? e : (e && (e.message || e.type)) || '');
  if (j.error) return { type: 'api_error', message: String(msgOf(j.error) || '上游返回错误').slice(0, 400) };
  const choice = (Array.isArray(j.choices) ? j.choices[0] : null) || {};
  const msg = choice.message || {};
  if (choice.finish_reason && choice.finish_reason !== 'length') {
    const bad = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
      .filter(tc => !toolArgsOk(tc && tc.function && tc.function.arguments));
    if (bad.length) {
      return { type: 'api_error', message: `上游返回的工具调用参数不完整: ${bad.map(b => (b.function && b.function.name) || b.id || '?').join(', ')}`.slice(0, 400) };
    }
  }
  return null;
}

function chatToAnthropic(j, model) {
  const choice = ((j && j.choices) || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  // 思考翻成 thinking 块(signature 空串占位;回传时 anthropicToChat 会丢弃 thinking,不会回流上游)
  const think = typeof msg.reasoning_content === 'string' ? msg.reasoning_content
    : (typeof msg.reasoning === 'string' ? msg.reasoning : '');
  if (think) content.push({ type: 'thinking', thinking: think, signature: '' });
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  let hasTool = false;
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    if (!tc || typeof tc !== 'object') continue;
    const fn = tc.function || {};
    // 参数解析不了时 input 只能是 {};这种响应应当由 chatErrorOf 先拦下,走到这里说明
    // 调用方没查——保留形状,但 stop_reason 不会被工具块带偏。
    content.push({ type: 'tool_use', id: tc.id || randId('call_'), name: fn.name || '', input: toolArgsValue(fn.arguments) });
    hasTool = true;
  }
  // 截断要如实表达:length → max_tokens,不能被工具块顺手改写成 tool_use
  const stop = choice.finish_reason === 'length' ? 'max_tokens' : (hasTool ? 'tool_use' : 'end_turn');
  return {
    id: (j && j.id) || randId('msg_'),
    type: 'message', role: 'assistant', model: (j && j.model) || model,
    content, stop_reason: stop, stop_sequence: null,
    usage: usageOf(j && j.usage),
  };
}

// 上游说 200/SSE 却给非 SSE 正文(HTML 错误页、裸 JSON 错误体):提交给客户端之前认出来,
// 交给外层按可重试处理。正文里已经有 data:/event: 行的,说明确实是流,交给流解析。
function terminalError(buffer) {
  if (/(^|\n)(data|event):/.test(buffer)) return null;
  if (/^\s*<(?:!doctype html|html)/i.test(buffer)) return '上游返回 HTML 页而不是 SSE 流';
  const m = buffer.match(/"message"\s*:\s*"([^"]{0,160})"/) || buffer.match(/"error"\s*:\s*"([^"]{0,160})"/);
  if (m) return m[1];
  return null;
}

// chat 的 SSE 流 → Anthropic 的 SSE 流。reasoning_content 事件丢弃。
// 终态纪律同 wire-responses:chat 流里唯一的终态信号是 [DONE] 或 finish_reason,
// 两者都没等到就是夭折,绝不能补 message_stop。
function relayChatStream(upRes, res, model, { mayRetry = false, headers = {}, onCommit = null } = {}) {
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
    // 外层还要按 writableFinished 兜一道(mixrouter.js 的 res.on('close'))。
    const settle = () => {
      if (settled) return;
      settled = true;
      const retryable = conv.retryable;
      const result = {
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
      usageOf, // chat 的 usage 是 prompt_tokens/completion_tokens 形状,换算是 chat 专用的
    });
    // 流里又夹了一条错误事件:提交前且允许重试就整个交回外层,否则按失败终态处理
    const failStream = m => {
      if (!conv.committed && mayRetry && conv.canRetry()) {
        conv.finished = true; conv.terminal = 'failed'; conv.retryable = true; conv.failMessage = String(m);
        if (conv.onDone) conv.onDone();
        return;
      }
      conv.finishTerminal('failed', { message: String(m) });
    };

    let buf = '', usage = null, finishReason = '', sawDone = false, sawFinish = false;
    const toolOrder = []; // 工具块的出现顺序(按 index 排序后物化,Anthropic 的块必须严格串行)
    const handlePayload = payload => {
      if (payload === '[DONE]') { sawDone = true; return; }
      let j;
      try { j = JSON.parse(payload); } catch { return; }
      if (j && j.error) {
        const m = (j.error && (j.error.message || j.error.type)) || j.message || '上游返回错误';
        failStream(m);
        return;
      }
      if (j && j.model) conv.model = j.model;
      if (j && j.usage) usage = j.usage;
      const choice = (Array.isArray(j && j.choices) ? j.choices[0] : null) || {};
      if (choice.finish_reason) { finishReason = String(choice.finish_reason); sawFinish = true; }
      const delta = choice.delta;
      if (!delta || typeof delta !== 'object') return;
      // 思考内容转发成 thinking 块:glm/qwen 系思考关不掉,这正是它们的价值——
      // 丢弃的话客户端花了 reasoning token 的钱却看不见过程。官方是 reasoning_content,
      // 少数站叫 reasoning,两种都认
      const think = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
        : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (think) {
        // 思考块的开合与 signature 占位收尾都在 AnthropicStream 里(与 responses 线共用同一套)
        conv.thinkingBlock('r');
        conv.send('content_block_delta', { type: 'content_block_delta', index: conv.index, delta: { type: 'thinking_delta', thinking: think } });
        conv.maybeCommit();
      }
      if (typeof delta.content === 'string' && delta.content) {
        conv.textBlock('t'); // 类内 textBlock 会先给思考块收尾(signature + stop),块顺序才是 thinking → text
        conv.send('content_block_delta', { type: 'content_block_delta', index: conv.index, delta: { type: 'text_delta', text: delta.content } });
        conv.maybeCommit();
      }
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (!tc || typeof tc !== 'object') continue;
        const key = (tc.index === undefined || tc.index === null) ? 0 : tc.index;
        if (!toolOrder.includes(key)) toolOrder.push(key);
        const st = conv.toolState(key);
        if (tc.id) st.id = tc.id;
        if (tc.function && tc.function.name) st.name = st.name || tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') st.args += tc.function.arguments;
      }
    };
    // 工具块攒到终态才逐个物化:chat 的 tool_calls 增量按 index 并行下发,而 Anthropic
    // 的块必须一个闭完再开下一个(与 wire-responses 同一条纪律,实测过同类错拼)。
    const finishNow = () => {
      if (conv.finished) return;
      // 只有思考、没有正文的响应(全花在 reasoning 上)也要让思考块带 signature 收尾;
      // 必须在 emitTool 之前——物化工具块会顺手关掉当前块,那时补 signature 就晚了
      conv.closeThinking();
      for (const key of toolOrder.slice().sort((a, b) => a - b)) conv.emitTool(key);
      conv.finishTerminal(finishReason === 'length' ? 'incomplete' : 'completed', { usage, reason: finishReason });
    };
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
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue; // 空行/注释/event: 行忽略
        let payload = line.slice(5);
        if (payload[0] === ' ') payload = payload.slice(1);
        payload = payload.trim();
        if (!payload) continue;
        handlePayload(payload);
        if (conv.finished || settled) return;
        // [DONE] 是 chat 流唯一的正式终止符,且 usage 总在它之前的 chunk 里;
        // 收到就立即收尾,不等上游关连接(有的站发完 [DONE] 还挂着 keep-alive)
        if (sawDone) { finishNow(); return; }
      }
    });
    upRes.on('end', () => {
      if (settled || conv.finished) return;
      // 有 finish_reason 但没等到 [DONE] 的站不算夭折:上游明确给过终态信息;
      // 两个信号都没有才是中途断了,交给 abort 按夭折处理
      if (sawDone || sawFinish) return finishNow();
      conv.abort('上游流没有给出终态就结束了');
    });
    upRes.on('close', () => transportDead('上游连接中断'));
    upRes.on('error', e => transportDead((e && (e.code || e.message)) || '上游连接错误'));
  });
}

module.exports = { anthropicToChat, chatToAnthropic, chatErrorOf, relayChatStream, usageOf };
