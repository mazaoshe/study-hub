# 版本管理

仓库：https://github.com/mazaoshe/study-hub

## 分支与归档

| 名称 | 用途 |
| --- | --- |
| `main` | 当前微信原生小程序与 Cloudflare Workers / D1 版本，日常维护主线 |
| `legacy/studyhub` | 原 uni-app / gin-vue-admin 版本，需要维护旧版时从此分支开始 |
| `archive/studyhub-2026-10-06`（标签） | 切换前的固定快照，指向 `576e411f6697f94b8c0e1b4b70ab6a0b5fac94bc`，不移动 |
| `my-project` | 仓库原有分支，本次保留原状 |

2026-10-06：将新版作为原 `main` 的后续提交导入，保留完整 Git 历史。旧实现可从归档标签或旧版分支取回。

## 后续开发

1. 从最新 `main` 创建 `feat/功能名` 或 `fix/问题名` 分支。
2. 按独立改动提交，运行 `npm run check`、`npm test`、`npm run build`；涉及迁移工具时，再运行 `python3 -m unittest discover -s scripts/tests -v`。
3. 推送分支，通过 Pull Request 检查改动后合并到 `main`。
4. 真机验收及部署完成后，为发布的提交创建 `vX.Y.Z` 标签。Git 提交本身不代表已上线。

旧版维护在单独目录检出 `legacy/studyhub`；两版架构不同，不将旧版整个分支合并到 `main`。

## 提交范围

提交应用源码、数据库结构迁移、测试、文档、依赖锁文件和配置示例。

`backups/` 中的学员数据、`.dev.vars` 及环境变体、`.env`、生产 `worker/wrangler.jsonc`、开发者工具个人配置、依赖目录及本地运行状态不进入版本库。根目录 `AGENTS.md` 和 `sources/` 属于本地 ChatGPT 项目上下文，也不提交。

新电脑克隆后，按 [部署文档](deployment.md) 单独配置所需密钥和环境。Git 归档保存代码；数据库恢复按 [迁移文档](studyhub-migration.md) 的流程处理。
