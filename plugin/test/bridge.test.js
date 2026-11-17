// 独立 App 桥（127.0.0.1:8893）的通道选择与降级测试。
//
// 全部用本机假服务器，不碰真机、不碰真板子 —— 真机脚本一律放 scripts/。
//
//   node --test test/bridge.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { probe, send, resetBase, kindOf, KIND, SVC } from '../lib/client.js';

/** 起一个假桥：routes 决定 /health /device /cmd 怎么答。 */
async function fakeBridge({ ble = true, svc = SVC, info = 'fake', transport = null } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    hits.push(url.pathname);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') {
      const body = { ok: true, info };
      if (svc !== null) body.svc = svc;
      if (ble !== null) body.ble = ble;
      if (transport !== null) body.transport = transport;
      res.end(JSON.stringify(body));
      return;
    }
    if (url.pathname === '/device') {
      res.end(JSON.stringify({ ok: true, svc: SVC, id: 'FAKE', ble }));
      return;
    }
    if (url.pathname === '/cmd') {
      const j = JSON.parse(url.searchParams.get('j') ?? '{}');
      res.end(JSON.stringify({ ok: true, t: j.t ?? 'unknown', ble, tip: false }));
      return;
    }
    if (url.pathname === '/screen') {
      res.end(JSON.stringify({ ok: true, known: true, w: 1080, h: 2340, rot: 0 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, err: 'not_found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function withEnv(urls, fn) {
  const prevUrl = process.env.DSH_ESP32_URL;
  const prevNoDiscover = process.env.DSH_ESP32_NO_DISCOVER;
  process.env.DSH_ESP32_URL = urls.join(',');
  process.env.DSH_ESP32_NO_DISCOVER = '1'; // 测试不扫局域网，否则会扫到真板子
  resetBase();
  try {
    await fn();
  } finally {
    if (prevUrl === undefined) delete process.env.DSH_ESP32_URL;
    else process.env.DSH_ESP32_URL = prevUrl;
    if (prevNoDiscover === undefined) delete process.env.DSH_ESP32_NO_DISCOVER;
    else process.env.DSH_ESP32_NO_DISCOVER = prevNoDiscover;
    resetBase();
  }
}

test('kindOf：8893 是 App 桥、8892 是 OTG、其他是无线', () => {
  assert.equal(kindOf('http://127.0.0.1:8893'), KIND.APP);
  assert.equal(kindOf('http://localhost:8893/'), KIND.APP);
  assert.equal(kindOf('http://127.0.0.1:8892'), KIND.OTG);
  assert.equal(kindOf('http://192.168.43.22:8892'), KIND.WIFI);
});

test('App 桥声明 svc 且 ble=true → 直接选它，并标成 app', async () => {
  const br = await fakeBridge({ ble: true, transport: 'app' });
  try {
    await withEnv([br.url], async () => {
      const p = await probe();
      assert.equal(p.ok, true);
      assert.equal(p.kind, KIND.APP);
      assert.equal(p.ble, true);
      assert.equal(p.health.svc, SVC);
    });
  } finally {
    await br.close();
  }
});

test('App 桥连着但 ble=false 时，优先用另一条 ble=true 的通道', async () => {
  const dead = await fakeBridge({ ble: false, info: 'bridge ble=off', transport: 'app' });
  const alive = await fakeBridge({ ble: true, info: 'wifi direct', transport: 'wifi' });
  try {
    await withEnv([dead.url, alive.url], async () => {
      const p = await probe();
      assert.equal(p.ok, true);
      assert.equal(p.base, alive.url, '有 ble=true 的通道就该用它');
      assert.equal(p.kind, KIND.WIFI);
      assert.equal(p.ble, true);
    });
  } finally {
    await dead.close();
    await alive.close();
  }
});

test('只有一条 ble=false 的通道时，仍然选它，但 send 给出可照做的原因', async () => {
  const dead = await fakeBridge({ ble: false, info: 'bridge ble=off', transport: 'app' });
  try {
    await withEnv([dead.url], async () => {
      const p = await probe();
      assert.equal(p.ok, true, '通道本身是通的，不能报「未连接」');
      assert.equal(p.ble, false);
      await assert.rejects(
        () => send({ t: 'ping' }),
        /App 桥在线，但它到 ESP32 的蓝牙还没连上/,
      );
    });
  } finally {
    await dead.close();
  }
});

test('ble 未知（老固件没有该字段）时不拦命令，照旧发出去', async () => {
  const old = await fakeBridge({ ble: null, info: 'legacy wifi fw' });
  try {
    await withEnv([old.url], async () => {
      const p = await probe();
      assert.equal(p.ok, true);
      assert.equal(p.ble, null, '字段缺失 = 未知，不能当 false');
      const r = await send({ t: 'ping' });
      assert.equal(r.ok, true);
      assert.equal(r.t, 'ping');
    });
  } finally {
    await old.close();
  }
});
