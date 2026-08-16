# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-08-16

### 新增

- 宿主插件核心:沙盒注册表(原子写)、端口池(探测分配)、进程树管理(3080 保护)
- 9 个原生工具:`sandbox_list / create / inject / run / health / stop / destroy / merge / prune`
- 合回门禁 `sandbox_merge`:白名单 + 语法校验 + bundle 校验 + 备份计划 + dryRun 默认
- 客户端设置页「测试沙盒」区段:沙盒卡片、报告徽标、新建表单、48h 超龄标记、一键清理
- 一键 QA(CDP 9223 真实浏览器,4 项检查)
- 三套测试:单元冒烟 24 项、端到端对抗 13 项(沙盒崩溃/坏补丁下本体 3080 全程无损)、CDP QA
- 安装/卸载脚本 `install.mjs`(幂等四步接线,先备份)
- 设计文档(DESIGN.md)与流程图(FLOW.md)
