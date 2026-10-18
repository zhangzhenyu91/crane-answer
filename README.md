# 微信群智能应答平台

监听微信群消息并按规则调用 Dify Workflow 的后端服务，附带 Web 管理端。

## 功能概览

- **位置消息触发**：群成员发送位置消息时，提取经纬度与发送者信息调用 Dify 工作流。
- **树木排查（会话捕获）**：按「@监听账号 + 关键词」开启/结束记录会话，会话内命中的报送消息逐条调用 Dify 提取工作流解析为结构化记录，引用已捕获记录的消息调用更正工作流打补丁，最终在管理端导出汇总 xlsx。

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
| `WECHATPADPRO_BOT_WXID` | 监听账号自身 wxid（树木排查必填） | 管理页配置 |
| `LOG_RAW_MESSAGE` | 为 `1` 时打印原始推送报文 | 关 |

## 树木排查（treeWatch）规则

### 会话生命周期

- **开始**：群内 `@监听账号` 且内容含任一开始关键词（默认：开始记录树障 / 开始记录 / 开始排查）。
- **结束**：`@监听账号` 且内容含任一结束关键词（默认：结束 / 汇总 / 结束记录）；或自最后一条捕获起超时（默认 12 小时，规则可配 1-72 小时）自动结束；或管理页手动结束。
- 每个群同时仅一个活动会话；监听账号自身发送的消息一律不参与捕获。
- **群内反馈**（WeChatPadPro `Msg/Quote` 引用回复，发送失败仅记日志不打断流程）：会话开始时引用指令消息回复「开始记录树障信息」；每条报送提取完成落库后引用该报送回复「已记录」；更正生效后引用更正消息回复「已更正」；会话结束时将汇总 xlsx 通过 `SendFile` 发送至群内。
- **失败重试**：Dify 提取/更正调用失败时按 5 秒间隔重试 5 次；仍失败的记录丢弃并引用原消息回复「记录失败」，更正则回复「更正失败」。

### 捕获规则（两层漏斗）

1. **本地正则初筛**（`src/wechatpadpro/messageHandler.js`，宽进严出）：命中「杆号（`24-25`、`26#-27#`、`29塔底`、`56号` 等）且含特征词（`棵|垂距|垂直|超高|水平`）」，或「含树种词（`树|棵`）且含量测词（`水平|垂距|垂直|超高`）」；纯交叉跨越消息（含 `交叉|跨越` 且无 `棵`）排除。
2. **Dify 提取工作流终审**：输出 `is_tree_hazard=false` 时丢弃。

### 更正与状态

- 群内**引用**一条已捕获记录并发送内容（如「更正，6棵」「垂距6m」「已处理」），系统通过被引用消息的 svrid 精确定位记录（svrid 不可用时以引用原文匹配兜底，引用套引用沿链回溯），调用更正提取工作流判定意图：
  - `correct`：按 `patches` 原地更正字段，历史快照留存在 `correctionHistory`；
  - `status`：标记处理状态（如「已处理」）；
  - `none`：忽略。
- 仅处理引用本会话时间窗内记录的消息。
- **并发约定**：报送消息先落库为「解析中」（pending）记录再调 Dify 提取；若提取尚未完成时收到指向该记录的引用更正，更正会等待提取完成后再触发更正工作流；提取失败或判定非树障时记录丢弃，等待中的更正随之忽略。会话结束指令与群内发送前会先等待本会话所有进行中的提取完成，避免漏掉最后的报送。
- 推送字段说明（已通过真实报文实测确认）：引用消息为 `kind=app` 且 `app.category='quote'`，被引用信息在 `app.reference`（`svr_id`/`new_msg_id`/`content`）；消息全局 ID 取 `svr_id`/`new_msg_id`（`msg_id` 是本地小 ID）。注意 `reply_context` 是普通消息的自身回显，不能用于引用判定；监听账号自身消息以 `direction=outgoing` + `botWxid` 双重排除。

### 汇总导出与群内发送

- **群内发送**：会话被「@监听账号 + 结束关键词」结束时，自动生成汇总 xlsx 并通过 WeChatPadPro `SendFile` 接口发送至该群（无记录的空会话跳过）；管理页「排查记录」每个会话也有「发至群聊」按钮可随时补发，发送成功的会话标记「已发群」时间。
- **本地下载**：管理页「排查记录」→ 会话 → 导出 xlsx。

列序固定：序号 / 电压等级 / 线路名称 / 区段 / 树种 / 数量 / 距小号侧距离（m）/ 距大号侧距离（m）/ 直径（cm）/ 水平距离（m）/ 垂直距离（m）/ 发现人 / 发现时间。

约定：

- **全部单元格为文本/常规格式**（numFmt `@`），日期、距离均不转数字格式；
- 排序：按线路表顺序分组，组内按起始杆号升序；线路未匹配的记录排最后并在导出中标「（待确认）」；
- 区段格式 `32#-33#`，单杆 `29#`，位置修饰（院内/弧垂等）尾随其后；
- 「超高」填入垂直距离列，形式为 `超高1.2`（区别于垂距纯数值）；
- 发现时间取报送消息日期，格式 `2026.10.18`；发现人优先取「发送者别名」。

### 线路表

管理页「线路表」维护（上传 xlsx 整体更新或在线增删改）。报送原文的线路名由项目侧归一化匹配（不归 Dify）：去 `110kV` 前缀、`吕汾1线→吕汾Ⅰ线` 罗马数字归一、补「线」字；多候选（如 `孝南` 可同时指 `孝南线`/`孝南T接线`）或无匹配时记录标「待确认」，在会话明细中下拉指定。

## Dify 工作流契约

树木排查需要两个 Dify Workflow 应用，每个监听群各配两个 API Key（提取 / 更正提取）。

### WF1 · 报送提取

> **模型不支持结构化输出时**（如 MiMo）：LLM 节点输出文本后接一个「代码执行」节点做 JSON 提取，脚本见 `design/dify-json-extract.py`（WF1/WF2 各一段粘贴即用代码）。接线：LLM 输出 → 代码节点输入 `text`（String）；代码节点把各字段作为**独立输出变量**逐个声明（WF1 全部 String；WF2 的 `patches` 为 Object），结束节点同名输出。本项目端直接读取 `outputs` 下各字段（`result` 汇总形态也兼容）。脚本已兼容 markdown 围栏、首尾废话、尾随逗号、数字带单位（"50米"/"10棵"）等情况。

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

## 位置与图片存证（后续规划，本期未实现）

报送消息中常出现「经纬度如下」后紧跟位置消息或奥维地图截图的用法。本期最终汇总表不含经纬度列，且 WeChatPadPro 推送中的图片消息暂无法提取下载，故位置/图片均不落库。后续接入方案预留如下：

- **位置消息挂接**：会话激活期间收到位置消息时，按「同发送者 + 最近一条记录（10 分钟窗口）」挂接到记录的 `location` 字段；挂接点位于 `messageHandler.js` 的 treeWatch 分支（参考现有 location 触发规则的经纬度提取）。
- **图片挂接**：待 WeChatPadPro 支持图片下载后，将会话内紧跟记录的图片（或引用记录的图片）下载到 `data/attachments/`，记录存相对路径，导出 xlsx 时追加「附件」列。
- 记录结构已预留扩展空间，升级时无需迁移历史数据。

## 目录结构

```
src/
  index.js                 入口：初始化、HTTP 服务、超时扫描
  server.js                Express 路由（认证、设置、规则、别名、线路表、排查记录）
  settings.js              设置与规则持久化（data/settings.json）
  dify.js                  Dify workflow 调用封装（blocking，inputs 透传）
  lines.js                 线路表存储、xlsx 解析、线路名归一化匹配
  inspection/
    store.js               排查会话与记录持久化（data/inspection-sessions.json）
    export.js              汇总 xlsx 导出（全文本单元格）
    deliver.js             生成 xlsx 并发送至群聊
  wechatpadpro/
    client.js              WebSocket 通道（换票、重连、心跳）
    messageHandler.js      消息分发：位置触发 + 树木排查会话
    memberResolver.js      发送者显示名解析（别名 > 群成员接口 > wxid）
    fileSender.js          WeChatPadPro SendFile 文件发送
```
