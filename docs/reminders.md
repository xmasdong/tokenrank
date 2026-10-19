# 小程序消息提醒

## 当前状态

消息模板尚未申请，正式环境总开关 `WX_REMINDERS_ENABLED=0`。页面入口可使用，但两项均显示“暂未开放”，不会发送消息，也不将模拟授权写成真实预约。

- 我的 → 消息提醒；周报 → 下期周报提醒；接入页 → 同步异常提醒设置。
- 首次获取接入命令时记录“等待首次上报”。收到真实 `last_report_at` 后才有询问资格，零 Token 也算同步成功。已有历史数据的用户、重新同步、重装或重置接入码不产生新的资格。
- 仅在真实模板可用时，主动弹“电脑已接入”，选择“设置提醒”进入设置页。之后必须点击页面中的“预约提醒”，才同步调用 `wx.requestSubscribeMessage`。取消不影响使用，也不反复询问；与现有隐私说明弹窗排队，离页或账号变化则跳过。
- 确认或取消后保存账号级已询问状态；客户端按账号持久去重，即使确认请求断网也不因轮询重复弹。该设备离线且确认未到服务器时，其他设备仍可能询问一次。
- 不依赖有无头像、昵称、用量大于零判断接入成功。公开分享记录页不插入接入询问。

## 申请与配置

在当前小程序的微信公众平台申请可用类目内的**一次性订阅消息**，分别用于周报、同步异常。能否申请及字段由平台实际返回决定，程序没有预设通用模板编号。申请前不要开启开关。普通一次订阅不能承诺每天／每周无限推送。

申请通过后把两项真实配置保存为 `WX_REMINDER_TEMPLATES`（JSON 对象；可用 `wrangler secret put WX_REMINDER_TEMPLATES` 输入，勿将生产凭证提交到仓库）。顶层键为 `weekly`、`sync_error`，各包含：

| 字段 | 内容 |
|---|---|
| `template_id` | 该小程序平台实际申请通过的模板 ID |
| `fields` | 实际关键词编号到程序数据字段的映射，不能按编号猜模板内容 |

可映射字段（未列出的值不允许）：

| 类型 | 数据字段 | 示例内容／口径 |
|---|---|---|
| 周报 | `title`、`range`、`tokens`、`active_days`、`reported_days`、`requests`、`time` | 个人周报、10.12–10.18、2.58 亿、活跃天数、已上报天数、请求数、发送北京时间 |
| 异常 | `title`、`reason`、`platform`、`duration`、`time` | 同步异常、安全错误描述、macOS／Windows、持续分钟数、发送北京时间 |

关键词名支持 `thingN`、`numberN`、`timeN`、`dateN`、`phraseN`、`character_stringN`。必须匹配已批准模板的实际语义与类型：例如 `tokens` 带中文单位应映射文本字段，天数／分钟数映射 number，时间映射 time，不能把区间映射 date。发送前限制 thing 20 字、phrase 5 字和 number 类型；不合规会记录失败而不发送。不同提醒必须用不同模板 ID。只配置一项时仅开放该项。

设置 `WX_REMINDERS_ENABLED="1"` 并部署后，再进行真实授权与发送验收。`WX_APPID`、`WX_APPSECRET` 复用现有真实微信配置。服务端通过 stable_token 获取微信访问凭证，不返回给小程序。

## 调度与状态

Cloudflare Cron `*/5 * * * *` 每五分钟检查已预约任务；关闭总开关时不读提醒任务、不发送。

- 周报：预约当前北京时间自然周的报告，下一周一 09:00 到期。报告读取本人选中设备的真实统计，不混入旧设备；无本周同步记录则跳过，不伪造零用量。迟到调度会在下一次检查执行。
- 同步异常：仅本人选中设备明确 `error`、最近 15 分钟仍有心跳、故障连续至少 15 分钟，且预约后已持续 15 分钟才触发。一日最多一次；健康／主动停止清除连续故障，心跳中断超过 15 分钟重新计时。失联、休眠、没有用量变化或主动停用不触发。重置接入码清除旧故障状态。
- 每项保留一条当前预约，用户接受授权后提交唯一 `request_id`；重试保存同一请求不会增加预约或复活已取消任务。发送中不接受取消或替换。原生授权接受后服务端保存失败，页面提供“重试保存预约”，不重复索取微信授权。
- 原生结果必须是对应模板的 `accept`；success 回调本身不代表授权。`getSetting` 的记住选择不能证明剩余次数，程序不显示虚构额度。
- `pending` 已预约，`sending` 正在提交，`sent` 微信接口已接收，`needs_permission` 需重新授权，`cancelled` 已取消，`failed` 失败，`unknown` 结果待确认，`skipped` 无本周记录。
- `sent` 不代表实际送达或已读。网络不确定不盲重试，以免重复消费一次授权；中断超过 10 分钟的发送标为待确认。明确凭证过期只重取令牌重试一次。43101 标为需重新授权。
- 取消只取消本项目的预约；微信通知权限需在微信设置中管理。再预约需要再次主动点击，程序不承诺永久订阅。

提醒接口要求有效小程序登录，只能管理本人预约。注销事务同时清除全部提醒表，数据库保护拦截注销后迟到写入；发送前复核账号仍存在且未停用。已经在微信网络请求中的消息不能撤回。

## 升级与验收

1. 已有库只执行 `server/migrations/0012_reminders.sql`，是新增表／索引／触发器，不会清空用量和群信息。必须先迁移、后部署。
2. 在 `server/wrangler.toml` 配置每五分钟 Cron，未获模板前总开关保持 0；不需要更新电脑端程序。
3. `node --test client/test-sync/*.test.mjs server/test/*.test.mjs miniprogram/test/*.test.cjs` 验证账号隔离、首次上报、去重、原生点击时机、保存失败、调度、注销及原有功能。
4. 当前生产接口和开发者工具只能验证“暂未开放”和正常业务不受影响；不应删真实用户数据制造首次接入。
5. 模板申请后用授权测试账号做手机验收：首次真实同步后询问一次；拒绝后不重弹；页面点击出现微信真实授权；接受／拒绝／总开关关闭分别检查；验证一次周报与连续故障通知、取消和再次预约。通过后再提交小程序审核与正式发布。

官方依据：[订阅消息](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html)、[requestSubscribeMessage](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)、[发送接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_sendmessage)。按 2026-10-19 官方文档核对，平台实际类目与模板权限仍需在本小程序后台确认。
