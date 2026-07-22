# 1.0.0-rc.3 发布记录

状态：源码已冻结并已生成不可变制品；Chrome/Edge 手工签署待执行

本记录只服务于 rc.3。rc.2 的提交、制品摘要和验收材料保留在 [rc-2-release-record.md](rc-2-release-record.md)，不得覆盖或改写。

## 源码与构建

- 当前开发分支：`main`
- 候选提交 SHA：`a7d3b42311578b5bc87a1e36806c231025a44e99`
- Git tree：`4d465bcf6a16b4fb71bae4c87610463fb700a337`
- Git 标签：`v1.0.0-rc.3`
- Manifest 版本：`0.99.0.3`
- 构建执行人：`xsu`
- 构建时间：`2026-07-21 03:01:40 +08:00`
- Node.js / npm：`v24.17.0` / `11.13.0`
- 工作树在构建前是否干净：是（标签 detached worktree）
- 验收模型：**单人双浏览器**（Chrome Stable + Edge Stable，独立 profile）

## 当前自动化证据

| 命令 | 结果 | 日期 | 执行人 |
| --- | --- | --- | --- |
| `npm ci --ignore-scripts` | 通过；0 vulnerabilities | 2026-07-21 | 本地 |
| `npm test` | 275 / 275 通过 | 2026-07-21 | 本地 |
| `npm run verify:syntax` | 54 / 54 通过 | 2026-07-21 | 本地 |
| `npm run test:coverage` | 275 / 275；67.08% lines | 2026-07-21 | 本地 |
| `npm run build` | 通过；28 runtime files | 2026-07-21 | 本地 |
| `npm run verify:package` | 通过；28 runtime files | 2026-07-21 | 本地 |
| `npm run verify:runtime -- --browser=edge` | 通过；Edge 150.0.4078.83；0 console errors | 2026-07-21 | 本地 |
| `npm run verify:ui` | 通过；4/4 | 2026-07-21 | 本地 |
| `npm audit --audit-level=high` | 0 vulnerabilities | 2026-07-21 | 本地 |
| runtime Key-like literal scan | 0 hits | 2026-07-21 | 本地 |

## 发布物

本地路径（gitignore，勿提交）：`release-artifacts/`

- ZIP：`public-site-hub-1.0.0-rc.3.zip`
- ZIP 字节数：`542742`
- SHA-256：`39b646965526f8b7222508009b532effa4f5183eaabb9dc4314c69f5749971b0`
- SHA-256 文件：`public-site-hub-1.0.0-rc.3.zip.sha256`
- 外部 attestation：`public-site-hub-1.0.0-rc.3.attestation.json`
- 第二个 detached worktree 复现 SHA-256：一致（`39b646965526f8b7222508009b532effa4f5183eaabb9dc4314c69f5749971b0`）

## 单人双浏览器验收

- 测试者 / 日期：
- Chrome Stable 完整版本：
- Edge Stable 完整版本：
- Chrome Stable 手工加载、权限和控制台结果：待执行
- Edge Stable 手工加载、权限和控制台结果：待执行
- 专用测试站：无外部测试站时只使用本机 HTTPS NewAPI 夹具，不宣称第三方兼容性
- 验收窗口：推荐五天；至少 Chrome/Edge 各一次完整主流程和交叉冒烟
- 问题台账：见 [rc-3-findings.md](rc-3-findings.md)

## 放行签署

- [x] 自动化与包完整性门禁通过。
- [x] 自动化阶段 P0、P1 和阻断型 P2 为零。
- [x] 源码已冻结、标签已创建且未移动；后续记录提交不改变标签绑定。
- [x] 两个 detached worktree 生成一致 ZIP SHA-256。
- [ ] Chrome + Edge 单人验收完成。
- [ ] P0、P1 和阻断型 P2 为零；延期项已批准。
- [ ] 测试凭据和 profile 清理责任人与截止日期已记录。
- [ ] 测试者和维护者最终签署完成。

最终结论：制品已生成且可复现；待 Chrome/Edge 单人手工验收与最终签署
