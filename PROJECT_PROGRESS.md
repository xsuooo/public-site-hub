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
| 标签与发布制品 | 进行中 | 提交后打 `v1.0.0-rc.2` 并 `release:artifact` |
| Git remote | 未配置 | 仓库无 remote；需维护者自行 `git remote add` |
| 真实手工验收 | 待你执行 | 按 `docs/rc/rc-2-test-matrix.md` |

## 下一步（你）

1. 加载版本化 ZIP 到 Chrome Stable 与 Edge Stable 独立 profile。
2. 按单人矩阵完成权限、Key、余额、导入导出与诊断。
3. 填 `rc-2-findings.md` / `rc-2-release-record.md`，结束后做凭据清理。
4. （可选）配置 git remote 并推送分支与标签，以便 GitHub Actions 运行。
