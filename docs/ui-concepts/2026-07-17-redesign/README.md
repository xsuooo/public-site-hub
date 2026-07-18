# 公益站收藏 UI 重构概念稿

这些文件是 1.0 UI 重构的可执行布局稿，不是生产扩展代码，也不会进入 `dist/`。

## 页面

- `popup-concept.html`：popup 混合状态、空状态、浅色/深色与筛选交互。
- `options-concept.html`：站点管理、导入与备份、诊断与权限、编辑 drawer 和统一确认 dialog。
- `concept.css`：概念设计 token、组件与响应式布局。
- `concept.js`：仅用于切换概念状态和展示交互，不调用扩展 API。

## 推荐评审地址

通过本地静态服务器打开：

```text
popup-concept.html?capture=1&state=mixed&theme=light
popup-concept.html?capture=1&state=empty&theme=dark
options-concept.html?capture=1&view=sites&drawer=1&theme=light
options-concept.html?capture=1&view=import&dialog=replace&theme=light
options-concept.html?capture=1&view=diagnostics&theme=dark
options-concept.html?capture=1&view=sites&drawer=1&theme=light  （768px viewport）
```

查询参数只用于固定截图状态；实际工作区交互会同步到 `#view=sites`、`#view=import`、`#view=diagnostics` 与 `#view=sites&edit=<siteId>`，并继续接受旧格式 `#edit=<siteId>`。

## 字体策略

- 英文和数字使用本机 `Segoe UI Variable` / `Segoe UI`，中文优先 `Noto Sans SC`，并回退到微软雅黑或苹方。
- 域名、Origin 与诊断字段使用 `Cascadia Mono` 优先的本地等宽字体；紧凑卡片中的 Key 尾号使用 UI 字体和等宽数字，避免与中文元数据混排时出现字重、基线跳变。
- 只使用 400、500、600、700 四档真实字重，关闭合成粗体；中文标题不再使用负字距。
- 不加载远程字体；目标字体缺失时按上述栈自然回退。

## 概念验收台账

| 检查点 | 结果 |
| --- | --- |
| 文案与信息层级 | Popup 列表优先；Options 三工作区、导入先预览、诊断摘要优先均已对齐 |
| Popup 容器 | 440×680 画布内保持 420×640；页面不滚动，只有站点列表滚动；真空数据与筛选无结果分离 |
| 批量余额 | 运行中进度条提供协作式“停止”；当前站点完成后结束，保留已完成结果与未处理队列 |
| 响应式 | 1280px 使用表格，768px 使用卡片和顶部导航；单栏 drawer 全宽；无横向溢出 |
| 浮层与键盘 | 菜单自动避让边界并在 Esc 后回焦；drawer 限制焦点；危险确认使用原生 `<dialog>` |
| Key 与合成数据 | 普通界面只显示名称、状态和尾号；域名均为 `.invalid`，无真实凭据 |
| 主题与运行时 | 六个交付状态覆盖浅色、深色、drawer、dialog 与窄屏；控制台零错误/警告 |

精确验证尺寸为 440×680、1280×900、1536×1024、768×1024，并额外检查 1024×720 与 614×819 的 125% 等效 CSS 视口。内置浏览器用于语义与交互检查；因其 viewport 覆盖不可靠，精确像素验收使用隔离 Playwright Chromium。

这些概念已经批准并作为生产 UI 的设计基线；后续实现必须继续忠实保持其信息层级、布局、文案、颜色、密度和交互模型。概念中的合成域名、余额和 Key 尾号仅用于展示。
