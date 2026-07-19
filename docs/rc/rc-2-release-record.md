# 1.0.0-rc.2 发布记录

状态：候选源码已完成本地门禁；版本化标签、不可变外部制品与双人手工验收待按流程执行

本记录是 rc.2 的当前记录。rc.1 的提交、制品摘要和验收材料保留在 `rc-1-release-record.md`，不得在本记录中覆盖或改写。

## 源码与构建

- 当前分支：`codex/rc2-hardening`
- 提交 SHA：本文件所在候选提交；提交后以 `git rev-parse HEAD` 核对
- Git tree：本文件所在候选提交对应 tree；提交后以 `git rev-parse 'HEAD^{tree}'` 核对
- Git 标签：`v1.0.0-rc.2`（待在干净候选提交上创建；本次准备工作不创建标签）
- 本记录提交 SHA（标签后的独立记录提交）：待标签和制品生成后填写；不写入自引用 SHA
- 构建执行人：本地自动化（Codex）
- 构建时间：2026-07-19 21:52:14 +08:00
- Node.js 版本：`v24.17.0`；npm `11.13.0`
- 工作树在构建前是否干净：提交后必须为是；日常工作树不得直接作为外部制品来源

## 门禁结果

| 命令 | 结果 | 日期 | 执行人 |
| --- | --- | --- | --- |
| `npm ci --ignore-scripts` | 通过；3 packages，0 vulnerabilities | 2026-07-19 | Codex |
| 递归 `node --check` | 61 / 61 通过 | 2026-07-19 | Codex |
| `npm test` | 290 / 290 通过；0 fail/skip | 2026-07-19 | Codex |
| `npm run build` | 通过；生成 rc.2 `dist/` | 2026-07-19 | Codex |
| `npm run verify:package` | 通过；27 个运行时文件 | 2026-07-19 | Codex |
| `npm run verify:runtime -- --browser=edge` | 通过；Edge `150.0.4078.83`，零控制台错误 | 2026-07-19 | Codex |
| `npm run verify:ui` | 通过；4 / 4，8.3s | 2026-07-19 | Codex |
| `npm audit --audit-level=high` | 通过；0 vulnerabilities | 2026-07-19 | Codex |

## 发布物

- ZIP：`public-site-hub-1.0.0-rc.2.zip`（待标签 detached worktree 生成）
- ZIP 字节数：
- SHA-256：
- SHA-256 文件：`public-site-hub-1.0.0-rc.2.zip.sha256`
- 外部 attestation：`public-site-hub-1.0.0-rc.2.attestation.json`
- attestation SHA-256：
- 第二个 detached worktree 复现 SHA-256：

## 双人验收

- 测试者 A 结果 / 日期：
- 测试者 B 结果 / 日期：
- Chrome Stable 完整版本：
- Edge Stable 完整版本：
- Edge/Chromium 自动冒烟结果：Edge `150.0.4078.83` 通过；仅代表无账号、无 Key 自动门禁
- Chrome Stable 手工加载与控制台结果：待测试者执行
- Edge Stable 手工加载与控制台结果：待测试者执行
- 专用测试站：无可用外部测试站时，仅可使用本机 HTTPS NewAPI 夹具验证合成数据；不得据此宣称第三方兼容性
- 五天窗口：待两名测试者确认开始日期
- 问题台账最终状态：待验收

## 维护者签署

- [x] 自动化与包完整性门禁通过。
- [x] 自动化阶段 P0 为零。
- [x] 自动化阶段 P1 为零。
- [x] 自动化阶段阻断型 P2 为零。
- [ ] 两名测试者均完成并签署。
- [ ] 发布物与标签、提交、SHA-256 一致。
- [ ] 凭据清理责任人与截止日期已记录。

最终结论：本地 rc.2 候选已通过自动门禁；待完成标签化、制品生成和双人验收

- 维护者：
- 日期：
- 备注（不得包含敏感信息）：
