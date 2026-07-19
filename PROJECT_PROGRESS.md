# 公益站收藏 Progress

## 当前检查点

- 更新时间：2026-07-19（Asia/Shanghai）
- 当前目标：`1.0.0-rc.2` 单人双浏览器 RC
- Goal 状态：标签与制品已就绪；手工验收待你执行
- 当前分支：`codex/rc2-hardening`（HEAD 可在标签后有记录提交）
- 源码标签：`v1.0.0-rc.2` → `b48190c9e2c1e78cd9d1ba0d6a88ae781e58b33c`
- 历史标签：`v1.0.0-rc.1` → `7bd153d`

## 本轮已完成

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| 双人验收 → 单人双浏览器 | 完成 | rc.2 文档、README、CHANGELOG、测试断言 |
| 最小 CI | 完成 | `.github/workflows/ci.yml` |
| 标签与发布制品 | 完成 | `v1.0.0-rc.2`；ZIP 在 `release-artifacts/` |
| 双 worktree 复现 | 完成 | ZIP SHA-256 两次一致 |
| Git remote | 未配置 | 需自行 `git remote add` 后推送分支/标签 |
| 真实手工验收 | 待你 | 加载 ZIP，按矩阵走 Chrome + Edge |

## 发布物

- 目录：`release-artifacts/`（gitignore）
- ZIP：`public-site-hub-1.0.0-rc.2.zip`
- SHA-256：`6a215dc47822e4e3fef89f015c0012ae6699889c86db56d1bd9dd1a0f459e6c3`
- 详情：`docs/rc/rc-2-release-record.md`

## 你的下一步

1. 校验 ZIP SHA-256 后解压到**新目录**（不要覆盖旧 RC）。
2. Chrome Stable 与 Edge Stable 各用独立 profile，开发者模式加载该目录。
3. 按 `docs/rc/rc-2-test-matrix.md` 完成权限、Key、余额、导入导出、诊断。
4. 记录问题到 `docs/rc/rc-2-findings.md`，完成后签署发布记录并做凭据清理。
5. （可选）配置 remote 并推送，以便 GitHub Actions 运行。
