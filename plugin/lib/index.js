// dsh-esp32-hid —— 让 DSH 直接驱动手机（ESP32-S3 当键鼠）
//
// 为什么需要它：DSH 的原生手机操作走无障碍/ADB 权限，遇到系统弹窗、安全键盘、
// 别家 App 的自绘界面、或无障碍被关掉时就够不着了。ESP32 在系统看来是真实的
// 蓝牙键盘/鼠标，绕开这些限制。
//
// 通道（自动挑能通的那条，顺序即优先级）：
//   · App 桥 —— 独立 App「汤圆蓝牙桥」前台服务替你握住 BLE GATT，插件只打 127.0.0.1:8893（推荐）
//   · OTG   —— 手机 Termux 里 `sh start_otg.sh` 起的 hidlink 服务（127.0.0.1:8892，老方案）
//   · 无线  —— ESP32 自己的 HTTP 服务（DSH_ESP32_URL 指定，或 UDP whois 发现）
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { probe, send, screenInfo, screenSet, a11yInfo, lastA11y, discover, screenshot, a11yTree } from './client.js';
import { statusView, actionView, panelView } from './view.js';

export const name = 'dsh-esp32-hid';
export const inject = ['tools'];

const CARD_MAX_BYTES = 8 * 1024;

/**
 * 把一个「当前屏幕像素」点换算成固件要的归一化坐标。
 * 拿不到屏幕信息时退回面板像素（老固件行为）。
 */
export function point(a, kx, ky, info) {
  // 调用方直接给归一化值时优先用它
  const ku = kx.replace(/^x/, 'u'), kv = ky.replace(/^y/, 'v');
  if (Number.isFinite(a[ku]) && Number.isFinite(a[kv])) return { u: a[ku], v: a[kv] };

  // u/v 是**当前显示方向**的相对坐标：u = x / 显示宽，v = y / 显示高。
  // （固件内部再乘 long-edge 量程转成 HID 逻辑值，那一步在固件里做，外面不要提前按长边归一化
  //   —— 之前统一除长边，竖屏时横向整体偏左 2.17 倍，实测点 x=270 落到 124。）
  const w = Number(info?.w) > 1 ? Number(info.w) : Number(info?.den) || 0;
  const h = Number(info?.h) > 1 ? Number(info.h) : Number(info?.den) || 0;
  if (w > 1 && h > 1) {
    const clamp01 = (n) => Math.min(1, Math.max(0, n));
    return {
      u: Number(clamp01(a[kx] / w).toFixed(6)),
      v: Number(clamp01(a[ky] / h).toFixed(6)),
    };
  }
  return { x: Math.round(a[kx]), y: Math.round(a[ky]) };
}

function toolCard(build) {
  return (args, value) => {
    try {
      const text = JSON.stringify(build(args, value));
      if (text === undefined || Buffer.byteLength(text, 'utf8') > CARD_MAX_BYTES) return {};
      return { 'dsh-go/view': JSON.parse(text) };
    } catch {
      return {};
    }
  };
}

let lastAction = null;
let lastStatus = null;

const okSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    t: { type: 'string' },
  },
  // JSON Schema 要求 required 是数组、放在对象层；写成属性里的 required:true 会让插件加载时抛错
  required: ['ok'],
};

function actionTool({ name: toolName, description, parameters, build, view }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: okSchema,
      render: (args, value) =>
        value.ok
          ? [{ type: 'text', text: `已执行 ${value.t ?? toolName}${value.detail ? `：${value.detail}` : ''}` }]
          : [{ type: 'text', text: `失败：${value.detail ?? '未知原因'}` }],
      presentationMeta: toolCard((args, value) => view(args, value)),
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false, // HID 报告必须串行
    async execute(args, exec) {
      let info = null;
      let rescaled = '';
      try {
        info = await screenInfo({ signal: exec?.signal });
      } catch {
        info = null; // 拿不到就按面板像素发，别让动作直接失败
      }
      // 调用方在参数里直接带 w/h（来自刚截的图）最省事，优先级最高
      const eff =
        Number(args.w) > 1 && Number(args.h) > 1
          ? { w: Number(args.w), h: Number(args.h), den: Math.max(Number(args.w), Number(args.h)) }
          : info;
      // 手机分辨率/方向可能变（智能分辨率、横竖屏切换），固件里的登记会过期。
      // 一旦和调用方给的不一致就立刻重新登记，否则 u/v 会按旧面板换算，整屏偏移。
      if (
        eff && Number(eff.w) > 1 && Number(eff.h) > 1 &&
        (!info || Number(info.w) !== Number(eff.w) || Number(info.h) !== Number(eff.h))
      ) {
        const rot = Number.isInteger(args.rot)
          ? Number(args.rot) & 3
          : (Number(eff.w) > Number(eff.h) ? 3 : 0); // 横屏默认 270°（唯一能全屏覆盖的）
        try {
          await screenSet({ w: Number(eff.w), h: Number(eff.h), rot, signal: exec?.signal });
          // P2：把「按新分辨率重新登记」这件事显式回给模型——
          // 静默改掉换算基准，出了问题会以为是模型点歪了。
          rescaled = `${info ? `${info.w}x${info.h}` : '未登记'} → ${eff.w}x${eff.h}`;
        } catch {
          /* 登记失败就让动作自己失败，别在这里吞掉 */
        }
      }
      const payload = build(args, eff);
      const isTouch = payload.t === 'tap' || payload.t === 'long' || payload.t === 'swipe';
      // rescaled 在下面的登记分支里可能被赋值，统一在返回时拼进去
      let res = null;
      let err = '';
      try {
        res = await send(payload, { signal: exec?.signal });
      } catch (e) {
        err = String(e?.message ?? e);
      }
      // 显式补抬起：绝不靠时序自己收尾。
      // 丢一个 UP 就会在手机上留下「幽灵手指」，之后所有点击/手势全部失效，
      // 只能锁屏解锁才救得回来 —— 所以只要有一点可疑就再补一条 up。
      let released = null;
      if (isTouch && (err || res?.tip === true)) {
        try {
          const up = await send({ t: 'up' }, { signal: exec?.signal });
          released = up?.tip === false;
        } catch {
          released = false;
        }
        // 抬起后必须再"出界"：只发 tip=0 而 InRange 仍是 1 时，Android 认为笔一直悬在
        // 屏上（isHovering=true），手指触摸全被压制 —— 用户看到的是「整屏点不动」。
        // 老固件（<0.3.3）没有 leave，失败忽略即可。
        try {
          await send({ t: 'leave' }, { signal: exec?.signal });
        } catch {
          /* ignore */
        }
      }
      if (err) {
        return { ok: false, t: payload.t, detail: released === false ? `${err}（抬起也失败了，请调 esp32_release）` : err };
      }
      lastAction = `${payload.t} ${payload.u !== undefined ? `${payload.u},${payload.v}` : `${payload.x},${payload.y}`}`.trim();
      const hint = [
        res.need_screen === true ? '屏幕未登记：请带 w/h 再调，或先跑 esp32_sync' : '',
        rescaled ? `已按截图重新登记 ${rescaled}` : '',
      ].filter(Boolean).join(' | ');
      return {
        ok: res.ok !== false,
        t: payload.t,
        detail: `${res.err ?? ''}${released === false ? ' | 警告：抬起未确认，请调 esp32_release' : ''}${hint ? ` | ${hint}` : ''}`.trim(),
      };
    },
  };
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'esp32_status',
      description:
        'Check the ESP32 HID bridge: which transport is reachable (USB-OTG via the local bridge, or Wi-Fi) and whether the Bluetooth HID link to the phone is connected. Call this first if phone actions are failing.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            transport: { type: 'string' },
            base: { type: 'string' },
            ble: { type: 'boolean' },
            info: { type: 'string' },
            tried: { type: 'array', items: { type: 'string' } },
          },
          required: ['transport'],
        },
        render: (_a, v) =>
          v.transport === '未连接'
            ? [{ type: 'text', text: `ESP32 未连接。试过：${(v.tried ?? []).join(' | ')}` }]
            : [{
                type: 'text',
                text: `ESP32 通道 ${v.transport}（${v.base}），蓝牙 HID ${v.ble ? '已连接' : '未连接'}，屏幕 ${v.screen ?? '?'}。${v.info ?? ''}${v.hint ? `\n${v.hint}` : ''}`,
              }],
        presentationMeta: toolCard((_a, v) => statusView(v)),
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const p = await probe({ signal: exec?.signal });
        if (!p.ok) {
          const out = { transport: '未连接', tried: p.tried.map((t) => `${t.base} → ${t.error}`) };
          lastStatus = out;
          return out;
        }
        // /health 不含 ble 字段（老固件只有 /cmd 回包才带），所以再发一次 ping 确认链路。
        let ble = typeof p.ble === 'boolean' ? p.ble : p.health?.ble;
        let info = String(p.health?.info ?? '');
        if (ble === undefined) {
          try {
            const ping = await send({ t: 'ping' }, { signal: exec?.signal });
            if (typeof ping?.ble === 'boolean') ble = ping.ble;
            if (ping?.info) info = String(ping.info);
          } catch {
            ble = false;
          }
        }
        // 通道类型由传输层报上来（App 桥 / OTG / 无线），不再按地址猜：
        // 从树莓派打局域网 IP 时链路照样可能是 OTG，App 桥用的也是 127.0.0.1。
        const KIND_LABEL = { app: 'App桥', otg: 'OTG', wifi: '无线' };
        const transport = KIND_LABEL[p.kind] ?? (/VID=[0-9a-f]{4}/i.test(info) ? 'OTG' : '无线');
        const out = {
          transport,
          base: p.base,
          kind: p.kind ?? null,
          ble: ble === true,
          info,
        };
        if (p.device) {
          out.id = p.device.id;
          out.fw = p.device.fw;
          out.name = p.device.name;
        }
        out.a11y = lastA11y
          ? (lastA11y.known === false ? 'unknown' : lastA11y.ours_enabled ? 'on' : 'off')
          : 'unknown';

        // ---- P4：自检。把「有没有幽灵手指」「屏幕登记了没」直接摊开 ----
        let tip = null;
        let needScreen = null;
        try {
          const ping = await send({ t: 'ping' }, { signal: exec?.signal });
          if (typeof ping?.tip === 'boolean') tip = ping.tip;
          if (typeof ping?.need_screen === 'boolean') needScreen = ping.need_screen;
        } catch {
          /* 链路问题上面已经暴露过，这里不重复报 */
        }
        let scr = null;
        try { scr = await screenInfo({ signal: exec?.signal, force: true }); } catch { scr = null; }

        const hint = [];
        if (ble === false) {
          hint.push(
            p.kind === 'app'
              ? 'App 桥在线，但它到 ESP32 的蓝牙还没连上 → 手机「设置 › 蓝牙」里把 Tangyuan HID N 连接一次（App 会自动重连）'
              : 'ESP32 在线，但蓝牙 HID 没连上这台手机 → 手机蓝牙里把 Tangyuan HID N 连上',
          );
        }
        if (tip === true) hint.push('⚠️ 固件报告手指仍按着（幽灵手指）→ 先调 esp32_release，否则所有手势失效');
        if (needScreen === true) hint.push('屏幕未登记 → 调 esp32_sync(w,h) 或下次动作带 w/h');
        if (scr && scr.known === false) hint.push('固件没有屏幕参数，坐标必然偏移');
        out.tip = tip;
        out.need_screen = needScreen;
        out.screen = scr && scr.known !== false ? `${scr.w}x${scr.h} rot=${scr.rot ?? 0}` : 'unknown';
        out.hint = hint.join('；');
        lastStatus = out;
        return out;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'esp32_scan',
      description:
        'Scan the local network for ESP32 HID bridges: broadcast a UDP whois on port 8890 and keep every device that answers with svc="tangyuan-hid". Identification is by protocol handshake, NOT by MAC or fixed IP, so any board running this firmware is found. Returns id, name, ip, firmware version, whether its Bluetooth link is up, and whether it requires a token. Run this when esp32_status says it cannot connect.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            count: { type: 'integer' },
            devices: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['count'],
        },
        render: (_a, v) =>
          v.count === 0
            ? [{ type: 'text', text: '局域网里没扫到 ESP32（确认它已连上同一个 Wi-Fi，且固件是 0.3.0-wifi 以上）' }]
            : [
                {
                  type: 'text',
                  text: `扫到 ${v.count} 台：` + v.devices.map((d) => `${d.id} @ ${d.ip}（${d.fw}${d.ble ? '，蓝牙在线' : ''}）`).join('；'),
                },
              ],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute() {
        const list = await discover({ force: true });
        return {
          count: list.length,
          devices: list.map((d) => ({
            id: d.id, name: d.name, ip: d.ip, port: d.port,
            fw: d.fw, ble: d.ble, auth: d.auth, rssi: d.rssi,
          })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'esp32_screen',
      description:
        'Report the phone screen geometry the bridge detected: current logical resolution, native panel size, rotation and digitizer range. Use it when taps land in the wrong place, after rotating the phone, or to confirm the plugin is adapting to this device.',
      parameters: {
        w: { type: 'integer', description: 'Logical screen width in pixels of the CURRENT orientation (take it from the screenshot you just captured). Pass together with h to register/refresh.' },
        h: { type: 'integer', description: 'Logical screen height in pixels of the CURRENT orientation.' },
        rot: { type: 'integer', description: 'Rotation: 0/1/2/3 = 0/90/180/270 degrees. Default 0.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            known: { type: 'boolean' },
            w: { type: 'number' },
            h: { type: 'number' },
            pw: { type: 'number' },
            ph: { type: 'number' },
            rot: { type: 'number' },
            den: { type: 'number' },
            detail: { type: 'string' },
          },
        },
        render: (_a, v) =>
          v.known === false
            ? [{ type: 'text', text: '屏幕参数还没登记：先带 w/h 调一次，或动作工具改用归一化 u,v' }]
            : [{ type: 'text', text: `屏幕 ${v.w}x${v.h}（面板 ${v.pw}x${v.ph}，旋转 ${(v.rot ?? 0) * 90}°，量程 ${v.den}）` }],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        // 带 w/h 就是「登记」：桥跑在 Termux（无特权 App），读不到 wm size，
        // 尺寸必须由调用方提供（通常来自刚截的图）。
        const i = args.w && args.h
          ? await screenSet({ w: args.w, h: args.h, rot: args.rot ?? 0, signal: exec?.signal })
          : await screenInfo({ signal: exec?.signal, force: true });
        return {
          known: i.known !== false,
          w: i.w ?? 0, h: i.h ?? 0, pw: i.pw ?? 0, ph: i.ph ?? 0,
          rot: i.rot ?? 0, den: i.den ?? 0,
          detail: i.known === false ? '未登记' : '',
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'esp32_a11y',
      description:
        "Check whether DSH's own accessibility service (PhoneA11yService) is enabled, and optionally turn it on. The plugin already does this automatically when the dedicated ESP32 bridge is detected; call it manually when phone control has stopped working, or after the app was reinstalled. If Android refuses the silent write, the accessibility settings page is opened for the user to confirm.",
      parameters: {
        enable: { type: 'boolean', description: 'true = try to enable it; omit/false = just report the state.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            ours_enabled: { type: 'boolean' },
            system_enabled: { type: 'boolean' },
            need_user: { type: 'boolean' },
            detail: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_a, v) => [{ type: 'text', text: v.detail ?? '' }],
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const i = await a11yInfo({ enable: Boolean(args.enable), signal: exec?.signal });
        const detail = i.need_user
          ? '系统不允许静默开启，已打开无障碍设置页：请打开 DSH 的开关'
          : i.ours_enabled
            ? '无障碍已开启'
            : '无障碍未开启（需要开启后才能用 DSH 原生手机操控）';
        return {
          ok: i.ok !== false,
          ours_enabled: Boolean(i.ours_enabled),
          system_enabled: Boolean(i.system_enabled),
          need_user: Boolean(i.need_user),
          detail,
        };
      },
    }),
  );


  // ---- 网格瞄准：把「截图 + 套格子」的精度方法固化成一个工具 ----
  // 模型直接估绝对像素误差常达几十像素（小图标必翻车）；改成「先报格子号、
  // 再报格内比例」，由插件换算精确像素，误差=格内比例误差×(格宽)，可控 5 倍以上。
  ctx.tools.register(
    defineTool({
      name: 'esp32_aim',
      description:
        'Aim by grid, then tap. Take a screenshot first, imagine a cols×rows grid over it (default 10×20), and report ONLY which cell contains the target plus where inside that cell (fx,fy 0..1). The plugin converts it to exact pixels — far more accurate than estimating absolute coordinates by eye, especially for small icons and dense lists. Use dry_run:true first to see the exact pixel it would hit.',
      parameters: {
        w: { type: 'integer', required: true, description: 'Width in px of the screenshot you are looking at.' },
        h: { type: 'integer', required: true, description: 'Height in px of that screenshot.' },
        col: { type: 'integer', required: true, description: 'Grid column index, 0-based, left to right.' },
        row: { type: 'integer', required: true, description: 'Grid row index, 0-based, top to bottom.' },
        fx: { type: 'number', description: 'Horizontal fraction inside the cell, 0..1 (default 0.5 = centered).' },
        fy: { type: 'number', description: 'Vertical fraction inside the cell, 0..1 (default 0.5 = centered).' },
        cols: { type: 'integer', description: 'Number of grid columns, default 10.' },
        rows: { type: 'integer', description: 'Number of grid rows, default 20.' },
        dry_run: { type: 'boolean', description: 'true = only compute and report the pixel, do not tap.' },
        x1: { type: 'integer', description: 'OPTIONAL coarse-to-fine: left of the sub-region the grid applies to (screenshot px). Use this after a first coarse look to zoom the grid into just that area.' },
        y1: { type: 'integer', description: 'OPTIONAL: top of that sub-region.' },
        x2: { type: 'integer', description: 'OPTIONAL: right of that sub-region.' },
        y2: { type: 'integer', description: 'OPTIONAL: bottom of that sub-region.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            cell: { type: 'string' },
            detail: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, v) =>
          v.ok
            ? [{ type: 'text', text: `${v.detail ?? ''} → (${v.x}, ${v.y})` }]
            : [{ type: 'text', text: `失败：${v.detail ?? '未知原因'}` }],
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const w = Number(args.w), h = Number(args.h);
        const cols = Math.max(1, Number(args.cols ?? 10));
        const rows = Math.max(1, Number(args.rows ?? 20));
        const col = Number(args.col), row = Number(args.row);
        if (!(w > 1 && h > 1)) return { ok: false, detail: '需要截图宽高 w/h' };
        if (!(col >= 0 && col < cols)) return { ok: false, detail: `col 需在 0..${cols - 1}` };
        if (!(row >= 0 && row < rows)) return { ok: false, detail: `row 需在 0..${rows - 1}` };
        const fx = Math.min(0.999, Math.max(0, Number(args.fx ?? 0.5)));
        const fy = Math.min(0.999, Math.max(0, Number(args.fy ?? 0.5)));
        // 由粗到细：给了区域就把网格套进这个框里（二次定位），否则铺满整屏
        let RX1 = 0, RY1 = 0, RX2 = w, RY2 = h;
        if ([args.x1, args.y1, args.x2, args.y2].every((v) => Number.isFinite(Number(v)))) {
          RX1 = Math.max(0, Math.min(w, Number(args.x1)));
          RY1 = Math.max(0, Math.min(h, Number(args.y1)));
          RX2 = Math.max(0, Math.min(w, Number(args.x2)));
          RY2 = Math.max(0, Math.min(h, Number(args.y2)));
          if (RX2 < RX1) [RX1, RX2] = [RX2, RX1];
          if (RY2 < RY1) [RY1, RY2] = [RY2, RY1];
        }
        const RW = Math.max(1, RX2 - RX1);
        const RH = Math.max(1, RY2 - RY1);
        const x = Math.max(0, Math.min(w - 1, Math.round(RX1 + ((col + fx) * RW) / cols)));
        const y = Math.max(0, Math.min(h - 1, Math.round(RY1 + ((row + fy) * RH) / rows)));
        const inRegion = RW !== w || RH !== h;
        const cell = `R${row}C${col}@${fx.toFixed(2)},${fy.toFixed(2)}${inRegion ? ` in [${RX1},${RY1}]-[${RX2},${RY2}]` : ''}`;
        if (args.dry_run) return { ok: true, x, y, cell, detail: `预演（未点击）${cell}` };
        try {
          // 登记 + 点击走与 esp32_tap 完全相同的路径，保证换算一致
          await screenSet({ w, h, rot: w > h ? 3 : 0, signal: exec?.signal }).catch(() => {});
          const res = await send({ t: 'tap', u: x / w, v: y / h, w, h }, { signal: exec?.signal });
          if (res?.tip === true) {
            try { await send({ t: 'up' }, { signal: exec?.signal }); } catch { /* 尽力而为 */ }
          }
          return {
            ok: res.ok !== false,
            x, y, cell,
            detail: res.ok === false ? (res.err ?? '点击失败') : `已点击 ${cell}`,
          };
        } catch (e) {
          try { await send({ t: 'up' }, { signal: exec?.signal }); } catch { /* ignore */ }
          return { ok: false, x, y, cell, detail: String(e?.message ?? e) };
        }
      },
    }),
  );


  // ---- 屏幕同步：固件每次上电都标 need_screen，必须现场推真实分辨率 ----

  // ---- P1：给包围盒，代码算中心点 ----
  // 研究结论：VLM 输出「框」比输出「精确点」稳得多（框只要圈住目标，点要求像素级）。
  // 所以让模型只报它看到的目标矩形，中心/内部分位由代码算，误差不再放大。
  ctx.tools.register(
    defineTool({
      name: 'esp32_tap_box',
      description:
        'Tap inside a bounding box you can see in the screenshot. Models localise a BOX far more reliably than an exact pixel, so report the target rect (x1,y1)-(x2,y2) in screenshot pixels and let the plugin tap its centre (or a fractional point inside it). Best for small icons, checkboxes, list rows and dense toolbars. Prefer this over esp32_tap when you can see the element edges.',
      parameters: {
        x1: { type: 'integer', required: true, description: 'Left edge of the target box, screenshot px.' },
        y1: { type: 'integer', required: true, description: 'Top edge of the box.' },
        x2: { type: 'integer', required: true, description: 'Right edge of the box.' },
        y2: { type: 'integer', required: true, description: 'Bottom edge of the box.' },
        w: { type: 'integer', required: true, description: 'Width of the screenshot you measured on.' },
        h: { type: 'integer', required: true, description: 'Height of that screenshot.' },
        fx: { type: 'number', description: 'Horizontal position inside the box, 0..1, default 0.5 (centre).' },
        fy: { type: 'number', description: 'Vertical position inside the box, 0..1, default 0.5.' },
        dry_run: { type: 'boolean', description: 'true = only compute the point, do not tap.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: true,
          properties: {
            ok: { type: 'boolean' }, x: { type: 'integer' }, y: { type: 'integer' },
            box: { type: 'string' }, detail: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (a, v) => (v.ok
          ? [{ type: 'text', text: `${v.detail ?? ''} → (${v.x}, ${v.y})` }]
          : [{ type: 'text', text: `失败：${v.detail ?? '未知原因'}` }]),
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const w = Number(args.w), h = Number(args.h);
        let x1 = Number(args.x1), y1 = Number(args.y1), x2 = Number(args.x2), y2 = Number(args.y2);
        if (!(w > 1 && h > 1)) return { ok: false, detail: '需要截图宽高 w/h' };
        if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) return { ok: false, detail: '需要完整的 x1/y1/x2/y2' };
        if (x2 < x1) [x1, x2] = [x2, x1];
        if (y2 < y1) [y1, y2] = [y2, y1];
        const fx = Math.min(0.99, Math.max(0.01, Number(args.fx ?? 0.5)));
        const fy = Math.min(0.99, Math.max(0.01, Number(args.fy ?? 0.5)));
        const x = Math.max(0, Math.min(w - 1, Math.round(x1 + (x2 - x1) * fx)));
        const y = Math.max(0, Math.min(h - 1, Math.round(y1 + (y2 - y1) * fy)));
        const box = `[${x1},${y1}]-[${x2},${y2}]`;
        if (args.dry_run) return { ok: true, x, y, box, detail: `预演（未点击）${box}` };
        try {
          await screenSet({ w, h, rot: w > h ? 3 : 0, signal: exec?.signal }).catch(() => {});
          const res = await send({ t: 'tap', u: x / w, v: y / h, w, h }, { signal: exec?.signal });
          if (res?.tip === true) { try { await send({ t: 'up' }, { signal: exec?.signal }); } catch { /* 尽力 */ } }
          return { ok: res.ok !== false, x, y, box, detail: res.ok === false ? (res.err ?? '点击失败') : `已点击 ${box}` };
        } catch (e) {
          try { await send({ t: 'up' }, { signal: exec?.signal }); } catch { /* ignore */ }
          return { ok: false, x, y, box, detail: String(e?.message ?? e) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'esp32_sync',
      description:
        'Register the CURRENT screen size with the bridge. The firmware flags need_screen on every power-up because the size it remembers may belong to a different phone or a stale resolution — trusting it shifts every tap. Call this once per session (or whenever a screenshot size changes), passing the width/height of the screenshot you are working with. Actions that pass w/h sync automatically, so this is for explicit re-sync and diagnostics.',
      parameters: {
        w: { type: 'integer', required: true, description: 'Real screen width in px (from a screenshot).' },
        h: { type: 'integer', required: true, description: 'Real screen height in px (from that screenshot).' },
        rot: { type: 'integer', description: 'Rotation 0..3; omit to infer from w>h (landscape = 3).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            w: { type: 'integer' },
            h: { type: 'integer' },
            rot: { type: 'integer' },
            need_screen: { type: 'boolean' },
            detail: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, v) =>
          v.ok
            ? [{ type: 'text', text: `屏幕已同步 ${v.w}x${v.h} rot=${v.rot}${v.need_screen ? '（固件仍报未同步，检查链路）' : ''}` }]
            : [{ type: 'text', text: `同步失败：${v.detail ?? '未知原因'}` }],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const w = Number(args.w), h = Number(args.h);
        if (!(w > 1 && h > 1)) return { ok: false, detail: '需要真实宽高 w/h' };
        const rot = Number.isInteger(args.rot) ? Number(args.rot) & 3 : (w > h ? 3 : 0);
        try {
          await screenSet({ w, h, rot, signal: exec?.signal });
          // 直接问固件要真值（桥的 /screen 只是它自己的缓存，不带 need_screen）
          const res = await send({ t: 'screen' }, { signal: exec?.signal });
          return {
            ok: res.ok !== false,
            w, h, rot,
            need_screen: res.need_screen === true,
            detail: res.err ?? '',
          };
        } catch (e) {
          return { ok: false, detail: String(e?.message ?? e) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'esp32_release',
      description:
        'Force-release a stuck touch AND park the pen out of range (leave hover). Call it whenever the phone stops reacting to taps/swipes — including when taps by FINGER stop working: a DOWN report without its UP, or a stylus left hovering (InRange=1), makes Android suppress all touch input until the HID device is re-registered. Cheap and harmless: sends tip-up then an out-of-range report.',
      parameters: {},
      output: {
        schema: okSchema,
        render: (args, value) =>
          value.ok
            ? [{ type: 'text', text: `已释放触摸并出界${value.detail ? `：${value.detail}` : ''}` }]
            : [{ type: 'text', text: `释放失败：${value.detail ?? '未知原因'}` }],
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const res = await send({ t: 'up' }, { signal: exec?.signal });
          // 关键第二步：把笔移出悬停范围。
          // 只发 tip=0 而 InRange 仍为 1 时，Android 认为笔一直悬在屏上（isHovering=true），
          // 手指触摸会被压制 → 用户看到「整屏点不动」。老固件没有 leave，失败就算了。
          let left = null;
          try {
            const lv = await send({ t: 'leave' }, { signal: exec?.signal });
            left = lv?.ok !== false;
          } catch {
            left = false;
          }
          return {
            ok: res.ok !== false && res.tip !== true,
            t: 'up',
            detail:
              res.tip === true
                ? '固件仍报告按着（可能 BLE 断了，需重新配对）'
                : left === false
                  ? '已抬起，但固件不支持 leave（<0.3.3）——手指若仍失灵，关开蓝牙重新配对'
                  : '已抬起并出界，状态干净',
          };
        } catch (e) {
          return { ok: false, t: 'up', detail: String(e?.message ?? e) };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool(
      actionTool({
        name: 'esp32_tap',
        description:
          'Tap a screen coordinate using the ESP32 Bluetooth touch device. Coordinates are pixels in the CURRENT screen (the screenshot you just took) — resolution and landscape/portrait are adapted automatically. Use when DSH native phone control cannot reach the target (system dialogs, secure keyboards, custom-drawn UIs).',
        parameters: {
          x: { type: 'integer', required: true, description: 'X in pixels of the current screenshot.' },
          y: { type: 'integer', required: true, description: 'Y in pixels of the current screenshot.' },
          w: { type: 'integer', description: 'OPTIONAL: logical width in px of the screenshot you are aiming at. Pass it (with h) whenever you have a screenshot — then x/y need no registration step.' },
          h: { type: 'integer', description: 'OPTIONAL: logical height in px of that screenshot.' },
        },
        build: (a, info) => ({ t: 'tap', ...point(a, 'x', 'y', info) }),
        view: actionView,
      }),
    ),
  );

  ctx.tools.register(
    defineTool(
      actionTool({
        name: 'esp32_swipe',
        description: 'Swipe/drag between two points (pixels in the CURRENT screen; orientation and resolution are adapted automatically). Good for scrolling lists and opening drawers.',
        parameters: {
          x1: { type: 'integer', required: true, description: 'Start X in screenshot pixels.' },
          y1: { type: 'integer', required: true, description: 'Start Y in screenshot pixels.' },
          x2: { type: 'integer', required: true, description: 'End X in screenshot pixels.' },
          y2: { type: 'integer', required: true, description: 'End Y in screenshot pixels.' },
          w: { type: 'integer', description: 'OPTIONAL: logical width in px of the screenshot you are aiming at. Pass it (with h) whenever you have a screenshot — then x/y need no registration step.' },
          h: { type: 'integer', description: 'OPTIONAL: logical height in px of that screenshot.' },
          ms: { type: 'integer', description: 'Duration in ms, default 300.' },
        },
        build: (a, info) => {
          const p1 = point(a, 'x1', 'y1', info);
          const p2 = point(a, 'x2', 'y2', info);
          const xy = p1.u !== undefined
            ? { u1: p1.u, v1: p1.v, u2: p2.u, v2: p2.v }
            : { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
          return { t: 'swipe', ...xy, ms: Math.round(a.ms ?? 300) };
        },
        view: actionView,
      }),
    ),
  );

  ctx.tools.register(
    defineTool(
      actionTool({
        name: 'esp32_long',
        description: 'Long-press a coordinate (pixels in the CURRENT screen, adapted automatically; default 900ms). Useful for context menus and selecting items.',
        parameters: {
          x: { type: 'integer', required: true, description: 'X in screenshot pixels.' },
          y: { type: 'integer', required: true, description: 'Y in screenshot pixels.' },
          ms: { type: 'integer', description: 'Hold duration in ms, default 900.' },
          w: { type: 'integer', description: 'OPTIONAL: logical width in px of the screenshot you are aiming at. Pass it (with h) whenever you have a screenshot — then x/y need no registration step.' },
          h: { type: 'integer', description: 'OPTIONAL: logical height in px of that screenshot.' },
        },
        build: (a, info) => ({ t: 'long', ...point(a, 'x', 'y', info), ms: Math.round(a.ms ?? 900) }),
        view: actionView,
      }),
    ),
  );

  ctx.tools.register(
    defineTool(
      actionTool({
        name: 'esp32_text',
        description:
          'Type text with the real Bluetooth keyboard. ASCII only (letters, digits, common punctuation) — the bridge rejects other characters. Use DSH native input for Chinese.',
        parameters: {
          s: { type: 'string', required: true, description: 'ASCII text to type.' },
        },
        build: (a) => ({ t: 'text', s: String(a.s ?? '') }),
        view: actionView,
      }),
    ),
  );

  ctx.tools.register(
    defineTool(
      actionTool({
        name: 'esp32_key',
        description:
          'Press a physical key with optional modifiers, e.g. k="enter", mods="ctrl". Use esp32_akey for system keys like home/back.',
        parameters: {
          k: { type: 'string', required: true, description: 'Key name: enter, esc, tab, space, backspace, up, down, left, right, or a single character.' },
          mods: { type: 'string', description: 'Modifiers: ctrl, shift, alt, gui (combinable with +).' },
        },
        build: (a) => ({ t: 'key', k: String(a.k ?? ''), mods: String(a.mods ?? '') }),
        view: actionView,
      }),
    ),
  );

  ctx.tools.register(
    defineTool(
      actionTool({
        name: 'esp32_akey',
        description:
          'Press an Android system key through the HID consumer-control channel: home, back, forward, search, menu, volup, voldown, mute, playpause, next, prev, wakeup, sleep, power. Back/home work even where DSH native control is blocked.',
        parameters: {
          k: {
            type: 'string',
            required: true,
            enum: ['home', 'back', 'forward', 'search', 'menu', 'volup', 'voldown', 'mute', 'playpause', 'next', 'prev', 'wakeup', 'sleep', 'power'],
            description: 'System key name.',
          },
        },
        build: (a) => ({ t: 'akey', k: String(a.k ?? '') }),
        view: actionView,
      }),
    ),
  );

  // ---- 感知：截图。让模型真的「看见」屏幕，而不是凭 a11y 猜 ----
  ctx.tools.register(
    defineTool({
      name: 'esp32_shot',
      description:
        "Capture the phone screen as JPEG through the bridge's accessibility service and save it in the workspace. Returns an absolute path: open that file with your image-reading tool to actually SEE the current screen. Take one before choosing tap coordinates and one after acting to verify the result.",
      parameters: {
        quality: { type: 'number', description: 'JPEG quality 20-95 (default 70). Lower = smaller file.' },
        tag: { type: 'string', description: 'Optional short label added to the file name, e.g. "settings".' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            bytes: { type: 'number' },
            detail: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_a, v) => [{ type: 'text', text: v.detail ?? '' }],
      },
      timeoutMs: 25000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const { buffer } = await screenshot({ quality: args.quality ?? 70, signal: exec?.signal });
          const dir = join(resolve(process.env.DSH_WORKSPACE || process.cwd()), '.esp32-shots');
          mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
          const tag = String(args.tag ?? '').replace(/[^\w.-]/g, '').slice(0, 24);
          const file = join(dir, `shot-${stamp}${tag ? '-' + tag : ''}.jpg`);
          writeFileSync(file, buffer);
          const kb = Math.round(buffer.length / 1024);
          return {
            ok: true,
            path: file,
            bytes: buffer.length,
            detail: `截图已保存：${file}（${kb} KB）。用读图工具打开这个文件就能看到当前屏幕。`,
          };
        } catch (e) {
          return { ok: false, detail: String(e?.message ?? e) };
        }
      },
    }),
  );

  // ---- 感知：控件树。给「语义坐标」，比从截图估像素准得多 ----
  ctx.tools.register(
    defineTool({
      name: 'esp32_ui',
      description:
        "Dump the foreground window's accessibility tree through the bridge: one line per node with text, class, screen bounds and its center, plus clickable/editable flags. Much more precise and cheaper than guessing pixels from a screenshot: pick the node you want, then tap its center with esp32_tap (or esp32_tap_box using the box). Falls back with a readable error on the lock screen or apps that block accessibility.",
      parameters: {
        max: { type: 'number', description: 'Max nodes to return (default 300, max 1500).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            pkg: { type: 'string' },
            count: { type: 'number' },
            detail: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_a, v) => [{ type: 'text', text: v.detail ?? '' }],
      },
      timeoutMs: 20000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const d = await a11yTree({ max: args.max ?? 300, signal: exec?.signal });
          if (d.ok === false) {
            return { ok: false, detail: `读不到控件树：${d.detail ?? d.err ?? '未知原因'}` };
          }
          const lines = [];
          for (const n of d.nodes ?? []) {
            const b = n.b ?? [];
            const cx = Math.round((b[0] + b[2]) / 2);
            const cy = Math.round((b[1] + b[3]) / 2);
            const label = n.t || n.d ? `"${n.t || n.d}"` : '(无文字)';
            const flags = [n.clk ? 'click' : '', n.ed ? 'edit' : '', n.sc ? 'scroll' : '', n.chk !== undefined ? (n.chk ? 'checked' : 'unchecked') : ''].filter(Boolean).join(' ');
            lines.push(`[${lines.length}] ${n.c || 'View'} ${label} center=(${cx},${cy}) box=(${b.join(',')})${flags ? ' ' + flags : ''}`);
            if (lines.join('\n').length > 11000) { lines.push('…（截断，调小 max 或看更具体的区域）'); break; }
          }
          return {
            ok: true,
            pkg: d.pkg ?? '',
            count: d.count ?? lines.length,
            detail: `前台：${d.pkg ?? '?'}　共 ${d.count ?? lines.length} 个节点\n${lines.join('\n') || '（空）'}`,
          };
        } catch (e) {
          return { ok: false, detail: String(e?.message ?? e) };
        }
      },
    }),
  );

  // 原生面板（仅 dsh-go 有 dshGo 服务时出现）
  ctx.inject(['dshGo'], (goCtx) => {
    if (typeof goCtx.dshGo?.panel !== 'function') return;
    goCtx.dshGo.panel('status', {
      view: () => panelView({ status: { ...(lastStatus ?? {}), last: lastAction } }),
    });
  });
}
