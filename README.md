# 公益站收藏

[![CI](https://github.com/xsuooo/public-site-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/xsuooo/public-site-hub/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**一键收藏公益 / 中转 API 站**：本地管 Key、查余额、导入导出。
Manifest V3 浏览器扩展 · 当前版本 `1.0.0-rc.3`（商店未上架，请用开发者模式加载）。

> **不要用生产账号或生产 Key 做联调。** 完整 Key、Cookie、真实站点清单不要进截图、issue 或仓库。

---

## 能做什么

| 能力 | 说明 |
|------|------|
| **收藏站点** | 从当前页识别 Origin（含显式端口），一键入库 |
| **本地 Key** | Key 只存在本机 `chrome.storage.local`；列表只显示尾号，完整值仅用户主动复制 |
| **余额查询** | 单站 / 批量；批量可停止、继续，浏览器重启后可恢复未完成队列 |
| **按站授权** | 可选 HTTPS 主机权限，按 Origin 申请；拒一站不影响其余 |
| **导入导出** | 导入前预览新增 / 更新 / 跳过；支持脱敏分享与完整备份 |
| **诊断** | 手动复制脱敏诊断；没有遥测、无自动上传 |

站点和恢复快照写入前会预检浏览器本地**存储配额**；空间不足时整次写入取消，**不会部分覆盖**现有数据。

---

## 快速安装

### 从源码（开发者模式）

要求：**Node.js 22+**，以及 Edge Stable（或可加载未打包扩展的 Chromium）。

```powershell
npm install
npm test
npm run test:coverage
npm run verify:syntax
npm run build
npm run verify:package
npm run verify:runtime
npm run verify:ui
```

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择相对路径 `dist/`

### 从发布 ZIP

在干净 worktree、指向发布标签的状态下：

```powershell
npm run release:artifact -- --out-dir ../public-site-hub-rc3-artifacts
```

校验 `.sha256` 后解压到**独立目录**再加载；不要覆盖旧解压目录。标签：`v1.0.0-rc.3`。

---

## 基本用法

1. 打开目标站点 → 点扩展图标 → **收藏当前页**
2. 首次识别 / 查余额 / 管 Key 时，在浏览器提示中批准该站的 HTTPS 权限
3. 没有 Key 时，用卡片上的获取 / 导入；只有在兼容站、已登录且远端令牌列表确认空时，才会在二次确认后创建测试 Key
4. **复制接口地址**只复制 `https://example.invalid/v1` 形式的地址；**复制 Key**单独执行。剪贴板用完建议清理
5. 设置页：批量添加、编辑、导入备份、诊断与孤立授权清理

---

## 本地开发

```powershell
npm test                 # 单元 / 集成测试
npm run test:coverage    # 覆盖率
npm run verify:syntax    # 全量 JS 语法检查
npm run build            # 输出 dist/
npm run verify:package   # dist 白名单校验
npm run verify:runtime   # Edge/Chromium 扩展上下文冒烟（无账号无 Key）
npm run verify:ui        # Playwright UI 门禁（隔离 profile + 合成数据）
```

| 命令 | 用途 |
|------|------|
| `verify:runtime` | 真实扩展上下文冒烟；**不替代** Chrome Stable 手工验收 |
| `verify:ui` | Popup / Options 布局与交互；临时数据不进 `dist/` |
| `rc:fixture` | 本机 NewAPI 夹具（无外部测试站时） |

修改源码后重新 `npm run build`，并在扩展管理页点「重新加载」。**不要直接改 `dist/`**，也不要提交 `dist/`、测试浏览器配置或发布 ZIP。

Playwright 默认找 Edge；也可设 `PUBLIC_SITE_HUB_BROWSER_PATH` 指向可执行文件。

---

## 权限与本地数据

- `storage`：在 `chrome.storage.local` 中保存站点、Key、偏好、迁移状态和未完成批量任务。
- `alarms`：仅唤醒本地维护任务，清理超过保留期的恢复快照；不执行网络请求。
- `tabs`：在用户主动打开站点、识别、导入 Key 或查询余额时读取或创建相关标签页。
- 扩展不申请 `cookies` 权限；需要登录状态的余额和 Key 操作在用户已打开或扩展临时打开的目标站标签页内执行，由浏览器按 Origin、路径与 Cookie 属性处理会话。
- `activeTab`：在用户点击扩展或右键入口时临时访问当前页面。
- `scripting`：仅在用户发起识别、余额、页面 Key 导入或获取 Key 流程时注入站点脚本。
- `contextMenus`：提供右键收藏入口。
- 可选 HTTPS 主机权限：按当前操作的 Origin 请求；显式端口不能被折叠到其他 Origin。

完整导出和恢复快照可能包含完整 Key，应按敏感文件处理。脱敏导出不能恢复完整凭据。站点 URL 在保存前会移除 query 和 hash，避免临时令牌或授权码进入本地数据。

`chrome.storage.local` 受浏览器 profile 保护，但扩展不会额外加密其中的 Key；能够读取该 profile 的本机用户或调试工具仍可能读取完整值。需要更强 at-rest 保护时，应使用独立浏览器 profile 或操作系统级凭据库。

---

## 隐私

扩展没有遥测、远程诊断、分析 SDK 或崩溃上报。诊断只能由用户主动复制，并必须排除完整 Key、Cookie、完整站点列表、备注、URL query/hash 和完整存储。

---

## 项目结构（简）

```
background.js          # Service Worker：消息分发、菜单、维护闹钟
popup.* / options.*    # 弹窗与设置页
storage.js             # 本地存储、迁移、配额预检、恢复快照
balance-refresh.js     # 单站 / 批量余额编排
permissions.js         # 可选主机权限
message-contract.js    # 运行时消息契约
key-*.js / page-scrape.js / detect.js / site-*.js
tests/                 # node:test + Playwright UI
scripts/               # 构建、冒烟、发布
docs/                  # 架构决策、RC 夹具说明
```

更多：

- [架构方案与当前选择](docs/architecture-decision.md)
- [版本历史](CHANGELOG.md)
- [本机 NewAPI 夹具](docs/rc/local-newapi-fixture.md)

---

## 已知限制

- 余额查询依赖对应站点的网页登录状态，API Key 不能代替登录会话
- 自动导入 Key 需要对应站点标签页已打开且会话有效
- 自动创建只适用于能够验证登录状态和空令牌列表的 NewAPI/OneAPI 兼容测试站
- 第一轮 RC 只支持 Chrome Stable 和 Edge Stable，不包含 Firefox 或浏览器商店安装流程

---

## 版本与发布

- 当前冻结候选：`1.0.0-rc.3`（`version_name`），manifest `version` 为 `0.99.0.3`
- `v1.0.0-rc.3` 源码标签与制品不可变；后续加固记在 [CHANGELOG Unreleased](CHANGELOG.md)
- 权限 UX 增量分支：`rc4/permission-ux`

生成可分发 ZIP（须在干净、指向注释标签的 detached worktree 中执行；已有同名文件时拒绝覆盖）：

```powershell
npm run release:artifact -- --out-dir ../public-site-hub-rc3-artifacts
```

---

## 许可证

[MIT](LICENSE)
