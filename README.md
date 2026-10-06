# 课时工具

微信原生小程序课时管理工具，后端使用 TypeScript、Hono、Cloudflare Workers 和 D1。

本项目是 [StudyHub](https://github.com/mazaoshe/study-hub) 的新版实现。`main` 维护当前版本；原 uni-app / gin-vue-admin 版本保留在 [`legacy/studyhub`](https://github.com/mazaoshe/study-hub/tree/legacy/studyhub)，切换前快照为 `archive/studyhub-2026-10-06`。分支约定见 [版本管理](docs/version-control.md)。

第一版包含微信登录、机构和邀请、课程、学员、共享课时包、充值、消课、冲正、归档与 CSV 导出。两个真实微信账号登录及邀请码流程已通过用户验证。应用通过 72 项自动测试，新增手机业务流程待验收，见 [docs/acceptance.md](docs/acceptance.md)。

## 界面截图

| 首页 | 学员列表 | 消课 |
| --- | --- | --- |
| ![课时工具首页](docs/images/screenshots/home.png) | ![学员列表](docs/images/screenshots/students.png) | ![消课表单](docs/images/screenshots/consume.png) |

| 管理 | 课程管理 | |
| --- | --- | --- |
| ![管理页面](docs/images/screenshots/manage.png) | ![课程管理](docs/images/screenshots/courses.png) | |

## 本地启动

```sh
npm install
npm run db:local
npm run dev
```

微信开发者工具导入本目录。开发阶段使用本地 API 时，在开发者工具本地设置中关闭合法域名校验；真机验证必须配置真实 AppID 和正式 HTTPS API 地址。

```sh
npm run check
npm test
npm run build
```

部署和真机验证见 [docs/deployment.md](docs/deployment.md)。进度见 [tasks/todo.md](tasks/todo.md)。

登录前需配置微信 AppSecret 和 SESSION_SECRET；本地开发可复制 `worker/.dev.vars.example` 为 `worker/.dev.vars` 后填写。超级管理员使用自己的小程序 openid 配置。详见部署文档。

接口说明见 [docs/api.md](docs/api.md)，身份设计见 [docs/decisions/001-identity-and-tenant.md](docs/decisions/001-identity-and-tenant.md)。

账本设计见 [docs/decisions/002-ledger.md](docs/decisions/002-ledger.md)。

StudyHub 旧数据已于 2026-10-02 正式导入新建的「一尘书画院」机构，并完成线上逐项对账。迁移期初、旧历史查询和离线工具见 [docs/studyhub-migration.md](docs/studyhub-migration.md)，工具另有 6 项本地测试。

机构管理员首页展示总剩余课时 ≤ 3 的待跟进学员，也可按姓名或手机号搜索全部正常学员并快捷充值、消课；底部导航为「首页 · 学员 · 管理」；完整学员名单与学员资料在「学员」，课程、流水、导出和管理员操作在「管理」。
