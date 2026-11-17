// 假 App 桥：没有手机时用来联调插件（路由/字段和 TangyuanBridge 的 HttpServer 一致）。
//
//   node scripts/fake-bridge.mjs            # 监听 127.0.0.1:8893
//   node scripts/fake-bridge.mjs --ble=0    # 模拟「App 在、蓝牙没连」
//
// 另一个终端：node scripts/live-check.mjs http://127.0.0.1:8893
import http from 'node:http';

const PORT = Number(process.env.FAKE_BRIDGE_PORT ?? 8893);
const bleFlag = process.argv.find((a) => a.startsWith('--ble='));
const BLE = bleFlag ? bleFlag.endsWith('1') : true;

let screen = { known: true, w: 1080, h: 2340, rot: 0 };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (o, code = 200) => {
    const body = JSON.stringify(o);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  log(req.method, url.pathname, url.search || '');

  switch (url.pathname) {
    case '/health':
      return send({
        ok: true, svc: 'tangyuan-hid', proto: 1, transport: 'app', ble: BLE,
        state: BLE ? 'ready' : 'connecting', tip: false, need_screen: !screen.known,
        screen, info: 'TangyuanBridge 1.1.0 · BLE ' + (BLE ? 'ready' : 'connecting') + ' · FAKE',
      });
    case '/device':
      return send({
        ok: true, svc: 'tangyuan-hid', proto: 1, transport: 'app', app: 'tangyuan-bridge',
        id: '68:EE:8F:4E:EE:D5', name: 'Tangyuan HID N', fw: 'bridge-1.1.0',
        mac: '68:EE:8F:4E:EE:D5', ip: '127.0.0.1', port: PORT, ble: BLE, auth: false, rssi: -40, mtu: 255,
      });
    case '/status':
      return send({ ok: true, t: 'bridge_status', state: BLE ? 'ready' : 'connecting', detail: 'fake', ready: BLE });
    case '/screen': {
      const w = Number(url.searchParams.get('w') || 0);
      const h = Number(url.searchParams.get('h') || 0);
      if (w > 0 && h > 0) {
        screen = { known: true, w, h, rot: Number(url.searchParams.get('rot') || 0) };
        return send({ ok: true, t: 'screen', ble: BLE, tip: false, need_screen: false });
      }
      return send({ ok: true, ...screen, pw: Math.min(screen.w, screen.h), ph: Math.max(screen.w, screen.h), den: Math.max(screen.w, screen.h) });
    }
    case '/scan':
      return send({ ok: true, devices: [{ name: 'Tangyuan HID N', mac: '68:EE:8F:4E:EE:D5', bonded: true }] });
    case '/reconnect':
      return send({ ok: true, t: 'reconnect', state: 'connecting' });
    case '/cmd': {
      if (!BLE) return send({ ok: false, err: 'ble_not_ready' }, 503);
      const j = JSON.parse(url.searchParams.get('j') || '{}');
      return send({ ok: true, t: j.t, ble: true, tip: false, need_screen: !screen.known });
    }
    default:
      return send({ ok: false, err: 'not_found' }, 404);
  }
});

server.listen(PORT, '127.0.0.1', () => log(`fake bridge on http://127.0.0.1:${PORT} ble=${BLE}`));
