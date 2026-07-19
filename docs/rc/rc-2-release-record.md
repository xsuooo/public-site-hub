# 1.0.0-rc.2 发布记录

状态：源码标签与不可变制品生成中；单人双浏览器手工验收待执行

本记录是 rc.2 的当前记录。rc.1 的提交、制品摘要和验收材料保留在 `rc-1-release-record.md`，不得在本记录中覆盖或改写。

## 源码与构建

- 当前分支：`codex/rc2-hardening`
- 提交 SHA：以 `git rev-list -n 1 v1.0.0-rc.2` 为准（标签创建后填写）
- Git tree：以 attestation 为准
- Git 标签：`v1.0.0-rc.2`（annotated）
- 本记录提交 SHA（标签后的独立记录提交）：制品生成后填写
- 构建执行人：本地维护者
- 构建时间：2026-07-19（Asia/Shanghai）
- Node.js 版本：`v24.17.0`；npm `11.13.0`
- 工作树在构建前是否干净：是
- 验收模型：**单人双浏览器**（Chrome Stable + Edge Stable，独立 profile）

## 门禁结果

| 命令 | 结果 | 日期 | 执行人 |
| --- | --- | --- | --- |
| `npm ci --ignore-scripts` | 通过 | 2026-07-19 | 本地 |
| `npm test` | 290 / 290 通过 | 2026-07-19 | 本地 |
| `npm run build` | 通过 | 2026-07-19 | 本地 |
| `npm run verify:package` | 通过；27 runtime files | 2026-07-19 | 本地 |
| `npm run verify:runtime -- --browser=edge` | 通过；Edge `150.0.4078.83` | 2026-07-19 | 本地 |
| `npm run release:artifact` | 待标签后生成 |  |  |
| 第二 worktree 复现 | 待执行 |  |  |
| `npm audit --audit-level=high` | 0 vulnerabilities | 2026-07-19 | 本地 |
| CI workflow `.github/workflows/ci.yml` | 已入库；无 remote 时未在 GitHub 执行 | 2026-07-19 | 本地 |

## 发布物

- ZIP：`public-site-hub-1.0.0-rc.2.zip`（Git 外部）
- ZIP 字节数：
- SHA-256：
- SHA-256 文件：`public-site-hub-1.0.0-rc.2.zip.sha256`
- 外部 attestation：`public-site-hub-1.0.0-rc.2.attestation.json`
- attestation SHA-256：
- 第二个 detached worktree 复现 SHA-256：

## 单人双浏览器验收

- 测试者结果 / 日期：
- Chrome Stable 完整版本：
- Edge Stable 完整版本：
- Edge/Chromium 自动冒烟结果：Edge `150.0.4078.83` 通过（无账号无 Key）
- Chrome Stable 手工加载与控制台结果：待执行
- Edge Stable 手工加载与控制台结果：待执行
- 专用测试站：无可用外部测试站时，仅可使用本机 HTTPS NewAPI 夹具验证合成数据
- 验收窗口：推荐五天；至少 Chrome/Edge 各完整主流程 + 交叉冒烟
- 问题台账最终状态：待验收

## 维护者签署

- [x] 自动化与包完整性门禁通过。
- [x] 自动化阶段 P0 为零。
- [x] 自动化阶段 P1 为零。
- [x] 自动化阶段阻断型 P2 为零。
- [ ] 测试者完成 Chrome + Edge 签署（单人验收）。
- [ ] 发布物与标签、提交、SHA-256 一致。
- [ ] 凭据清理责任人与截止日期已记录。

最终结论：单人双浏览器流程与 CI 已就绪；待标签化制品与手工验收。

- 维护者：
- 日期：
- 备注（不得包含敏感信息）：
