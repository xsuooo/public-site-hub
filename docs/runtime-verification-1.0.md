# 公益站收藏 1.0 真实运行验证

状态：由 `1.0.0-rc.2` 验收流程接管

此文件保留旧入口，避免历史链接失效。当前唯一有效的发布门禁是：

- [RC 流程总览](rc/README.md)
- [RC 验收清单](rc/rc-2-acceptance.md)
- [单人双浏览器测试矩阵](rc/rc-2-test-matrix.md)
- [问题台账](rc/rc-2-findings.md)
- [历史 rc.1 双人矩阵（归档）](rc/rc-1-test-matrix.md)

验收必须加载由当前源码生成并通过包校验的 `dist/`，不得直接加载源码目录，也不得使用生产账号、生产 Key 或真实站点清单作为证据。

隔离 Edge/Chromium 扩展上下文自动冒烟、Chrome Stable 与 Edge Stable 单人双浏览器真实账号手工验收都完成后，维护者才能签署 RC。旧 2.x 验收清单已移入 [archive/](archive/README.md)，仅供历史参考。
