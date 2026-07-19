# 公益站收藏 Goal Card

## 项目与版本

- 项目名称：公益站收藏
- 目标版本：`1.0.0-rc.2` candidate hardening
- 目标状态：G6+，本地门禁与单人双浏览器流程就绪；真实 Chrome/Edge 手工验收仍待执行

## 目标

- 一句话目标：把 Manifest V3 公益/API 站点收藏扩展整理为可标签化、可打包的 rc.2 候选，并按**单人双浏览器**模型进入手工验收。
- 目标用户：单名可信测试者；在 Chrome Stable 与 Edge Stable 上使用独立 profile、专用测试账号和测试 Key。
- 核心问题：在多个站点、显式端口、权限拒绝、余额长任务和导入恢复场景下，仍要保持数据、凭据和任务状态正确且可恢复。
- 核心价值：让用户能在本地安全管理站点与 Key，并用可追溯的错误和恢复操作完成余额查询。
- 核心使用场景：收藏或识别站点，按当前 Origin 授权，导入或创建 Key，查询单站或批量余额，停止/继续任务，导入导出并恢复数据。
- 用户最终获得的结果：可加载的扩展包、可复现的验证命令、明确的失败反馈，以及不泄露敏感值的本地数据管理流程。

## 第一版范围

### 必须实现

- 保留站点完整 Origin（含显式端口），保存 URL 时去除 query/hash。
- Popup 显示全部匹配站点并支持健康、分类、标签和关键词筛选。
- Key 与接口地址分离处理；掩码、截断或不可信页面文本不能写入完整 Key。
- HTTPS 权限只在前台用户手势中按 Origin 请求；拒绝一个站点不阻断已授权站点。
- 单站/批量余额刷新具备超时、稳定错误码、协作式停止、继续和重启恢复。
- 导入先预览新增/更新/跳过；替换导入具备恢复快照、恢复和清理能力。
- 脱敏诊断和导出不包含完整 Key、Cookie、真实站点列表、备注或深层 URL。
- 真实扩展 runtime smoke、Playwright UI gate、构建和发布包完整性检查可执行。
- RC 文档与测试断言反映单人双浏览器验收模型；仓库含最小 CI 工作流。

### 明确不做

- 不推送远端（仓库可无 remote，由维护者自行配置）。
- 不使用生产账号、生产 Key 或真实用户数据。
- 不进行浏览器商店发布、Firefox 适配或自动化真实第三方站点验收。
- 不新增与当前 RC 核心流程无关的产品功能或框架迁移。

## 成功指标与验收标准

- `npm test` 在最终代码状态下通过且无 fail/skip。
- `node --check popup.js options.js background.js` 通过。
- `npm run build` 和 `npm run verify:package` 通过，包只含运行时白名单文件。
- 可用 Edge/兼容 Chromium 时，`npm run verify:runtime -- --browser=<path>` 和 `npm run verify:ui` 通过。
- 安全敏感信息检查通过：测试输出、诊断、页面文本和发布包中不出现完整 Key/Cookie/query/hash。
- 存在 annotated 标签 `v1.0.0-rc.2` 与外部不可变 ZIP/SHA/attestation 后，才进入正式手工 RC 签署。

## 本地验证结论

- 本地自动化门禁可重复执行并通过。
- 验收模型已从双人改为单人双浏览器；真实权限弹窗与专用账号流程仍须手工完成。
- 无 git remote 时 CI 与标签推送需维护者另行配置远端。

## 约束与边界

- 技术约束：Manifest V3 classic service worker、`importScripts`、原生 HTML/CSS/JavaScript、`chrome.storage.local`。
- 业务约束：当前 RC 面向单名可信测试者，真实主链路需专用测试站或本机夹具。
- 安全与隐私：零遥测；只做当前工作区和本地测试环境的安全检查；不写入秘密。
- 外部依赖：Node.js 22+、Edge Stable 或可加载扩展的兼容 Chromium、Playwright。

## 主要风险与缓解

- 标签与制品未生成：仅在干净候选提交打 annotated 标签，并用 detached worktree 打包。
- 浏览器或外部测试站不可用：执行本地逻辑、fixture 和可用浏览器门禁，明确标记真实集成未验证。
- 凭据泄漏：使用 `.invalid`、合成 Key 和脱敏证据；审查日志、诊断和包内容。
- 无 remote：本地仍可标签与打包；备份与 CI 需维护者配置远端。
