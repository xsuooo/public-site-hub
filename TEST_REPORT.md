# 公益站收藏 Test Report

## 报告范围

- 目标：`PROJECT_GOAL.md` 中的 `1.0.0-rc.2` candidate hardening
- 报告状态：rc.2 本地最终验证完成；真实双人 RC 门禁待执行
- 测试环境：Windows PowerShell；Node.js、浏览器版本和临时 profile 在每轮执行时记录
- 证据边界：只记录命令、摘要、计数和脱敏路径，不记录完整 Key、Cookie、完整存储或真实站点清单

## 身份切换前基线

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 单元/集成回归 | `npm test` | PASS，290/290 |
| Popup 语法 | `node --check popup.js` | PASS |
| Options 语法 | `node --check options.js` | PASS |
| Service worker 语法 | `node --check background.js` | PASS |

## 质量门禁

| 检查项 | 命令 | 状态 | 证据 |
| --- | --- | --- | --- |
| 依赖与初始化 | `npm ci --ignore-scripts` | PASS | added 3 packages；audit 0 vulnerabilities |
| 格式/lint/typecheck | 项目未配置独立门禁 | N/A | 无对应脚本，使用语法检查与测试替代 |
| Node 回归 | `npm test` | PASS | 290/290，2026-07-19 |
| 覆盖率 | `npm run test:coverage` | PASS | 290/290；all files 67.26% lines |
| 构建 | `npm run build` | PASS | 生成 `dist/` |
| 包完整性 | `npm run verify:package` | PASS | 27 runtime files |
| Runtime smoke | `npm run verify:runtime -- --browser=edge` | PASS | Edge 150.0.4078.83；0 console errors |
| UI gate | `npm run verify:ui` | PASS | 4/4；empty/single/mixed/hundred；8.3s |
| 依赖安全 | `npm audit --audit-level=high` | PASS | 0 vulnerabilities |
| JavaScript 语法 | 递归 `node --check`（排除依赖/产物） | PASS | 61 files |
| Diff/敏感信息 | `git diff --check`；运行时代码 Key-like literal scan | PASS | 无空白错误；runtime 0 个 |

## 最终 30 轮矩阵

最终代码状态下每轮必须有实际证据；失败轮次修复后重验，失败尝试不计入 PASS。

| 轮次 | 测试目的 | 执行方式 | 结果 | 证据 |
| ---: | --- | --- | --- | --- |
| 1 | 依赖安装、初始化和首次启动 | `npm ci --ignore-scripts`；Node 入口加载 | PASS | 3 packages added；0 vulnerabilities |
| 2 | 全量核心回归 | `npm test` | PASS | 290/290，0 fail/skip |
| 3 | 全部 JavaScript 语法 | 递归 `node --check`（61 文件） | PASS | 61/61 |
| 4 | 构建运行时目录 | `npm run build` | PASS | `dist/` 生成 |
| 5 | 发布包白名单与引用 | `npm run verify:package` | PASS | 27 文件 |
| 6 | 真实 MV3 基础启动 | `npm run verify:runtime -- --browser=edge` | PASS | Edge 150.0.4078.83；service worker/Popup/Options/console |
| 7 | UI 空状态 | Playwright `empty` scenario | PASS | 空 Popup、Options、诊断 all-clear，无溢出 |
| 8 | UI 单站键盘与路由 | Playwright `single` scenario | PASS | 菜单键盘、drawer focus、路由 |
| 9 | UI 混合筛选与主题 | Playwright `mixed` scenario | PASS | health/category/tag、dark、窄屏、125% 等效视口 |
| 10 | UI 大数量与可达性 | Playwright `hundred` scenario | PASS | 100 站点、列表滚动、搜索、无横向溢出 |
| 11 | Origin/显式端口隔离 | `node --test --test-name-pattern="Origin identity distinguishes" tests/origin-identity.test.js` | PASS | 1/1 |
| 12 | 导入大小与数量边界 | `node --test --test-name-pattern="import parsing rejects oversized" tests/import-export-sync.test.js` | PASS | 2 MB/1000 条边界，1/1 |
| 13 | URL query/hash 清洗 | `node --test --test-name-pattern="native export removes query" tests/import-export-sync.test.js` | PASS | 存储/导出不保留 query/hash，1/1 |
| 14 | 并发站点 mutation | `node --test --test-name-pattern="concurrent site mutations" tests/storage-upsert.test.js` | PASS | 手工编辑与加 Key 均保留，1/1 |
| 15 | 预览过期保护 | `node --test --test-name-pattern="import preview version" tests/storage-backup.test.js` | PASS | 队列内拒绝 stale preview，1/1 |
| 16 | 替换、恢复和安全快照 | `node --test --test-name-pattern="replace-import snapshots" tests/storage-backup.test.js` | PASS | 恢复前/后快照一致，1/1 |
| 17 | 掩码 Key 安全 | `node --test --test-name-pattern="masked keys are diagnostic" tests/ui-runtime.test.js` | PASS | 不可复制/设默认的掩码值，1/1 |
| 18 | Key 创建确认门 | `node --test --test-name-pattern="empty token list requires" tests/key-provision.test.js` | PASS | 未确认不 POST，确认后才创建，1/1 |
| 19 | Key 操作 lease 与删除冲突 | `node --test --test-name-pattern="site deletion is rejected" tests/key-provision.test.js` | PASS | `site_operation_busy` 且不部分删除，1/1 |
| 20 | 余额停止协作 | `node --test --test-name-pattern="background stops a shared" tests/background-checkin.test.js` | PASS | 当前站完成、pending 保留，1/1 |
| 21 | 单站/批量同站协调 | `node --test --test-name-pattern="single and batch refresh share" tests/balance-refresh-race.test.js` | PASS | 单一 in-flight 请求，1/1 |
| 22 | 刷新期间删除站点 | `node --test --test-name-pattern="deleted site is rechecked" tests/balance-refresh-race.test.js` | PASS | 删除后不发下一请求，1/1 |
| 23 | Worker 重启恢复 | `node --test --test-name-pattern="worker restart converts" tests/background-checkin.test.js` | PASS | stopping 转 interrupted，1/1 |
| 24 | 前台授权与端口 | `node --test --test-name-pattern="foreground permission request starts" tests/permissions-user-gesture.test.js` | PASS | 直接 request、保留 8443，1/1 |
| 25 | 孤立 HTTPS 授权清理 | `node --test --test-name-pattern="orphaned permission discovery" tests/permissions-user-gesture.test.js` | PASS | 只保留未使用的精确 Origin，1/1 |
| 26 | 批量凭据隔离 | `node --test --test-name-pattern="batch add without credentials" tests/background-checkin.test.js` | PASS | 批量写入无 Key，1/1 |
| 27 | 旧 balance attempt 失效 | `node --test --test-name-pattern="import replacement and backup restore" tests/storage-backup.test.js` | PASS | replace/restore 清空旧 attempt，1/1 |
| 28 | 诊断脱敏 | `node --test --test-name-pattern="copied diagnostics are allowlisted" tests/options-diagnostics.test.js` | PASS | 无站点/凭据材料，1/1 |
| 29 | 确定性发布制品 | `node --test --test-name-pattern="release ZIP, sidecar and attestation" tests/release-artifact.test.js` | PASS | ZIP/sidecar/attestation 可复现且不可覆盖，1/1 |
| 30 | 四端口本机 NewAPI 扩展集成链路 | 隔离 Edge + `dist` 临时副本（仅加入 4 个 fixture Origin 的 host permission 以绕过无头授权弹窗）+ `startFixture`；识别、Key、停止/继续余额 | PASS | A 自动导入 1；B 取消创建写入 0、确认后 1；停止 1/4 后恢复 4/4；临时 profile/夹具已清理；不替代真实权限弹窗 |

## 结论

rc.2 身份下的依赖、语法、290 项全量回归、覆盖率、构建、包、Edge runtime 和四个 Playwright UI 场景均已重跑并通过；30/30 独立轮次的功能代码未在身份切换后变化，受影响的版本、制品和运行时证据已重新验证。仍不能标记正式 RC/G7：真实 Chrome/Edge 权限弹窗、专用账号/Key、双人五天验收、凭据清理和新标签发布尚未执行。无头 Edge 权限弹窗联调被明确记录为 BLOCKED，不以预授权测试包冒充真实授权通过。

## rc.2 切换问题闭环

- 首次 `npm test`：289/290；`attestation identity must match the manifest inside the ZIP` 未抛出预期异常。
- 根因：负例仍把 `0.99.0.2` 作为错误 Manifest 版本，而它已经是 rc.2 的正确版本。
- 修复：负例改用历史 rc.1 的 `0.99.0.1`，不降低制品身份断言。
- 回归：`tests/release-artifact.test.js` 6/6、相关元数据/诊断测试 27/27、全量 `npm test` 290/290。
