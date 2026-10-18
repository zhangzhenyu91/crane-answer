# AGENTS.md — crane-answer

面向 AI 编码助手的项目规则。开始改动前先读完本文件。

## 协作规则（最高优先级）

1. **只写文件，不做部署**：不主动连接云端资源（WeChatPadPro / Dify 只在代码中按配置对接）。
2. **不擅自做 git 操作**：`commit` / `push` / `reset` / `tag` 需用户明确指示。
3. **发版纪律**：日常开发只本地提交，不推送、不打 tag、不触发构建；仅当用户明确说「发版/推送发版」时执行 `README.md` 的《发版流程》。发版 tag 定版后不再删除/移动，workflow 有修要验证时走下一个 patch 版号。
4. **数据安全**：`data/` 为运行时数据（含 Token 等敏感配置），由 `.gitignore` 保护，绝不入库。

## 技术要点

- Node.js 单进程：Express 管理端 + WeChatPadPro WebSocket 消息通道；持久化全部走 `data/` 下 JSON 文件（临时文件 + rename 原子写），不引数据库。
- 规则引擎两类触发：`location`（位置消息）与 `treeWatch`（树木排查会话捕获），契约与 Dify 提示词见 `README.md`。
- 改动后自检：`node --check` 全部源文件；涉及消息处理的用真实报文回放验证（勿新增测试框架）。
