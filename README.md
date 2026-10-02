# Token 群排名

一个微信小程序，看自己用 Claude Code、Codex、Cursor 这些 AI 编程工具烧了多少 token，也能在微信群里排个榜。一个微信群对应一张榜，不想上榜可以关掉排名，只自己看。

整个项目开源，包括电脑端同步器、服务端和小程序：https://github.com/xmasdong/tokenrank

<p align="center">
  <img src="miniprogram/assets/mini-program-code.jpg" width="220" alt="Token 群排名小程序码">
  <br>
  <b>微信扫码，看看你一天用了多少 token</b>
</p>

## 隐私

电脑端只读本机统计库，上传按天汇总的数字，并定期报告同步程序是否正常运行。

**会上传的**：每天的 token 数（总量、输入、输出、缓存读取、缓存写入）、调用次数、工具和模型名称、随机设备 ID，以及系统类型、程序版本、同步状态、检查时间、固定错误码和本机最新统计日期。心跳不上传原始错误信息或日志。

**不会上传的**：代码、对话内容、提示词、项目名、仓库名、文件路径、电脑名、用户名。

接入后在电脑上运行下面这条命令，可以预览用量报文，不上传。心跳字段可在 [`client/sync/health.js`](client/sync/health.js) 核对：

```sh
tokenrank rank push --full --dry-run
```

同步器的全部代码在 [`client/sync`](client/sync)，没有第三方运行依赖，读取统计库时是只读模式。服务端存了什么可以看 [`server/schema.sql`](server/schema.sql)。

不想被排名，可以在小程序「我的」里关掉“参与排名”。关掉后自己的用量照常能看，广场和所有群榜都不显示你，随时可以再打开。只想在某个群里不显示，就在那个群的榜单页关掉“在本群显示我的排名”，其他群和广场不受影响。

彻底停止使用，可以进入「我的 → 注销账号」。确认后删除云端账号、头像昵称、所有日期和设备的用量、分享快照、同步及重建记录、群成员关系和全部登录/接入凭证，并清空小程序本地缓存。多人群榜保留，发起权限转交给最早加入的其他成员（同一时间加入时按用户 ID 排序）；只有本人的群榜删除。旧电脑凭证无法继续回传。电脑原始日志和统计库不会被删除，已经保存或转发的图片无法撤回。

注销完成后不会自动登录；用户主动重新登录才可再次使用。网络中断导致结果不确定时，小程序会暂停自动登录并提供重试；必要时通过微信只查询现有账号确认结果，避免误创建新账号。

重新登录会创建空账号，需要重新填写头像昵称、加入群榜。重新接入原电脑后，会将电脑仍保留的全部历史用量上传到新账号；未重新接入前不会恢复任何用量，旧分享链接始终失效。

## 怎么工作的

```
本机 AI 工具日志 → token-watcher（开源采集器，负责读日志）→ 本机统计库
                                                      ↓ 只读
                                        TokenRank 同步器（client/sync，每 5 分钟）
                                                      ↓ 每日汇总
                                        Cloudflare Worker + D1（server）
                                                      ↓
                                        微信小程序（miniprogram）
```

读日志、识别 13 种 AI 编程工具的工作由 [luwill/token-watcher](https://github.com/luwill/token-watcher)（MIT）完成，这个项目不改它的代码，也不写它的数据库。安装脚本在本机没有 token-watcher 时会装官方最新稳定版，已有版本低于 1.8.2（旧版会重复统计 Codex 和 DSH）时先升级并重新计算。

总用量用 token-watcher 的 `total_tokens`，含缓存，按北京时间自然日统计。这是各人电脑自报的数字，只能当交流参考，不等于厂商账单。

## 目录

| 目录 | 内容 |
|---|---|
| `client/sync` | 电脑端同步器（当前 0.2.10）：接入、只读同步、心跳、超时恢复、更新重算、备份清理 |
| `client/bin/tokenrank.js` | 同步器命令行入口 |
| `server` | Cloudflare Worker、D1 表结构与迁移、安装和更新脚本 |
| `miniprogram` | 原生微信小程序 |
| `scripts` | 生成分享封面、用量卡预览等辅助脚本 |

## 本地开发

需要 Node.js 22.13+。

```sh
cd server
npm install
cp wrangler.toml.example wrangler.toml   # 填入自己的 D1 数据库和域名
npm run init-db:local
npm run dev
```

开发时可以设置 `ALLOW_DEV_LOGIN=1` 模拟微信登录；正式环境要去掉它，并用 `wrangler secret put` 配置 `WX_APPSECRET`，`WX_APPID` 写在 `wrangler.toml`。

用开发登录拿到的接入码连本地服务：

```sh
node client/bin/tokenrank.js connect http://127.0.0.1:8799 <接入码>
node client/bin/tokenrank.js rank push --full --dry-run
```

小程序用微信开发者工具导入 `miniprogram/`，本地联调时把 `utils/api.js` 里的 `BASE_URL` 改成本地地址。

## 测试与打包

```sh
(cd client && npm run pack:dist)   # 生成 server/public/dl 下的同步器安装包
node --test client/test-sync/*.test.mjs server/test/*.test.mjs miniprogram/test/*.test.cjs
```

安装脚本的测试会用到打包出来的安装包，所以先打包再跑测试。测试全部使用临时目录、合成数据和模拟的微信接口，不碰真实服务和线上数据。

## 部署

1. 新建数据库用 `server/schema.sql`；已有数据库只执行尚未执行过的迁移，当前最新 `0010_sync_agents.sql`。`0009` 是注销并发保护，`0010` 新增心跳表；必须先执行迁移再部署相应 Worker。当前正式库此前通过 SQL 文件逐项迁移，不要依赖 Wrangler 的迁移追踪表重跑全部迁移。
2. `cd client && npm run pack:dist`，然后在 `server` 目录 `npx wrangler deploy`，安装包和脚本作为静态资源一起发布。
3. 微信后台配置 request、uploadFile 合法域名；在「用户隐私保护指引」里声明“收集你的昵称、头像”和“选中的照片或视频信息”（头像选择的兜底）。
4. 上传小程序，真机验收后提交审核。

## 查看同步是否正常

同步器 0.2.10 起每 5 分钟发送独立心跳，启动和检查结束也报告状态。用量未变时仍有心跳，不再用最后上传时间推断程序是否运行。小程序接入页分别显示最近联系、最近检查、最近上传时间。

| 状态 | 依据 |
|---|---|
| 在线／无新增用量 | 已收到心跳，最近一次检查完成，无需再次上传相同用量 |
| 检查中 | 同步子进程正在读取或上传 |
| 检查失败 | 收到固定错误码，可区分读取失败、上传失败、版本过旧和超时 |
| 已主动关闭／服务已停止 | 电脑执行停用命令并成功通知服务器 |
| 暂时联系不到电脑 | 超过 15 分钟无心跳；不能进一步断定是关机、休眠、断网还是进程故障 |
| 旧版／状态未知 | 没有心跳记录；历史上传时间仍保留，不能据此判定用户关闭同步 |

在已配置 Wrangler 的项目目录查询正式环境：

```sh
node scripts/sync-status.mjs
node scripts/sync-status.mjs --json   # 含每台设备的版本、状态、检查时间与错误码
```

查询只读，使用操作者自己的 Cloudflare 权限，没有公开管理接口。列表包含曾完成同步或已有心跳的账号，默认按当前榜单来源设备展示，不把另一台在线设备当成当前用量来源在线。账号注销时同时删除心跳记录；重置接入码时清理旧状态。

后台进程由系统托管，异常退出后重启。读取和上传在独立子进程中执行，单次超过 15 分钟终止并在后续周期重试，心跳继续运行。电脑休眠时不会被唤醒。此状态监测的是 TokenRank 同步程序，不保证原版采集器持续采集；没有新增日志与原版停止采集仍需结合电脑状态检查。

旧用户需升级一次电脑端同步器才能上报心跳；服务端升级无法让旧脚本自动具备该能力。可重新复制新版小程序里的接入命令，只升级同步器时不会强制重算已达修复版本的原版统计；已有通用更新命令也会升级同步器，但会同时执行备份重算流程。

已接入的用户升级同步器（下面是正式服务的地址，自己部署时换成自己的域名）（会备份后从本机日志重算，并整体替换本账号的云端数据）：

```sh
curl -fsSL https://tokenrank.xmasdong.cn/update.sh | sh
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((irm 'https://tokenrank.xmasdong.cn/update.ps1')))
```

## 后台管理

发现明显伪造的数据，可以在 D1 里停用账号。停用后不出现在任何榜单，上传会被拒绝，数据保留，可以恢复：

```sh
npx wrangler d1 execute <数据库名> --remote --command "UPDATE users SET disabled_at = CAST(strftime('%s','now') AS INTEGER)*1000, disabled_reason = '原因' WHERE id = <用户ID>"
```

## 致谢

采集能力来自 [luwill/token-watcher](https://github.com/luwill/token-watcher)（MIT）。`client/` 最初从它 fork 而来，保留了原 LICENSE。

## 协议

[MIT](LICENSE)
