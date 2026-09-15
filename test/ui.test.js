'use strict';
// No browser, dependencies, network requests or user configuration writes.
// Execute the real inline script with a deliberately small DOM/fetch boundary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
const script = new vm.Script(source, { filename: 'public/index.html:inline' });

function fixture() {
  return {
    version: 'test', proxy_port: 8787, ui_port: 8788, uptime_s: 125,
    stats: { reqs: 12, inTok: 100, outTok: 40 },
    providers: {
      claude: [
        { id: 'a1', name: 'Alpha', base_url: 'https://anthropic.example', models: ['claude-special'], slots: { opus: 'slot-model' }, enabled: true, key_masked: '***' },
        { id: 'a2', name: 'Disabled', base_url: 'https://old.example', models: ['claude-old'], enabled: false },
      ],
      codex: [
        { id: 'o1', name: 'Beta', base_url: 'https://openai.example/v1', model: 'gpt-test', wire_api: 'responses', enabled: true },
        { id: 'o2', name: 'Chat gateway', base_url: 'https://chat.example/v1', model: 'text-model', wire_api: 'chat', enabled: false },
      ],
    },
    current: { claude: 'a1', codex: null, zcode: null },
    live: {
      claude: { base_url: 'https://anthropic.example', model: 'claude-special', match: true, router: false },
      codex: { base_url: '', match: true, router: false },
      zcode: { base_url: '', model: '', match: true, router: false },
    },
    router: { id: '@router', url: 'http://127.0.0.1:8787', claude_base: 'http://127.0.0.1:8787', codex_base: 'http://127.0.0.1:8787/v1', zcode_base: 'http://127.0.0.1:8787/custom' },
    routes: { rules: [{ id: 'r1', match: 'claude', provider: 'a1', model: '', enabled: true, pool: [], when: {} }], default: { provider: 'a1', model: '', pool: [] } },
    slots: {
      claude: ['main', 'opus', 'sonnet', 'fable', 'haiku', 'subagent'].map(name => ({
        name, alias: 'mixr-' + name,
        env: { main: 'ANTHROPIC_MODEL', subagent: 'CLAUDE_CODE_SUBAGENT_MODEL' }[name] || 'ANTHROPIC_DEFAULT_' + name.toUpperCase() + '_MODEL',
        provider: name === 'main' ? 'a1' : '', provider_name: name === 'main' ? 'Alpha' : '', enabled: true,
        model: name === 'main' ? 'claude-special' : '',
      })),
      codex: [],
    },
    sessions: [], cooldowns: [],
  };
}

async function harness(data = fixture()) {
  const elements = new Map();
  const listeners = new Map();
  let document;
  class Element {
    constructor(id = '', tag = 'div') {
      this.id = id; this.tagName = tag.toUpperCase(); this.style = {}; this.dataset = {};
      this.attributes = {}; this.value = ''; this.checked = false; this.disabled = false;
      this.hidden = false; this.inert = false; this.isConnected = true; this.children = [];
      this.parentElement = null; this.events = {}; this.htmlWrites = 0; this.textContent = '';
      const classes = new Set();
      this.classList = {
        add: (...xs) => xs.forEach(x => classes.add(x)),
        remove: (...xs) => xs.forEach(x => classes.delete(x)),
        contains: x => classes.has(x),
        toggle: (x, force) => { const on = force ?? !classes.has(x); if (on) classes.add(x); else classes.delete(x); return on; },
      };
    }
    set innerHTML(value) {
      this._html = value; this.htmlWrites++;
      for (const match of value.matchAll(/<(input|select|button|div|label)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const el = new Element(match[2], match[1]); el.parentElement = this; elements.set(el.id, el);
        el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
      }
    }
    get innerHTML() { return this._html || ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    focus() { document.activeElement = this; }
    contains(el) { return el === this || !!el?.parentElement && this.contains(el.parentElement); }
    matches(selector) { return selector.split(',').some(s => s.trim() === this.tagName.toLowerCase()); }
    getClientRects() { return this.hidden ? [] : [{}]; }
    querySelectorAll(selector) {
      if (selector.includes(':disabled')) return this.children.filter(el => !el.disabled && ['BUTTON', 'INPUT', 'SELECT'].includes(el.tagName));
      if (selector === 'button') return this.children.filter(el => el.tagName === 'BUTTON');
      return [];
    }
    querySelector(selector) { return selector === '.modal' ? this.modal : this.querySelectorAll(selector)[0] || null; }
    reportValidity() { return true; }
    click() { this.onclick?.({ preventDefault() {} }); }
  }
  for (const m of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) elements.set(m[2], new Element(m[2], m[1]));
  const get = id => { assert.ok(elements.has(id), 'Unknown DOM id: ' + id); return elements.get(id); };
  const body = new Element('body', 'body');
  const nav = ['providers', 'routes', 'sessions', 'logs'].map(view => { const el = new Element('nav-' + view, 'a'); el.dataset.view = view; return el; });
  const tabs = new Element('tabs');
  document = {
    body, activeElement: body,
    getElementById: id => elements.get(id) || null,
    querySelectorAll: selector => selector === 'nav a' ? nav : [],
    querySelector: selector => selector === '.apptabs' ? tabs : nav.find(el => selector.includes(`data-view="${el.dataset.view}"`)) || null,
    addEventListener: (event, fn) => { (listeners.get(event) || listeners.set(event, []).get(event)).push(fn); },
  };
  for (const id of ['rules-box', 'def-box', 'save-routes', 'add-rule']) get(id).parentElement = get('view-routes');
  for (const [maskId, controls] of [['mask', ['m-name', 'm-base', 'm-key', 'save-provider']], ['confirm-mask', ['confirm-cancel', 'confirm-ok']]]) {
    const mask = get(maskId); mask.modal = new Element(maskId + '-dialog'); mask.modal.parentElement = mask;
    mask.children = controls.map(id => { const el = get(id); el.parentElement = mask; return el; });
  }
  get('provider-filter').value = 'all'; get('logs-auto').checked = true;
  const requests = [];
  const slots = structuredClone(data.slots || { claude: [], codex: [] });
  let failState = false;
  const context = vm.createContext({
    document, window: { addEventListener() {} }, console, URL, URLSearchParams, AbortController, structuredClone,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', body });
      if (url === '/api/state') {
        if (failState) throw new Error('simulated disconnect');
        return { ok: true, json: async () => structuredClone(data) };
      }
      if (url === '/api/stats') return { ok: true, json: async () => ({ reqs: 12, ok_rate: 100, inTok: 100, outTok: 40, cache: 0 }) };
      if (url === '/api/slots' && options.method === 'PUT') {
        // 模拟真实服务端:合并槽位改动后返回最新槽位表(slotsPublic)
        for (const app of ['claude', 'codex']) {
          const patch = body?.[app];
          if (!patch || typeof patch !== 'object') continue;
          for (const [name, val] of Object.entries(patch)) {
            if (val === null) { const i = slots[app].findIndex(s => s.name === name); if (i >= 0) slots[app].splice(i, 1); continue; }
            const entry = slots[app].find(s => s.name === name);
            if (entry) Object.assign(entry, val);
          }
        }
        return { ok: true, json: async () => ({ ok: true, slots: structuredClone(slots) }) };
      }
      if (url.startsWith('/api/logs')) return { ok: true, json: async () => ({ logs: [] }) };
      return { ok: true, json: async () => ({ ok: true, id: 'created-id' }) };
    },
  });
  const run = code => vm.runInContext(code, context);
  script.runInContext(context);
  await run('refreshTask');
  return {
    data, get, run, requests, document, listeners, tabs,
    disconnect(value = true) { failState = value; },
    async confirm(code) { const result = run(code); run('finishConfirm(true)'); await result; },
  };
}

test('ZCode is a client over two protocol stores; counts never duplicate the repository', async () => {
  const h = await harness();
  h.run("setApp('zcode'); setZcodeWire('anthropic')");
  assert.equal(h.run('providerGroup()'), 'claude');
  assert.equal(h.run('providers().length'), 2);
  assert.equal(h.get('count-zcode').textContent, 4);
  assert.equal(h.get('metric-providers').textContent, 2);
  assert.equal(h.get('metric-requests').textContent, '12');
  assert.equal(h.get('metric-tokens').textContent, '140');
  for (const wire of ['responses', 'chat']) {
    h.run(`setZcodeWire('${wire}')`);
    assert.equal(h.run('providerGroup()'), 'codex');
    assert.equal(h.run('providers().length'), 2); // No hard filtering by wire.
    assert.equal((h.get('prov-grid').innerHTML.match(/<article /g) || []).length, 2);
  }
  assert.equal(h.run('state.providers.zcode'), undefined);
  h.run("setApp('claude')");
  assert.equal(h.run('providerGroup()'), 'claude');
});

test('provider search combines name, URL, models, slots and enabled-state filters', async () => {
  const h = await harness();
  const search = (query, filter = 'all') => {
    h.get('provider-search').value = query; h.get('provider-filter').value = filter; h.run('renderProviders()');
    return (h.get('prov-grid').innerHTML.match(/<article /g) || []).length;
  };
  for (const query of ['ALPHA', 'anthropic.example', 'CLAUDE-SPECIAL', 'slot-model']) assert.equal(search(query), 1);
  assert.equal(search('claude', 'enabled'), 1);
  assert.equal(search('claude', 'disabled'), 1);
  assert.equal(search('ALPHA', 'disabled'), 0);
  assert.equal(h.get('prov-empty').hidden, false);
  h.get('empty-action').onclick();
  assert.equal(h.get('provider-search').value, '');
  assert.equal(h.get('provider-filter').value, 'all');
  h.run("setApp('zcode'); setZcodeWire('chat')");
  assert.equal(search('gpt-test'), 1);
  assert.equal(search('missing-model'), 0);
});

test('多 Key 弹窗:老式单 Key 渠道预置「账号1」,顶栏那行不再覆盖生效 Key', async () => {
  const data = fixture();
  // 服务端 publicProvider 会把"只有 api_key"的老渠道合成一条固定 id 的「账号1」,夹具照这个形状给
  data.providers.claude[0] = { ...data.providers.claude[0], has_key: true, key_masked: 'sk-leg…0001',
    keys: [{ id: 'klegacy', label: '账号1', key_masked: 'sk-leg…0001' }], active_key: 'klegacy' };
  const h = await harness(data);
  assert.match(h.get('prov-grid').innerHTML, /<select class="keypick"/);   // 卡片上有可点的账号下拉
  assert.match(h.get('prov-grid').innerHTML, /账号1/);

  h.run("openProvider('a1')");
  assert.equal(h.run('keyDraft.length'), 1);            // 不是空白清单:老 Key 看得见、留得住
  assert.equal(h.run('keyDraft[0].id'), 'klegacy');
  assert.match(h.get('m-key-hint').textContent, /清单/);

  h.run('addKeyDraft()');
  h.run("keyDraft[1].label = '账号2'; keyDraft[1].key = 'sk-second-0002'");
  h.get('m-key').value = '';                            // 顶栏那个单行 API Key 留空
  await h.run('saveProvider()');
  const put = h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/providers/a1');
  assert.equal(put.body.api_key, '', '有清单时顶栏那把不参与保存,免得覆盖生效 Key');
  assert.deepEqual(put.body.keys, [
    { id: 'klegacy', label: '账号1', key: '' },         // 留空=不改,由服务端解析回原 Key
    { id: '', label: '账号2', key: 'sk-second-0002' },
  ]);
});

test('ZCode create/edit saves use the selected protocol group, including chat default', async () => {
  const h = await harness();
  for (const [wire, group] of [['anthropic', 'claude'], ['responses', 'codex'], ['chat', 'codex']]) {
    h.run(`setApp('zcode'); setZcodeWire('${wire}'); openProvider()`);
    h.get('m-name').value = 'New channel'; h.get('m-base').value = 'https://new.example/v1'; h.get('m-model').value = 'model-a';
    await h.run('saveProvider()');
    const req = h.requests.filter(r => r.method === 'POST' && r.url === '/api/providers').at(-1);
    assert.equal(req.body.app, group);
    if (group === 'codex') assert.equal(req.body.wire_api, wire);
    assert.equal(h.get('workspace').inert, false);
  }
  h.run("setZcodeWire('chat'); openProvider('o1')");
  assert.equal(h.get('m-wire').value, 'responses'); // Preserve actual channel protocol when editing.
  await h.run('saveProvider()');
  const edited = h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/providers/o1');
  assert.equal(edited.body.app, 'codex');
  assert.equal(edited.body.wire_api, 'responses');
  assert.equal(h.requests.some(r => r.body?.app === 'zcode'), false);
});

test('ZCode switch sends app=zcode; router sends the chosen wire; other clients preserve empty bodies', async () => {
  const h = await harness();
  h.run("setApp('zcode'); setZcodeWire('responses')");
  await h.confirm("switchProvider('o1')");
  assert.deepEqual(h.requests.findLast(r => r.url === '/api/switch/o1').body, { app: 'zcode' });
  h.run("setZcodeWire('chat')");
  await h.confirm('switchRouterMode()');
  assert.deepEqual(h.requests.findLast(r => r.url === '/api/router/zcode').body, { wire_api: 'chat' });
  assert.equal(h.run("routerBase('zcode')"), h.data.router.zcode_base);
  delete h.data.router.zcode_base; await h.run('refresh()');
  assert.equal(h.run("routerBase('zcode')"), h.data.router.url);
  h.run("setApp('claude')");
  await h.confirm("switchProvider('a1')");
  assert.equal(h.requests.findLast(r => r.url === '/api/switch/a1').body, undefined);
  h.run("setApp('codex')"); await h.confirm('switchRouterMode()');
  assert.equal(h.requests.findLast(r => r.url === '/api/router/codex').body, undefined);
});

test('old backend cannot receive ZCode write requests that might target another client', async () => {
  const data = fixture(); delete data.current.zcode; delete data.live.zcode;
  const h = await harness(data);
  h.run("setApp('zcode')");
  assert.equal(h.get('btn-router').disabled, true);
  await h.run("switchProvider('a1')"); await h.run('switchRouterMode()');
  assert.equal(h.requests.some(r => r.method === 'POST'), false);
});

test('polling preserves route DOM identity, focus, drafts, and unsaved values across views', async () => {
  const h = await harness();
  h.run("view = 'routes'");
  const input = h.get('rule-0-match'), rules = h.get('rules-box'), defaults = h.get('def-box');
  input.focus(); input.value = 'unfinished, draft';
  h.run("routesDraft.rules[0].match = 'unfinished, draft'; markRoutesDirty()");
  const before = [rules.htmlWrites, defaults.htmlWrites];
  h.data.routes.rules[0].match = 'external-update';
  for (let n = 0; n < 3; n++) await h.run('refresh()');
  assert.deepEqual([rules.htmlWrites, defaults.htmlWrites], before);
  assert.equal(h.get('rule-0-match'), input);
  assert.equal(h.document.activeElement, input);
  assert.equal(input.value, 'unfinished, draft');
  assert.equal(h.run('routesDraft.rules[0].match'), 'unfinished, draft');
  assert.equal(h.run('routesDirty'), true);
  h.run("view = 'providers'"); await h.run('refresh()'); h.run("view = 'routes'"); await h.run('refresh()');
  assert.deepEqual([rules.htmlWrites, defaults.htmlWrites], before);
  await h.confirm('reloadRoutes()');
  assert.equal(h.run('routesDraft.rules[0].match'), 'external-update');
  assert.equal(h.run('routesDirty'), false);
});

test('disconnect leaves a labelled stale snapshot, not a green online state, then recovers', async () => {
  const h = await harness();
  assert.equal(h.document.body.dataset.connection, 'online');
  assert.equal(h.run('online'), true);
  const before = h.get('metric-requests').textContent;
  h.disconnect(); await h.run('refresh()');
  assert.equal(h.document.body.dataset.connection, 'offline');
  assert.equal(h.run('online'), false);
  assert.equal(h.get('connection-banner').classList.contains('show'), true);
  assert.equal(h.get('btn-router').disabled, true);
  assert.equal(h.get('metric-requests').textContent, before);
  assert.equal(h.get('liveinfo').innerHTML.includes('mode-card selected'), false);
  const writes = h.requests.filter(r => r.method !== 'GET').length;
  await h.run("switchProvider('a1')");
  assert.equal(h.requests.filter(r => r.method !== 'GET').length, writes);
  h.disconnect(false); h.data.stats.reqs = 20; await h.run('refresh()');
  assert.equal(h.get('metric-requests').textContent, '20');
  assert.equal(h.document.body.dataset.connection, 'online');
  assert.equal(h.get('connection-banner').classList.contains('show'), false);
});

test('dialog traps Tab in both directions, Escape cancels and returns focus, tabs support arrows', async () => {
  const h = await harness();
  const opener = h.get('new-provider'); opener.focus(); h.run('openProvider()');
  assert.equal(h.get('workspace').inert, true);
  assert.equal(h.document.activeElement, h.get('m-name'));
  const keydown = key => {
    let prevented = false;
    for (const listener of h.listeners.get('keydown')) listener({ ...key, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(keydown({ key: 'Tab', shiftKey: true }), true);
  assert.equal(h.document.activeElement, h.get('save-provider'));
  assert.equal(keydown({ key: 'Tab', shiftKey: false }), true);
  assert.equal(h.document.activeElement, h.get('m-name'));
  keydown({ key: 'Escape' });
  assert.equal(h.document.activeElement, opener);
  assert.equal(h.get('workspace').inert, false);
  const confirmation = h.run("askConfirm('Delete', 'Are you sure?')");
  keydown({ key: 'Escape' }); assert.equal(await confirmation, false);
  h.tabs.events.keydown[0]({ key: 'End', preventDefault() {} });
  assert.equal(h.run('curApp'), 'zcode');
  assert.equal(h.get('tab-zcode').getAttribute('aria-selected'), 'true');
  assert.equal(h.document.activeElement, h.get('tab-zcode'));
});

test('live configuration mismatch never labels the stored provider as the actual direct upstream', async () => {
  const data = fixture();
  data.live.claude = { base_url: 'https://external.example', provider: 'External provider', match: false, router: false };
  const h = await harness(data);
  const direct = h.get('liveinfo').innerHTML.split('</article>')[0];
  assert.equal(direct.includes('External provider'), true);
  assert.equal(direct.includes('Alpha'), false);
  assert.equal(h.get('drift-banner').classList.contains('show'), true);
  data.live.claude.error = 'invalid config'; await h.run('refresh()');
  assert.equal(h.get('liveinfo').innerHTML.includes('mode-card selected'), false);
  assert.equal(h.get('drift-text').textContent.includes('invalid config'), true);
});

test('generated handlers compile safely for quotes, apostrophes, and HTML in provider identifiers', async () => {
  const data = fixture(); data.providers.claude[0].id = `a'"<&`; data.providers.claude[0].name = '<script>bad()</script>';
  const h = await harness(data);
  const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const fragment of [html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), h.get('prov-grid').innerHTML, h.get('rules-box').innerHTML, h.get('def-box').innerHTML]) {
    for (const match of fragment.matchAll(/\bon(?:click|input|change|submit)="([^"]*)"/g)) new vm.Script(`(function(event){${decode(match[1])}})`);
  }
  assert.equal(h.get('prov-grid').innerHTML.includes('<script>bad()'), false);
  assert.equal(h.get('prov-grid').innerHTML.includes('&lt;script&gt;bad()'), true);
});

test('槽位落点模型是下拉:渠道模型列全可选,换渠道当场换清单,未登记的模型名走「自定义模型…」', async () => {
  const h = await harness();
  h.run("setApp('claude')");
  const before = h.get('slots-rows').innerHTML;
  // 必须是 select:datalist 会被 Chromium 按输入框已有内容过滤,填了值就只剩一个候选,等于没法挑
  assert.match(before, /<select aria-label="main 槽模型" onchange="onSlotModelPick\('claude','main',this\.value\)">/);
  assert.match(before, /<option value="claude-special" selected>claude-special<\/option>/);
  assert.match(before, /<option value="__custom__">自定义模型…<\/option>/);
  assert.doesNotMatch(before, /claude-old/);
  // 用户刚在渠道 select 里选完新渠道,焦点还停在槽位表内:轮询守卫本会跳过重绘,用户提交的改动必须绕过它
  h.run("globalThis.__sel = new document.body.constructor('f', 'select'); __sel.setAttribute('aria-label', 'main 槽渠道'); __sel.parentElement = document.getElementById('slots-rows'); __sel.focus();");
  assert.equal(h.document.activeElement.getAttribute('aria-label'), 'main 槽渠道');
  await h.run("setSlot('claude', 'main', 'provider', 'a2')");
  const after = h.get('slots-rows').innerHTML;
  assert.match(after, /value="a2"/);
  assert.match(after, /<option value="claude-old" selected>claude-old<\/option>/);  // 落点模型跟着新渠道的清单走
  assert.doesNotMatch(after, /claude-special/);
  assert.match(after, /<select aria-label="subagent 槽模型" disabled><option>（先选渠道）<\/option><\/select>/);
  // 渠道清单里没有的模型名:选「自定义模型…」切输入框后照样能提交
  // (夹具的 /api/state 是静态的,refresh 会把槽位表还原成初始值,所以这里只断言提交内容)
  h.run("onSlotModelPick('claude','main','__custom__')");
  assert.match(h.get('slots-rows').innerHTML, /<input type="text" aria-label="main 槽模型" list="slot-models-main" value="claude-special"/);
  h.run("slotModelKey({ key: 'Escape', target: {} }, 'claude', 'main')");
  assert.equal(h.run('slotModelEdit.claude'), null);
  assert.match(h.get('slots-rows').innerHTML, /<select aria-label="main 槽模型"/, 'Esc 退出输入框,回到下拉');
  h.run("onSlotModelPick('claude','main','__custom__')");
  await h.run("slotModelKey({ key: 'Enter', preventDefault() {}, target: { value: 'brand-new-model' } }, 'claude', 'main')");
  const put = h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/slots');
  assert.equal(put.body.claude.main.model, 'brand-new-model');
  assert.equal(typeof put.body.claude.main.provider, 'string');
  assert.equal(h.run('slotModelEdit.claude'), null, '提交后回到下拉,不再停在输入框');
  // 失焦提交不依赖 change 事件:值变了才提交,没变就只清标记,不写盘
  const putCount = () => h.requests.filter(r => r.method === 'PUT' && r.url === '/api/slots').length;
  const putBefore = putCount();
  h.run("onSlotModelPick('claude','main','__custom__')");
  h.run("endSlotModelEdit('claude','main', slotModelEdit.claude.value)");        // 原样失焦
  assert.equal(putCount(), putBefore, '没改就不写盘');
  h.run("onSlotModelPick('claude','main','__custom__')");
  await h.run("endSlotModelEdit('claude','main','second-new-model')");
  assert.equal(h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/slots').body.claude.main.model, 'second-new-model');
});

test('渠道弹窗不再带模型映射:保存只提交模型列表,不再写渠道级槽位', async () => {
  const h = await harness();
  assert.doesNotMatch(html, /id="m-slot-/);              // 弹窗里那条「模型映射」整体去掉
  h.run("setApp('claude'); openProvider('a1')");
  h.get('m-models').value = 'brand-new-model, claude-special';
  await h.run('saveProvider()');
  const put = h.requests.findLast(r => r.method === 'PUT' && r.url === '/api/providers/a1');
  assert.equal(put.body.models, 'brand-new-model, claude-special', '模型列表照旧按自由文本提交');
  assert.equal(put.body.slots, undefined, '渠道级槽位不再由弹窗改写');
});
