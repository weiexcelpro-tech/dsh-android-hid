// 真实精度实测：用 esp32_tap_box 点汉堡，验证包围盒换算 + 实际命中
import * as plugin from '../lib/index.js';
import { resetBase } from '../lib/client.js';

process.env.DSH_ESP32_URL = 'http://192.168.43.22:8892';
resetBase();

const tools = new Map();
plugin.apply({ tools: { register: (t) => tools.set(t.name, t) }, inject: () => {} });

const box = tools.get('esp32_tap_box');
const st = tools.get('esp32_status');

const W = 1080, H = 2340;
// 汉堡图标（全分辨率）：半分辨率截图里约 (30,56)-(64,90) → 全分辨率 (60,112)-(128,180)
const args = { x1: 60, y1: 112, x2: 128, y2: 180, w: W, h: H };

console.log('① 干跑:', JSON.stringify(await box.execute({ ...args, dry_run: true })));
const s1 = await st.execute({});
console.log('② 点前状态: screen=%s tip=%s need_screen=%s', s1.screen, s1.tip, s1.need_screen);
console.log('③ 真点:', JSON.stringify(await box.execute(args)));
await new Promise((r) => setTimeout(r, 1500));
const s2 = await st.execute({});
console.log('④ 点后状态: tip=%s（必须 false）', s2.tip);
