// 真机联调脚本（会真发命令，别放进 test/）：
//   node scripts/live-check.mjs http://192.168.43.22:8892
//
// 验证顺序按 skill 的要求走：探测 → 状态 → 扫描 → 真发一条（BLE 没连时应当拿到 no_hid）。
import * as plugin from '../lib/index.js';
import { probe, resetBase, send } from '../lib/client.js';

const url = process.argv[2] || process.env.DSH_ESP32_URL || 'http://192.168.43.22:8892';
process.env.DSH_ESP32_URL = url;

function fakeCtx() {
  const tools = new Map();
  const panels = new Map();
  return {
    tools: { register: (t) => tools.set(t.name, t) },
    inject: (deps, cb) => {
      if (deps.includes('dshGo')) cb({ dshGo: { panel: (id, def) => panels.set(id, def) } });
    },
    _tools: tools,
    _panels: panels,
  };
}

const line = (s) => console.log(`\n=== ${s} ===`);

resetBase();
line('1. probe');
const p = await probe();
console.log(JSON.stringify({ ok: p.ok, base: p.base, kind: p.kind, ble: p.ble, health: p.health }, null, 2));

const ctx = fakeCtx();
plugin.apply(ctx);

line('2. esp32_status');
const st = await ctx._tools.get('esp32_status').execute({}, {});
console.log(JSON.stringify(st, null, 2));

line('3. esp32_scan（UDP whois）');
const scan = await ctx._tools.get('esp32_scan').execute({}, {});
console.log(JSON.stringify(scan, null, 2));

line('4. esp32_tap（BLE 未连时应拿到 no_hid，而不是“连不上”）');
const tap = await ctx._tools.get('esp32_tap').execute({ x: 540, y: 1170, w: 1080, h: 2340 }, {});
console.log(JSON.stringify(tap, null, 2));

line('5. send() 直连一次 ping');
try {
  console.log(JSON.stringify(await send({ t: 'ping' }), null, 2));
} catch (e) {
  console.log('抛出：', e.message);
}
