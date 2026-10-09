# V1 API

Base URL：部署者自己的 Worker HTTPS 地址，例如 `https://api.example.com`。本文不绑定任何维护者域名。

JSON 请求和响应。认证接口要求 `Authorization: Bearer <token>`。

## 登录

`POST /auth/login`：`{ "code": "wx.login 返回的 code" }`。

返回 `token`、Unix 秒单位的 `expires_at`，以及以下身份结构：

```json
{
  "user": { "id": "用户ID", "openid": "当前用户的openid", "status": "ACTIVE" },
  "role": null,
  "organization": null,
  "needs_binding": true
}
```

role 为 `SUPER_ADMIN`、`ORG_ADMIN` 或未绑定用户的 `null`。机构管理员的 organization 包含 `id`、`name`、`status`。仅向当前用户返回自身 openid，管理员列表不返回别人的 openid。

`GET /me`：返回当前身份。`POST /auth/logout`：撤销当前会话，返回 `{ "ok": true }`。

账号停用或机构停用返回 403；会话失效返回 401。登录时也检查停用状态。

## 超级管理员

| 接口 | 请求 | 返回 |
|---|---|---|
| GET /organizations?page=1 | 每页 20 条，页码从 1 开始 | organizations、page、has_more |
| POST /organizations | `{ "name": "机构名称" }` | organization，HTTP 201 |
| PATCH /organizations/:id | name 和/或 status（ACTIVE / DISABLED） | organization |

机构名称为 1～80 字。停用机构仍在超级管理员列表中，机构管理员下一次请求立即被拒绝。

## 邀请管理员

`POST /invites`：超级管理员提交 `{ "organization_id": "机构ID" }`；机构管理员提交 `{}`，只会为自身机构生成邀请码。

返回 `{ "code": "一次性邀请码", "expires_at": 1790000000 }`，HTTP 201。有效期 7 天，明文仅在创建时返回。

`POST /invites/redeem`：未绑定用户提交 `{ "code": "邀请码" }`，返回更新后的身份。客户端可输入小写、空格或分隔连字符，服务器统一规范化。已有业务角色的账号不能重复绑定或加入另一机构。

`GET /admins`：机构管理员读取自己的机构管理员列表，返回 admins，成员字段为 id、status、created_at。

## 错误

统一返回 `{ "error": "错误码", "message": "面向用户的提示" }`。

| HTTP | 场景 |
|---|---|
| 400 | 请求格式、名称或微信 code 无效 |
| 401 | 未登录或会话过期 |
| 403 | 无权限、账号或机构停用 |
| 404 | 不存在的机构或接口 |
| 409 | 已绑定、邀请码失效或机构不可用 |
| 413 | 请求体超过限制 |
| 429 | 登录或兑换太频繁 |
| 502 | 微信登录接口错误 |
| 503 | 缺少登录配置 |

`/health` 是服务连通检查，不访问数据库。`/test` 只在 `development` / `validation` 开放；正式阶段关闭该测试接口。生产部署和微信合法域名配置见 [部署文档](deployment.md)。

## 课程、学员与课时包

以下接口仅允许机构管理员访问，机构从登录身份获取，忽略客户端提供的 organization_id。

| 接口 | 请求 / 返回 |
|---|---|
| GET /courses、GET /students | page（20 条/页）、search（课程名称；学员姓名或手机号）、status=ACTIVE 或 ARCHIVED（精确筛选，优先于 archived）；未传 status 时兼容 archived=1（含归档），否则仅正常；返回 items、total、page、has_more，total 为同一筛选条件下总数 |
| POST /courses、POST /students | name、remark（选填）、phone（学员选填）；返回 item，201 |
| GET /courses/:id、GET /students/:id | 返回 item |
| PATCH /courses/:id、PATCH /students/:id | name、remark、phone、status（ACTIVE / ARCHIVED）；返回 item |
| GET /students/:id/packages | 返回 packages，含归档课时包 |
| POST /students/:id/packages | course_ids（1～100 个不同的本机构正常课程）；name 选填，省略或留空时按课程自动命名；返回 package，201 |
| GET /packages/:id | 返回 package，含 courses、student_name、student_status |
| PATCH /packages/:id | name、status、course_ids；未提供的字段保留；余额不能直接修改 |

名称最多 80 字，备注最多 500 字，电话最多 40 字。归档保留全部历史，恢复后可以继续使用。归档学员或课时包禁止新增充值、消课；归档课程禁止消课；仍可冲正已有流水。

底部「学员」页提供完整学员列表，首页及管理页不再放重复入口。学员列表分为「正常学员」和「已归档」，默认正常学员，两类互不混合，显示当前列表的筛选总人数及已加载人数，可按姓名或手机号搜索；滑到底部自动加载下一页，也可点击「加载更多」。列表覆盖课时充足、无课时包及归档学员，不受首页待跟进余额条件限制。每位学员同时返回 paid_balance、gift_balance、total_balance、package_count，按其正常课时包汇总，不因共享多门课程重复计数；没有正常包时为零。切换列表保留搜索词并从第一页重新加载；归档或恢复后刷新当前列表。课程管理仍默认只显示正常课程。

学员卡片提供正常课时包的充值／消课快捷入口，编辑及归档／恢复收进「更多」。新增与编辑采用底部弹窗。返回列表、编辑保存及归档操作后，按当前筛选刷新已加载的所有页，再整体替换列表并恢复滚动位置；中途加载失败保留原列表。学员详情将正常课时包与已归档课时包分组展示，默认正常，归档包只提供查看入口。

学员排序参数 `sort=name|balance|newest|archived`：正常学员默认姓名拼音顺序（按完整匹配名单排序后分页），可切换剩余总课时升序或新增时间倒序；已归档默认归档时间倒序。姓名同名时用编号稳定排序。归档新增 `archived_at`，编辑姓名或备注不改变它，恢复后清空，再次归档重新记录；旧记录时间未知时保留 null，排在有时间的记录后。姓名排序仅读取匹配学员的编号和姓名，在 Worker 中进行中文拼音比较，再读取当前页详情；机构名单规模大幅增长时应考虑持久化排序键。

## 课时账本

| 接口 | 请求 |
|---|---|
| POST /packages/:id/recharge | request_id、paid_hours、gift_hours、remark（选填） |
| POST /packages/:id/consume | request_id、course_id、hours、remark（选填） |
| POST /lesson-records/:id/reverse | request_id、remark（页面要求填写原因） |
| GET /lesson-records | page、package_id、student_id（选填）；返回 items、page、has_more |

写入成功返回 `{ "record": { ... } }`。所有课时必须为 JavaScript 安全整数。充值的付费与赠送均为非负整数，总和大于零；消课为正整数。多课程共享同一个包的余额，先扣赠送，再扣付费，付费允许负数。流水包含操作人编号和时间。

request_id 为 1～80 字的客户端操作编号；同一机构内，同一编号及相同内容返回原流水，内容不同返回 409。手机断网重试应保留操作编号，成功后的下一笔操作才换新编号。

冲正新增一条原流水变动的相反记录，原记录不可修改或删除。每笔充值或消课最多冲正一次，冲正本身不可再冲正。充值的赠送课时已用掉，导致冲正后赠送余额为负时拒绝，余额和流水均保持不变。消课、充值、冲正的流水及余额在数据库同一事务中写入。

## CSV

GET /exports/students、/exports/packages、/exports/records：返回带 UTF-8 BOM 的 CSV 文本，含本机构全部数据和已归档记录。课时包导出包括绑定课程；流水包括原流水编号及操作人编号。文本公式前缀做转义，避免打开表格时执行公式。

小程序通过 request 接口获取文件，再由用户点击“分享文件”，因此无需额外配置 downloadFile 合法域名。

## 旧系统迁移数据

以下为内部兼容接口。小程序不展示系统来源、结转卡片及分配说明；查询和导出入口统一称「历史记录」，结转导出仅保留接口。学员备注展示、编辑及普通 CSV 隐藏自动导入编号，存储中的编号仍保留；历史 CSV 使用不含来源说明的业务列名。

`GET /packages/:id` 增加可空的 `legacy_opening`，含 `paid_hours`、`gift_hours`、`source_total`、`snapshot_at`、`allocation_note`。这些是迁移时的结转数，不是当前余额；余额仍读取课时包的 `paid_balance` / `gift_balance`。

`GET /legacy-records?page=1&package_id=...&student_id=...`：机构管理员只读本机构历史，筛选项可省略。返回 `items`、`page`、`has_more`，每页 20 条。保留原课程名称、增减方向、课时（含零）、备注、原创建时间、使用日期和删除标记。原日期不附加时区、不转换为新发生的流水，原操作人未知。已归档学员历史可查。

`GET /exports/legacy-records` 和 `/exports/legacy-openings` 分别导出旧历史、迁移期初 CSV；与新流水的 `/exports/records` 分开。对账公式是“迁移期初 + 新流水变动 = 当前余额”，不再叠加旧历史。文本沿用公式注入防护。

没有历史写入、修改、删除或冲正接口。先应用 `0004_legacy_import.sql` 再部署支持这些查询的后端。离线试导入说明见 [StudyHub 迁移](studyhub-migration.md)。

## 机构管理员首页

GET /dashboard?page=1&search=关键词：返回 students、count、page、has_more，每页 20 位学员。仅机构管理员可访问自身机构。

提醒按学员汇总所有 ACTIVE 课时包的付费余额和赠送余额；总余额 ≤ 3 时进入列表。学员也必须为 ACTIVE，并至少有一个正常课时包。已归档对象不参与汇总。排序为总余额升序、名称、学员编号；已透支、已用完的学员优先。返回学员姓名、电话、paid_balance、gift_balance、total_balance、package_count。

search 省略或去除首尾空白后为空时显示上述提醒。非空时按姓名或手机号做字面子串匹配，最多 80 字；覆盖本机构全部正常学员，包括课时充足或没有正常课时包的学员，按姓名、编号排序。余额仍只汇总正常课时包。

首页显示待跟进学员与搜索结果，结果提供充值、消课入口。充值在一个正常课时包时直达操作表单，多个时先选择课时包；消课在首页弹出操作面板，在同一面板内选择课时包和课程，成功后刷新余额并聚焦搜索框，便于连续处理学员。无正常包时需进入学员详情创建或恢复课时包。快捷入口不会自动记账，仍需确认提交。完整学员列表、学员资料和课时包入口在底部「学员」页；课程、流水、CSV、管理员邀请与退出登录在「管理」页。

课时包创建页面只需选择课程，无需填写名称。自动名称如「英语课时包」「阅读／英语课时包」，多个课程时使用前两门加课程数量，最多 80 字。已存在的名称及旧客户端提交的自定义名称保留。

## 退学结清

`GET /students/:id/withdrawal-preview` 返回当前学员、全部未结清课时包（包括已归档包）、snapshot、blocked_reason 和最近结清记录。snapshot 是服务端生成的版本快照，客户端原样回传。

`POST /students/:id/withdraw`：`request_id`（1～80 字）、`expected_snapshot`、`refund_confirmed: true`、`remark`（可选，最多 500 字）。记录已在线下完成的退费，不执行付款、不计算退款金额。原子记录各课时包的结清变动，付费与赠送余额清零，归档课时包与学员；返回 withdrawal、lines。同一请求编号与内容重试返回同一结果，不同内容冲突。

存在透支课时返回 WITHDRAWAL_OVERDRAFT；预览后余额／状态／包集合变更返回 WITHDRAWAL_BALANCE_CHANGED；学员不存在或无可再次结清内容返回 WITHDRAWAL_UNAVAILABLE。失败不留下部分结清数据。普通归档不执行清零。

课时流水和 CSV 增加 WITHDRAWAL；没有课时包的结清事件 lesson_package_id 为 null。课时包和流水增加 settled 标记，已结清包不能恢复或冲正历史余额，返回 PACKAGE_SETTLED。学员可以恢复后新建课时包重新报名。原始账本与结清记录均只追加，数据源内部区别不展示给用户。

上线前先应用 `0007_student_withdrawals.sql`，它增加审计表、视图、版本字段与保护触发器，不改动已有课时余额。详见 [结清决策](decisions/004-student-withdrawal.md)。
