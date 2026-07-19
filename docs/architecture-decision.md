# 架构方案与当前选择

## 结论

当前版本继续使用 Manifest V3 classic service worker、`importScripts` 模块图和原生 HTML/CSS/JavaScript。核心状态仍由 `chrome.storage.local` 持久化，站点写入通过串行 mutation queue，长耗时余额请求通过 per-site coordinator 和持久化 `attemptId + Origin` 做并发隔离。

这个选择保留了现有扩展的运行时兼容性、存储键和消息协议，同时把真正影响数据正确性的并发边界放到了存储层，而不是依赖界面互斥。

## 方案比较

| 方案 | 优点 | 代价与风险 | 当前判断 |
| --- | --- | --- | --- |
| Classic MV3 + 原生 UI（当前） | 不需要打包器；`importScripts` 顺序可审计；旧 profile 和消息协议稳定；发布包小 | 全局 API 需要靠加载顺序管理；类型隔离弱 | 当前 RC 最合适 |
| ESM service worker + bundler | 依赖边界、tree-shaking 和类型检查更好 | 会改变脚本加载、测试夹具、发布校验和 service worker 启动语义；迁移时容易丢失旧存储/消息兼容 | 暂不迁移 |
| React/Vue 状态层 | 复杂交互和大型表单更容易组件化 | Popup/Options 包体和生命周期更复杂；短生命周期 Popup 不需要额外框架；会扩大 CSP、构建和 UI 回归面 | 暂不引入 |
| 全局单一余额队列 | 实现简单，顺序直观 | 一个慢站点阻塞全部站点；单站刷新和批量刷新容易重复请求 | 不采用 |
| per-site coordinator + 全局批量控制（当前） | 同一站点只保留一个 in-flight Promise；批量可停止/恢复；站点删除或 Origin 变化能使旧结果失效 | 需要维护 attempt 生命周期和终态计数 | 当前采用 |

## 关键不变量

1. 批量添加只接收 URL 文本，不接收任何 Key 字段；单站 Key 只能在单站上下文写入。
2. 自动创建 Key 持有站点 operation lease；删除操作遇到 lease 时整体返回 `site_operation_busy`，不会部分删除。
3. 余额结果落库前重新验证站点存在、Origin 未变且 `attemptId` 仍为当前值。
4. 导入预览绑定 `siteDataMeta.updatedAt`，写入队列内部再次校验，预览过期不会覆盖较新的编辑。
5. 权限申请只在 Popup/Options 的用户手势中发生；诊断复制只包含 allowlist 字段。

## 演进边界

如果未来需要 ESM 或组件框架，应先保持下列兼容壳不变，再分阶段替换内部实现：

- `chrome.storage.local` 的键和 schema migration；
- service worker 的 message type 与返回码；
- Popup/Options 共享的 `ui-runtime` 契约；
- 真实扩展 smoke、Playwright UI gate 和双浏览器手工验收。

在这些边界没有独立回归门禁前，不把“代码更现代”当作迁移收益。
