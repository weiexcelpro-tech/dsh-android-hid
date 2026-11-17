// esp32_release 必须发两条命令：up（抬起）+ leave（出界）。
// 回归理由：只发 up 时 InRange 仍为 1，Android 认为笔一直悬停在屏上
// （dumpsys input 里 isHovering=true），随后**手指触摸被压制 → 整屏点不动**。
// 这是真机事故的固化用例，别删。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import * as plugin from '../lib/index.js';
import { resetBase } from '../lib/client.js';

const cmds = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/health')
    return res.end(JSON.stringify({ ok: true, svc: 'tangyuan-hid', proto: 1, info: 'mock' }));
  if (u.pathname === '/device') return res.end(JSON.stringify({ ok: true, fw: '0.3.3-mock' }));
  if (u.pathname === '/cmd') {
    let j = {};
    try {
      j = JSON.parse(u.searchParams.get('j') || '{}');
    } catch {
      /* ignore */
    }
    cmds.push(j.t);
    return res.end(JSON.stringify({ ok: true, t: j.t, ble: true, tip: false, need_screen: false, rot: 0 }));
  }
  res.statusCode = 404;
  res.end('{}');
});

test('esp32_release 发 up + leave', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  process.env.DSH_ESP32_URL = `http://127.0.0.1:${port}`;
  resetBase();

  const tools = new Map();
  plugin.apply({
    tools: { register: (t) => tools.set(t.name, t) },
    inject: (deps, cb) => {
      if (deps.includes('dshGo')) cb({ dshGo: { panel: () => {} } });
    },
  });

  cmds.length = 0;
  const res = await tools.get('esp32_release').execute({}, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(cmds, ['up', 'leave'], `实际发出：${cmds.join(',')}`);

  server.close();
  delete process.env.DSH_ESP32_URL;
  resetBase();
});
