// 真机联调：走 WiFi 直连固件（192.168.43.22:8892），不产生触摸
import * as plugin from '../lib/index.js';
import { resetBase } from '../lib/client.js';

process.env.DSH_ESP32_URL = process.env.DSH_ESP32_URL || 'http://192.168.43.22:8892';
resetBase();

const tools = new Map();
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  inject: (deps, cb) => { if (deps.includes('dshGo')) cb({ dshGo: { panel: () => {} } }); },
};
plugin.apply(ctx);

const status = tools.get('esp32_status');
const sync = tools.get('esp32_sync');

const st1 = await status.execute({});
console.log('【同步前】', JSON.stringify({
  transport: st1.transport, screen: st1.screen, tip: st1.tip,
  need_screen: st1.need_screen, hint: st1.hint, fw: st1.fw,
}, null, 0));

const sy = await sync.execute({ w: 1080, h: 2340 });
console.log('【sync】', JSON.stringify(sy));

const st2 = await status.execute({});
console.log('【同步后】', JSON.stringify({
  screen: st2.screen, tip: st2.tip, need_screen: st2.need_screen, hint: st2.hint,
}));
