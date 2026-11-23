import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 更新弹窗里「当前版本更新内容」读的是 resources/release-notes.txt，
// 它必须和 CHANGELOG.md 最上面那一节保持一致，免得两处各写一套。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const targetPath = path.join(root, 'resources', 'release-notes.txt');

if (!existsSync(changelogPath)) throw new Error(`找不到 ${changelogPath}`);
const changelog = readFileSync(changelogPath, 'utf8');
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((line) => /^## /.test(line));
if (start < 0) throw new Error('CHANGELOG.md 里没有版本小节');

let end = lines.length;
for (let index = start + 1; index < lines.length; index += 1) {
  if (/^## /.test(lines[index]) || /^---\s*$/.test(lines[index])) {
    end = index;
    break;
  }
}

const heading = lines[start].replace(/^##\s*/, '').trim();
const body = lines
  .slice(start + 1, end)
  .join('\n')
  .replace(/^###\s*/gm, '')
  .replace(/^- \s*/gm, '· ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const output = `${heading}\n\n${body}\n`;
const previous = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
if (previous !== output) {
  writeFileSync(targetPath, output, 'utf8');
  console.log(`release-notes.txt 已同步：${heading}`);
} else {
  console.log(`release-notes.txt 已是最新：${heading}`);
}
