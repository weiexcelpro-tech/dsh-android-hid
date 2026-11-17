// ESP32-S3 HID 桥的传输层。
//
// 三条通道，自动挑第一条通的（顺序即优先级）：
//   1. 独立 App 桥：TangyuanBridge 前台服务 → http://127.0.0.1:8893
//      手机上的 App 替我们握住 BLE GATT（proot 里拿不到蓝牙栈），
//      插件只打本机 HTTP —— 不需要 Termux，也不依赖 WiFi。
//   2. OTG：手机 Termux 里的 hidlink.py serve（http://127.0.0.1:8892，老方案）
//   3. 无线：ESP32 自己开的 HTTP 服务（http://<esp32-ip>:8892）
//
// 可用环境变量覆盖：DSH_ESP32_URL（逗号分隔，按顺序尝试，排在内置候选之前）
// 也可在插件设置里填 url。

import dgram from 'node:dgram';

// 设备身份靠**协议握手**，不锁 MAC / 不锁 IP：
// 只有回答 svc === 'tangyuan-hid' 的才算自己人，所以任何刷了这套固件的板子都能用。
export const SVC = 'tangyuan-hid';
export const DISCOVER_PORT = 8890;
const DISCOVER_TIMEOUT_MS = 1600;
const DISCOVER_CACHE_MS = 60000;

/** 通道种类：决定状态怎么报、错误怎么解释。 */
export const KIND = Object.freeze({ APP: 'app', OTG: 'otg', WIFI: 'wifi' });

const DEFAULT_CANDIDATES = [
  { url: 'http://127.0.0.1:8893', kind: KIND.APP }, // 独立 App（推荐）
  { url: 'http://127.0.0.1:8892', kind: KIND.OTG }, // Termux hidlink serve（老）
  { url: 'http://192.168.4.1', kind: KIND.WIFI }, // ESP32 自己当 AP 时的网关
];

/** 从 URL 猜通道种类（环境变量覆盖时用）。 */
export function kindOf(url) {
  const u = String(url);
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):8893\b/.test(u)) return KIND.APP;
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):8892\b/.test(u)) return KIND.OTG;
  return KIND.WIFI;
}

/**
 * 通道种类优先问对端：App 桥会在 /health 里报 transport=app。
 * 没报（老固件、任意端口）才按 URL 猜 —— 别把“端口号”当身份。
 */
export function kindFrom(health, url) {
  const t = health?.transport;
  if (t === KIND.APP || t === KIND.OTG || t === KIND.WIFI) return t;
  return kindOf(url);
}

const HEALTH_TIMEOUT_MS = 2500;
const CMD_TIMEOUT_MS = 12000;

function candidates() {
  const env = typeof process !== 'undefined' ? process.env?.DSH_ESP32_URL : undefined;
  const extra = env
    ? String(env)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((url) => ({ url, kind: kindOf(url) }))
    : [];
  return [...extra, ...DEFAULT_CANDIDATES];
}

// ---------------- UDP 广播发现 ----------------
let discoverCache = { at: 0, list: [] };

/**
 * 在同一网段广播 {"q":"whois"}，收集所有回答 svc='tangyuan-hid' 的 ESP32。
 * 不依赖 mDNS（很多路由器拦多播），也不依赖固定 IP。
 */
export async function discover({ timeoutMs = DISCOVER_TIMEOUT_MS, force = false } = {}) {
  const now = Date.now();
  if (!force && discoverCache.list.length && now - discoverCache.at < DISCOVER_CACHE_MS) {
    return discoverCache.list;
  }

  const found = new Map();
  const list = await new Promise((resolve) => {
    let sock;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      try { sock.close(); } catch { /* 已关 */ }
      resolve([...found.values()]);
    };
    sock.on('error', done);
    sock.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(String(msg));
        if (!j || j.svc !== SVC) return; // 不是我们的固件，直接忽略
        const key = j.id || `${rinfo.address}:${j.port ?? 8892}`;
        found.set(key, {
          id: j.id ?? key,
          name: j.name ?? '',
          fw: j.fw ?? '',
          ip: j.ip || rinfo.address,
          port: Number(j.port) || 8892,
          ble: Boolean(j.ble),
          auth: Boolean(j.auth),
          rssi: j.rssi ?? null,
        });
      } catch { /* 非 JSON，忽略 */ }
    });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* 某些环境不允许 */ }
      const probe = JSON.stringify({ q: 'whois', svc: SVC });
      // 连发三枪：ESP32 的 Wi-Fi 开了 modem sleep，单发很容易错过 DTIM 窗口（实测时灵时不灵）
      for (const delay of [0, 350, 700]) {
        setTimeout(() => {
          for (const t of ['255.255.255.255']) {
            try { sock.send(probe, DISCOVER_PORT, t); } catch { /* 忽略 */ }
          }
        }, delay);
      }
    });
    setTimeout(done, timeoutMs);
  });

  // 已连着 BLE 的优先（说明它正在给一台手机干活，多半就是这台）
  list.sort((a, b) => Number(b.ble) - Number(a.ble));
  discoverCache = { at: now, list };
  return list;
}

export function resetDiscover() {
  discoverCache = { at: 0, list: [] };
}

function withTimeout(ms, signal) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function getJson(url, ms, signal, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { signal: withTimeout(ms, signal) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`ESP32 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(`ESP32 HTTP ${res.status}: ${body?.err ?? ''}`);
  return body;
}

/** 缓存可用地址，避免每条命令都探测。 */
let cachedBase = null;

export function resetBase() {
  cachedBase = null;
}

/** /health 里有 ble 就取真值；老固件没这个字段时返回 null（未知 ≠ 未连接）。 */
function bleOf(h) {
  return typeof h?.ble === 'boolean' ? h.ble : null;
}

/** 屏幕信息缓存：桥会自己探测尺寸/旋转/量程，这里只做短缓存。 */
let screenCache = { at: 0, info: null };

export function resetScreen() {
  screenCache = { at: 0, info: null };
}

/**
 * 读桥里登记的屏幕参数：{known,w,h,pw,ph,rot,den}。
 * 注意：桥跑在 Termux 里，是无特权 App —— 它**读不到** wm size / dumpsys，
 * 所以这些值只能由调用方（插件/Agent，通常来自刚截的图）登记进来。
 */
export async function screenInfo({ signal, force = false } = {}) {
  const now = Date.now();
  if (!force && screenCache.info && now - screenCache.at < 3000) return screenCache.info;

  const p = await probe({ signal });
  if (!p.ok) throw new Error('连不上 ESP32 桥，拿不到屏幕信息');
  const info = await getJson(`${p.base}/screen`, 8000, signal);
  screenCache = { at: now, info };
  return info;
}

/**
 * 登记屏幕参数（像素 + 旋转）。插件拿到截图尺寸后调用一次，
 * 桥会持久化并推给固件，之后所有像素坐标都能正确换算。
 */
export async function screenSet({ w, h, rot = 0, signal } = {}) {
  const p = await probe({ signal });
  if (!p.ok) throw new Error('连不上 ESP32 桥，登记不了屏幕参数');
  const raw = await getJson(
    `${p.base}/screen?w=${Math.round(w)}&h=${Math.round(h)}&rot=${Math.round(rot) % 4}`,
    8000,
    signal,
  );
  // 固件的 /screen 只回 {ok,t:"screen"}（它只管收下参数），这里补全成完整状态，
  // 免得调用方拿到一堆 undefined。
  const ww = Math.round(w);
  const hh = Math.round(h);
  const info = raw?.known === undefined && raw?.ok !== false
    ? {
        ok: true, known: true, w: ww, h: hh, rot: Math.round(rot) % 4,
        pw: Math.min(ww, hh), ph: Math.max(ww, hh), den: Math.max(ww, hh), pushed: true,
      }
    : raw;
  screenCache = { at: Date.now(), info };
  return info;
}

/**
 * 找一条能通的通道；找不到返回 { ok:false, tried:[...] }。
 * 返回里带 kind（app/otg/wifi）和 ble（true/false/null），状态工具靠它们说人话。
 */
export async function probe({ signal, allowDiscover = !process.env.DSH_ESP32_NO_DISCOVER } = {}) {
  const onFound = (base, h, device = null) => {
    const kind = kindFrom(h, base);
    cachedBase = base;
    // 一接上就顺手确认无障碍是不是开着（只做一次，失败不重试）
    if (!a11yAttempted) {
      a11yAttempted = true;
      autoA11y(base).catch(() => {});
    }
    return { ok: true, base, kind, health: h, device, ble: bleOf(h) };
  };

  if (cachedBase) {
    try {
      const h = await getJson(`${cachedBase}/health`, HEALTH_TIMEOUT_MS, signal);
      return onFound(cachedBase, h);
    } catch {
      cachedBase = null;
    }
  }

  const tried = [];
  // 弱候选：能通、但不是我们这套固件答的（典型是 Termux 的 OTG 桥：板子没插时它仍会应答）
  let weak = null;
  // 是我们的固件，但蓝牙 HID 没连上 —— 先记着，实在没别的通道再用它（错误信息最准）
  let answered = null;

  for (const c of candidates()) {
    try {
      const h = await getJson(`${c.url}/health`, HEALTH_TIMEOUT_MS, signal);
      // 认固件：/health 一定带 svc（App 桥和 WiFi 直连都带）
      if (h && h.svc === SVC) {
        if (bleOf(h) === true) return onFound(c.url, h); // 能干活，立刻用
        if (!answered) answered = { base: c.url, h };
        tried.push({ base: c.url, error: 'ble not connected' });
        continue;
      }
      if (!weak) weak = { base: c.url, h, kind: c.kind };
      tried.push({ base: c.url, error: 'answered but svc mismatch (old OTG bridge?)' });
    } catch (e) {
      tried.push({ base: c.url, error: String(e?.message ?? e) });
    }
  }

  // 固定地址都不通 → 在局域网里扫一遍（不锁 IP、不锁 MAC）
  if (allowDiscover) {
    try {
      const list = await discover();
      for (const d of list) {
        const base = `http://${d.ip}:${d.port}`;
        try {
          const h = await getJson(`${base}/health`, HEALTH_TIMEOUT_MS, signal);
          if (bleOf(h) === true) return onFound(base, h, d);
          if (!answered) answered = { base, h };
          tried.push({ base: `${base} (scan: ${d.id})`, error: 'ble not connected' });
        } catch (e) {
          tried.push({ base: `${base} (scan: ${d.id})`, error: String(e?.message ?? e) });
        }
      }
      if (!list.length) tried.push({ base: '局域网扫描', error: '没有设备应答 whois 广播' });
    } catch (e) {
      tried.push({ base: '局域网扫描', error: String(e?.message ?? e) });
    }
  }

  // 有真固件应答（哪怕蓝牙没连）就先用它：报错能指到具体原因
  if (answered) return onFound(answered.base, answered.h);
  // 没有真固件应答时，退回 OTG 桥（它也能干活，只是状态字段来源不同）
  if (weak) return onFound(weak.base, weak.h);

  return { ok: false, tried };
}

/** 最近一次无障碍检查的结果，供面板/状态工具展示。 */
export let lastA11y = null;

let a11yAttempted = false;

export function resetA11y() {
  a11yAttempted = false;
  lastA11y = null;
}

async function autoA11y(base) {
  try {
    const dev = await getJson(`${base}/device`, 4000);
    if (!dev.esp) return; // 挂的不是我们这颗板子，绝不碰系统设置
    lastA11y = await getJson(`${base}/a11y?enable=1`, 15000);
  } catch {
    // 老版本桥没有 /device、/a11y —— 静默跳过
  }
}

/** 查（或尝试开启）DSH 的无障碍服务。 */
export async function a11yInfo({ enable = false, signal } = {}) {
  const p = await probe({ signal });
  if (!p.ok) throw new Error('连不上 ESP32 桥，查不到无障碍状态');
  const info = await getJson(`${p.base}/a11y${enable ? '?enable=1' : ''}`, 15000, signal);
  lastA11y = info;
  return info;
}

/**
 * 发一条命令。
 * @param {object} payload 例如 {t:'tap', x:540, y:1170}
 * @returns {Promise<object>} ESP32 的 JSON 回包
 */
export async function send(payload, { signal } = {}) {
  const p = await probe({ signal });
  if (!p.ok) {
    const detail = p.tried.map((t) => `${t.base} → ${t.error}`).join('; ');
    throw new Error(`连不上 ESP32。可用的地址都试过了：${detail}`);
  }
  // 通道通了但蓝牙没连上：动作必然失败。直接给出照着做就行的原因，
  // 别让调用方去猜 no_hid / ble_not_ready 是什么意思。
  if (p.ble === false) {
    throw new Error(
      p.kind === KIND.APP
        ? 'App 桥在线，但它到 ESP32 的蓝牙还没连上：手机「设置 › 蓝牙」里把 Tangyuan HID N 连接一次（App 会自动重连），然后重试'
        : 'ESP32 在线，但它的蓝牙 HID 没连上这台手机：检查手机蓝牙里 Tangyuan HID N 是否处于已连接',
    );
  }
  const url = `${p.base}/cmd?${new URLSearchParams({ j: JSON.stringify(payload) })}`;
  try {
    return await getJson(url, CMD_TIMEOUT_MS, signal);
  } catch (e) {
    cachedBase = null; // 下次重新探测
    throw e;
  }
}

// ---------------------------------------------------------------- 感知层
// 桥（或固件）负责「看」：/shot 出 JPEG，/a11y?tree=1 出前台控件树。
// 固件老版本没有这两个路由 —— 抛可读错误，别让调用方去猜 404。

/** 抓一张屏幕截图。返回 { buffer, jpeg }；桥不支持时抛错。 */
export async function screenshot({ quality = 70, signal } = {}) {
  const p = await probe({ signal });
  if (!p.ok) {
    const detail = p.tried.map((t) => `${t.base} → ${t.error}`).join('; ');
    throw new Error(`连不上桥，截不了图。试过：${detail}`);
  }
  const q = Math.max(20, Math.min(95, Number(quality) || 70));
  const url = `${p.base}/shot?q=${q}`;
  let res;
  try {
    res = await fetch(url, { signal: withTimeout(12000, signal) });
  } catch (e) {
    throw new Error(`截图请求失败：${e?.message ?? e}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`截图失败 HTTP ${res.status}：${t.slice(0, 200) || '桥不支持 /shot，请升级汤圆蓝牙桥到 1.2.0+'}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.startsWith('image/')) {
    throw new Error(`截图失败：桥返回了 ${ct || '未知类型'}（需要 1.2.0+ 的汤圆蓝牙桥）`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`截图失败：只拿到 ${buffer.length} 字节`);
  return { buffer, jpeg: true, base: p.base };
}

/** 读前台控件树（文字 + 包围盒 + 可点/可输入）。 */
export async function a11yTree({ max = 300, signal } = {}) {
  const p = await probe({ signal });
  if (!p.ok) {
    const detail = p.tried.map((t) => `${t.base} → ${t.error}`).join('; ');
    throw new Error(`连不上桥，读不了控件树。试过：${detail}`);
  }
  return await getJson(`${p.base}/a11y?tree=1&max=${Math.max(20, Math.min(1500, Number(max) || 300))}`, 15000, signal);
}

// ---------------------------------------------------------------- 看门狗
// 桥 1.3.0+ 自带无障碍看门狗：dsh-go 的手机操控被系统关掉会自动补回。
// 老桥没有 /watch（404）—— 抛可读错误，别让调用方猜。

/** 查询/操作看门狗。op: status | on | off | fix | add | del */
export async function watchdog(op = 'status', arg = '', { signal } = {}) {
  const p = await probe({ signal });
  if (!p.ok) {
    const detail = p.tried.map((t) => `${t.base} → ${t.error}`).join('; ');
    throw new Error(`连不上桥，查不到看门狗。试过：${detail}`);
  }
  const qs = new URLSearchParams({ op });
  if (arg) qs.set('arg', arg);
  try {
    return await getJson(`${p.base}/watch?${qs}`, 15000, signal);
  } catch (e) {
    if (String(e?.message ?? '').includes('404')) {
      throw new Error('桥不支持 /watch：请把「汤圆蓝牙桥」升级到 1.3.0+');
    }
    throw e;
  }
}
