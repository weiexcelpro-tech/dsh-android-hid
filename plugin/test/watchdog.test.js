// 看门狗客户端测试：/watch 的各种 op、老桥 404、参数编码。
// 全部用本机假服务器 —— 真机联调见 scripts/live-check.mjs。
//
//   node --test test/watchdog.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { watchdog, resetBase, SVC } from '../lib/client.js';

/** 起一个假桥，只关心 /health 与 /watch（watch=null 表示 1.2.0 老桥，无此路由）。 */
async function fakeBridge({ watch = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, svc: SVC, ble: true, transport: 'app' }));
      return;
    }
    if (url.pathname === '/watch' && watch) {
      seen.push(Object.fromEntries(url.searchParams.entries()));
      res.end(JSON.stringify(watch));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, err: 'not_found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function withBridge(url, fn) {
  const prevUrl = process.env.DSH_ESP32_URL;
  const prevNoDiscover = process.env.DSH_ESP32_NO_DISCOVER;
  process.env.DSH_ESP32_URL = url;
  process.env.DSH_ESP32_NO_DISCOVER = '1';
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

const HEALTHY = {
  ok: true,
  on: true,
  permitted: true,
  running: true,
  targets: ['a.b/a.b.C', 'com.tangyuan.bridge/com.tangyuan.bridge.CapService'],
  master: true,
  missing: [],
  fixes: 3,
  last: 'restored:[a.b/a.b.C]',
  last_at: 1763452800000,
};

test('watchdog 默认查 status，字段原样透出', async () => {
  const b = await fakeBridge({ watch: HEALTHY });
  try {
    await withBridge(b.url, async () => {
      const d = await watchdog();
      assert.equal(d.ok, true);
      assert.equal(d.permitted, true);
      assert.equal(d.fixes, 3);
      assert.deepEqual(d.missing, []);
      assert.deepEqual(b.seen, [{ op: 'status' }]);
    });
  } finally {
    await b.close();
  }
});

test('watchdog(off/fix) 把 op 带过去，arg 会被正确编码', async () => {
  const b = await fakeBridge({ watch: { ...HEALTHY, on: false } });
  try {
    await withBridge(b.url, async () => {
      await watchdog('off');
      await watchdog('fix');
      await watchdog('add', 'com.foo.app/com.foo.app.BarService');
      assert.deepEqual(b.seen[0], { op: 'off' });
      assert.deepEqual(b.seen[1], { op: 'fix' });
      assert.deepEqual(b.seen[2], {
        op: 'add',
        arg: 'com.foo.app/com.foo.app.BarService',
      });
    });
  } finally {
    await b.close();
  }
});

test('缺少权限时原样返回 permitted=false，不臆造成功', async () => {
  const b = await fakeBridge({
    watch: { ...HEALTHY, permitted: false, hint: 'adb shell pm grant ...' },
  });
  try {
    await withBridge(b.url, async () => {
      const d = await watchdog();
      assert.equal(d.permitted, false);
      assert.match(d.hint, /pm grant/);
    });
  } finally {
    await b.close();
  }
});

test('老桥（1.2.0，没有 /watch）给出可读的升级提示，不是裸 404', async () => {
  const b = await fakeBridge({ watch: null });
  try {
    await withBridge(b.url, async () => {
      await assert.rejects(() => watchdog(), /升级到 1\.3\.0/);
    });
  } finally {
    await b.close();
  }
});

test('桥完全连不上时错误里带上试过的地址', async () => {
  await withBridge('http://127.0.0.1:1', async () => {
    await assert.rejects(() => watchdog(), /连不上桥/);
  });
});
