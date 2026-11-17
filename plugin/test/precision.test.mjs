// 精度链路验证：网格 / 包围盒 / 区域二次定位 的换算是否正确
// 全部 dry_run，不产生真实触摸。
import * as plugin from '../lib/index.js';

const tools = new Map();
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  inject: (deps, cb) => { if (deps.includes('dshGo')) cb({ dshGo: { panel: () => {} } }); },
};
plugin.apply(ctx);

const W = 1080, H = 2340;
const show = (label, r) => console.log(`${label.padEnd(34)} → (${r.x}, ${r.y})  ${r.ok ? '✓' : '✗ ' + r.detail}`);

const aim = tools.get('esp32_aim');
const box = tools.get('esp32_tap_box');

// 1) 整屏网格 10x20：第 5 列第 10 行居中
show('网格 R10C5 中心 (期望 594,1228)',
  await aim.execute({ w: W, h: H, col: 5, row: 10, dry_run: true }));

// 2) 整屏网格，格内偏移到右上角
show('网格 R0C0 @0.9,0.1 (期望 97,11)',
  await aim.execute({ w: W, h: H, col: 0, row: 0, fx: 0.9, fy: 0.1, dry_run: true }));

// 3) 由粗到细：先在 [100,800]-[500,1000] 里 2x2 网格取 R1C1 中心
show('区域 2x2 R1C1 中心 (期望 400,950)',
  await aim.execute({ w: W, h: H, col: 1, row: 1, cols: 2, rows: 2, x1: 100, y1: 800, x2: 500, y2: 1000, dry_run: true }));

// 4) 包围盒居中
show('盒 [100,200]-[300,260] 中心 (期望 200,230)',
  await box.execute({ x1: 100, y1: 200, x2: 300, y2: 260, w: W, h: H, dry_run: true }));

// 5) 包围盒反序输入应自动纠正
show('盒 [300,260]-[100,200] 反序 (期望 200,230)',
  await box.execute({ x1: 300, y1: 260, x2: 100, y2: 200, w: W, h: H, dry_run: true }));

// 6) 越界钳制
show('盒越界 [1000,2300]-[2000,9999] 居中',
  await box.execute({ x1: 1000, y1: 2300, x2: 2000, y2: 9999, w: W, h: H, dry_run: true }));

// 7) 参数校验
const bad = await aim.execute({ w: W, h: H, col: 99, row: 0, dry_run: true });
console.log(`列号越界应报错                          → ${bad.ok ? '✗ 没拦住' : '✓ ' + bad.detail}`);
