# 部署与微信配置

本文描述陌生部署者从零部署当前版本。示例中的域名、AppID、数据库名称和 ID 都是占位符，必须替换成自己的值；不要把 Secret 写进配置文件或提交到 Git。

## 1. 准备账号和工具

需要准备：

- Node.js（建议当前 LTS）和 npm；
- 微信公众平台小程序账号，并能取得自己的 AppID、AppSecret；
- Cloudflare 账号、Workers 权限、D1 权限，以及一个已接入 Cloudflare 的自有 HTTPS 域名；
- 微信开发者工具。

克隆项目后在根目录安装依赖：

```sh
npm install
npm run check
npm test
npm run build
```

`npm run build` 使用 `worker/wrangler.example.jsonc` 做 dry-run，只验证 Worker 可构建，不会发布生产服务。

## 2. 配置小程序

1. 在根目录的 `project.config.json` 和 `miniprogram/project.config.json` 填入同一个自己的 AppID。通常从仓库根目录导入项目，`miniprogramRoot` 已指向 `miniprogram/`。
2. 修改 `miniprogram/config.js` 的 `API_BASE_URL` 为自己的 Worker HTTPS 地址，不要保留示例或维护者地址；只写协议和域名，不要追加 API 路径。
3. 在微信公众平台的「开发管理 → 开发设置」中配置 request 合法域名，加入上述 HTTPS API 域名。
4. 小程序通过 `wx.request` 获取 CSV 后在本地生成文件并使用「分享文件」，不需要另配 `downloadFile` 合法域名。
5. 开发者工具导入根目录，选择自己的 AppID。正式真机验证不要依赖关闭合法域名校验；该选项只适合本地开发。

AppSecret 只交给后端 Secret 管理，不放入 `miniprogram/`、`project.config.json` 或前端请求。

## 3. 创建生产 Worker 配置和 D1

进入 Worker 目录登录 Cloudflare，并创建自己的 D1 数据库：

```sh
cd worker
npx wrangler login
npx wrangler d1 create <自己的数据库名称>
```

复制 `worker/wrangler.example.jsonc` 为未提交的 `worker/wrangler.jsonc`，至少修改：

- `name`：自己的 Worker 名称（也可保留项目默认名称）；
- `vars.APP_ENV`：生产必须为 `production`；
- `vars.WECHAT_APP_ID`：与两个小程序项目配置相同的自己的 AppID；
- `routes`：自己的 Cloudflare Custom Domain，或按 Cloudflare 的 Workers 路由配置；
- `d1_databases[0].database_name` 和 `database_id`：`d1 create` 返回的自己的值；
- 保留 `binding` 为 `DB`、`main` 为 `src/index.ts`、`migrations_dir` 为 `../migrations`。

生产配置不应包含 `WECHAT_APP_SECRET`、`SESSION_SECRET` 或 `SUPER_ADMIN_OPENID`。这些变量用 Secret 设置：

```sh
npx wrangler secret put WECHAT_APP_SECRET --config wrangler.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.jsonc
```

`SESSION_SECRET` 使用至少 32 个字符的随机值，例如先在本地生成：

```sh
openssl rand -hex 32
```

不要把生成结果写入项目文件、日志或文档；更换它会使已有会话失效。`SUPER_ADMIN_OPENID` 在首次微信登录后再设置，步骤见 [完整教程](guide.md#首次登录与设置超级管理员)。

## 4. 应用迁移并发布 Worker

确认当前目录为 `worker/`，先应用所有尚未执行的 D1 迁移：

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
```

该命令按 `migrations/0001_*.sql` 至当前最新文件顺序执行，重复执行不会重复应用已记录的迁移。不要用本地 SQLite 文件覆盖线上 D1。

然后运行项目发布脚本：

```sh
npm run deploy
```

发布脚本会读取根目录 `project.config.json`，检查后端 AppID 与小程序 AppID 一致，并检查 `WECHAT_APP_SECRET`、`SESSION_SECRET` 确实是 Cloudflare Secret，最后才执行 `wrangler deploy --config wrangler.jsonc`。因此不要绕过脚本直接用示例配置发布生产环境。

发布后先用浏览器或命令行访问自己的：

```text
https://<自己的 API 域名>/health
```

应得到包含 `"ok":true` 的 JSON。`/health` 只检查服务连通性，不检查数据库和微信登录；生产环境的 `/test` 会返回 404，这是预期行为。

## 5. 首次登录和超级管理员

1. 将 `miniprogram/config.js` 指向已发布的 HTTPS API，在开发者工具重新编译并预览。
2. 用准备作为超级管理员的微信账号点击「微信登录」。后端尚未配置超级管理员时，该账号会进入「加入机构」页。
3. 点击「复制账号标识」，将复制的值作为 `SUPER_ADMIN_OPENID` 写入 Cloudflare Secret：

   ```sh
   npx wrangler secret put SUPER_ADMIN_OPENID --config wrangler.jsonc
   ```

   这是该小程序登录得到的 openid，不是 AppID、微信号，也不是开发者工具账号名称。
4. 重新登录（必要时退出后重新打开小程序）。确认进入「机构管理」页面。

超级管理员权限按后端配置实时判断，不要在文档、前端代码或普通变量中保存 openid。后续普通管理员通过机构邀请码加入，不需要把 openid 写入配置。

## 6. 本地开发

本地 Worker 使用示例配置：

```sh
cd worker
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，替换所有占位值为自己的开发用值
npm run db:local
npm run dev
```

本地开发配置只用于本地；`.dev.vars` 不得提交。根目录的 `npm run db:local` 和 `npm run dev` 是上述命令的 workspace 包装。小程序本地 API 使用 `http://127.0.0.1:8787`，并在开发者工具中关闭合法域名校验。真机和正式发布必须换回 HTTPS 地址并配置合法域名。

## 7. 发布前检查

在根目录执行：

```sh
npm run check
npm test
npm run build
```

再逐项确认：

- 两个小程序配置文件的 AppID 相同，且与 `worker/wrangler.jsonc` 的 `WECHAT_APP_ID` 相同；
- `APP_ENV=production`，D1 的 `database_id` 是自己的生产库；
- Worker 的两个登录密钥为 Cloudflare Secret，未出现在 JSONC、Git 或日志；
- `miniprogram/config.js` 使用自己的 HTTPS API 域名；
- 微信后台已配置 request 合法域名；
- `/health` 返回 200，`/test` 在生产返回 404；
- 已阅读 [验收清单](acceptance.md)，准备测试机构、课程和学员数据。

业务操作、首次建机构、管理员邀请和验收顺序见 [陌生部署者完整教程](guide.md)。

## 常见部署故障

| 现象 | 检查 |
| --- | --- |
| 发布提示 AppID 不一致 | 对比根目录 `project.config.json` 与 `worker/wrangler.jsonc` 的 `WECHAT_APP_ID`，并确认 `miniprogram/project.config.json` 也使用同一 AppID。 |
| 发布提示 Secret 未配置 | 在 `worker/` 执行 `npx wrangler secret list --config wrangler.jsonc`，确认两个登录密钥的类型是 `secret_text`；不要只写在 `vars`。 |
| `/health` 正常但登录失败 | 检查 API 域名、AppID、AppSecret、微信 request 合法域名和 `APP_ENV`；查看 Worker 日志中的错误类别，不要打印 Secret。 |
| 小程序提示网络连接失败 | 先确认 `miniprogram/config.js` 没有旧地址或多余路径，再确认使用 HTTPS、域名已接入 Cloudflare 且已在微信后台登记。 |
| 数据库报表为空或表不存在 | 确认迁移命令使用的是生产 `wrangler.jsonc` 和 `--remote`，且 `binding` 为 `DB`。 |
| 旧会话全部失效 | 检查是否更换了 `SESSION_SECRET`；更换后重新登录即可。 |
| 邀请码不能使用 | 邀请码 7 天有效且一次性使用；确认机构仍为启用状态、账号尚未绑定其他机构，并重新复制完整邀请码。 |
| `/test` 不可访问 | 生产环境关闭该接口，这是正常安全策略；连通性使用 `/health`，业务流程使用真实登录。 |

继续开发时请遵守 [版本管理](version-control.md)；身份、账本和结清的约束见 `docs/decisions/`，不要通过手工修改 D1 绕过这些规则。
