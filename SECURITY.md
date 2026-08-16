# Security Policy

## 数据边界

- 本插件**不读取、不上传任何用户凭据或会话数据**;所有文件操作限于:沙盒注册表(`D:\ai-temp\dsh-sandbox-registry.json`)、沙盒实体目录(`D:\DeepseekHarness_Sandboxes\`)、以及安装时明确列出的两处 DSH 配置(profile manifest 与 apiproxy 白名单,均先备份)。以上路径均为默认值,可在插件设置(命名空间 `sandbox`)中修改,不同部署环境以其实际配置为准。
- 无遥测、无外部网络请求;一键 QA 仅连接本机 `127.0.0.1`(目标实例与 CDP 9223)。

## 本体保护设计

- `sandbox_stop` 与进程树终止前会反查 3080 监听 PID,目标树内包含本体进程时**拒绝执行**;
- `sandbox_merge` 的目标白名单仅允许 11 个补丁面文件与显式声明的新增文件,越界、路径穿越、语法失败一律拒绝;真实写入需显式环境开关 `DSH_SANDBOX_MERGE_ALLOW=1`,且失败自动回滚;
- 沙盒启动入口强制注入独立 `DSH_HOME` 与 `DSH_INSTALL_DIR`,杜绝与本体数据串写。

## 报告漏洞

请在仓库 Issues 提交,或通过 Security Advisory 私密报告。请勿在公开 Issue 中附带任何凭据、路径中的真实用户名或会话数据。
