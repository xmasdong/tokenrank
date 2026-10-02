# TokenRank 独立同步器

v0.2.10 为独立只读适配器，接入原版 [luwill/token-watcher](https://github.com/luwill/token-watcher)。Node.js 22.13+，无第三方运行依赖。

更换服务器、接入码或统计库后，会重新全量上传本机保留的历史用量，包含注销后重新接入的情况。上传中断可分批续传；重复执行同一账号的接入命令不会重传未变化的日期。

```text
AI 工具日志 → 原版 token-watcher → 原版 SQLite 统计库
                                       ↓ 只读快照
                               TokenRank 独立同步器
                                       ↓ 日聚合
                               榜单服务 → 微信小程序
```

## 接入

在小程序「连接电脑」页复制一条专属接入命令，脚本按以下顺序准备环境：

1. 检测 PATH、已保存的实际入口、npm 全局目录和 macOS 服务配置中的原版包。通过包名、仓库标识和实际入口识别，不执行未知同名命令。仅有统计库不代表已安装；旧版 TokenRank fork 不算原版。
2. 已有原版则复用，不重新安装、不升级、不降级、不替换其服务。已有数据先做只读兼容性检查，结构不兼容时停止；原版已装但还没有统计库时调用其 `scan` 初始化。
3. 原版缺失时，从官方 npm registry 安装最新稳定版（不低于修复重复统计的 1.8.2），调用原版完成首次采集；已有原版低于 1.8.2 时，接入后先升级并重新计算，升级前不上传用量。安装在用户目录，无须 sudo、不写全局 npm 或覆盖原有命令。
4. 新装原版自动开启采集后台，再配置 TokenRank 的独立只读同步服务、连接账号和回填历史。

原版默认统计库为 `~/.tokenmeter/tokenmeter.db`。新装包位置：macOS/Linux 为 `~/.local/share/token-watcher/node_modules/token-watcher`；Windows 为 `%USERPROFILE%/AppData/Local/TokenWatcher/node_modules/token-watcher`。首次采集可能需要几分钟。

自定义原版路径先将原版命令加入 PATH，或手动配置原版后再接入已有统计库：

```sh
node bin/tokenrank.js doctor --db /absolute/path/tokenmeter.db
node bin/tokenrank.js connect https://your-server.example <32位接入码> --db /absolute/path/tokenmeter.db
node bin/tokenrank.js install-agent
```

npm 发布后，仅注册 `tokenrank` 命令，不注册 `token-watcher` / `tokenwatcher` / `tokenmeter` 等原版命令。

## 更新统计内核并纠正已上传数据

已接入的用户在原电脑执行，无须重新输入接入码。一次完成内核和本地同步脚本升级、备份重建及本账号云端统计的完整替换；日常同步仍只读。

macOS / Linux：

```sh
curl -fsSL https://tokenrank.xmasdong.cn/update.sh | sh
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((irm 'https://tokenrank.xmasdong.cn/update.ps1')))
```

顺序：验证现有安装和后台归属 → 查询官方 npm 最新稳定版并下载 → 暂停同步与采集 → 备份统计库 → 升级原版和 `~/.tokenrank/app` 中的同步脚本 → 在副本中清除可从文件重建的事件与扫描游标 → 用原版 Scanner 从现存日志重新计算 → 校验并切换本地统计库 → 恢复采集 → 分批暂存全量数据 → 云端一次性清除本账号所有旧设备日统计及旧协议日统计、写入新结果 → 恢复每 5 分钟同步。

绑定的账号、服务器、设备 ID 与原服务配置保留。统计库通过 SQLite 快照备份，包含已提交的 WAL 数据，位于 `~/.tokenrank/backups/update-*/tokenmeter.db`；原版程序和同步脚本分别保留旧目录备份。本地重建不沿用旧扫描游标，设置、配额以及不能从本地日志重建的轮询来源（例如 Cursor）保留。重建中每 15 秒尽量输出已处理文件数和耗时。

最低修复版本为 1.8.2。若 npm 尚未发布该版本，下载上游已合并的固定源码 [`c5a84fc`](https://github.com/luwill/token-watcher/commit/c5a84fcc4a3ea63fb46a44a860b164999b9f7748)；npm 发布 1.8.2 或更高稳定版后自动优先使用 npm。不会把本机更新的稳定版降级。没有修改或拼接原版统计算法，安装脚本禁用 npm 生命周期脚本。

完整替换按账号隔离，包括云端有而重算结果中没有的旧日期，不依赖本机曾同步过哪些天。所有批次到齐并校验成功才通过 D1 事务切换，上传中断时继续显示原榜单；空重算结果也能明确替换为零。完成过修复的账号拒绝低于本次客户端/内核版本的回传，防止旧脚本覆盖回来。头像、昵称、群成员关系、其他账号及已发出的历史分享快照不受影响。

原始日志已删除的请求无法重新计算，其旧统计只保留在本机备份中；若已有用量但整个源目录不可用，会在切换前停止。文件解析失败也保留原库与云端数据、暂停同步；重算完成但网络回传失败则保留新本地库和 `replace_pending` 标记，后台继续完整替换重试。同设备重新执行命令可替代中断的暂存任务，其他设备不能抢占正在进行的重建。重建不会保证数字只降不升，最终以新版原版解析器的结果为准。

支持本项目一键接入生成的 macOS LaunchAgent、Windows 计划任务、Linux 用户 systemd 服务，以及配置官方 macOS 自启的原版。macOS 按实际加载的采集服务选择原版安装，兼容旧服务名 `com.tokenmeter.server` 和官方旧命令别名；保留原启动路径、参数和 plist。未加载且无法核实的历史 plist 会跳过，不删除或启动；两套原版同时加载时停止并提示用户确认。

已达到最新修复版本的源码检出或 Homebrew 安装可直接重算回传，无需替换内核程序。需要升级的源码检出、Homebrew Cellar、自定义数据库或无法核实的后台会在修改前停止，需按原管理方式处理；不申请管理员权限。Windows 和 Linux 的服务命令经过模拟测试，完整运行验收仍需对应平台。更新工具临时下载运行并永久更新本地同步脚本，无须重新登录。

## 隔离边界

- 日常同步通过 SQLite `readOnly: true` + `query_only` 打开原库，不调用原版 Store、扫描器、迁移、HTTP 控制接口或 CLI。安装准备与用户显式执行 `update-and-resync` 时调用原版采集与后台管理，维护过程与日常上传循环分离。
- 上传模块只查询事件的时间、工具、模型、Token 计数，以及显式 `migrate-config` 时的旧接入设置；它不读取 Cursor 令牌、代码、会话正文或项目路径。原版采集行为遵循原项目实现。
- TokenRank 的接入码、随机设备 ID、同步检查点、锁与日志仅写入 `~/.tokenrank/`。配置文件使用 0600 权限（Windows 继承用户目录 ACL）。
- 同步服务：macOS `com.tokenrank.sync`、Windows `TokenRankSync`、Linux `tokenrank-sync.service`。新装原版在 macOS 调用其原生 `install-agent`；Windows/Linux 分别使用独立的 `TokenWatcherForTokenRank` / `token-watcher-for-tokenrank.service` 启动未改动的原版 `serve --no-open`。已有原版沿用原有服务。
- 安装脚本先暂存并检查新包，替换前保留旧程序目录备份。不会删除原版数据目录。

## 升级旧版 TokenRank

v0.1.0 使用原版数据库和服务名。升级脚本先准备原版，再停用确认属于旧 TokenRank 的服务，随后启动新装原版的后台并接入同步。下载或首次采集失败时不会提前停用旧服务。

脚本仅在旧包名称和版本为 `tokenrank-client@0.1.0`，且服务入口确实指向该安装目录时，停用旧 TokenRank 后台；macOS 旧 plist 先备份到 `~/.tokenrank/migrations/`。指向原版安装的同名服务不会被移除。旧 `~/.tokenmeter` 数据及设置不会删除或迁移。若复用的已有原版服务此前被旧版覆盖，需要按原版说明恢复原版自启；脚本不会猜测或覆盖已有原版服务配置。

手动迁移旧接入配置可用 `tokenrank migrate-config`，它只读旧设置并写入独立配置；不自动停用任意来源的旧程序。通过 npm 安装的旧版需先确认服务入口归属再迁移，不能假定更新 npm 包能停掉旧进程。

## 同步口径与可靠性

v0.2.10 增加独立心跳：启动、检查完成及每 5 分钟报告状态。心跳仅含随机设备 ID、平台、同步器和内核版本、检查时间、最新统计日期、状态与固定错误码；无原始错误、代码、会话、路径或电脑名。`TOKENRANK_OFFLINE=1` / `TOKENMETER_OFFLINE=1` 同时关闭心跳和用量上传。`rank push --dry-run` 仅预览用量报文，本身不联网；已经运行的后台服务仍按其配置工作。

系统托管的监督进程保持心跳，单次只读同步在独立子进程中执行；15 分钟仍未结束会终止该子进程，下一周期重试。macOS KeepAlive、Linux Restart=always；Windows 保留进程退出码，异常重启并每 5 分钟检查任务是否需要启动，允许电池运行，不唤醒休眠电脑。不会停止或重启原版采集器。Windows/Linux 设置已用模拟命令验证，仍需相应系统实机验收。

心跳缓存单独写入 `~/.tokenrank/health/config.json`，不与同步子进程争写检查点。`rank status` 输出最近一次确认的心跳；这是历史状态，不保证当前正在运行。`rank off` 先在本机断开，再尽力发送关闭通知；网络不可用时服务器只能显示失联。`uninstall-agent` 和 `uninstall` 同样发送明确停止事件。小程序会分别显示最后联系、检查和上传时间，旧版无心跳时标为未知。

默认每 5 分钟读取同一个 SQLite 快照，包含已提交的 WAL 记录；扫描全部已保留历史以发现旧日期变更。北京时间日桶、主用量直接读取原版 total_tokens（含缓存），input_tokens、output_tokens、缓存读写单列。工具、模型按原版总量各保留每日用量前 8 项，服务端将未分类差额单列。

历史按最多 400 天且小于 450 KiB 分批发送，无总历史天数截断；每批得到完整确认后才保存检查点。失败批次留待重试，429 按 Retry-After 等待，401 提示重新接入。超出当前计数协议范围会停止同步并提示，不裁剪源数据。原版升级后缺少必要字段时停止上报，不修改或自动升级原库。

“无损”指原版安装和统计数据不被适配器改写，不代表两个产品展示完全一致，也不承诺未来数据库结构始终兼容。服务端按来源快照更新，支持历史下调或已删除日期归零；一个账号显示最近完成完整接入的电脑，多个独立设备尚不能相加。维度明细仍受前 8 项协议限制。

## 排查与卸载

```sh
tokenrank doctor                         # 只读兼容性检查
tokenrank rank status                    # 状态，不输出接入码
tokenrank rank push --full --dry-run     # 预览完整聚合报文，不联网
tokenrank rank push                      # 手动同步变化
tokenrank rank off                       # 断开后续上传
tokenrank uninstall-agent                # 仅停止并移除独立自启
tokenrank uninstall --purge-data         # 移除自启、清除独立配置文件
```

卸载命令保留程序、日志、备份和全部原版数据，包括安装脚本新装的原版和其采集后台。原版可独立使用；停用 macOS 原版可调用其 `uninstall-agent`，Windows 需停止并移除 `TokenWatcherForTokenRank`，Linux 使用 `systemctl --user disable --now token-watcher-for-tokenrank.service`。需要删除程序时：npm 安装用 `npm rm -g tokenrank-client`；脚本安装在停止服务后自行移除 `~/.tokenrank/app` 与脚本生成的 tokenrank 快捷命令。不会删除服务器历史。`TOKENRANK_OFFLINE=1` 或 `TOKENMETER_OFFLINE=1` 禁止上传。

## 开发与许可

`npm test` 验证独立适配器；`npm run pack:dist` 生成服务端静态分发包。包内仅包含 `sync/`、新入口、旧入口安全转接、清单、说明和 MIT LICENSE。

本目录最初从 token-watcher fork 而来，保留原版 MIT 许可和归属；早期 fork 的采集代码不在开源仓库中，采集能力来自独立安装的 token-watcher。适配器按 token-watcher 的 events 表字段读取。


安装编排命令 `prepare-upstream` / `start-upstream` 与只读上传循环分离；下载、扫描或后台启动失败会报错并停止后续接入，重跑可继续已完成的准备阶段。原版 `scan` 会按自身逻辑正常更新统计库；“同步器只读”不意味着原版采集过程中数据库不再变化。
