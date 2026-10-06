import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
const stop = () => {
  for (const child of children) child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const compile = spawn(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.electron.json'],
  { cwd, stdio: 'inherit' },
);
await new Promise((resolve) =>
  compile.on('exit', (code) => {
    if (code) process.exit(code);
    resolve();
  }),
);
const vite = spawn(
  process.execPath,
  [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js')],
  { cwd, stdio: 'inherit' },
);
children.push(vite);
vite.on('exit', (code) => {
  stop();
  process.exit(code || 0);
});
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch('http://127.0.0.1:5178')).ok) break;
  } catch {}
  if (i === 59) {
    stop();
    throw Error('本机界面服务启动失败');
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const electron = spawn(require('electron'), ['.'], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, GOODS_DEV_URL: 'http://127.0.0.1:5178' },
});
children.push(electron);
electron.on('exit', (code) => {
  stop();
  process.exit(code || 0);
});
