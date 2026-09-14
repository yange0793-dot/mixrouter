'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');

// 环回地址永不出网:本机渠道(本地模型、mock 上游)走隧道会被隧道拒或绕远路
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d+){3}|::1|\[::1\])$/i;
function bypassed(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  if (LOOPBACK.test(host)) return true;
  const extra = String(process.env.MIXR_UPSTREAM_PROXY_BYPASS || '').split(',')
    .map(s => s.trim().toLowerCase()).filter(Boolean);
  return extra.some(p => (p.startsWith('.') ? host.toLowerCase().endsWith(p) : host.toLowerCase() === p));
}
// 直连(不走隧道)时只挑 TLS/网络相关的键:请求头、path 这些塞进 tls.connect 会被当成 unix socket 路径
function directOptions(options, hostname, port) {
  const keys = ['ca', 'cert', 'key', 'pfx', 'passphrase', 'rejectUnauthorized', 'ALPNProtocols',
    'servername', 'family', 'lookup', 'localAddress', 'localPort', 'timeout'];
  const picked = Object.fromEntries(keys.filter(k => options[k] !== undefined).map(k => [k, options[k]]));
  return { ...picked, host: hostname, port };
}

function createProxyAgents(proxyUrl, agentOptions = {}) {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== 'http:') throw new Error('MIXR_UPSTREAM_PROXY 只支持 http:// CONNECT 代理');
  const timeout = Number(agentOptions.timeout) || 30000;
  const connect = (options, callback, secure) => {
    const hostname = String(options.hostname || options.host).replace(/^\[|\]$/g, '');
    const port = options.port || (secure ? 443 : 80);
    if (bypassed(hostname)) {
      const direct = secure ? tls.connect(directOptions(options, hostname, port)) : net.connect(directOptions(options, hostname, port));
      let done = false;
      const settle = (error) => { if (done) return; done = true; callback(error, error ? undefined : direct); };
      direct.once('error', settle);
      direct.once(secure ? 'secureConnect' : 'connect', () => settle());
      return;
    }
    const authority = `${net.isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`;
    const headers = { Host: authority };
    if (proxy.username || proxy.password) headers['Proxy-Authorization'] = 'Basic ' +
      Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    let settled = false;
    let socket;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { req.destroy(); if (socket) socket.destroy(); }
      callback(error, result);
    };
    const req = http.request({ hostname: proxy.hostname, port: proxy.port || 80,
      method: 'CONNECT', path: authority, headers, agent: false });
    const timer = setTimeout(() => finish(new Error('upstream proxy connect timeout')), timeout);
    req.on('error', error => finish(error));
    req.on('response', res => { res.resume(); finish(new Error(`upstream proxy CONNECT ${res.statusCode}`)); });
    req.on('connect', (res, tunnel, head) => {
      socket = tunnel;
      if (res.statusCode !== 200) return finish(new Error(`upstream proxy CONNECT ${res.statusCode}`));
      if (head.length) tunnel.unshift(head);
      if (!secure) return finish(null, tunnel);
      socket = tls.connect({ ...options, socket: tunnel,
        servername: options.servername || (net.isIP(hostname) ? undefined : hostname) });
      socket.once('error', error => finish(error));
      socket.once('secureConnect', () => finish(null, socket));
    });
    req.end();
  };
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, ...(agentOptions.http || {}) });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, ...(agentOptions.https || {}) });
  httpAgent.createConnection = (options, callback) => { connect(options, callback, false); };
  httpsAgent.createConnection = (options, callback) => { connect(options, callback, true); };
  return { http: httpAgent, https: httpsAgent };
}

const caches = new Map();
function upstreamAgent(protocol) {
  const url = process.env.MIXR_UPSTREAM_PROXY;
  if (!url) return undefined;
  if (!caches.has(url)) caches.set(url, createProxyAgents(url));
  return caches.get(url)[protocol === 'https:' ? 'https' : 'http'];
}
module.exports = { createProxyAgents, upstreamAgent, bypassed };
