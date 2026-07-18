# 1.0.0 RC 验收总览

本目录定义 `1.0.0-rc.1` 的唯一有效发布流程。目标是向两名可信测试者提供版本化 ZIP，以开发者模式加载；本轮不提交浏览器商店，也不生成或分发外部 CRX。

## 固定边界

- 用户版本：`1.0.0-rc.1`
- Manifest 数字版本：`0.99.0.1`
- Git 标签：`v1.0.0-rc.1`
- ZIP：`public-site-hub-1.0.0-rc.1.zip`
- SHA-256：`public-site-hub-1.0.0-rc.1.zip.sha256`
- 外部 attestation：`public-site-hub-1.0.0-rc.1.attestation.json`
- 支持浏览器：Chrome Stable、Edge Stable
- 测试人数：两人，各自使用独立专用账号和 Key
- 测试周期：五天
- 数据边界：零遥测，只允许用户主动复制脱敏诊断

下一候选版本必须使用新的编号。例如 `1.0.0-rc.2` 对应 Manifest `0.99.0.2` 和 Git 标签 `v1.0.0-rc.2`。正式版 Manifest 使用 `1.0.0`，严格高于所有 `0.99.0.x` RC。不得覆盖、替换或重用已经分发的 RC 文件。

## 放行顺序

1. 冻结候选源码提交，确认仓库只包含预期源码、测试和文档变更；运行 `npm test`、`npm run build`、`npm run verify:package` 和 `npm run verify:runtime -- --browser=edge`。若使用兼容 Chromium，则把 `--browser` 改为其可执行文件路径并记录完整版本。
2. 提交候选源码，确认 `git status --short` 为空；在该提交创建注释标签 `git tag -a v1.0.0-rc.1 -m "Public Site Hub 1.0.0-rc.1"`，并复核 `HEAD` 与 `'v1.0.0-rc.1^{commit}'` 完全一致。
3. 从该标签创建新的 detached worktree，不在日常开发目录打包：

   ```powershell
   git worktree add --detach ../public-site-hub-rc1-build v1.0.0-rc.1
   Set-Location ../public-site-hub-rc1-build
   npm run release:artifact -- --out-dir ../public-site-hub-rc1-artifacts
   ```

   发布脚本会再次确认 worktree 干净、`HEAD` 正好位于对应注释标签，重新生成并校验 `dist/`，然后输出固定根布局、排序、时间戳和 `store` 模式的确定性 ZIP、标准 SHA-256 sidecar 与外部 attestation。`manifest.json` 位于 ZIP 根目录；已有同名产物时脚本必须失败，不能覆盖。
4. 在另一个全新 detached worktree 和空输出目录重复第 3 步，确认两个 `.zip.sha256` 内容完全一致。attestation 中的标签、提交、tree、ZIP 文件名、字节数和 SHA-256 也必须一致。
5. ZIP、sidecar 和 attestation 是 Git 外部不可变发布物，不提交到源码标签。回到主分支后，把 attestation 中的提交和摘要抄入 [发布记录](rc-1-release-record.md)，作为标签后的记录提交；此提交只更新验收记录，绝不移动或重建源码标签。这样发布记录可以在五天验收期间继续填写，同时标签始终只绑定候选源码。
6. 两名测试者按 [双人测试矩阵](rc-1-test-matrix.md) 使用独立专用账号验收五天。
7. 所有问题使用 [反馈模板](rc-1-feedback-template.md) 记录到 [问题台账](rc-1-findings.md)。
8. P0、P1 和阻断型 P2 均为零，两名测试者均完成清单后，由维护者在 [发布记录](rc-1-release-record.md) 最终签署。
9. 验收结束后执行 [凭据清理](credential-cleanup.md)。若候选被撤回，仍须完成凭据清理。

## 自动与手工门禁

这是 Edge/Chromium 自动门禁：`npm run verify:runtime -- --browser=edge` 负责无账号、无 Key 的 Edge 自动扩展上下文冒烟；也可以把 `--browser` 指向能够加载未打包扩展的 Chromium 可执行文件。自动门禁包括扩展加载、service worker、Popup、Options、路由和控制台错误。

品牌 Chrome Stable 不应通过 `--load-extension` 自动化结果代替验收。Chrome Stable 和 Edge Stable 都必须由两名测试者按矩阵以开发者模式手工加载版本化 ZIP，完成真实权限、登录会话、Key、余额中断恢复和导入导出流程。

真实流程必须从经过 `npm run verify:package` 校验的 `dist/` 构建产物执行。测试材料中只能使用 `.invalid` 合成域名或脱敏描述，不得记录真实站点清单。

## 文档索引

- [RC 验收清单](rc-1-acceptance.md)
- [双人测试矩阵](rc-1-test-matrix.md)
- [无外部测试站时的本机 NewAPI 夹具](local-newapi-fixture.md)
- [问题反馈模板](rc-1-feedback-template.md)
- [问题台账](rc-1-findings.md)
- [发布记录](rc-1-release-record.md)
- [凭据清理](credential-cleanup.md)
- [不可变发布与撤回规则](immutable-release-policy.md)
- [历史验收归档](../archive/README.md)

## 禁止进入仓库或反馈的内容

- 完整或可恢复的 Key
- Cookie、Authorization header 或登录会话
- 浏览器完整存储、完整导出或恢复快照
- 真实站点完整清单、私人备注或账号标识
- 带 query/hash 的 URL
- 测试浏览器 profile、下载文件或剪贴板转储
