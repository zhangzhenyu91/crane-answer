# 微信群智能应答平台

监听微信群消息并按规则调用 Dify Workflow 的后端服务，附带 Web 管理端。

## 功能概览

- **位置消息触发**：群成员发送位置消息时，提取经纬度与发送者信息调用 Dify 工作流。
- **输电班组运维（treeWatch，内部键保留）**：树木排查 + 交跨排查 + 群内提问。树木排查与交跨排查均为全天候监听捕获，同一条规则内按消息内容**双漏斗分流**到各自日桶（树障桶 / 交跨桶，交跨桶 ID 加 `_crossing` 后缀、kind 隔离），命中的报送消息逐条调用对应 Dify 提取工作流（WF1 / WF1c）解析为结构化记录后**实时推送壹匣**（树障→`treehazard`、交跨→`crossing` ingest，含更正重推、撤回删除推送）；引用已捕获记录的消息按记录类型调用对应更正工作流（WF2 / WF2c）打补丁；「@监听账号 + 汇总」把当天两类汇总 xlsx 发群、「报送」两类各自整体重推，管理端可导出/补发/手动重推。群内提问为「@监听账号 + 文字/引用文字/图片/文件/视频/语音」，以该成员 wxid 对应的壹匣账号身份调壹匣 Call Me 提问，回答写成 md 文件发回群（见《群内提问》）。交跨排查为规则内可选子能力：每群配置「交跨提取 / 交跨更正」两个 Key 后启用，无群内提问、无辅证照片。

## 快速开始

```bash
npm install
npm start        # 或开发模式 npm run dev
```

访问 `http://localhost:3000`，默认管理员 `admin / Admin@123`（请通过环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 修改）。

Docker 部署见 `Dockerfile` 与 `docker/docker-compose.yml`，数据持久化在 `data/` 目录（挂载卷）。

## 发版流程

日常开发只本地提交，不推送、不打 tag。发版（需明确指令）：

1. `package.json` 升版本号并提交；
2. `git push origin main`（同步分支到 CNB，构建 `latest` + commit 短哈希标签镜像）；
3. `git tag vX.X.X && git push origin vX.X.X`（GitHub Actions `mirror.yml` 把 tag 回推到 CNB → CNB `tag_push` 流水线构建镜像：标签为 **Tag 名**（如 `v0.2.2`）+ 更新 `latest`，推 CNB 制品库与腾讯云 TCR，并自动创建同名 CNB Release）。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` / `HOST` | Web 服务监听 | `3000` / `0.0.0.0` |
| `DATA_DIR` | 数据目录 | `data` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 管理员账号 | `admin` / `Admin@123` |
| `WECHATPADPRO_TOKEN` | Cloud Access Token | 管理页配置 |
| `WECHATPADPRO_BOT_WXID` | 监听账号自身 wxid（输电班组运维必填） | 管理页配置 |
| `LOG_RAW_MESSAGE` | 为 `1` 时打印原始推送报文 | 关 |
| `YIXIA_BASE_URL` / `YIXIA_INGEST_TOKEN` | 壹匣后端地址 / 推送令牌（树障推送、交跨推送、聊天归档与群内提问必填，任一缺失均不可用；与壹匣同 Docker 网络时按容器名填，如 `http://j1toolkit`） | 空 |
| `CHATLOG_DIGEST_TIME` | 聊天日志兜底归档的每日执行时点（北京时间 HH:mm，到点把未被规则消费的消息总结推 WeKnora 知识库） | `23:26` |

## 输电班组运维（treeWatch）规则

> 内部键 `treeWatch` 保留（数据兼容），管理页展示名为「输电班组运维」，一条规则内包含**树木排查 + 交跨排查 + 群内提问**三大能力；交跨排查为可选子能力（每群配「交跨提取 / 交跨更正」Key 启用，见《捕获规则》《交跨记录报送》）。

> **v0.8.0 → 0.9.0 迁移**：v0.8.0 曾以独立 `crossWatch` 规则承载交跨排查，0.9.0 起并入 treeWatch 规则。启动时自动迁移：crossWatch 规则的每个群按群 ID 并入覆盖同群的 treeWatch 规则（提取 Key→交跨提取 Key、更正 Key→交跨更正 Key，目标群已有交跨 Key 不覆盖），随后删除该 crossWatch 规则并日志留痕；没有任何 treeWatch 规则覆盖的群降级丢弃并日志提示，需到管理页重新配置。

### 全天候监听与日桶

- **全天候捕获**：无需「开始/结束」指令，命中捕获条件的报送消息逐条捕获并**实时推送壹匣**；记录按**北京时间自然天**归入日桶（跨天自动换桶）。
- **双日桶分流**：同群树木排查与交跨排查各归各的日桶——树障桶 ID = `<群ID>_<yyyy-MM-dd>`（旧数据零迁移），交跨桶 ID = `<群ID>_<yyyy-MM-dd>_crossing`（桶对象 `kind='crossing'`，旧桶无 kind 视同树障）。普通文字先过**交跨闸**（命中 `交叉|跨越|交跨` 特征词 + 杆号，且该群配了交跨提取 Key）进交跨桶，否则过**树木闸**进树障桶；未配交跨 Key 的群，交跨报送记日志忽略、不回落树障闸。两类记录的线路省略补全、撤回定位、推送地址均按桶 kind 各自独立。
- **日桶自动销毁**：只保留**北京时间当天**的日桶——服务启动时与跨天时自动销毁前一天及更早的日桶（树障桶与交跨桶一并清除，桶内记录的辅证照片缓存与本地文件随之清理）。**取舍**：未推送成功（`pushStatus` 非 ok）的记录随桶销毁、此后不再补推——当日报送请关注推送失败告警及时处理；已推送壹匣的记录不受影响（壹匣侧留存）；删除重试队列（`pendingDeletes`）不受桶销毁影响，仍按原节奏补推。
- **汇总**（唯一汇总指令）：`@监听账号` 且内容含任一汇总关键词（默认：汇总，可自定义）→ 等待进行中的提取完成后，树障/交跨两类日桶**各自有记录就各发一份**当天汇总 xlsx 至群内（无记录的那类不发），统一回执「今日汇总表已发送」；两类都无记录回「今日暂无记录」。发表后可继续捕获/更正并再次汇总。
- **报送**（兜底补推指令）：`@监听账号` 发送「报送」→ 树障/交跨两类日桶**各自**把当天全部有效记录以 direct 模式整体重推壹匣（实时推送已逐条上送，重推幂等覆盖），回执合并为一条「今日树木 N 条、交跨 M 条已重新报送壹匣」（仅一类有记录时只提该类）；都无记录回「今日暂无记录」。
- 监听账号自身发送的消息一律不参与捕获。
- **群内反馈**（WeChatPadPro `Msg/Quote` 引用回复，发送失败仅记日志不打断流程）：每条报送提取完成落库后引用该报送回复「已记录」（引用的图片不可用时为「已记录，但未找到引用的图片」，辅证下载失败时为「已记录，但辅证照片下载失败」，记录均保留）；「引用记录发图片」挂接辅证后引用该图片回复「已添加辅证照片」（下载失败回复「辅证照片下载失败」）；更正生效后引用更正消息回复「已更正」；汇总 xlsx 通过 `SendFile` 发送至群内（汇总指令发表后附引用回执「今日汇总表已发送」/「今日暂无记录」）。实时推送壹匣失败时引用该报送回复「报送失败，请私聊报送班管及超管」（记录保留，仍由失败重扫补推；辅证/更正重推失败维持静默待重扫）。**群内一切反馈均由 crane-answer 自行发送**——壹匣 ingest 结果仅走壹匣站内通知（超管/班管），不经壹匣通知系统向微信群推送。
- **失败重试**：Dify 提取/更正调用失败时按 5 秒间隔重试 5 次；仍失败的记录丢弃并引用原消息回复「记录失败」，更正则回复「更正失败」。
- **撤回删除**：群内撤回系统消息（`kind=system`、`type=10002`）触发删除。实时推送的撤回事件**不含被撤消息 ID**（已实测确认），采用启发式匹配：撤回人 wxid（群场景下若事件 sender 为群 ID，则从「"昵称" 撤回了一条消息」解析并反查群成员）+ 3 分钟时间窗内（该群**所有日桶**，覆盖跨午夜边界），把**记录与缓存图片放进同一时间线取较新者**——撤到图片：已挂接记录的仅摘删该辅证照片（记录保留，反馈「已删除辅证照片」）并实时重推该条（evidence_photos 同步为剩余照片，清空即清除壹匣辅证），未挂接的静默清缓存（剥皮语义：保护旧记录不被后续误撤波及）；撤到记录：**先实时推送删除至壹匣**（deletes 契约见《报送壹匣》；失败入删除重试队列由失败重扫补推，不丢失），再删记录并**连带删除其全部辅证照片**（本地文件 + 缓存条目），反馈「已删除」（已撤回的消息无法再被引用，故用纯文本）；撤回人两者皆无时兜底群内时间窗内最近一条记录。竞态处理：撤回先于记录落库到达时暂存撤回事件，记录出现时以「撤回时间 ≥ 报送时间」补判删除（可区分"先撤回闲聊再报送"）；提取进行中记录被撤回的，提取返回后跳过落库与「已记录」反馈。局限：同一发送者连续报送时，撤回只能定位到其最近一条消息项，无法精确到被撤的那一条；「引用图片发文字」后撤回图片的，因记录（引用文字）比图片更新，会按撤记录处理（整条删除）。

### 捕获规则（树障/交跨双漏斗）

- **交跨闸（优先）**：文字命中 `交叉|跨越|交跨` 且含杆号（`43-44`、`25#-26#`、`29号` 等区间或单杆）→ 该群配了**交跨提取 Key** 时落交跨日桶并调 WF1c 提取终审（输出 `is_crossing=false` 丢弃）；未配 Key 记日志忽略、**不回落树障闸**。「引用图片发文字」同样先过交跨闸：命中则按交跨捕获且不挂辅证（交跨无照片机制），未命中维持树障带辅证逻辑。
- **树木闸**：交跨闸未命中再走原树障口径——本地正则初筛（`src/wechatpadpro/messageHandler.js`，宽进严出）：命中「杆号（`24-25`、`26#-27#`、`29塔底`、`56号` 等）且含特征词（`棵|垂距|垂直|超高|水平`）」，或「含树种词（`树|棵`）且含量测词（`水平|垂距|垂直|超高`）」；纯交叉跨越消息（含 `交叉|跨越` 且无 `棵`）排除。
- **Dify 提取工作流终审**：树障输出 `is_tree_hazard=false`、交跨输出 `is_crossing=false` 时丢弃。
- **省略线路名称自动补全**：报送消息省略线路名称（提取后 `line_name` 为空）时，按**该成员最近一次有效记录**的线路名称自动补全（树障按树障历史、交跨按交跨历史，各自独立；优先归一化匹配名，回退原始线路名；待删除记录不计），填入后走正常归一化匹配；引用回执注明「已记录（线路按你上次记录补为：X）」（与「但未找到引用的图片」等既有回执变体叠加），便于当场发现补错后引用更正线路；该成员无历史线路记录则不补，维持原状（上送后壹匣侧按缺线路跳过）。「引用图片发记录文字」路径同样生效。

### 辅证照片（图片挂接）

报送除纯文字外支持两种带图形态（Dify 提取/更正契约不变，照片不参评提取）：

- **引用图片发记录文字**：先往群里发照片，再**引用这张照片**发送报送文字。引用消息 `kind=app` 且 `app.category='quote'`，`app.reference.msg_type=3` 表明被引用者是图片（refermsg XML 兜底取 `<type>3</type>`），据此与「引用记录发文字 → 更正」分流。命中后文字走正常两层漏斗捕获，Dify 确认是树障后再下载被引用图片挂为该记录的辅证照片（判定非树障或初筛不过则不下载）。
- **引用记录发图片**：**引用一条已捕获的报送消息**发送照片（图片消息自身 `source`/`go_fields.Content` 的 refermsg 块携带被引用记录 svr_id）。命中记录即下载挂接并反馈「已添加辅证照片」，同一记录可挂多张；记录仍在提取中的等提取完成后挂接。图片消息无更正文本可言，**永不进更正工作流**（与更正的识别据此严格区分）。
- **多人配合记录**：报送文字引用的图片由他人所发（或为他人记录补挂辅证）时，该图片发送者记为协作供图人，发现人展示为「记录者 供图者」两人（单空格分隔，上限两人，alias 覆盖各自生效；其照片被撤回摘除后协作人同步失效）。
- **裸发图片**（不引用任何消息）：仅按 `svr_id` 缓存 CDN 下载参数备查（`data/image-cache.json` 持久化，重启不丢），不下载本体、不做反馈。

实现要点（2026-10-20 实测确认）：

- 图片消息（`kind=image`/`type=3`）的 `image.cdn_download_contexts[]` 自带 CDN 下载参数（`file_no` + `file_aes_key`，`variant=standard` 为原图）；**引用报文不含这些参数**，只能靠 `app.reference.svr_id` 关联 → 图片到达时按 `svr_id` 缓存参数，被引用时查表下载。
- 下载走云端网关 `POST {apiBase}/v1/Tools/CdnDownloadImage`（`X-Cloud-Access-Token` 鉴权，**参数必须小写** `file_no`/`file_aes_key`），返回 `Data.Image` 为服务端已解密的完整原图 base64；单次超时 180 秒（10M 级大原图经网关解密回传的究极保底），失败按 3 秒间隔重试 2 次，魔数校验 JPEG/PNG 后存 `data/attachments/evi-<svrId>.<jpg|png>`。（`GetMsgBigImg`/`DownloadImg` 等旧接口已实测不可用，勿回退。）
- 缓存条目未挂接记录时 3 天过期清理；挂接后随记录存续，记录被撤回/删除时连带清除（含本地文件）。
- 管理页「排查记录 → 日桶 → 记录明细」新增「辅证」列展示缩略图（点击看原图，经 `/api/inspection/attachments/:name` 鉴权读取，文件名白名单防穿越）。
- 报送壹匣时照片随记录上送（`records[i].evidence_photos`，base64 dataURL，见《报送壹匣》接口契约），壹匣侧写入自家 COS 作为辅证照片（kind=evidence）。

### 更正与状态

- 群内**引用**一条已捕获记录并发送内容（如「更正，6棵」「垂距6m」「已处理」），系统在**同群当天的树障/交跨两类日桶内**通过被引用消息的 svrid 定位记录（先树障桶、后交跨桶；svrid 不可用时以引用原文匹配兜底，引用套引用沿链回溯），并按记录所在桶类型调用对应更正提取工作流：树障记录用每群「更正提取 Key」（WF2，含 status 分支），交跨记录用「交跨更正 Key」（WF2c，仅 correct/none；未配置时记日志忽略、记录不受影响），判定意图：
  - `correct`：按 `patches` 原地更正字段，历史快照留存在 `correctionHistory`；
  - `status`：标记处理状态（如「已处理」）；
  - `none`：忽略。
- 仅处理引用当日日桶内记录的消息（按日桶范围定位，跨天的旧记录不进更正流程）。
- **并发约定**：报送消息先落库为「解析中」（pending）记录再调 Dify 提取；若提取尚未完成时收到指向该记录的引用更正，更正会等待提取完成后再触发更正工作流；提取失败或判定非树障时记录丢弃，等待中的更正随之忽略。汇总指令发表前会先等待当日所有进行中的提取完成，避免漏掉最后的报送。
- 推送字段说明（已通过真实报文实测确认）：引用消息为 `kind=app` 且 `app.category='quote'`，被引用信息在 `app.reference`（`svr_id`/`new_msg_id`/`content`）；消息全局 ID 取 `svr_id`/`new_msg_id`（`msg_id` 是本地小 ID）。注意 `reply_context` 是普通消息的自身回显，不能用于引用判定；监听账号自身消息以 `direction=outgoing` + `botWxid` 双重排除。

### 汇总导出与群内发送

- **群内发送**：「@监听账号 + 汇总关键词」随时把**当天**记录汇总 xlsx 发表（可反复；树障/交跨两类各有记录则各发一份，sheet 分别为「通道树木排查记录」「交叉跨越排查记录」）；管理页「排查记录」每个日桶也有「发至群聊」按钮可随时补发，发送成功的日桶标记「已发群」时间（sentAt，供「报送」幂等参考，不作为推送前提）。
- **本地下载**：管理页「排查记录」→ 日桶 → 导出 xlsx（按桶类型自动选择树障/交跨列头与文件名前缀）。

树障列序固定：序号 / 电压等级 / 线路名称 / 区段 / 树种 / 数量 / 距小号侧距离（m）/ 距大号侧距离（m）/ 直径（cm）/ 水平距离（m）/ 垂直距离（m）/ 发现人 / 发现时间。

交跨列序固定（14 列）：序号 / 电压等级 / 线路名称 / 跨越区段 / 跨越类型 / 交叉点距小号侧距离（m）/ 交叉点距大号侧距离（m）/ 交叉物距边线水平距离（m）/ 交叉垂直距离（m）/ 交叉角（°）/ 是否存在隐患 / 发现人 / 巡视时间 / 备注。

约定：

- **全部单元格为文本/常规格式**（numFmt `@`），日期、距离均不转数字格式；
- 排序：按线路表顺序分组，组内按起始杆号升序；线路未匹配的记录排最后并在导出中标「（待确认）」；
- 区段格式 `32#-33#`，单杆 `29#`，位置修饰（院内/弧垂等）尾随其后；
- 「超高」填入垂直距离列，形式为 `超高1.2`（区别于垂距纯数值）；
- 发现时间取报送消息日期，格式 `2026.10.18`；发现人优先取「发送者别名」。

### 报送壹匣

记录在捕获落库 / 更正 / 辅证变更后**实时推送**壹匣；整条记录被撤回删除时先推 deletes 再做本地删除。「报送」为兜底整体重推：

- **实时推送**（`mode=direct`）：单条 `records[]` 上送（辅证照片随记录，base64 dataURL）。失败不在群里反馈，落 `pushStatus='failed'` + `pushError` 静默待重扫；成功置 `pushStatus='ok'`。
- **失败静默重扫**：每 60 秒扫描所有日桶中 `pushStatus` 非 `ok` 且不在提取/推送进行中、距上次推送尝试 ≥5 分钟的记录逐条补推，错误只汇总打一条日志不刷屏。**删除事件同机制重试**：撤回删除推送失败的事件持久化进删除重试队列（`data/inspection-sessions.json` 顶层 `pendingDeletes`，重启不丢），同一节奏 ≥5 分钟补推 `pushDelete`，成功出队；前 20 次失败后降级为每天至多补推一次，失败日志前 3 次记单条、之后并入每天一条汇总（删除事件永不丢弃，直至补推成功）。记录重试跳过已删/待删记录（`deleting` 标记或存在删除事件），避免把已删记录重新 upsert 回壹匣。
- **群指令**（均需 `@监听账号`）：
  - 「汇总」→ 当天树障/交跨两类汇总 xlsx 发群（见上节）；
  - 「报送」→ 两类日桶**各自**把当天全部有效记录以 `direct` 模式整体重推（xlsx 照常随传存档），回执合并「今日树木 N 条、交跨 M 条已重新报送壹匣」；「报送修改」暂存模式已随会话制取消删除。
  - 「报送」为锚定判定（全等）且优先于关键词包含判定。
- **管理页**：「排查记录」→ 日桶详情弹窗底部「重新报送」按钮 = 重推该桶全部记录（`POST /api/inspection/sessions/:id/push`，direct）；失败记录行旁「重推」按钮 = 单条重推（`POST /api/inspection/sessions/:id/records/:rid/push`）。删除日桶仅删本地数据，不联动壹匣删除已上报记录。
- **归属班组**：treeWatch 规则表单「归属班组（壹匣）」（最长 32 字符），作为 `team_name` 上报；未配置时推送直接报错。
- **状态落库**：记录级 `pushStatus`（`pending`/`ok`/`failed`）/ `pushedAt` / `pushError`；整体重推另在日桶上记录 `pushedAt` / `pushMode` / `pushResult`（如 `ok: inserted=3 updated=1 photos_failed=0 deleted=0` 或 `fail: 原因`）。
- **调用策略**：单次超时 60 秒（辅证照片随记录上送、壹匣侧入 COS 耗时），失败按 3 秒间隔重试 2 次（共 3 次）。

**接口契约**：`POST {YIXIA_BASE_URL}/api/v1/treehazard/ingest`，请求头 `Content-Type: application/json`、`X-Ingest-Token: {YIXIA_INGEST_TOKEN}`，body：

| 字段 | 说明 |
|---|---|
| `session_id` | **日桶 ID**（`<群ID>_<yyyy-MM-dd>`，北京时间自然天） |
| `group_id` / `group_name` | 群 ID / 群备注 |
| `team_name` | 规则配置的归属班组 |
| `mode` | 实时推送恒为 `direct`（入库） |
| `review_note` | 审核备注（恒空串，保留字段） |
| `pusher` | 推送人 `{wxid, name}`（整体重推时为发送者/管理员，实时推送为空） |
| `xlsx_base64` | 汇总 xlsx 的 base64（仅「报送」整体重推随传，存档用；实时推送不带） |
| `records` | 有效记录数组（`status=active`），字段见下；实时推送时通常单条 |
| `deletes` | **新增可选**：`[{ crane_record_id, msg_id? }]`，与 `records` 允许同批并存。壹匣按 `(team_id, crane_record_id)` 定位（不限 session_id）删除记录行 + treehazard_photo 行 + COS 对象并写 `treehazard_deleted_id` 墓碑，找不到计 skipped 不报错。删除推送 body 仅含 `session_id` / `team_name` / `group_name` / `mode` / `deletes` |

**响应**：`ok` / `inserted` / `updated` / `skipped` / `photos_failed`，**新增 `deleted`** 计数。

`records[i]`：`crane_record_id`、`msg_id`、`voltage_level`、`line_name`（未匹配为空）、`line_name_raw`、`section`（同导出区段格式）、`pole_from` / `pole_to`（数字或 null）、`position_note`、`tree_species`、`tree_count`、`dist_small` / `dist_big`（距小号/大号侧距离）、`diameter`、`horizontal`、`vertical`（超高为 `超高x` 形式）、`finder_name`（别名优先）、`found_at`（`yyyy-MM-dd`）、`evidence_photos`（辅证照片数组，恒存在、可为空：`[{ msg_id, image }]`，`msg_id` 为来源图片消息 svr_id，`image` 为 jpeg/png base64 dataURL；壹匣侧整组替换该记录的 evidence 照片，空数组=清除，字段缺省=不动既有辅证）。

### 群内提问（@提问）

规则「群内提问」区块开启且配置「文件名生成工作流 API Key（WF3）」后生效。群成员 `@监听账号` 发送内容（或引用消息后 @），未命中「报送」全等与汇总关键词时进入提问流程：**以该成员 wxid 对应的壹匣账号身份**调壹匣 Call Me（WeKnora）提问，回答经 WF3 命名后写成 md 文件发回群；会话以「{归属班组}群内提问」命名。未启用（开关关闭或 Key 未配置）时，@ 未命中指令的消息静默忽略。

**指令清单**（均需 `@监听账号`，按优先级）：

1. 「报送」（全等）→ 当天全部有效记录整体重推壹匣；
2. 汇总关键词（默认「汇总」）包含 → 当天汇总 xlsx 发群；
3. 其余 → 群内提问（六形态）。

**提问六形态**：

| 形态 | 触发方式 | 上送内容与提问文本 |
|---|---|---|
| 纯文字 | `@监听账号` + 文字 | 提问文本=文字本身（为空则忽略） |
| 引用文字 | 引用一条文字消息后 `@监听账号` + 文字 | 提问文本=新文字 + 被引用正文（未附文字则只用被引用正文） |
| 引用图片 | 引用一张图片后 `@监听账号` + 文字 | 图片以 base64 dataURL 上送（jpeg/png，≤8MB、≤1 张）；提问文本=文字，缺省「请回答图片中的问题」 |
| 引用文件 | 引用一个文件后 `@监听账号` + 文字 | 文件下载后以 `{name, data_base64}` 上送（≤50MB）；提问文本=文字，缺省「请分析这个文件」 |
| 引用视频 | 引用一段视频后 `@监听账号` + 文字 | 视频转 mp4 上送；提问文本=文字，缺省「请分析这段视频」 |
| 引用语音 | 引用一条语音后 `@监听账号` + 文字 | 语音 silk 转 WAV 后上送；提问文本=文字 +「请回答语音中的问题」（无文字则只用该句） |

**模型指定**：提问文本中可用「请使用 / 调用 / 换成 / 切换到 + 模型名」指定模型（如『请使用K3』），由壹匣 Call Me 解析，指定时思考强度取最高档；模型不存在时回执当前可调用模型列表（见下表 `model_not_found`）。

**回执**：受理后引用提问回复「正在思考，请稍候」；回答落成 md 文件（标题=WF3 生成的文件名，含提问人/提问/时间与回答正文）经 `SendFile` 发回群。失败回执（引用提问回复）：

| 情形 | 群内回执 |
|---|---|
| wxid 未绑定 / 多绑壹匣账号（`user_not_found`） | 你的微信尚未绑定壹匣账号，请联系超管录入 |
| 无 Call Me 权限（`no_permission`） | 你暂无 Call Me 使用权限 |
| 指定模型不存在（`model_not_found`） | 未添加该模型，当前可调用模型：\<逐行列出\> |
| 文件类型不支持（`unsupported_file`） | 该文件类型暂不支持 |
| 文件超限（`file_too_large`） | 文件超过 50MB 上限 |
| 未配置壹匣对接 | 未配置壹匣对接 |
| 引用图片缓存缺失 | 图片已过期，请重新发送后引用 |
| 文件/视频参数解析不出 | 文件信息解析失败，请重新发送文件后引用 |
| 语音参数解析不出或转码失败 | 语音解析失败，请改用文字提问 |
| 引用了暂不支持的消息类型 | 暂支持文字、图片、文件、视频、语音提问 |
| 其它失败 | 提问失败：\<原因\> |
| md 文件发送失败 | 回答已生成但文件发送失败 + 回答前 500 字文本兜底 |

**ingest-chat 接口契约**：`POST {YIXIA_BASE_URL}/api/v1/callme/ingest-chat`，请求头 `Content-Type: application/json`、`X-Ingest-Token: {YIXIA_INGEST_TOKEN}`（与树障推送同值），body：

| 字段 | 说明 |
|---|---|
| `wxid` | 提问人 wxid（壹匣侧映射为该成员 Call Me 账号身份） |
| `query` | 提问文本（六形态拼装结果） |
| `session_title` | `{归属班组}群内提问` |
| `web_search` | 恒 `true` |
| `image` | 可选，base64 dataURL（jpeg/png/gif/webp，≤8MB、≤1 张） |
| `file` | 可选，`{ name, data_base64 }`（≤50MB，扩展名白名单=Call Me 上传白名单+mp4，语音以 voice.wav 上送） |

响应：成功 `{ ok: true, data: { session_id, session_title, answer, model_used: {id, name}|null } }`；失败 `{ ok: false, code, message, models? }`，`code` 枚举 `user_not_found` / `no_permission` / `model_not_found`（附 `models:[{id,name}]`）/ `unsupported_file` / `file_too_large` / `upstream_error`。**调用策略**：单次超时 320 秒（含模型思考），**不重试**（非幂等，避免重复扣费/重复回答）。

**群内提问媒体解析（待真机首验）**：文件/视频/语音三类媒体的报文字段形态与下载接口参数**尚无真实报文实测**（2026-10 首版按 WeChatPadPro 网关惯例小写驼峰实现）——文件 `POST /v1/Tools/DownloadFileBinary`（`app_id`/`attach_id`/`data_len`/`file_name`/`user_name` + `section{start_pos,data_len}` 分片 512KB）、视频 `POST /v1/Tools/DownloadVideo`（`compress_type`/`data_len`/`msg_id` + `section` 分片）、语音 `POST /v1/Tools/DownloadVoiceBinary`（`chat_room_name`/`client_msg_id`/`file_name`/`format`/`from_user_name`/`length`/`master_buf_id`/`msg_id`/`new_msg_id`/`to_user_name`，一次性取回）。`user_name`/`to_wxid`/`to_user_name` 确切语义未实测，按示例填充（文件 `user_name`=文件发送者 wxid；视频 `to_wxid`、语音 `to_user_name`=监听账号 wxid）；`app_id` 取报文自带值，无则用「接入设置 → 文件下载 AppID」（缺省 `ID_10001`）。真机首验方法：开启「打印原始推送报文」抓文件/视频/语音消息及其引用报文，核对 `app_id`、`attachid`、`msg_id`、`master_buf_id` 等字段形态后对齐 `src/wechatpadpro/fileStore.js` 解析器；识别为媒体但关键字段不全时，服务端日志会原样打印该条报文。

**语音转码与 silk-wasm 依赖**：语音下载内容先按魔数探测（`RIFF`=wav / `ID3`、`0xFFEx`=mp3 / `#!SILK_V3`=silk），wav/mp3 直出，silk 用 `silk-wasm`（WASM 实现，无原生编译）解码 PCM 后自行封装 44 字节 WAV 头（16bit 单声道）。`silk-wasm` 实际可用版本为 3.x（其 `decode(input, sampleRate)` 不回传采样率，但输出即按入参采样率重采样，WAV 头按微信语音常规 24kHz 写入，待真机试听对齐）；依赖缺失或转码失败回执「语音解析失败，请改用文字提问」。

### 聊天日志兜底归档（treeWatch 子能力）

规则级可选配置「聊天日志总结工作流 API Key（WF4）」（管理页「聊天日志总结」区块，留空=不启用，留空提交保持已保存值）。启用后每天定时（北京时间 `CHATLOG_DIGEST_TIME`，默认 `23:26`，60 秒循环到点触发、当天只跑一次）把当天收集的未消费消息总结成当日纪要、连同文档类文件推送壹匣写入 WeKnora 知识库（知识库 ID 配在壹匣侧 env `WEKNORA_CHATLOG_KB_ID`，默认即检修一班历史聊天记录库）。

**收集口径**：只收集**未命中任何规则（含未来新增规则）且非监听账号自身发送**的消息——在消息分发层做「消费标记」，走完所有分流后无人认领才进兜底：

- 文本消息（XML 形态内容跳过；引用消息的可见文字取 app.title）记入 `{time, senderName, content}`；**文档类文件消息**（`kind=file`，不限扩展名）记入当天文档清单（fileStore 下载参数引用 + 文件名 + 发送者 + 时间）——**即使被 fileStore 缓存了下载参数（供群内提问引用）也算未消费，照样登记留痕**；扩展名不在 WeKnora 可入库白名单内者打 `unsupported` 标记：不进上传清单，仅在纪要尾部「未归档」组留痕（见下）；
- 被消费（=不进兜底）：@监听账号的一切消息（指令/提问，未启用提问也静默算消费）、树障/交跨捕获、引用更正、撤回处理、图片/视频/语音等媒体备查；「交跨闸命中但未配交跨 Key 被忽略」也算消费（记日志不进兜底）；监听账号自身发送的一切内容（`direction=outgoing` 或 senderId=botWxid，天然排除「已记录/已更正」等回执与 Call Me 回答 md）、系统消息与撤回事件、私聊、非绑定群同样不进兜底；
- **扩展约定：新增规则 handler 需返回消费布尔**（由 `dispatchRules` 汇总取并集，同群多规则时同一条消息只收集一次；文档另按消息 svr_id 去重）——未消费消息才会进兜底归档，新增规则无需改动归档侧。
- 同群多规则时同一条消息只收集一次（文档按消息 svr_id 去重）。

**执行**：对每个「启用 treeWatch 规则且配了 digestApiKey」覆盖的群（多规则同群去重，取第一个有 Key 的规则的 Key）：

1. 当天该群 messages 与 documents 全空 → 跳过不写库；未配 digestApiKey 的群：当天数据保留、过期天丢弃；
2. 调 WF4：`runWorkflow(digestApiKey, { date, group, messages })`，messages 拼「HH:mm 昵称：内容」逐行，**最多 400 条、总字符 ≤20000**，截断时末尾补一行「（其余 N 条从略）」；
3. 组装 md：`# {群名} {date} 聊天纪要` + WF4 返回正文 + 末尾附「原始消息 N 条 / 归档文档 M 个：文件名清单」；存在不支持入库的文档时追加第二组「未归档文档 K 个（类型不支持入库）：文件名清单」留痕；
4. **先推 digest（kind=digest），再逐个文档**：仅白名单内扩展名可入库——`pdf doc docx ppt pptx xlsx xls epub mhtml csv md markdown txt json html`（与壹匣 callme 的 WeKnora 上传白名单一致；zip/rar/7z/dwg/ofd/音视频/图片/无扩展名不入库，仅留痕）。从 fileStore 取下载参数调 `DownloadFileBinary` 取二进制（>30MB 跳过记日志；参数缺失跳过该文档记日志，不阻断整批），base64 后逐个 `kind=file` 推送；某文档被壹匣以 `unsupported_file` 拒收时**不再重试该文件**（视为终态：移入「未归档」记录并落盘 `unsupported` 标记防反复重推），其余文件继续、整批不算失败；
5. 全成功 → 清理该群当天数据；部分失败 → attempts+1 保留，**次日启动时补跑一次存量**，attempts ≥3 丢弃并 error 日志。

**壹匣契约**：`POST {YIXIA_BASE_URL}/api/v1/chatlog/ingest`，头 `X-Ingest-Token: {YIXIA_INGEST_TOKEN}`，**一次调用只带一件**：

| 形态 | body |
|---|---|
| 纪要 | `{ date:'yyyy-MM-dd', group_name, kind:'digest', digest_md:'<markdown 正文>' }` |
| 文档 | `{ date, group_name, kind:'file', file:{ name:'原始文件名', data_base64:'<base64 纯内容，不带 dataURL 前缀>' } }`（单文件 ≤30MB） |

响应 `{ok:true}`；失败 `{ok:false,code,message}`（重试 2 次仍失败按上文物料计 attempts）。壹匣侧落库：知识库（`WEKNORA_CHATLOG_KB_ID`）下建 `/{yyyy}/{M.d}/` 文件夹（如 `/2026/10.23/`），纪要存为 `{群名}_{date}.md`，文档按原名；**同名先删后传**（幂等重跑）。

**WF4 · 聊天日志总结**：输入变量（String）：`date` / `group` / `messages`。输出：`summary`（String，Markdown 正文）。提示词（LLM 节点系统提示）：

```text
你是班组微信群聊天日志整理员。给定某天群内未被任何业务规则捕获的零散消息（每行「HH:mm 昵称：内容」），整理成一份当日纪要，只输出 Markdown 正文，不要输出任何多余文字。

要求：
- 按主题归并（工作安排/故障缺陷/物资备件/安全提醒/天气环境/其他事务等，按实际内容定），主题用二级标题，主题下要点列出关键信息并标注涉及人昵称
- 相对时间词（今天/明天/后天/下周等）结合日志日期换算为具体日期标注
- 纯闲聊、表情、客套、无信息量内容直接忽略；拿不准的宁可保留一句
- 全文不超过 800 字，不要开头大标题（标题由系统拼接）
```

### 线路表

管理页「线路表」维护（上传 xlsx 整体更新或在线增删改）。报送原文的线路名由项目侧归一化匹配（不归 Dify）：去 `110kV` 前缀、`吕汾1线→吕汾Ⅰ线` 罗马数字归一、补「线」字；多候选（如 `孝南` 可同时指 `孝南线`/`孝南T接线`）或无匹配时记录标「待确认」，在当日记录明细中下拉指定。树障与交跨记录共用同一张线路表。

### 交跨记录报送（/api/v1/crossing/ingest）

> 由 treeWatch 规则的交跨子能力推送：每群配「交跨提取 / 交跨更正」Key 后启用；树障推送契约见上《报送壹匣》。交跨排查能力 = 树木排查全量对齐 − 群内提问 − 辅证照片 − 处理状态：图片消息直接忽略（不缓存 CDN 参数），「引用图片发文字」命中交跨闸时不挂辅证，WF2c 无 status 分支。

实时推送 / 失败静默重扫（60 秒扫描、≥5 分钟重试间隔）/ 「报送」整体重推 / 管理端桶级与单条重推，机制与树障完全一致，仅 ingest 地址与记录字段集不同：

**接口契约**：`POST {YIXIA_BASE_URL}/api/v1/crossing/ingest`，请求头同树障（`Content-Type: application/json`、`X-Ingest-Token: {YIXIA_INGEST_TOKEN}`）。body 外层字段口径与树障一致（`session_id`（交跨日桶 ID）/ `group_id` / `group_name` / `team_name` / `mode` / `review_note`（恒空串）/ `pusher` / `xlsx_base64`（仅整体重推随传）/ `records` / `deletes`）；删除推送 body 仅含 `session_id` / `team_name` / `group_name` / `mode` / `deletes`，壹匣按 `(team_id, crane_record_id)` 定位删除并写墓碑，找不到计 skipped。

**响应**：`ok` / `inserted` / `updated` / `skipped` / `deleted`（交跨无辅证照片，故无 `photos_failed` 计数）。

`records[i]`（实时推送通常单条，纯文字无照片字段）：

| 字段 | 说明 |
|---|---|
| `crane_record_id` | 记录 ID（壹匣侧按 `(team_id, crane_record_id)` 幂等 upsert） |
| `msg_id` | 报送消息 svr_id |
| `voltage_level` | 电压等级（线路表匹配值，未匹配为空） |
| `line_name` | 归一化线路名（未匹配为空） |
| `line_name_raw` | 报送原文线路名 |
| `section` | 跨越区段（同导出区段格式 `43#-44#`） |
| `pole_from` / `pole_to` | 杆号（数字或 null） |
| `crossing_type` | 跨越物原文（如 `10kV5106三皇2回线主干17-18` / `35kV` / `通讯线`），未提空串 |
| `dist_small` / `dist_big` | 交叉点距小号/大号侧距离（m，side 判定同 WF1c） |
| `cross_horizontal` | 交叉物距边线水平距离（m，一般空） |
| `cross_vertical` | 交叉垂直距离（m，「垂距/垂直/距离」入此列） |
| `cross_angle` | 交叉角（°） |
| `has_hazard` | 是否存在隐患（原文，一般空） |
| `finder_name` | 发现人（别名优先） |
| `inspect_at` | 巡视时间（`yyyy-MM-dd`，由报送消息日期生成） |
| `remark` | 备注（无法归入上述字段的补充说明，如「下方跨越」） |

## Dify 工作流契约

输电班组运维（treeWatch）每条规则每个监听群最多配置 **4 个 Dify Workflow API Key**：WF1（树木提取，必填）+ WF2（树木更正提取，必填）+ WF1c（交跨提取，可空）+ WF2c（交跨更正提取，可空）；交跨两个 Key 留空 = 该群不启用交跨排查。另有规则级可空的 WF3（群内提问回答文件命名）。v0.8.0 的独立 crossWatch 规则会在启动时自动迁移为 treeWatch 规则群上的交跨 Key（见《输电班组运维（treeWatch）规则》章首迁移说明）。

### WF1 · 报送提取

> **模型不支持结构化输出时**（如 MiMo）：LLM 节点输出文本后接一个「代码执行」节点做 JSON 提取，脚本见 `design/dify-json-extract.py`（WF1/WF2/WF1c 各一段粘贴即用代码，WF2c 复用 WF2 段）。接线：LLM 输出 → 代码节点输入 `text`（String）；代码节点把各字段作为**独立输出变量**逐个声明（WF1 全部 String；WF2 的 `patches` 为 Object），结束节点同名输出。本项目端直接读取 `outputs` 下各字段（`result` 汇总形态也兼容）。脚本已兼容 markdown 围栏、首尾废话、尾随逗号、数字带单位（"50米"/"10棵"）等情况。

**输入变量**（均为 String）：`text`（报送原文）、`nickname`（发送者显示名）、`wxid`、`group`（群备注）。

**输出**：结束节点输出变量 `result`，为 JSON 字符串（或直接以各字段为输出变量），字段如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `is_tree_hazard` | Boolean | 是否树木类报送（交叉跨越、闲聊、天气等填 false） |
| `line_name` | String | 线路名称原文，原样提取不加工（如 `孝南线`/`孝南`/`110kV孝南线`/`胜下`） |
| `pole_from` / `pole_to` | Number | 杆号区间；`29塔底`/`56号塔底` 两值相同 |
| `position_note` | String | 位置修饰（塔底/院内/弧垂/苗圃等），无则空串 |
| `side` | String | `small`（小号侧/距小号杆）/ `big`（大号侧/距大号杆）/ `both`（两侧）/ `""` |
| `distance` | Number/String | 上述侧别距离（米），未提则空 |
| `tree_species` | String | 树种（杨树/柳树/槐树/核桃树/杂树），「不知什么树」填 `未知`，未提空串 |
| `tree_count` | Number/String | 数量（棵），未提则空 |
| `horizontal` | Number/String | 「水平」数值 |
| `vertical` | Number/String | 「垂距/垂直」数值 |
| `over_height` | Number/String | 「超高」数值，独立字段，**不要并入 vertical** |
| `diameter` | Number/String | 直径 cm，一般无，空串 |
| `status_note` | String | 处理状态（如「已削枝」），无则空串 |

**提示词（LLM 节点系统提示）**：

```text
你是输电通道树障排查信息提取员。从微信群的树障报送消息中提取字段，只输出 JSON，不要输出任何多余文字。

字段定义：
- is_tree_hazard: 布尔，是否树木类报送（交叉跨越、闲聊、天气预报等填 false）
- line_name: 线路名称原文，原样提取不加工（如"孝南线""孝南""110kV孝南线""胜下"）
- pole_from / pole_to: 杆号区间数字。"26#-#27"→26和27；"29塔底""56号塔底"→两值相同
- position_note: 位置修饰词（塔底/院内/弧垂/苗圃等），无则空串
- side: "small"(小号侧/距小号杆) | "big"(大号侧/距大号杆) | "both"(两侧) | ""(未提)
  判断规则："距26#xx"且区间为26-27 → small；"距27#xx"→ big；"距离29号50米"在29-30区间 → small
- distance: 上述距离数值（米），未提则空
- tree_species: 树种（杨树/柳树/槐树/核桃树/杂树），"不知什么树"→"未知"，未提→空串
- tree_count: 数量（棵），数字，未提则空
- horizontal: "水平"后数值
- vertical: "垂距/垂直"后数值
- over_height: "超高"后数值（独立字段，不要并入 vertical），未提则空
- diameter: 直径cm，一般无，空串
- status_note: 处理状态（如"已削枝"），无则空串

数值只填数字不带单位。拿不准的字段留空，禁止编造。

示例：
输入：孝南线29-30，距离29号50米，铁路大号侧这边杨树10棵，水平0，垂距3.7，经纬度如下
输出：{"is_tree_hazard":true,"line_name":"孝南线","pole_from":29,"pole_to":30,"position_note":"","side":"small","distance":50,"tree_species":"杨树","tree_count":10,"horizontal":0,"vertical":3.7}

输入：孝南线26#-27#，距26#10m，核桃苗圃，核桃树1棵，水平0，垂距2
输出：{"is_tree_hazard":true,"line_name":"孝南线","pole_from":26,"pole_to":27,"position_note":"苗圃","side":"small","distance":10,"tree_species":"核桃树","tree_count":1,"horizontal":0,"vertical":2}

输入：孝南28-29，距离小号侧10米，两侧柳树5棵，水平2，超高1.5
输出：{"is_tree_hazard":true,"line_name":"孝南","pole_from":28,"pole_to":29,"position_note":"","side":"small","distance":10,"tree_species":"柳树","tree_count":5,"horizontal":2,"over_height":1.5}

输入：孝南35#-36#，水平0，垂距2.2
输出：{"is_tree_hazard":true,"line_name":"孝南","pole_from":35,"pole_to":36,"position_note":"","side":"","distance":"","tree_species":"","tree_count":"","horizontal":0,"vertical":2.2}

输入：孝南线56号塔底，杨树1棵，水平0，垂距5
输出：{"is_tree_hazard":true,"line_name":"孝南线","pole_from":56,"pole_to":56,"position_note":"塔底","side":"","distance":"","tree_species":"杨树","tree_count":1,"horizontal":0,"vertical":5}

输入：孝南线43-44，下方跨越10kV5106三皇2回线主干17-18，距大号侧60m，交叉角度90度，垂距11m
输出：{"is_tree_hazard":false}

输入：110kV孝南线24#-25#，核桃树1棵，水平0，垂距1米，已削枝
输出：{"is_tree_hazard":true,"line_name":"110kV孝南线","pole_from":24,"pole_to":25,"position_note":"","side":"","distance":"","tree_species":"核桃树","tree_count":1,"horizontal":0,"vertical":1,"status_note":"已削枝"}
```

### WF2 · 更正提取

**输入变量**（均为 String）：`correction_text`（引用者新发的内容）、`quoted_text`（被引用消息原文）、`current_record`（该记录当前已解析字段的 JSON 字符串）、`nickname`、`wxid`。

**输出**：`result`，JSON 字符串：

| 字段 | 说明 |
|---|---|
| `action` | `correct`（更正字段）/ `status`（状态反馈）/ `none`（无关闲聊） |
| `patches` | action=correct 时的字段补丁对象，键名与 WF1 一致，如 `{"tree_count": 6}` |
| `status` | action=status 时的状态文字（如「已处理」） |
| `reason` | 一句话判断依据 |

**提示词**：

```text
你是输电通道树障排查记录的更正判定员。群内成员引用了一条已捕获的报送记录并发送了新内容，请判断其意图，只输出 JSON。

输入包含：correction_text（新内容）、quoted_text（被引用的报送原文）、current_record（该记录当前已解析字段的 JSON）。

输出字段：
- action: "correct"(更正字段) | "status"(处理状态反馈) | "none"(无关内容)
- patches: action 为 correct 时给出要修改的字段及新值，键名与 current_record 一致（如 {"tree_count": 6}、{"vertical": 6}）；只输出需要变更的字段
- status: action 为 status 时填状态文字（如"已处理"）
- reason: 一句话说明判断依据

规则：
- "更正，6棵"→ {"action":"correct","patches":{"tree_count":6}}
- "垂距6m"→ {"action":"correct","patches":{"vertical":6}}
- "已处理"→ {"action":"status","status":"已处理"}
- 补充说明类（如"再往24方向走10m，有更近的2棵，1.5"）若语义是修正原记录字段 → correct 并给出 patches；若与记录无关 → none
- 纯表情、收到、闲聊 → none
- 拿不准时输出 none，禁止编造 patches
```

### WF1c · 交跨报送提取

> 模型不支持结构化输出时的「代码执行」节点脚本见 `design/dify-json-extract.py`（WF1c 段，WF2c 复用 WF2 段），接线与输出声明口径同 WF1/WF2。

**输入变量**（均为 String）：`text`（报送原文）、`nickname`、`wxid`、`group`。

**输出**：结束节点输出变量 `result`，为 JSON 字符串（或直接以各字段为输出变量），字段如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `is_crossing` | Boolean | 是否交叉跨越类报送（树木树障、闲聊、天气等填 false） |
| `line_name` | String | 线路名称原文，原样提取不加工（如 `孝南线`/`孝南`/`110kV孝南线`/`昌城`） |
| `pole_from` / `pole_to` | Number | 跨越区段杆号；单杆两值相同 |
| `crossing_type` | String | 跨越物原文（厂区/10kV线路/通讯线/公路/铁路等），未提空串 |
| `side` | String | `small`（交叉点距小号侧）/ `big`（距大号侧）/ `""`（未提） |
| `distance` | Number/String | 上述距离（米），未提则空 |
| `cross_horizontal` | Number/String | 交叉物距边线水平距离（米），一般空 |
| `cross_vertical` | Number/String | 交叉垂直距离（米），「距离/垂距」入此列 |
| `cross_angle` | Number/String | 交叉角（度） |
| `has_hazard` | String | 是否存在隐患原文，未提空串（一般空） |
| `remark` | String | 备注，无则空串 |

**提示词（LLM 节点系统提示）**：

```text
你是输电线路交叉跨越排查信息提取员。从微信群的交跨排查报送消息中提取字段，只输出 JSON，不要输出任何多余文字。

字段定义：
- is_crossing: 布尔，是否交叉跨越类报送（树木树障、闲聊、天气预报等填 false）
- line_name: 线路名称原文，原样提取不加工（如"孝南线""昌城""110kV孝南线"）
- pole_from / pole_to: 跨越区段杆号区间数字。"25#-26#"→25和26；"43-44"→43和44；只提单杆时两值相同
- crossing_type: 跨越物（被交叉对象）原文描述，如"10kV5106三皇2回线主干17-18""35kV""380V""厂区""通讯线""公路""铁路""河流""房屋"，未提则空串
- side: "small"(交叉点距小号侧/距小号杆) | "big"(距大号侧/距大号杆) | ""(未提)
  判断规则："距大号侧60m"→big；"距25#xx"且区间为25-26→small
- distance: 上述交叉点距小号/大号侧距离数值（米），未提则空
- cross_horizontal: 交叉物距边线水平距离（米），"边线水平x"后数值，未提则空（一般不提）
- cross_vertical: 交叉垂直距离（米），"垂距x"/"垂直x"/"距离x"后数值
- cross_angle: 交叉角（度），"角度90"/"交叉角度90度"/"交叉角90"→90
- has_hazard: 是否存在隐患，原文摘录（如"是"/"否"），未提则空串（一般不提）
- remark: 备注（无法归入上述字段的补充说明，如"下方跨越"），无则空串

数值只填数字不带单位。拿不准的字段留空，禁止编造。

示例：
输入：孝南线43-44，下方跨越10kV5106三皇2回线主干17-18，距大号侧60m，交叉角度90度，垂距11m
输出：{"is_crossing":true,"line_name":"孝南线","pole_from":43,"pole_to":44,"crossing_type":"10kV5106三皇2回线主干17-18","side":"big","distance":60,"cross_horizontal":"","cross_vertical":11,"cross_angle":90,"has_hazard":"","remark":"下方跨越"}

输入：昌城线25#-26#，跨越35kV，交叉角度90度，距离6
输出：{"is_crossing":true,"line_name":"昌城线","pole_from":25,"pole_to":26,"crossing_type":"35kV","side":"","distance":"","cross_horizontal":"","cross_vertical":6,"cross_angle":90,"has_hazard":"","remark":""}

输入：昌城21#-22#，跨越380V，角度90，距离6.4
输出：{"is_crossing":true,"line_name":"昌城","pole_from":21,"pole_to":22,"crossing_type":"380V","side":"","distance":"","cross_horizontal":"","cross_vertical":6.4,"cross_angle":90,"has_hazard":"","remark":""}

输入：孝南线15#-16#，跨越通讯线，交叉点距小号侧30米，垂距8，角度75，通讯杆老化
输出：{"is_crossing":true,"line_name":"孝南线","pole_from":15,"pole_to":16,"crossing_type":"通讯线","side":"small","distance":30,"cross_horizontal":"","cross_vertical":8,"cross_angle":75,"has_hazard":"","remark":"通讯杆老化"}

输入：110kV孝南线24#-25#，核桃树1棵，水平0，垂距1米
输出：{"is_crossing":false}
```

### WF2c · 交跨更正提取

**输入变量**（均为 String）：`correction_text`（引用者新发的内容）、`quoted_text`（被引用消息原文）、`current_record`（该记录当前已解析字段的 JSON 字符串）、`nickname`、`wxid`。

**输出**：`result`，JSON 字符串：

| 字段 | 说明 |
|---|---|
| `action` | `correct`（更正字段）/ `none`（无关闲聊）；交跨无处理状态，不返回 `status` |
| `patches` | action=correct 时的字段补丁对象，键名与 WF1c 一致，如 `{"cross_vertical": 12.5}` |
| `reason` | 一句话判断依据 |

**提示词**：

```text
你是输电线路交叉跨越排查记录的更正判定员。群内成员引用了一条已捕获的交跨记录并发送了新内容，请判断其意图，只输出 JSON。

输入包含：correction_text（新内容）、quoted_text（被引用的报送原文）、current_record（该记录当前已解析字段的 JSON）。

输出字段：
- action: "correct"(更正字段) | "none"(无关内容)
- patches: action 为 correct 时给出要修改的字段及新值，键名与 current_record 一致（如 {"cross_vertical": 12.5}、{"cross_angle": 60}）；只输出需要变更的字段
- reason: 一句话说明判断依据

规则：
- "更正，垂距12.5"→ {"action":"correct","patches":{"cross_vertical":12.5}}
- "角度是60度"→ {"action":"correct","patches":{"cross_angle":60}}
- "跨越的是10kV三皇线"→ {"action":"correct","patches":{"crossing_type":"10kV三皇线"}}
- 补充说明类若语义是修正原记录字段 → correct 并给出 patches；若与记录无关 → none
- 纯表情、收到、闲聊 → none
- 拿不准时输出 none，禁止编造 patches
```

### WF3 · 回答文件命名（群内提问）

群内提问回答落成 md 文件前调用，为回答文件生成标题。每个规则在「群内提问」区块单独配置本工作流的 API Key。

**输入变量**（均为 String）：`question`（提问文本）、`answer`（回答正文，截取前 4000 字）。

**输出**：`filename`（String），纯文本文件名（不含扩展名）；兼容结束节点以 `result`（JSON 字符串/对象）输出时取其中 `filename` 字段。项目侧会剔除 `\ / : * ? " < > |` 与换行并截 40 字；输出为空或调用异常时兜底「群内问答-yyyyMMdd-HHmm」。

**提示词**（LLM 节点·系统提示）：

```text
你是文件名生成器。根据用户给出的提问与回答内容，概括主题并生成一个简洁的中文文件名。严格遵守：只输出文件名本身；不含扩展名、不含引号/书名号/括号注解、不含换行和任何解释；不超过 20 个汉字；不得包含 \ / : * ? " < > | 字符；除日报/周报/月报类内容外不带日期。
```

**用户提示词**：

```text
提问：{{question}}

回答：{{answer}}
```

End 节点输出变量 `filename`（String）= LLM 输出文本；建议低延迟小模型、temperature≈0.2。

## 位置与图片存证

报送消息中常出现「经纬度如下」后紧跟位置消息的用法，最终汇总表不含经纬度列，位置信息不落库。图片存证（辅证照片）已实现：「引用图片发记录文字」与「引用记录发图片」两种形态挂接辅证，下载方式、缓存、撤回连带删除与报送契约见《树木排查（treeWatch）规则 · 辅证照片》节；汇总 xlsx 列序保持不变（不加附件列），照片随记录在实时推送与「报送」重推时以 `evidence_photos` 上送壹匣。

## 目录结构

```
src/
  index.js                 入口：初始化、HTTP 服务、壹匣推送失败重扫
  server.js                Express 路由（认证、设置、规则、别名、线路表、排查记录）
  settings.js              设置与规则持久化（data/settings.json）
  dify.js                  Dify workflow 调用封装（blocking，inputs 透传）
  lines.js                 线路表存储、xlsx 解析、线路名归一化匹配
  ask/
    groupAsk.js            群内提问：六形态装配、调壹匣 Call Me、WF3 命名后 md 文件发回群
  inspection/
    store.js               排查日桶与记录持久化（data/inspection-sessions.json，旧会话结构启动时自动迁移）
    export.js              汇总 xlsx 导出（全文本单元格）
    deliver.js             生成 xlsx 并发送至群聊
    push.js                记录/删除实时推送与整体重推壹匣（xlsx base64 附档、超时重试）；postIngestWithRetry 兼供群内提问调 ingest-chat
  wechatpadpro/
    client.js              WebSocket 通道（换票、重连、心跳）
    messageHandler.js      消息分发：位置触发 + 输电班组运维（treeWatch）全天候捕获（树障/交跨双漏斗分流、辅证照片双向引用挂接、双桶引用更正路由、撤回分流、群内提问分流、媒体参数缓存）
    memberResolver.js      发送者显示名解析（别名 > 群成员接口 > wxid）
    imageStore.js          群图片 CDN 参数缓存与下载（data/image-cache.json + data/attachments/）
    fileStore.js           文件/视频/语音下载参数缓存与下载、silk→WAV 转码（data/media-cache.json，字段形态待真机首验）
    sender.js              WeChatPadPro 消息发送（SendTxt / Quote / SendFile）
```
