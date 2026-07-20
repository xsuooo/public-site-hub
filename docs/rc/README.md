# 1.0.0 RC 验收总览

本目录定义当前候选 `1.0.0-rc.3` 的唯一有效发布流程。目标是向**单名可信测试者**提供版本化 ZIP，以开发者模式加载，并在 **Chrome Stable + Edge Stable** 上完成验收；本轮不提交浏览器商店，也不生成或分发外部 CRX。`rc-1-*` 和 `rc-2-*` 文件以及对应标签是不可变历史记录。

## 固定边界

- 用户版本：`1.0.0-rc.3`
- Manifest 数字版本：`0.99.0.3`
- Git 标签：`v1.0.0-rc.3`（待创建）
- ZIP：`public-site-hub-1.0.0-rc.3.zip`（待生成）
- SHA-256：`public-site-hub-1.0.0-rc.3.zip.sha256`（待生成）
- 外部 attestation：`public-site-hub-1.0.0-rc.3.attestation.json`（待生成）
- 支持浏览器：Chrome Stable、Edge Stable
- 测试人数：**一人**；同一人覆盖双浏览器，使用相互独立的浏览器 profile 与专用测试账号/Key
- 测试周期：推荐五天；至少保证 Chrome 与 Edge 各有完整主流程日与交叉冒烟
- 数据边界：零遥测，只允许用户主动复制脱敏诊断

更高候选版本必须继续使用新的编号。正式版 Manifest 使用 `1.0.0`，严格高于所有 `0.99.0.x` RC。不得覆盖、替换或重用已经分发的 RC 文件。

## 放行顺序

1. 冻结候选源码提交，确认仓库只包含预期源码、测试和文档变更；运行 `npm ci --ignore-scripts`、`npm run verify:syntax`、`npm test`、`npm run test:coverage`、`npm run build`、`npm run verify:package`、`npm run verify:runtime -- --browser=edge` 和 `npm run verify:ui`。若使用兼容 Chromium，则为 runtime smoke 指定 `--browser` 路径，并通过 `PUBLIC_SITE_HUB_BROWSER_PATH` 为 UI 门禁指定相同可执行文件；记录完整版本。
2. 提交候选源码，确认 `git status --short` 为空；在该提交创建注释标签 `git tag -a v1.0.0-rc.3 -m "Public Site Hub 1.0.0-rc.3"`，并复核 `HEAD` 与 `'v1.0.0-rc.3^{commit}'` 完全一致。
3. 从该标签创建新的 detached worktree，不在日常开发目录打包：

   ```powershell
   git worktree add --detach ../public-site-hub-rc3-build v1.0.0-rc.3
   Set-Location ../public-site-hub-rc3-build
   npm run release:artifact -- --out-dir ../public-site-hub-rc3-artifacts
   ```

   发布脚本会再次确认 worktree 干净、`HEAD` 正好位于对应注释标签，重新生成并校验 `dist/`，然后输出固定根布局、排序、时间戳和 `store` 模式的确定性 ZIP、标准 SHA-256 sidecar 与外部 attestation。`manifest.json` 位于 ZIP 根目录；已有同名产物时脚本必须失败，不能覆盖。
4. 在另一个全新 detached worktree 和空输出目录重复第 3 步，确认两个 `.zip.sha256` 内容完全一致。attestation 中的标签、提交、tree、ZIP 文件名、字节数和 SHA-256 也必须一致。
5. ZIP、sidecar 和 attestation 是 Git 外部不可变发布物，不提交到源码标签。回到分支后，把 attestation 中的提交和摘要抄入 [发布记录](rc-3-release-record.md)，作为标签后的记录提交；此提交只更新验收记录，绝不移动或重建源码标签。这样发布记录可以在验收期间继续填写，同时标签始终只绑定候选源码。
6. 唯一测试者按 [单人双浏览器测试矩阵](rc-3-test-matrix.md) 使用专用账号与独立 profile 验收（推荐五天）。
7. 所有问题使用 [反馈模板](rc-3-feedback-template.md) 记录到 [问题台账](rc-3-findings.md)。
8. P0、P1 和阻断型 P2 均为零，测试者完成清单后，由维护者在 [发布记录](rc-3-release-record.md) 最终签署（维护者可与测试者同一人，须写明）。
9. 验收结束后执行 [凭据清理](credential-cleanup.md)。若候选被撤回，仍须完成凭据清理。

## 自动与手工门禁

Edge/Chromium 自动门禁分两层：`npm run verify:runtime -- --browser=edge` 负责无账号、无 Key 的扩展加载、service worker、基础 Popup/Options、路由和控制台冒烟；`npm run verify:ui` 使用 Playwright 隔离 profile 和合成数据，覆盖 empty、single、mixed、hundred、关键键盘路径、横向溢出、深色模式和 125% 等效视口。两者都必须通过，且都不能替代品牌 Chrome Stable 的手工验收。

品牌 Chrome Stable 不应通过 `--load-extension` 自动化结果代替验收。Chrome Stable 和 Edge Stable 都必须由测试者按矩阵以开发者模式手工加载版本化 ZIP，完成真实权限、登录会话、Key、余额中断恢复和导入导出流程。

真实流程必须从经过 `npm run verify:package` 校验的 `dist/` 构建产物执行。测试材料中只能使用 `.invalid` 合成域名或脱敏描述，不得记录真实站点清单。

CI 至少重跑依赖安装、语法、覆盖率、构建、包校验、Chromium runtime smoke 和 Playwright UI gate；品牌 Chrome/Edge 的账号与权限流程仍由测试者手工完成。

## 文档索引

- [RC.3 验收清单](rc-3-acceptance.md)
- [单人双浏览器测试矩阵](rc-3-test-matrix.md)
- [无外部测试站时的本机 NewAPI 夹具](local-newapi-fixture.md)
- [问题反馈模板](rc-3-feedback-template.md)
- [问题台账](rc-3-findings.md)
- [发布记录](rc-3-release-record.md)
- [凭据清理](credential-cleanup.md)
- [不可变发布与撤回规则](immutable-release-policy.md)

## 禁止进入仓库或反馈的内容

- 完整或可恢复的 Key
- Cookie、Authorization header 或登录会话
- 浏览器完整存储、完整导出或恢复快照
- 真实站点完整清单、私人备注或账号标识
- 带 query/hash 的 URL
- 测试浏览器 profile、下载文件或剪贴板转储
