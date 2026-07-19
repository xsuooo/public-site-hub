# 1.0.0-rc.2 发布记录

状态：源码标签与不可变制品已生成；单人双浏览器手工验收待执行

本记录是 rc.2 的当前记录。rc.1 的提交、制品摘要和验收材料保留在 `rc-1-release-record.md`，不得在本记录中覆盖或改写。

## 源码与构建

- 当前分支：`codex/rc2-hardening`
- 提交 SHA：`cdfc253fc5e76265be06de9b7883d1ff218283c5`
- Git tree：`a20c4a3a45cf55dd4e4574080520a2e14824db1a`
- Git 标签：`v1.0.0-rc.2`（annotated）
- 本记录提交 SHA（标签后的独立记录提交）：见本提交；不写入自引用 SHA
- 构建执行人：本地维护者
- 构建时间：2026-07-19（Asia/Shanghai）
- Node.js 版本：`v24.17.0`；npm `11.13.0`
- 工作树在构建前是否干净：是（标签绑定提交 `cdfc253`）
- 验收模型：**单人双浏览器**（Chrome Stable + Edge Stable，独立 profile）

## 门禁结果

| 命令 | 结果 | 日期 | 执行人 |
| --- | --- | --- | --- |
| `npm ci --ignore-scripts` | 通过；3 packages，0 vulnerabilities | 2026-07-19 | 本地 |
| `npm test` | 290 / 290 通过 | 2026-07-19 | 本地 |
| `npm run build` | 通过 | 2026-07-19 | 本地 |
| `npm run verify:package` | 通过；27 runtime files | 2026-07-19 | 本地 |
| `npm run verify:runtime -- --browser=edge` | 通过；Edge `150.0.4078.83` | 2026-07-19 | 本地 |
| `npm run release:artifact` | 通过；见下方发布物 | 2026-07-19 | 本地 |
| 第二 worktree 复现 | SHA-256 与首包一致 | 2026-07-19 | 本地 |
| `npm audit --audit-level=high` | 0 vulnerabilities | 2026-07-19 | 本地 |
| CI workflow `.github/workflows/ci.yml` | 已入库；无 remote 时未在 GitHub 执行 | 2026-07-19 | 本地 |

## 发布物

Git 外部路径（默认）：仓库旁或 `release-artifacts/`（已 gitignore，勿提交）。

- ZIP：`public-site-hub-1.0.0-rc.2.zip`
- ZIP 字节数：`532748`
- SHA-256：`6a215dc47822e4e3fef89f015c0012ae6699889c86db56d1bd9dd1a0f459e6c3`
- SHA-256 文件：`public-site-hub-1.0.0-rc.2.zip.sha256`
- 外部 attestation：`public-site-hub-1.0.0-rc.2.attestation.json`
- attestation SHA-256：`3dc2ffc72018ec50a964b94e85f334dd66bbdb529a0e7b9eb9399ca6cabc2740`
- 第二个 detached worktree 复现 SHA-256：`6a215dc47822e4e3fef89f015c0012ae6699889c86db56d1bd9dd1a0f459e6c3`（一致）

## 单人双浏览器验收

- 测试者结果 / 日期：
- Chrome Stable 完整版本：
- Edge Stable 完整版本：
- Edge/Chromium 自动冒烟结果：Edge `150.0.4078.83` 通过（无账号无 Key）
- Chrome Stable 手工加载与控制台结果：待执行
- Edge Stable 手工加载与控制台结果：待执行
- 专用测试站：无可用外部测试站时，仅可使用本机 HTTPS NewAPI 夹具验证合成数据；不得据此宣称第三方兼容性
- 验收窗口：推荐五天；至少 Chrome/Edge 各完整主流程 + 交叉冒烟
- 问题台账最终状态：待验收

## 维护者签署

- [x] 自动化与包完整性门禁通过。
- [x] 自动化阶段 P0 为零。
- [x] 自动化阶段 P1 为零。
- [x] 自动化阶段阻断型 P2 为零。
- [ ] 测试者完成 Chrome + Edge 签署（单人验收）。
- [x] 发布物与标签、提交、SHA-256 一致（本地双 worktree 复现）。
- [ ] 凭据清理责任人与截止日期已记录。

最终结论：`v1.0.0-rc.2` 源码标签与不可变 ZIP 已就绪；请用 ZIP 做单人 Chrome/Edge 手工验收，勿用日常源码目录替代。

- 维护者：
- 日期：
- 备注（不得包含敏感信息）：
