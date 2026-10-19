# 小程序消息提醒

## 开放条件

真实模板 ID、关键词映射和 `WX_REMINDERS_ENABLED=1` 同时配置才开放对应预约；否则页面显示“暂未开放”。模板从当前小程序可用的公共库选用，不使用模拟授权或虚构模板 ID。是否已经选用、是否已经开启与是否实际收到消息是三种不同状态。

- 我的 → 消息提醒；日报／周报 → 用量日报提醒；接入页 → 同步异常提醒设置。
- 首次获取接入命令时记录“等待首次上报”。收到真实 `last_report_at` 后才有询问资格，零 Token 也算同步成功。已有历史数据的用户、重新同步、重装或重置接入码不产生新的资格。
- 仅在真实模板可用时，主动弹“电脑已接入”，选择“设置提醒”进入设置页。之后必须点击页面中的“预约提醒”，才同步调用 `wx.requestSubscribeMessage`。取消不影响使用，也不反复询问；与现有隐私说明弹窗排队，离页或账号变化则跳过。
- 确认或取消后保存账号级已询问状态；客户端按账号持久去重，即使确认请求断网也不因轮询重复弹。该设备离线且确认未到服务器时，其他设备仍可能询问一次。
- 不依赖有无头像、昵称、用量大于零判断接入成功。公开分享记录页不插入接入询问。

## 申请与配置

优先通过微信官方 API 查询并选用当前小程序类目内的**一次性订阅消息**；已有公共模板不需要重新申请。只有公共库没有适用内容时，再到微信公众平台申请新的模板或关键词。

1. `getCategory`（`GET /wxaapi/newtmpl/getcategory`）读取本账号的类目，不猜类目 ID。
2. `getPubTemplateTitleList`（`GET /wxaapi/newtmpl/getpubtemplatetitles`）传真实类目 `ids`，`start` 从 0 开始分页、`limit` 最大 30；只选择 `type=2`，不能把其他类型当作普通一次授权。
3. `getPubTemplateKeyWordsById`（`GET /wxaapi/newtmpl/getpubtemplatekeywords`）按 `tid` 查询字段的 `kid`、名称、类型和示例，按实际语义选择 2–5 个关键词。
4. `addTemplate`（`POST /wxaapi/newtmpl/addtemplate`）提交 `tid`、`kidList` 和不超过 15 字的 `sceneDesc`，选入本小程序私有库，取得 `priTmplId`。公共库的 `tid` 不能用作小程序授权的模板 ID。
5. `getTemplateList`（`GET /wxaapi/newtmpl/gettemplate`）复核私有模板的实际 `content` 和类型，严格按 `{{thingN.DATA}}` 等编号配置映射。不修改或删除其他已有模板；请求结果不确定时先查询现有库，不盲目重复添加。

这些接口在服务端使用当前小程序的稳定访问凭据调用；不导出 AppSecret，不在日志中输出访问凭据，不在客户端暴露模板管理能力。仅选用模板不会获得用户授权，也不会自动发送消息。普通一次订阅不能承诺每天／每周无限推送。

已核对的公共模板组合（仍需以本账号实际返回为准，私有 ID 不提交到仓库）：

| 业务 | 公共模板 | 选择的关键词 | 程序映射 |
|---|---|---|---|
| 日报 | 报告生成通知，`tid=2663` | 报告名称、报告摘要、生成时间（2、3、5） | `thing2: title`、`thing3: summary`、`time5: time` |
| 同步异常 | 日志记录提醒，`tid=5161` | 日志类型、提示信息（1、3） | `thing1: title`、`thing3: reason` |

同步异常属于电脑同步日志告警，日志类型填“同步异常”，提示信息填安全错误描述。提醒标题由微信模板决定。

选用成功并复核后，把两项真实配置保存为 `WX_REMINDER_TEMPLATES`（JSON 对象；可用 `wrangler secret put WX_REMINDER_TEMPLATES` 输入，勿将生产凭证提交到仓库）。顶层键为 `daily`、`sync_error`，各包含：

| 字段 | 内容 |
|---|---|
| `template_id` | 该小程序实际选用成功返回的私有模板 ID |
| `fields` | 实际关键词编号到程序数据字段的映射，不能按编号猜模板内容 |

可映射字段（未列出的值不允许）：

| 类型 | 数据字段 | 示例内容／口径 |
|---|---|---|
| 日报 | `title`、`range`、`tokens`、`requests`、`summary`、`time` | 10.18 Token日报、2026-10-18、2.58 亿、请求数、2.58亿 · 1382次、发送北京时间 |
| 异常 | `title`、`reason`、`platform`、`duration`、`time` | 同步异常、安全错误描述、macOS／Windows、持续分钟数、发送北京时间 |

关键词名支持 `thingN`、`numberN`、`timeN`、`dateN`、`phraseN`、`character_stringN`。必须匹配已批准模板的实际语义与类型：例如 `tokens` 带中文单位应映射文本字段，天数／分钟数映射 number，时间映射 time，不能把区间映射 date。发送前限制 thing 20 字、phrase 5 字和 number 类型；不合规会记录失败而不发送。不同提醒必须用不同模板 ID。只配置一项时仅开放该项。

确认私有模板类型和字段后，设置 `WX_REMINDERS_ENABLED="1"` 并部署，再进行真实授权与发送验收。`WX_APPID`、`WX_APPSECRET` 复用现有真实微信配置。服务端通过 stable_token 获取微信访问凭证，不返回给小程序。

## 调度与状态

Cloudflare Cron `*/5 * * * *` 每五分钟检查已预约任务；关闭总开关时不读提醒任务、不发送。

- 日报：预约下一个北京时间 09:00 的前一自然日报告。09:00 前预约当天发送（汇总昨天）；09:00 起预约次日发送（汇总今天）。通知标题由微信固定为“报告生成通知”，内容例如“报告名称：10.18 Token日报；报告摘要：2.58亿 · 1382次；生成时间：实际发送时间”。模板摘要最多 20 字，大数按万／亿或科学计数法显示；精确数字保留在详情。
- 点开 `pages/daily/daily?day=YYYY-MM-DD`，展示通知对应日期的含缓存总量、调用次数、输入／输出／缓存明细和工具／模型占比，只读本人选中设备的正式统计；不会跳回今天。日报 GET 与其他数据一样缓存五分钟，下拉刷新主动取新数据。
- 无对应日同步记录时标记 `NO_DAY_USAGE` 并跳过，不伪造零用量；真实上报零用量可发送 0。任务到期后延迟不足 24 小时仍可发送原日期日报；延迟达到 24 小时标记 `DAILY_EXPIRED`，不自动换日期补发。
- 每次用户授权并预约一条日报，发送后停止；不自动续约、补发或承诺永久每天通知。原生授权次数和项目预约状态分别管理。
- 同步异常：仅本人选中设备明确 `error`、最近 15 分钟仍有心跳、故障连续至少 15 分钟，且预约后已持续 15 分钟才触发。一日最多一次；健康／主动停止清除连续故障，心跳中断超过 15 分钟重新计时。失联、休眠、没有用量变化或主动停用不触发。重置接入码清除旧故障状态。
- 每项保留一条当前预约，用户接受授权后提交唯一 `request_id`；重试保存同一请求不会增加预约或复活已取消任务。发送中不接受取消或替换。原生授权接受后服务端保存失败，页面提供“重试保存预约”，不重复索取微信授权。
- 原生结果必须是对应模板的 `accept`；success 回调本身不代表授权。`getSetting` 的记住选择不能证明剩余次数，程序不显示虚构额度。
- `pending` 已预约，`sending` 正在提交，`sent` 微信接口已接收，`needs_permission` 需重新授权，`cancelled` 已取消，`failed` 失败，`unknown` 结果待确认，`skipped` 无对应日记录或预约过期。
- `sent` 不代表实际送达或已读。网络不确定不盲重试，以免重复消费一次授权；中断超过 10 分钟的发送标为待确认。明确凭证过期只重取令牌重试一次。43101 标为需重新授权。
- 取消只取消本项目的预约；微信通知权限需在微信设置中管理。再预约需要再次主动点击，程序不承诺永久订阅。

提醒接口要求有效小程序登录，只能管理本人预约。注销事务同时清除全部提醒表，数据库保护拦截注销后迟到写入；发送前复核账号仍存在且未停用。已经在微信网络请求中的消息不能撤回。

## 升级与验收

1. 已有库按顺序执行缺少的 `0012_reminders.sql`、`0013_daily_reminders.sql`。`0013` 只重建提醒任务表以允许 `daily` 类型，原样保留所有记录并停止待发送的旧周报预约；同步异常预约及用量、群信息不变。旧周报授权不自动变成日报授权，用户需要重新主动预约。数据库沿用 `week_start` 列作为报告日期锚点以保持旧版本部署兼容；日报 API 对外字段为 `report_day`。必须先迁移、后部署，并将配置键由 `weekly` 改为 `daily`，把摘要映射由 `tokens` 改为 `summary`。
2. 在 `server/wrangler.toml` 配置每五分钟 Cron，未选用并配置真实模板前总开关保持 0；不需要更新电脑端程序。
3. `node --test client/test-sync/*.test.mjs server/test/*.test.mjs miniprogram/test/*.test.cjs` 验证账号隔离、首次上报、去重、原生点击时机、保存失败、调度、注销及原有功能。
4. 在未配置环境验证“暂未开放”；在已配置环境使用正式接口验证实际私有模板 ID、字段对应的可预约状态、返回缓存和手动刷新。开发者工具不代替手机原生授权验收，不应删真实用户数据制造首次接入。
5. 模板选用并配置后用授权测试账号做手机验收：首次真实同步后询问一次；拒绝后不重弹；页面点击出现微信真实授权；接受／拒绝／总开关关闭分别检查；验证一次指定日期日报与连续故障通知、取消和再次预约。通过后再提交小程序审核与正式发布。

官方依据：[选用模板](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_addwxanewtemplate.html)、[公共模板列表](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_getpubnewtemplatetitles.html)、[订阅消息](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html)、[requestSubscribeMessage](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)、[发送接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_sendmessage)。按 2026-10-19 官方文档核对，平台实际类目与模板权限仍需在本小程序后台确认。

## 邮箱日报登记

提醒页增加「完整邮箱日报」入口，日报详情也可进入。按当前产品阶段只收集用户主动填写的邮箱，不接入发信服务、不验证或发送邮件，也不改变现有微信预约。界面区分“微信每次授权一条摘要”和“邮箱完整日报计划每日接收”，后者明确尚未开放。迁移、数据边界及验收见 [邮箱日报登记](email-registration.md)。
