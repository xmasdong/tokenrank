# Token 群排名

一个微信小程序，看自己用 Claude Code、Codex、Cursor 这些 AI 编程工具烧了多少 token，也能在微信群里排个榜。一个微信群对应一张榜，不想上榜可以关掉排名，只自己看。

整个项目开源，包括电脑端同步器、服务端和小程序：https://github.com/xmasdong/tokenrank

## 隐私

电脑上只做一件事：读取本机统计库里按天汇总的数字，然后上传。

**会上传的**：每天的 token 数（总量、输入、输出、缓存读取、缓存写入）、调用次数、用了哪些工具和模型的名字、一个随机生成的设备 ID。

**不会上传的**：代码、对话内容、提示词、项目名、仓库名、文件路径、电脑名、用户名。

不用只看这段话，可以自己核对。接入后在电脑上运行下面这条命令，会把准备上传的内容原样打印出来，只预览，不上传：

```sh
tokenrank rank push --full --dry-run
```

同步器的全部代码在 [`client/sync`](client/sync)，没有第三方运行依赖，读取统计库时是只读模式。服务端存了什么可以看 [`server/schema.sql`](server/schema.sql)。

不想被排名，可以在小程序「我的」里关掉“参与排名”。关掉后自己的用量照常能看，广场和所有群榜都不显示你，随时可以再打开。

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
| `client/sync` | 电脑端同步器（当前 0.2.8）：接入、只读同步、更新重算、备份清理 |
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

1. 新建数据库用 `server/schema.sql`；已有数据库按顺序执行 `server/migrations/0001` 到 `0007`（都是非破坏性迁移）。
2. `cd client && npm run pack:dist`，然后在 `server` 目录 `npx wrangler deploy`，安装包和脚本作为静态资源一起发布。
3. 微信后台配置 request、uploadFile 合法域名；在「用户隐私保护指引」里声明“收集你的昵称、头像”和“选中的照片或视频信息”（头像选择的兜底）。
4. 上传小程序，真机验收后提交审核。

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
