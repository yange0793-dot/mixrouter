// 识图中继:主链(claude /v1/messages)模型没有视觉,Anthropic 直通上游收到 image 块直接
// 500(“Upstream rejected the request as invalid”),chat 桥不认图——模型根本没机会开口去跑
// ~/.claude/bin/grok-vision,用户贴图=整轮报废。这里把请求体里的 image 块落盘成文件、
// 原位换成指路文本,模型照文本跑脚本拿文字描述,识图策略才真正会被触发。
// responses 线由 wire-responses 原生转 input_image,调用方负责跳过本模块。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INBOX = process.env.MIXR_IMAGE_INBOX || path.join(process.env.HOME || os.homedir(), '.claude', 'vision-inbox');
const RETAIN_MS = 3 * 24 * 3600 * 1000; // 落盘图片保留 3 天
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

let lastPrune = 0;
function pruneOnce(now) {
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  let names;
  try { names = fs.readdirSync(INBOX); } catch { return; }
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(INBOX, name));
      if (now - st.mtimeMs > RETAIN_MS) fs.unlinkSync(path.join(INBOX, name));
    } catch {}
  }
}

function saveBase64(data, mediaType) {
  // 同一张图(CC 每轮都会重发全部历史)按内容定名,只写一次盘
  const name = crypto.createHash('sha1').update(data).digest('hex').slice(0, 16) + '.' + (EXT[mediaType] || 'bin');
  const file = path.join(INBOX, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

function relayText(file) {
  return `[识图中继] 这张图片已由 mixrouter 存到: ${file}。当前会话模型没有视觉能力,不能直接看图,也不要用 Read 读图片文件;` +
    `请立即运行: ~/.claude/bin/grok-vision ${file} ,用它输出的文字描述来理解图片并继续回答。`;
}

// 原地改写 body.messages:每个 image 块换成一块指路文本,返回替换数量。body 无图时零开销。
function rewrite(body) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : null;
  if (!msgs) return 0;
  let n = 0;
  let dirReady = false;
  const stamp = () => {
    if (!dirReady) { fs.mkdirSync(INBOX, { recursive: true }); pruneOnce(Date.now()); dirReady = true; }
  };
  // 只认 Anthropic 形状的块:image(base64/url)与 tool_result.content 里的嵌套图片;
  // 不深入 tool_use.input 等业务载荷,避免误伤
  const walk = arr => {
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'image' && b.source && b.source.type === 'base64' && typeof b.source.data === 'string') {
        stamp(); n++;
        arr[i] = { type: 'text', text: relayText(saveBase64(b.source.data, b.source.media_type)) };
      } else if (b.type === 'image' && b.source && b.source.type === 'url' && typeof b.source.url === 'string') {
        // URL 型不落盘(不阻塞请求行):让模型自己下载后再走脚本
        n++;
        const tmp = `/tmp/mixr-img-${Date.now()}-${n}`;
        arr[i] = { type: 'text', text: `[识图中继] 这张图片是 URL(${b.source.url}),当前会话模型没有视觉能力;` +
          `先把它下载到本地(如 curl -sL -o ${tmp} '${b.source.url}'),再运行 ~/.claude/bin/grok-vision ${tmp} 获取描述。` };
      } else if (Array.isArray(b.content) && (b.type === 'tool_result' || !b.type)) {
        walk(b.content);
      }
    }
  };
  walk(msgs);
  return n;
}

module.exports = { rewrite, INBOX };
