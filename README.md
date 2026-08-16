# dsh-sandbox

**DSH 测试沙盒插件**——为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的进程级隔离测试场。

开发/测试类改动全部跑在完全隔离的沙盒实例(独立进程 + 独立数据 + 独立端口)里,沙盒内任何死循环、崩溃、误操作都**不会影响本体**(本体 3080 全程可用);合回本体必须通过机器强制的门禁校验,改坏代码再也打不开页面的日子到此为止。

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-0.1.0-blue)
![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.6-blue)

---

## 目录

- [特性](#特性)
- [架构与流程图](#架构与流程图)
- [安装要求](#安装要求)
- [安装教程](#安装教程)
- [使用说明](#使用说明)
- [合回门禁](#合回门禁)
- [数据与隐私](#数据与隐私)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [故障排查](#故障排查)
- [License](#license)

---

## 特性

### 🧪 进程级隔离沙盒

- `sandbox_create` 从本体程序目录复制出独立沙盒(默认裁剪,`fullCopy: true` 全量);
- 沙盒 = 独立程序副本 + 全新 `DSH_HOME` + 自动分配独立端口(3182 起,冲突自动 +1);
- 沙盒由 `node bin.js web --port <p>` 直接拉起,崩溃只死沙盒进程;
- 实证:沙盒内注入坏补丁/强杀沙盒进程,本体 3080 全程 HTTP 200。

### 🛠️ 9 个原生工具

| 工具 | 用途 |
| --- | --- |
| `sandbox_list` | 列出全部沙盒(状态/端口/年龄/最近报告) |
| `sandbox_create` | 创建沙盒(裁剪或全量复制、指定端口) |
| `sandbox_inject` | 把待测插件/补丁打进沙盒(自动备份 + 回滚清单,路径越界即拒绝) |
| `sandbox_run` | 预检本体 → 拉起沙盒 → 轮询健康 → 可选一键 QA |
| `sandbox_health` | 端口 + HTTP + 关键 bundle 检查,产出报告 |
| `sandbox_stop` | 停止沙盒(进程树校验:永不会误伤 3080) |
| `sandbox_destroy` | 销毁沙盒(需 `confirm: true`,目录与注册表全清) |
| `sandbox_merge` | **门禁式合回**(见下文) |
| `sandbox_prune` | 清理孤儿/超龄沙盒(默认 48h 标记,dryRun 预览) |

### 🚧 合回门禁(机器强制,不可绕过)

目标白名单(11 个补丁面文件 + 显式新增)→ 逐文件 `node --check` → bundle 校验 → 备份计划 + 回滚清单 → 默认 dryRun 只校验出报告;真实写入需 `DSH_SANDBOX_MERGE_ALLOW=1` 且失败即自动回滚。

### 🌐 一键 QA(真实浏览器)

`sandbox_run qa: true` 接跑 CDP 9223 驱动的 headless Edge:首页 200、`/plugins/dsh-sandbox/client.js` 200、设置页真实渲染「测试沙盒」区段、控制台无未捕获异常,产出结构化报告。

### ⚙️ 设置页管理

DSH 设置 → **测试沙盒**:沙盒卡片(状态徽标/报告徽标/端口/年龄/操作按钮)、新建表单、48h 超龄提示、一键清理、合回门禁摘要卡。

---

## 架构与流程图

插件自身只做**编排**,不执行危险代码;危险代码永远只进沙盒进程。完整架构、生命周期、门禁决策树与一键 QA 时序见 [FLOW.md](./FLOW.md)。

```text
本体(3080)─ 宿主插件 + 9 工具 + 设置页区段(自身永不执行危险代码)
    │  create / run / inject / stop / destroy
    ▼
沙盒(3182+)─ 独立程序副本 + 独立 DSH_HOME + 独立进程
    │  崩溃/死循环/误操作
    ▼
只死沙盒进程 —— 本体 3080 全程 200
```

---

## 安装要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 |
| Node.js | 18+(执行安装脚本需要) |
| DeepSeek Harness | `0.1.0-rc.6` 或同系列版本 |
| 磁盘 | 每个沙盒默认裁剪复制约 270 MB(node_modules) |

> 安装脚本会修改 DSH 安装目录中两处文件(profile manifest、apiproxy 白名单,均先备份),建议安装前关闭 DSH 页面。

## 安装教程

### 第 1 步:获取插件

**方式 A:下载 Release(推荐)**:打开 [Releases](https://github.com/Sutera-Diffusus/dsh-sandbox-tester/releases),下载最新版 zip 并解压。

**方式 B:克隆仓库**

```powershell
git clone https://github.com/Sutera-Diffusus/dsh-sandbox-tester.git
cd dsh-sandbox-tester
```

### 第 2 步:确认 DSH 安装目录

DSH 安装目录通常包含 `DeepSeekHarness-Launcher.exe` 和 `node_modules`。可通过启动器配置确认:

```powershell
Get-Content "D:\Deepseek harness\DeepSeekHarness-Launcher.cfg"
```

其中 `workDir` 字段指向安装目录,下文以 `<DSH_INSTALL_DIR>` 代替(本文示例路径 `D:\Deepseek harness` 为作者环境,请按实际替换)。脚本会从目标目录的 `DeepSeekHarness-Launcher.cfg` 自动解析其 `DSH_HOME`。

### 第 3 步:执行安装脚本

```powershell
node install.mjs --target "<DSH_INSTALL_DIR>"
```

幂等四步接线(重复执行安全):

1. bundle 行合入 profile manifest(`dsh-sandbox` + `file:` 依赖);
2. node_modules junction(profile 链接 + 内置包扁平回退);
3. apiproxy 设置白名单加 `sandbox`(先备份 `.dsh-sandbox-bak`);
4. 客户端插件挂载校验(`/plugins/dsh-sandbox/client.js` 可达)。

### 第 4 步:重启 DSH 并验证

1. 重启 DSH(服务与页面);
2. 打开设置页 → 应出现「测试沙盒」区段;
3. 新建会话,让 Agent 调用 `sandbox_list` → 9 个工具已注册。

### 卸载

```powershell
node install.mjs --target "<DSH_INSTALL_DIR>" --uninstall
```

## 使用说明

### 在会话中使用工具

直接对 Agent 说,例如:

- 「用测试沙盒验证这个补丁:先 `sandbox_create`,再 `sandbox_inject` 打进去,`sandbox_run` 起来,健康检查过了再 `sandbox_merge`」
- 「`sandbox_list` 看看现在有哪些沙盒,把超龄的清掉」

### 设置面板

路径:DSH 设置 → **测试沙盒**。

| 分组 | 内容 |
| --- | --- |
| 沙盒卡片 | 名称 / 状态(运行中·已停止·已销毁)/ 最近报告(通过·失败 + 摘录)/ 端口 / 年龄 / 启动·停止·健康检查·销毁 |
| 新建沙盒 | 名称 + 可选端口 + 完整复制开关 |
| 维护 | 48h 超龄标记、一键清理孤儿沙盒、合回门禁摘要 |

## 合回门禁

```text
sandbox_merge(name, targets, dryRun=true)
 ├─ ① 目标白名单(11 补丁面 + 显式新增,越界即拒)
 ├─ ② 逐文件 node --check
 ├─ ③ bundle 校验
 ├─ ④ 备份计划 + 回滚清单(不执行)
 └─ ⑤ dryRun=true → 只出报告;dryRun=false 需 DSH_SANDBOX_MERGE_ALLOW=1,失败即回滚
```

合回成功后自动同步 `D:\DeepseekHarness_Backup`(DSH 启动守卫 bin-guard 的回滚源)。

## 数据与隐私

- 沙盒注册表写入 `D:\ai-temp\dsh-sandbox-registry.json`,沙盒实体在 `D:\DeepseekHarness_Sandboxes\`(可在设置中改);
- 不读取、不上传任何用户凭据或会话数据;
- 除复制本体程序目录(只读)外,插件不对本体做任何写入;
- 无遥测、无外部网络请求(一键 QA 仅连本机 127.0.0.1)。

## 项目结构

```text
dsh-sandbox/
├─ lib/
│  ├─ index.js            # 宿主插件主入口(服务组装 + 9 工具注册 + settings 命名空间)
│  ├─ registry.js         # 沙盒注册表(原子写)与共享常量
│  ├─ ports.js            # 端口池(探测 + 自动分配)
│  ├─ proctree.js         # 进程树管理(3080 保护 + 拉起/停止/存活判定)
│  ├─ tools-lifecycle.js  # list/create/inject/stop/destroy/prune
│  ├─ tools-runhealth.js  # run/health
│  └─ merge-gate.js       # 合回门禁
├─ client/
│  └─ client.js           # 设置页「测试沙盒」区段
├─ test/
│  ├─ smoke.mjs           # 单元冒烟(24 项)
│  ├─ e2e.mjs             # 端到端对抗(创建→启动→杀进程→坏补丁→销毁,13 项)
│  └─ qa-cdp.mjs          # 一键 QA(CDP 9223 真实浏览器,4 项)
├─ skills/dsh-sandbox/    # Agent 技能(SKILL.md)
├─ cordis.patch.yml       # bundle 接入(loader entry: test-sandbox)
├─ install.mjs            # 安装/卸载(幂等)
├─ DESIGN.md              # 设计规格(含评审结论)
├─ FLOW.md                # 工作流程图(Mermaid)
├─ LICENSE / README.md / CHANGELOG.md / SECURITY.md / CONTRIBUTING.md
```

## 开发与测试

```powershell
# 单元冒烟(24 项,不启动任何进程)
node test/smoke.mjs

# 端到端对抗(真实复制 270MB 创建沙盒;需本体 3080 在运行以做无损对照)
node test/e2e.mjs

# 一键 QA(需 headless Edge CDP 9223 + 目标实例)
node test/qa-cdp.mjs <port>
```

> 开发建议:在独立 DSH 测试副本上开发验证,避免污染主安装;本仓库开发期间遵循的隔离政策见 CONTRIBUTING。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 副本/本体启动报 `duplicate loader entry id: sandbox` | 你的组合里混入了旧版 cordis.patch.yml;确认使用 `test-sandbox` entry(本仓库已修复) |
| 设置页没有「测试沙盒」区段 | 安装后需重启 DSH;确认 apiproxy 白名单含 `sandbox`(install.mjs 会打印) |
| 沙盒启动失败 | 看沙盒 stderr;首启需完成引导,QA 脚本已自动处理(预置 workspace) |
| 销毁沙盒报错 | `confirm` 必须为 `true`;运行中的沙盒先 `sandbox_stop` |

## License

[MIT](./LICENSE)
