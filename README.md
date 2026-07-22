# 公益站收藏

公益站收藏是一个 Manifest V3 浏览器扩展，用于收藏公益或中转 API 站点、管理本地 Key、查看余额，以及导入或导出站点数据。

当前版本是 `1.0.0-rc.3`。它不是商店公开发布版；不要用生产账号或生产 Key 做联调。门禁以本仓库自动化命令为准；需要独立包时用标签 `v1.0.0-rc.3` 在干净 worktree 生成 ZIP。权限 UX 增量（全站授权等）在分支 `rc4/permission-ux`。

## 主要能力

- 从当前页面收藏站点，并保留完整 Origin，包括显式端口。
- 在弹窗中查看全部匹配站点，不分页；可按健康状态、分类、标签和关键词筛选。
- Key 与站点数据仅保存在浏览器本地；接口地址和 Key 分开复制。
- 按站点请求可选 HTTPS 权限；拒绝某一站授权不应影响已授权站点。
- 查询单站或批量余额；批量任务支持停止、继续和浏览器重启后的恢复。
- 仅使用 `alarms` 每日清理过期本机恢复快照，不会定时访问站点或自动刷新余额。
- 导入前预览新增、更新和跳过数量；支持脱敏导出、完整导出和替换导入快照。
- 导入单次限制为 2 MB、1000 个站点；预览后站点数据发生变化时必须重新预览。
- 站点和恢复快照写入前会预检浏览器本地存储配额；空间不足时整次写入取消，不会部分覆盖现有数据。
- 诊断页可查看并清理不再对应收藏站点的孤立 HTTPS 授权，复制内容不包含真实域名。
- 手动复制脱敏诊断；项目不包含遥测、远程日志或自动上传。

## 安装（开发者模式）

从源码：

```powershell
npm test
npm run build
npm run verify:package
npm run verify:runtime
npm run verify:ui
```

然后在 `chrome://extensions` 或 `edge://extensions` 启用开发者模式，加载相对路径 `dist/`。

从发布 ZIP：在干净 worktree 执行 `npm run release:artifact -- --out-dir <空目录>`，校验 `.sha256` 后解压到独立目录再加载；不要覆盖旧解压目录。

`npm run verify:runtime` 是无账号、无 Key 的 Edge/Chromium 扩展上下文冒烟。`npm run verify:ui` 用隔离 profile 和合成数据检查 Popup/Options 布局与交互。真实站点权限、登录会话、Key 与余额仍需本机自测。

## 基本使用

1. 打开目标站点，点击扩展图标，再选择“收藏当前页”。
2. 首次识别、余额查询或 Key 操作时，仅批准当前测试站点所需的 HTTPS 权限。
3. 没有 Key 时，使用卡片中的获取或导入入口。只有在兼容站点、已确认登录且远端令牌列表为空时，才允许在明确确认后创建一把测试 Key。
4. “复制接口地址”只复制 `https://example.invalid/v1` 形式的地址；“复制 Key”单独执行。
5. 设置页用于批量添加、编辑、导入与备份、诊断和权限处理。

不要在问题记录、截图、诊断文本或仓库文件中粘贴完整 Key、Cookie、完整存储、真实站点清单，或带 query/hash 的 URL。

## 本地开发

要求：Node.js 22 或更高版本，以及用于自动冒烟和 UI 门禁的 Edge Stable（或可加载未打包扩展的 Chromium）。安装依赖后，Playwright 测试默认寻找 Edge；也可通过 `PUBLIC_SITE_HUB_BROWSER_PATH` 指定可执行文件。

```powershell
npm test
npm run test:coverage
npm run verify:syntax
npm run build
npm run verify:package
npm run verify:runtime
npm run verify:ui
```

- `npm test`：运行自动化测试。
- `npm run test:coverage`：生成本地覆盖率结果。
- `npm run verify:syntax`：递归检查源码、脚本和测试中的 JavaScript 语法。
- `npm run build`：生成 `dist/`。
- `npm run verify:package`：校验 `dist/` 只包含允许的运行时文件。
- `npm run verify:runtime`：在 Edge/Chromium 真实扩展上下文执行无凭据自动冒烟检查；它不替代 Chrome Stable 手工验收。
- `npm run verify:ui`：构建扩展并运行单 worker Playwright UI 门禁；测试 profile、storage 和截图均为临时数据，不进入 `dist/`。

修改源码后重新构建并在扩展管理页重新加载。不要直接编辑 `dist/`，也不要把 `dist/`、测试浏览器配置或发布 ZIP 提交到 Git。

## 权限与本地数据

- `storage`：在 `chrome.storage.local` 中保存站点、Key、偏好、迁移状态和未完成批量任务。
- `alarms`：仅唤醒本地维护任务，清理超过保留期的恢复快照；不执行网络请求。
- `tabs`：在用户主动打开站点、识别、导入 Key 或查询余额时读取或创建相关标签页。
- 扩展不申请 `cookies` 权限；需要登录状态的余额和 Key 操作在用户已打开或扩展临时打开的目标站标签页内执行，由浏览器按 Origin、路径与 Cookie 属性处理会话。
- `activeTab`：在用户点击扩展或右键入口时临时访问当前页面。
- `scripting`：仅在用户发起识别、余额、页面 Key 导入或获取 Key 流程时注入站点脚本。
- `contextMenus`：提供右键收藏入口。
- 可选 HTTPS 主机权限：按当前操作的 Origin 请求；显式端口不能被折叠到其他 Origin。

原生完整导出和恢复快照可能包含完整 Key，应按敏感文件处理。脱敏导出不能恢复完整凭据。站点 URL 在保存前会移除 query 和 hash，避免临时令牌或授权码进入本地数据。

`chrome.storage.local` 受浏览器 profile 保护，但扩展不会额外加密其中的 Key；能够读取该 profile 的本机用户或调试工具仍可能读取完整值。需要更强 at-rest 保护时，应使用独立浏览器 profile 或操作系统级凭据库，而不是把口令写回扩展存储。

## 隐私边界

扩展没有遥测、远程诊断、分析 SDK 或崩溃上报。诊断只能由用户主动复制，并必须排除完整 Key、Cookie、完整站点列表、备注、URL query/hash 和完整存储。

## 文档与发布

- [架构方案与当前选择](docs/architecture-decision.md)
- [版本历史](CHANGELOG.md)
- [本机 NewAPI 夹具](docs/rc/local-newapi-fixture.md)（无外部测试站时用）

生成可分发 ZIP（须在干净、指向注释标签的 detached worktree 中执行；已有同名文件时拒绝覆盖）：

```powershell
npm run release:artifact -- --out-dir ../public-site-hub-rc3-artifacts
```

## 已知限制

- 余额查询依赖对应站点的网页登录状态，API Key 不能代替登录会话。
- 自动导入 Key 需要对应站点标签页已打开且会话有效。
- 自动创建只适用于能够验证登录状态和空令牌列表的 NewAPI/OneAPI 兼容测试站；无法确认时必须停止并提示人工处理。
- 第一轮 RC 只支持 Chrome Stable 和 Edge Stable，不包含 Firefox 或浏览器商店安装流程。
