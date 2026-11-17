#!/usr/bin/env node
/**
 * 测试用垫片：在仓库里造一个最小的 `@deepseek-ai/dsh-tools`。
 *
 * 为什么需要：插件 `lib/index.js` 会 `import { defineTool } from '@deepseek-ai/dsh-tools'`。
 * 真正跑起来时这个包由 DSH 宿主提供（proot 里 dsh-go 自己的 node_modules），
 * 但单元测试只关心工具定义长什么样，不需要宿主 —— 于是塞一个透传实现。
 *
 * 只在**本地/CI 测试**时生成，不进 git（.gitignore 里有 node_modules/），
 * 也不写进 package.json 的 dependencies，避免部署进 dsh-go 后盖掉宿主真正的包。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools');

mkdirSync(dir, { recursive: true });

const pkg = join(dir, 'package.json');
if (!existsSync(pkg)) {
  writeFileSync(
    pkg,
    JSON.stringify(
      {
        name: '@deepseek-ai/dsh-tools',
        version: '0.0.0-test-stub',
        type: 'module',
        main: 'index.js',
        private: true,
      },
      null,
      2,
    ) + '\n',
  );
}

const idx = join(dir, 'index.js');
if (!existsSync(idx)) {
  writeFileSync(
    idx,
    '// 测试垫片：真实现会做完整校验，这里只需要 defineTool 的透传\n' +
      'export const defineTool = (t) => t;\n',
  );
}

console.log('dsh-tools 测试垫片就绪:', dir);
