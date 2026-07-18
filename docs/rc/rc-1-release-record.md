# 1.0.0-rc.1 发布记录

状态：候选包已生成；双人手工验收与五天窗口待执行

## 源码与构建

- 提交 SHA：`7bd153dc7825bf94837ef54df6dbaf0ab69b203f`
- Git tree：`0360e0e5e22e0b0ca94408a6ee5276a61957c628`
- Git 标签：`v1.0.0-rc.1`
- 本记录提交 SHA（标签后的独立记录提交）：本文件所在提交；不写入自引用 SHA
- 构建执行人：本地自动化（Codex）
- 构建时间：2026-07-18 17:51:59 +08:00
- Node.js 版本：`v24.17.0`
- 工作树在构建前是否干净：是；`HEAD` 与 `v1.0.0-rc.1^{commit}` 均为上述提交

## 门禁结果

| 命令 | 结果 | 日期 | 执行人 |
| --- | --- | --- | --- |
| `node --check popup.js` | 通过 | 2026-07-18 | Codex |
| `node --check options.js` | 通过 | 2026-07-18 | Codex |
| `npm test` | 257 / 257 通过 | 2026-07-18 | Codex |
| `npm run build` | 通过 | 2026-07-18 | Codex |
| `npm run verify:package` | 通过；27 个运行时文件 | 2026-07-18 | Codex |
| `npm run verify:runtime -- --browser=edge` | 通过；Edge `150.0.4078.65`，零控制台错误，临时 profile 已清理 | 2026-07-18 | Codex |
| `npm run release:artifact -- --out-dir <外部空目录>` | 两个 detached worktree 均通过 | 2026-07-18 | Codex |

## 发布物

- ZIP：`public-site-hub-1.0.0-rc.1.zip`
- ZIP 字节数：`475585`
- SHA-256：`98acf9c23cc5f78eae026dff7a162e0b8a57893b9b3576f217d3421d0ea6c0dc`
- SHA-256 文件：`public-site-hub-1.0.0-rc.1.zip.sha256`
- 外部 attestation：`public-site-hub-1.0.0-rc.1.attestation.json`
- attestation SHA-256：`fc54cf4b4617d2967a3b7277a0059d4f8fe4502a6901bd87a979abd2d137011b`
- 从标签重新构建复核人：同机独立 detached worktree 自动复核（Codex）
- 第二个 detached worktree 复现 SHA-256：一致，`98acf9c23cc5f78eae026dff7a162e0b8a57893b9b3576f217d3421d0ea6c0dc`

## 双人验收

- 测试者 A 结果 / 日期：
- 测试者 B 结果 / 日期：
- Chrome Stable 完整版本：
- Edge Stable 完整版本：
- Edge/Chromium 自动冒烟结果：Edge `150.0.4078.65` 通过；仅无账号、无 Key 自动门禁
- Chrome Stable 手工加载与控制台结果：待测试者执行
- Edge Stable 手工加载与控制台结果：待测试者执行
- 五天窗口：待两名测试者确认开始日期
- 问题台账最终状态：自动化审查阶段无 P0、P1 或阻断型 P2；手工验收结果待记录

## 维护者签署

- [x] 自动化审查阶段 P0 为零。
- [x] 自动化审查阶段 P1 为零。
- [x] 自动化审查阶段阻断型 P2 为零。
- [ ] 两名测试者均完成并签署。
- [x] 发布物与标签、提交、SHA-256 一致。
- [ ] 凭据清理责任人与截止日期已记录。

最终结论：候选包可进入双人 RC 验收；尚未完成正式签署

- 维护者：
- 日期：
- 备注（不得包含敏感信息）：
