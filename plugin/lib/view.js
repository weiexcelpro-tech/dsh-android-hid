// 工具卡视图：纯函数，输入工具返回值，输出组件树（≤8KiB）。
// 组件类型见 docs/plugins/components.md：stack / row / metric / text / callout / list

export function statusView(v) {
  const ok = v.transport !== '未连接';
  return {
    type: 'stack',
    title: ok ? `ESP32 · ${v.transport}` : 'ESP32 未连接',
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: '通道', value: v.base || '—' },
          { type: 'metric', label: 'BLE', value: v.ble ? '已连接' : '未连接' },
        ],
      },
      ...(v.info ? [{ type: 'text', text: v.info, tone: 'muted' }] : []),
      ...(v.ble === false
        ? [{
            type: 'callout',
            tone: 'warning',
            text: v.kind === 'app'
              ? 'App 桥在线但蓝牙未连：手机设置 › 蓝牙里连接一次 Tangyuan HID N。'
              : 'ESP32 蓝牙 HID 未连上手机：手机蓝牙里连接一次 Tangyuan HID N。',
          }]
        : []),
      ...(ok
        ? []
        : [{ type: 'callout', tone: 'warning', text: '先启动通道：装好「汤圆蓝牙桥」App 并点启动，或让 ESP32 连上同一网络。' }]),
    ],
  };
}

const ACTION_LABEL = {
  tap: '点击',
  swipe: '滑动',
  long: '长按',
  text: '输入',
  key: '按键',
  akey: '系统键',
};

export function actionView(args, value) {
  const label = ACTION_LABEL[value.t] ?? value.t;
  const where =
    value.t === 'tap' || value.t === 'long' ? `(${args.x}, ${args.y})` : value.t === 'swipe' ? `(${args.x1},${args.y1}) → (${args.x2},${args.y2})` : '';
  return {
    type: 'stack',
    title: `${label} ${where}`.trim(),
    children: [
      { type: 'row', children: [{ type: 'metric', label: '结果', value: value.ok ? '成功' : '失败' }] },
      ...(value.detail ? [{ type: 'text', text: value.detail, tone: 'muted' }] : []),
    ],
  };
}

export function panelView(scope, caps) {
  const s = scope?.status;
  return {
    type: 'stack',
    children: [
      { type: 'metric', label: '通道', value: s?.base || '未探测' },
      { type: 'metric', label: 'BLE', value: s?.ble ? '已连接' : '未连接' },
      ...(s?.last ? [{ type: 'text', text: `最近动作：${s.last}`, tone: 'muted' }] : []),
      { type: 'callout', tone: 'info', text: '模型可用 esp32_status / esp32_tap / esp32_swipe / esp32_text 等工具操作手机。' },
    ],
  };
}
