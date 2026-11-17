// 输出 schema 必须是合法 JSON Schema：required 写成「数组、放在对象层」。
// 之前把 required: true 塞进属性里，dsh-go 加载插件时直接抛错 —— 而且抛得很安静：
// 插件在设置里显示「已启用 / 组件 1 个」，但工具一个都没注册，agent 那边只看到
// 「没有 esp32_scan 这个工具」，极难定位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

/** 找出所有 `output: {` 之后配对的 {...} 文本片段 */
function outputSchemaBlocks(text) {
  const blocks = [];
  const re = /output:\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let i = text.indexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end > 0) blocks.push(text.slice(i, end));
  }
  return blocks;
}

test('每个 output.schema 都不含属性级 required: true', () => {
  const blocks = outputSchemaBlocks(src);
  assert.ok(blocks.length >= 3, `应找到多个 output 块，实际 ${blocks.length}`);
  const bad = blocks.filter((b) => /required:\s*true/.test(b));
  assert.equal(
    bad.length,
    0,
    `发现 ${bad.length} 个 output 块用了 required: true —— 要改成对象层 required: ['字段']`,
  );
});

test('output.schema 的 required 是数组', () => {
  for (const b of outputSchemaBlocks(src)) {
    for (const hit of b.matchAll(/required:\s*(\[[^\]]*\]|[^,\n}]+)/g)) {
      assert.ok(hit[1].trim().startsWith('['), `required 必须是数组，实际: ${hit[1]}`);
    }
  }
});
