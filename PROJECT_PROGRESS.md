# 公益站收藏 Progress

## 当前检查点

- 更新时间：2026-07-19（Asia/Shanghai）
- 当前目标：`PROJECT_GOAL.md` 中的 `1.0.0-rc.2` candidate hardening
- Goal 状态：G6，rc.2 本地验证完成，外部双人 RC 门禁待执行
- 当前分支：`codex/rc2-hardening`
- 当前 HEAD：本文件所在 rc.2 候选提交，基于 `2b601db`
- 冻结标签：`v1.0.0-rc.1` 指向 `7bd153d`，不是当前 HEAD

## 已确认基线

- `npm test`：290 passed, 0 failed, 0 skipped
- `node --check popup.js`：通过
- `node --check options.js`：通过
- `node --check background.js`：通过
- 已存在的未提交修改集中在后台任务、存储/备份、权限、Key、Options/Popup、测试和 UI/发布门禁。
- rc.2 身份下的依赖、语法、全量测试、覆盖率、构建、包、runtime 和 UI 门禁均已重跑；真实双人 RC 门禁仍未执行。

## 任务清单

| 任务 | 状态 | 证据/下一步 |
| --- | --- | --- |
| 调查项目、目标和发布边界 | 已验证 | README、RC 文档、Git 状态和历史 |
| 建立目标卡片与恢复检查点 | 已验证 | `PROJECT_GOAL.md`、本文件、`TEST_REPORT.md` |
| 构建并校验运行时包 | 已验证 | `npm run build`、`npm run verify:package`，27 个运行时文件 |
| Edge/兼容 Chromium runtime smoke | 已验证 | Edge `150.0.4078.83`，无控制台错误，临时 profile 已清理 |
| Playwright UI gate | 已验证 | empty/single/mixed/hundred，4/4 PASS，单 worker，8.3s |
| 失败定位与最小修复 | 已验证 | rc.2 切换后负例仍使用当前 Manifest 版本，修正为 rc.1 错误值；定向 6/6、相关 27/27、全量 290/290 |
| 最终 30 轮独立测试 | 已验证 | `TEST_REPORT.md`，30/30 PASS |
| 目标漂移与完成声明审计 | 已验证 | 本地范围未漂移；真实双人验收仍明确为未执行 |
| rc.2 版本与发布资料切换 | 已验证 | 元数据、当前文档和测试断言一致；全套门禁已重跑 |

## 已执行命令

- `git status --short --branch`
- `git log -5 --oneline --decorate`
- `npm test`
- `node --check popup.js`
- `node --check options.js`
- `node --check background.js`
- `npm ci --ignore-scripts`
- `npm run test:coverage`
- `npm audit --audit-level=high`
- `npm run build`
- `npm run verify:package`
- `npm run verify:runtime -- --browser=edge`
- `npm run verify:ui`
- 30 轮定向 Node 测试和四端口本机 HTTPS NewAPI 夹具联调（仅合成数据）

## 阻塞与边界

- 真实 Chrome/Edge 双人验收、专用账号、五天窗口尚未由测试者执行，不能由本地自动化代替。
- 本次已获授权进行本地提交；仍不推送、打标签、外部发布或操作真实数据。
- `v1.0.0-rc.1` 标签仍指向冻结提交；rc.2 必须在干净标签 worktree 生成外部制品。

## 下一步

1. 保留 rc.1 标签和备份 stash；本地 rc.2 候选提交不推送、不打标签。
2. 由后续发布流程在 `v1.0.0-rc.2` 的 detached worktree 生成不可变 ZIP、sidecar 和 attestation。
3. 两名测试者按 `docs/rc/rc-2-test-matrix.md` 完成 Chrome/Edge、专用账号和五天窗口。
4. 记录问题台账、凭据清理和最终签署后再宣称正式 RC 放行。
4. 记录问题台账、凭据清理和最终签署后再宣称正式 RC 放行。
