# 部署与真机验证

当前小程序 AppID 已配置为 `wx2c8672ff25a93740`，API 地址为 `https://lession-api.yppnote.com`。域名按提供的拼写保留。配置完成不代表云端已经部署。

1. 在微信开发者工具导入项目，把 `project.config.json` 中的 `appid` 替换成真实 AppID。
2. 在 `worker/` 内执行 `npx wrangler login`，完成自己的 Cloudflare 授权。
3. 执行 `npx wrangler d1 create lesson-tracker-test`，保存返回的数据库 ID。
4. 复制 `worker/wrangler.example.jsonc` 为 `worker/wrangler.jsonc`，填入数据库 ID，并把 `APP_ENV` 改为 `validation`。
5. 在 `worker/` 内执行 `npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc`。
6. 执行 `npx wrangler deploy --config wrangler.jsonc`，在 Cloudflare 配置自有 API 域名。
7. 在微信小程序后台配置 request 合法域名；将 `miniprogram/config.js` 中的 API 地址替换为该 HTTPS 域名。
8. 真机依次点击“测试连接”“写入数据”“读取数据”，确认记录内容和编号一致。

在不同网络下记录请求是否成功、耗时是否能接受。Phase 0 通过后，再开发正式业务表、身份和账本。

测试接口不需要登录，只用于无个人信息的连通验证。验证结束后，将 `APP_ENV` 改为 `production` 并重新部署，关闭 `/test`；`/health` 继续可用。

参考：[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)、[D1 预编译语句](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)。

## 身份与机构阶段

2026-09-30：正式建表文件已应用到云端，新版 Worker 已部署，自有域名 /health 返回 200。SESSION_SECRET 已独立随机生成并存入 Cloudflare；微信 AppSecret 已配置，真实微信登录在开发者工具中通过。经用户明确授权设置超级管理员后，真实登录成功进入机构管理页，机构列表无报错。用户已确认两个真实账号登录及机构管理员邀请成功。下方完整步骤也适用于自行部署。

在 Cloudflare 的 `lesson-tracker-api` → Settings → Variables and Secrets 配置：

| 名称 | 类型 | 值 |
|---|---|---|
| WECHAT_APP_ID | 公开变量 | wx2c8672ff25a93740 |
| WECHAT_APP_SECRET | Secret | 微信小程序后台的 AppSecret |
| SESSION_SECRET | Secret | 随机生成的至少 32 字符密钥 |
| SUPER_ADMIN_OPENID | Secret | 首次登录后复制的账号标识 |
| APP_ENV | 公开变量 | production |

AppSecret 只填在 Cloudflare，不填入小程序代码、文档或聊天。SESSION_SECRET 可在终端用 `openssl rand -hex 32` 生成，复制到 Secret 后保存。更改 SESSION_SECRET 会让已有会话失效。

先配置 AppID、AppSecret 和 SESSION_SECRET，SUPER_ADMIN_OPENID 可以暂时不填。首次登录会进入“加入机构”页，点击“复制账号标识”，把该值填入 SUPER_ADMIN_OPENID，应用更新后重新登录，即可进入机构管理页。这里要使用本小程序登录得到的 openid，不能使用开发者工具账号的 openid。

在项目根目录验证：

```sh
npm install
npm run check
npm test
npm run build
```

在 `worker/` 目录发布：

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
npm run deploy
```

本地 `wrangler.jsonc` 的 vars 应包含 WECHAT_APP_ID 和 APP_ENV=production。Secret 使用 Cloudflare 管理，不写进这个文件。把已绑定的自有域名也写进 routes，避免后续发布时配置不一致。

验收顺序：

1. 微信登录并设置超级管理员身份。
2. 超级管理员创建机构，生成邀请码。
3. 另一个微信账号登录，兑换邀请码，进入自己的机构。
4. 机构管理员邀请第二位管理员，确认邀请码不能重复使用。
5. 超级管理员停用机构；原管理员下一次请求应被拒绝。重新启用后可登录。

后端 `/test` 在 production 关闭，因此此前的连接测试页不再用于写入。小程序默认入口已经改为登录页。

## 核心业务阶段

新增 0003_ledger.sql，给流水添加幂等摘要字段，并用触发器保证余额与流水原子写入。现有机构、账号、邀请保留。按上方迁移、发布步骤更新即可。小程序重新编译后，机构管理员首页将显示课时管理与导出入口。手机验收见 [acceptance.md](acceptance.md)。

发布脚本检查后端 AppID 与根目录小程序配置一致，并要求 WECHAT_APP_SECRET、SESSION_SECRET 为真正的 Cloudflare Secret。普通变量不满足检查，避免发布覆盖登录密钥。

2026-10-01：根目录与 miniprogram 子目录的项目 AppID 已统一为 wx2c8672ff25a93740。若开发者工具导入子目录，也必须使用该 AppID；切换后重新打开项目，并重新生成手机预览，避免旧 AppID 的 wx.login 凭证与后端不匹配。
