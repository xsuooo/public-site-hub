# 1.0.0-rc.3 验收清单

状态：自动化门禁已通过；源码尚未冻结，标签和不可变 ZIP 尚未生成

本清单只能针对未来 `v1.0.0-rc.3` 对应提交及其不可变 ZIP 执行。当前源码目录和 `dist/` 不能代替候选制品。测试只使用专用账号和测试 Key，不得使用生产凭据。

## 候选信息

- 提交 SHA：待源码冻结后填写
- Git 标签：`v1.0.0-rc.3`（待创建）
- Manifest 版本：`0.99.0.3`
- ZIP 文件：`public-site-hub-1.0.0-rc.3.zip`（待生成）
- ZIP SHA-256：待生成
- 外部 attestation：`public-site-hub-1.0.0-rc.3.attestation.json`（待生成）
- 构建日期和执行人：待生成后填写

## 自动化与制品

- [x] `npm ci --ignore-scripts` 通过，依赖审计为 0 vulnerabilities。
- [x] `npm run verify:syntax` 对 54 个 JavaScript 文件通过。
- [x] `npm test` 通过 275/275，无 fail、skip 或 todo。
- [x] `npm run test:coverage` 通过，all files 行覆盖率 67.08%。
- [x] `npm run build` 和 `npm run verify:package` 通过，包只含 28 个 runtime 文件。
- [x] `npm run verify:runtime -- --browser=edge` 在隔离 Edge 中通过，0 console errors。
- [x] `npm run verify:ui` 通过 empty、single、mixed、hundred 四个场景。
- [ ] 源码冻结提交已完成，工作树为空，`HEAD` 与注释标签提交完全一致。
- [ ] `npm run release:artifact -- --out-dir <外部空目录>` 只在标签的干净 detached worktree 中运行。
- [ ] 第二个全新 detached worktree 生成相同 ZIP SHA-256，sidecar 和 attestation 一致。
- [ ] Chrome Stable 与 Edge Stable 都从新目录加载该 ZIP，service worker、Popup、Options 和控制台无错误。

## rc.3 新增加固

- [ ] Manifest 不包含 `cookies` 权限；公共站点探测请求不携带浏览器 Cookie。
- [ ] 已登录余额和 Key 操作仍只在用户选定且 Origin 匹配的目标站标签页上下文执行。
- [ ] 超过存储配额的站点或快照写入返回 `storage_quota_exceeded`，原数据不被部分覆盖。
- [ ] 43 个 runtime 消息类型的既有 Popup/Options 操作全部保持可用。
- [ ] 未知消息返回 `unknown_message`，不进入业务分发。
- [ ] 非当前扩展发送方返回 `untrusted_sender`，不读取或修改数据。
- [ ] 超长 ID、超过 1000 项的 ID 数组、超过 2 MB 的文本或导入配置被拒绝。

## 权限、Origin 与 Key

- [ ] 站点权限只由 Popup/Options 的直接用户点击请求；“授权”可一次请求全部已收藏 Origin，拒绝后可从新的用户手势再次授权。
- [ ] 收藏、识别、重新识别、余额和 Key 操作只处理当前操作的精确 HTTPS Origin。
- [ ] 显式端口在权限、标签页、存储、请求和导出中保持一致；跨 Origin 或导航变化时失败闭合。
- [ ] 批量刷新中未授权站点记为跳过，已授权站点继续处理。
- [ ] 掩码、截断、示例和页面非可信文本不能保存、复制或设为默认 Key。
- [ ] 创建 Key 前可以取消；明确确认后最多创建一把，并在创建前再次验证账号与 Origin。
- [ ] 获取 Key 自动补开的令牌页使用后台标签，不切走用户当前页面；主动打开令牌页仍可前台进入。
- [ ] “复制接口地址”与“复制 Key”保持两个独立动作，完整 Key 不进入日志、诊断或截图。

## 余额、导入与恢复

- [ ] 单站和批量余额成功、未登录、权限拒绝、类型错误及超时均显示稳定状态和下一步。
- [ ] 批量刷新可协作式停止并继续；已完成结果保留，未处理项不误记失败。
- [ ] 扩展重新加载或浏览器重启后能识别中断任务，旧 runId 不覆盖新任务。
- [ ] 所有导入先预览新增、更新、重复和跳过数量；取消不修改存储。
- [ ] 替换导入先创建恢复快照；恢复、删除和清理快照均按预期工作。
- [ ] 完整导出需要确认，脱敏导出不能恢复凭据，URL query/hash 不进入导出。

## UI、诊断与隐私

- [ ] Popup/Options 在 100%、125% 和 150% 缩放及浅色/深色主题下无横向溢出或文字遮挡。
- [ ] Tab、Shift+Tab、Enter、Space 和 Escape 可完成主路径，浮层关闭后焦点返回触发器。
- [ ] 脱敏诊断只包含 allowlist 计数和稳定错误码，不含 Key、Cookie、备注、完整存储或真实站点列表。
- [ ] 没有遥测、远程日志、分析 SDK、崩溃上报或自动诊断上传。

## 放行判定

- [ ] 唯一测试者完成 Chrome Stable 主验收与 Edge 干净 profile 交叉冒烟。
- [ ] 同一测试者完成 Edge Stable 主验收与 Chrome 干净 profile 交叉冒烟。
- [ ] 所有发现进入 `rc-3-findings.md`，P0、P1 和阻断型 P2 均为零。
- [ ] 延期 P2/P3 已记录影响、规避方式、责任人和目标版本。
- [ ] ZIP、SHA-256、attestation、提交和标签全部一致。
- [ ] 测试凭据撤销、浏览器 profile 和临时导出清理责任人及期限已记录。
- [ ] 测试者与维护者完成最终签署。

最终结果：待候选制品生成和手工验收
