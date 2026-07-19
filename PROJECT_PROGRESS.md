# 公益站收藏 Progress

## 当前检查点

- 更新时间：2026-07-19（Asia/Shanghai）
- 当前目标：`1.0.0-rc.2` 单人双浏览器 RC 就绪
- Goal 状态：文档与 CI 已切换；标签/制品/手工验收按发布流程推进
- 当前分支：`codex/rc2-hardening`
- 冻结标签：`v1.0.0-rc.1` 指向 `7bd153d`（历史）；`v1.0.0-rc.2` 在本轮修复中创建

## 本轮修复

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| 双人验收 → 单人双浏览器 | 已改 | rc.2 文档、README、CHANGELOG、测试断言 |
| 最小 CI | 已加 | `.github/workflows/ci.yml`（test/build/verify:package/audit） |
| 标签与发布制品 | 已完成 | `v1.0.0-rc.2` @ `cdfc253`；ZIP SHA-256 见发布记录 |
| 双 worktree 复现 | 已完成 | 两次 SHA-256 均为 `6a215dc4…e6c3` |
| Git remote | 未配置 | 仓库无 remote；需自行 `git remote add` 后推送 |
| 真实手工验收 | 待你执行 | 加载 `release-artifacts` 中的 ZIP，按矩阵验收 |

## 发布物位置

- 本地：`release-artifacts/public-site-hub-1.0.0-rc.2.zip`（gitignore，勿提交）
- 标签：`v1.0.0-rc.2` → `cdfc253fc5e76265be06de9b7883d1ff218283c5`

## 下一步（你）

1. 校验 ZIP SHA-256 与 `docs/rc/rc-2-release-record.md` 一致后解压到**新目录**。
2. Chrome Stable + Edge Stable 各用独立 profile 加载该目录。
3. 按 `docs/rc/rc-2-test-matrix.md` 完成权限、Key、余额、导入导出与诊断。
4. 填 `rc-2-findings.md` / 发布记录签署，结束后做凭据清理。
5. （可选）配置 git remote 并推送分支与标签，以便 GitHub Actions 运行。
