import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Validate names only: never print remote variables or credential values.
const project = JSON.parse(await readFile('../project.config.json', 'utf8'));
const config = await readFile('wrangler.jsonc', 'utf8');
const appId = config.match(/"WECHAT_APP_ID"\s*:\s*"([^"]+)"/)?.[1];
if (!appId || appId !== project.appid) {
  console.error('后端 AppID 与当前小程序不一致，发布已停止。');
  process.exit(1);
}
const listed = spawnSync('npx', ['wrangler', 'secret', 'list', '--config', 'wrangler.jsonc'], { encoding: 'utf8' });
if (listed.status !== 0) {
  console.error('无法检查 Cloudflare Secret，发布已停止，请检查 Cloudflare 登录和网络。');
  process.exit(1);
}
let secrets;
try { secrets = JSON.parse(listed.stdout); }
catch { console.error('无法解析 Secret 名称列表，发布已停止。'); process.exit(1); }
for (const name of ['WECHAT_APP_SECRET', 'SESSION_SECRET']) {
  if (!secrets.some(item => item.name === name && item.type === 'secret_text')) {
    console.error(name + ' 尚未配置为 Secret，发布已停止。普通变量会被本地配置覆盖，请先改存 Secret。');
    process.exit(1);
  }
}
const deployed = spawnSync('npx', ['wrangler', 'deploy', '--config', 'wrangler.jsonc'], { encoding: 'utf8' });
if (deployed.status !== 0) {
  console.error('发布未完成。请在 Cloudflare 检查部署状态；诊断输出已隐藏，避免泄露普通变量中的密钥。');
  process.exit(1);
}
console.log('Worker 发布成功。' + (deployed.stdout.match(/Current Version ID: [^\r\n]+/)?.[0] || ''));
