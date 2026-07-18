# 公益站收藏

公益站收藏是一个 Manifest V3 浏览器扩展，用于收藏公益或中转 API 站点、管理本地 Key、查看余额，以及导入或导出站点数据。

当前发布目标是 `1.0.0-rc.1`，仅面向两名可信测试者。它不是公开发布版本，也不得使用生产账号或生产 Key 验收。

## 主要能力

- 从当前页面收藏站点，并保留完整 Origin，包括显式端口。
- 在弹窗中查看全部匹配站点，不分页；可按健康状态、分类、标签和关键词筛选。
- Key 与站点数据仅保存在浏览器本地；接口地址和 Key 分开复制。
- 按站点请求可选 HTTPS 权限；拒绝某一站授权不应影响已授权站点。
- 查询单站或批量余额；批量任务支持停止、继续和浏览器重启后的恢复。
- 导入前预览新增、更新和跳过数量；支持脱敏导出、完整导出和替换导入快照。
- 手动复制脱敏诊断；项目不包含遥测、远程日志或自动上传。

## RC 安装

测试者应收到版本化 ZIP、对应的 SHA-256 和外部 attestation，不应收到会被静默覆盖的固定文件名。

1. 校验 ZIP 的 SHA-256 与发布记录一致。
2. 将 ZIP 解压到一个新的、版本独立的目录，不覆盖旧 RC。
3. 打开 `chrome://extensions` 或 `edge://extensions`。
4. 启用开发者模式，选择“加载已解压的扩展程序”，加载刚解压的目录。
5. 对照 [RC 验收总览](docs/rc/README.md) 记录浏览器版本、扩展版本和结果。

从源码验收时先生成发布目录，再加载相对路径 `dist/`：

```powershell
npm test
npm run build
npm run verify:package
npm run verify:runtime
```

`npm run verify:runtime` 是无账号、无 Key 的 Edge/Chromium 扩展上下文自动冒烟门禁。品牌 Chrome Stable 需要按 RC 清单手工加载；真实授权、余额和 Key 流程仍需使用专用测试账号完成。

## 基本使用

1. 打开目标站点，点击扩展图标，再选择“收藏当前页”。
2. 首次识别、余额查询或 Key 操作时，仅批准当前测试站点所需的 HTTPS 权限。
3. 没有 Key 时，使用卡片中的获取或导入入口。只有在兼容站点、已确认登录且远端令牌列表为空时，才允许在明确确认后创建一把测试 Key。
4. “复制接口地址”只复制 `https://example.invalid/v1` 形式的地址；“复制 Key”单独执行。
5. 设置页用于批量添加、编辑、导入与备份、诊断和权限处理。

不要在问题记录、截图、诊断文本或仓库文件中粘贴完整 Key、Cookie、完整存储、真实站点清单，或带 query/hash 的 URL。

## 本地开发

要求：Node.js 22 或更高版本，以及用于自动冒烟的 Edge Stable 或可加载未打包扩展的 Chromium。

```powershell
npm test
npm run test:coverage
npm run build
npm run verify:package
npm run verify:runtime
```

- `npm test`：运行自动化测试。
- `npm run test:coverage`：生成本地覆盖率结果。
- `npm run build`：生成 `dist/`。
- `npm run verify:package`：校验 `dist/` 只包含允许的运行时文件。
- `npm run verify:runtime`：在 Edge/Chromium 真实扩展上下文执行无凭据自动冒烟检查；它不替代 Chrome Stable 手工验收。

修改源码后重新构建并在扩展管理页重新加载。不要直接编辑 `dist/`，也不要把 `dist/`、测试浏览器配置或发布 ZIP 提交到 Git。

## 权限与本地数据

- `storage`：在 `chrome.storage.local` 中保存站点、Key、偏好、迁移状态和未完成批量任务。
- `tabs`：在用户主动打开站点、识别、导入 Key 或查询余额时读取或创建相关标签页。
- `cookies`：在用户主动操作时读取当前测试站点的登录会话；不会读取浏览器保存的密码。
- `activeTab`：在用户点击扩展或右键入口时临时访问当前页面。
- `scripting`：仅在用户发起识别、余额、页面 Key 导入或获取 Key 流程时注入站点脚本。
- `contextMenus`：提供右键收藏入口。
- 可选 HTTPS 主机权限：按当前操作的 Origin 请求；显式端口不能被折叠到其他 Origin。

原生完整导出和恢复快照可能包含完整 Key，应按敏感文件处理。脱敏导出不能恢复完整凭据。站点 URL 在保存前会移除 query 和 hash，避免临时令牌或授权码进入本地数据。

## 隐私边界

扩展没有遥测、远程诊断、分析 SDK 或崩溃上报。诊断只能由用户主动复制，并必须排除完整 Key、Cookie、完整站点列表、备注、URL query/hash 和完整存储。

## RC 发布资料

- [RC 流程总览](docs/rc/README.md)
- [RC 验收清单](docs/rc/rc-1-acceptance.md)
- [双人测试矩阵](docs/rc/rc-1-test-matrix.md)
- [问题反馈模板](docs/rc/rc-1-feedback-template.md)
- [问题台账](docs/rc/rc-1-findings.md)
- [凭据清理清单](docs/rc/credential-cleanup.md)
- [不可变发布与撤回规则](docs/rc/immutable-release-policy.md)
- [版本历史](CHANGELOG.md)

维护者只能在干净、正好指向版本注释标签的独立 worktree 中生成候选物：

```powershell
npm run release:artifact -- --out-dir ../public-site-hub-rc1-artifacts
```

该命令会重新构建并校验 `dist/`，再生成确定性 ZIP、标准 `.sha256` sidecar 和 Git 外部 attestation；已有同名文件时会拒绝覆盖。完整的标签、复现和发布记录顺序以 [RC 流程总览](docs/rc/README.md) 为准。

## 已知限制

- 余额查询依赖对应站点的网页登录状态，API Key 不能代替登录会话。
- 自动导入 Key 需要对应站点标签页已打开且会话有效。
- 自动创建只适用于能够验证登录状态和空令牌列表的 NewAPI/OneAPI 兼容测试站；无法确认时必须停止并提示人工处理。
- 第一轮 RC 只支持 Chrome Stable 和 Edge Stable，不包含 Firefox 或浏览器商店安装流程。
