# 公益站收藏

[![CI](https://github.com/xsuooo/public-site-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/xsuooo/public-site-hub/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**一键收藏公益 / 中转 API 站**：本地管 Key、查余额、导入导出。
Manifest V3 浏览器扩展 · 当前版本 `1.0.0-rc.3`（商店未上架，请用开发者模式加载）。

---

## 能做什么

| 能力 | 说明 |
|------|------|
| **收藏站点** | 从当前页识别 Origin（含显式端口），一键入库 |
| **本地 Key** | Key 只存在本机 `chrome.storage.local`；列表只显示尾号，完整值仅用户主动复制 |
| **余额查询** | 单站 / 批量；批量可停止、继续，浏览器重启后可恢复未完成队列 |
| **按站授权** | 可选 HTTPS 主机权限，按 Origin 申请；拒一站不影响其余 |
| **导入导出** | 导入前预览新增 / 更新 / 跳过；支持脱敏分享与完整备份 |
| **诊断** | 手动复制脱敏诊断；无遥测、无自动上传 |

> **不要用生产账号或生产 Key 做联调。** 完整 Key、Cookie、真实站点清单不要进截图、issue 或仓库。

---

## 快速安装

### 从源码（开发者模式）

要求：**Node.js 22+**，以及 Edge Stable（或可加载未打包扩展的 Chromium）。

```powershell
npm install
npm test
npm run build
npm run verify:package
```

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择项目里的 `dist/`

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
4. **复制接口地址** 与 **复制 Key** 分开；剪贴板用完建议清理
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

| 权限 | 用途 |
|------|------|
| `storage` | 站点、Key、偏好、迁移状态、未完成批量任务 |
| `alarms` | 仅清理过期本机恢复快照，**不访问站点、不刷余额** |
| `tabs` / `activeTab` | 用户主动打开站、识别、导入 Key、查余额时读写相关标签 |
| `scripting` | 同上场景注入站点脚本 |
| `contextMenus` | 右键收藏 |
| 可选 HTTPS 主机 | 按操作 Origin 申请；**显式端口不能被折叠** |

- **不申请 `cookies`**。需要登录态的操作在目标站标签页内执行，由浏览器按 Origin 处理会话。
- 站点 URL 入库前剥离 query / hash，避免临时令牌进本地数据。
- 完整导出与恢复快照可含完整 Key，按敏感文件处理；脱敏导出不能恢复凭据。
- `chrome.storage.local` 受 profile 保护，扩展**不额外加密** Key；能读该 profile 的本机用户仍可能看到明文。需要更强 at-rest 保护时，请用独立浏览器 profile 或系统凭据库。

---

## 隐私

- 无遥测、无远程诊断、无分析 SDK、无崩溃上报
- 诊断只能用户主动复制，且排除完整 Key、Cookie、完整站点列表、备注、URL query/hash

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

- 余额依赖站点**网页登录态**，API Key 不能代替登录会话
- 自动导入 Key 需要目标站标签已打开且会话有效
- 自动创建仅适用于能校验登录与空令牌列表的 NewAPI / OneAPI 兼容测试站
- 第一轮 RC：**Chrome Stable + Edge Stable**；不含 Firefox / 商店安装流程

---

## 版本与发布

- 当前冻结候选：`1.0.0-rc.3`（`version_name`），manifest `version` 为 `0.99.0.3`
- `v1.0.0-rc.3` 源码标签与制品不可变；后续加固记在 [CHANGELOG Unreleased](CHANGELOG.md)
- 权限 UX 增量分支：`rc4/permission-ux`

---

## 许可证

[MIT](LICENSE)
