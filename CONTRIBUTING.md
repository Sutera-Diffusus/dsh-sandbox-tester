# Contributing

## 开发环境

- Windows 10/11 + Node.js 18+;一个可用的 DeepSeek Harness 安装(0.1.0-rc.6 同系列)。
- **强烈建议在独立 DSH 测试副本上开发**(独立程序目录 + 独立 `DSH_HOME` + 独立端口),不要直接在日常使用的本体上实验;本体与本仓库开发过程中的隔离政策见项目 DESIGN.md。

## 构建与测试

```powershell
node --check lib/*.js client/*.js test/*.mjs   # 语法门禁
node test/smoke.mjs                            # 单元冒烟(24 项,不启动进程)
node test/e2e.mjs                              # 端到端对抗(会复制约 270MB 创建真实沙盒)
node test/qa-cdp.mjs <port>                    # CDP 一键 QA(需 headless Edge 9223)
```

## 提交规范

- 一个提交只做一件事,信息说明动机;
- 涉及 `lib/merge-gate.js`(门禁)或 `lib/proctree.js`(进程管理)的改动,必须附上相应测试的通过输出;
- 不要把 `.credentials.yaml`、令牌、本机用户路径写入提交。

## 架构约定

- 插件自身是**编排器**:宿主进程内代码保持"永不抛异常、不阻塞事件循环、不执行危险操作";
- 危险代码只进沙盒进程;沙盒终止逻辑不得触碰 3080 端口进程;
- 新增工具遵循 `tools-*.js` 模块拆分与 CONTRACT 中的工具签名约定。
