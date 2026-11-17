// 冒烟测试：插件能否注册工具，以及能否真的打通 ESP32 通道。
//
//   node --test test/smoke.test.js
//   DSH_ESP32_URL=http://192.168.43.16:8892 node --test test/smoke.test.js   # 真机联调
import test from 'node:test';
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';
import { send, probe, resetBase } from '../lib/client.js';

function fakeCtx() {
  const tools = new Map();
  const panels = new Map();
  return {
    tools: { register: (t) => tools.set(t.name, t) },
    inject: (deps, cb) => {
      if (deps.includes('dshGo')) {
        cb({ dshGo: { panel: (id, def) => panels.set(id, def) } });
      }
    },
    _tools: tools,
    _panels: panels,
  };
}

test('插件元信息', () => {
  assert.equal(plugin.name, 'dsh-esp32-hid');
  assert.deepEqual(plugin.inject, ['tools']);
});

test('注册全部工具', () => {
  const ctx = fakeCtx();
  plugin.apply(ctx);
  const names = [...ctx._tools.keys()].sort();
  assert.deepEqual(names, [
    'esp32_a11y',
    'esp32_aim',
    'esp32_akey',
    'esp32_key',
    'esp32_long',
    'esp32_release',
    'esp32_scan',
    'esp32_screen',
    'esp32_shot',
    'esp32_status',
    'esp32_swipe',
    'esp32_sync',
    'esp32_tap',
    'esp32_tap_box',
    'esp32_text',
    'esp32_ui',
    'esp32_watch',
  ]);
  for (const t of ctx._tools.values()) {
    assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`);
    assert.equal(typeof t.description, 'string');
    assert.ok(t.output?.schema, `${t.name} 缺 output.schema`);
    assert.equal(typeof t.output?.render, 'function', `${t.name} 缺 render`);
  }
  assert.ok(ctx._panels.has('status'), '没注册原生面板');
});

test('参数构造正确', () => {
  const ctx = fakeCtx();
  plugin.apply(ctx);
  const tap = ctx._tools.get('esp32_tap');
  assert.deepEqual(tap.parameters.x.required, true);
  assert.equal(tap.isConcurrencySafe(), false);
});

test('连不上时的报错是给人看的', async () => {
  resetBase();
  const prev = process.env.DSH_ESP32_URL;
  process.env.DSH_ESP32_URL = 'http://127.0.0.1:1';
  process.env.DSH_ESP32_NO_DISCOVER = '1';   // 否则真机会被扫描到，测试就"连上了"
  try {
    await assert.rejects(() => send({ t: 'ping' }), /连不上 ESP32|没有设备|扫描/);
  } finally {
    if (prev === undefined) delete process.env.DSH_ESP32_URL;
    else process.env.DSH_ESP32_URL = prev;
    delete process.env.DSH_ESP32_NO_DISCOVER;
    resetBase();
  }
});

test('真机通道（需要 DSH_ESP32_URL 指向可用的桥）', async (t) => {
  if (!process.env.DSH_ESP32_URL?.includes('192.168') && !process.env.DSH_ESP32_URL?.includes('127.0.0.1')) {
    t.skip('未设置 DSH_ESP32_URL');
    return;
  }
  resetBase();
  const p = await probe();
  assert.equal(p.ok, true, `探测失败：${JSON.stringify(p.tried)}`);
  assert.match(p.health.info ?? '', /VID=|iface=/);

  const ping = await send({ t: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.t, 'ping');
});

test('esp32_status 报出的 BLE 状态与 /cmd 一致（回归：/health 不含 ble 字段）', async (t) => {
  if (!process.env.DSH_ESP32_URL) {
    t.skip('未设置 DSH_ESP32_URL');
    return;
  }
  resetBase();
  const ctx = fakeCtx();
  plugin.apply(ctx);
  const out = await ctx._tools.get('esp32_status').execute({}, {});
  assert.equal(out.transport, 'OTG');
  const ping = await send({ t: 'ping' });
  assert.equal(out.ble, ping.ble, 'esp32_status 的 ble 必须与 ping 回包一致');
  assert.equal(out.ble, true, 'BLE HID 应已连接');
});

// ---- 分辨率 / 横屏自适应 ----
import { point } from '../lib/index.js';

test('像素→归一化：u=x/宽、v=y/高（各轴独立）', () => {
  const info = { w: 1080, h: 2340 };
  const r = point({ x: 270, y: 1170 }, 'x', 'y', info);
  assert.equal(r.u, 0.25);
  assert.equal(r.v, 0.5);
  // 往返：固件按 u*(w-1) 还原成像素
  assert.equal(Math.round(r.u * (info.w - 1)), 270);
  assert.equal(Math.round(r.v * (info.h - 1)), 1170);
});

test('回归：竖屏不能统一除长边（否则横向偏 2.17 倍）', () => {
  const info = { w: 1080, h: 2340, den: 2340 };
  const r = point({ x: 270, y: 1170 }, 'x', 'y', info);
  // 旧实现会给 270/2340 = 0.115385，导致落点 124 而不是 270
  assert.notEqual(r.u, Number((270 / 2340).toFixed(6)));
  assert.equal(r.u, 0.25);
});

test('像素→归一化：720p 机型', () => {
  const info = { w: 720, h: 1600 };
  const r = point({ x: 180, y: 800 }, 'x', 'y', info);
  assert.equal(r.u, 0.25);
  assert.equal(r.v, 0.5);
});

test('像素→归一化：2K 机型', () => {
  const info = { w: 1320, h: 2868 };
  const r = point({ x: 330, y: 1434 }, 'x', 'y', info);
  assert.equal(r.u, 0.25);
  assert.equal(r.v, 0.5);
});

test('像素→归一化：横屏 2340x1080', () => {
  const info = { w: 2340, h: 1080 };
  const r = point({ x: 585, y: 540 }, 'x', 'y', info);
  assert.equal(r.u, 0.25);
  assert.equal(r.v, 0.5);
  assert.equal(Math.round(r.u * (info.w - 1)), 585);
});

test('调用方直接给 u,v 时原样透传', () => {
  const r = point({ u: 0.25, v: 0.4 }, 'x', 'y', { w: 1080, h: 2340 });
  assert.equal(r.u, 0.25);
  assert.equal(r.v, 0.4);
});

test('超界坐标被夹住，不会溢出', () => {
  const r = point({ x: 9999, y: -50 }, 'x', 'y', { w: 1080, h: 2340 });
  assert.equal(r.u, 1);   // 9999/2340 > 1 → 夹到 1
  assert.equal(r.v, 0);   // 负数 → 夹到 0
});

test('拿不到屏幕信息时退回面板像素', () => {
  const r = point({ x: 540, y: 1170 }, 'x', 'y', null);
  assert.deepEqual(r, { x: 540, y: 1170 });
});
