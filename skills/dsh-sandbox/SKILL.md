---
name: dsh-sandbox
description: 用 DSH 测试沙盒插件做进程级隔离的开发/测试:创建沙盒(sandbox_create)、注入补丁(sandbox_inject)、启动运行(sandbox_run)、健康检查(sandbox_health)、停止/销毁/清理(sandbox_stop/destroy/prune)、门禁式合回(sandbox_merge)。当用户提到沙盒、隔离测试、试跑插件、打补丁、防止搞坏本体(3080)、合回本体或验证改动时使用本技能。
---

# DSH 测试沙盒工作流

本环境通过 `dsh-sandbox` 插件提供**进程级隔离**的测试实例:把开发/测试任务路由到完全隔离的沙盒(独立进程 + 独立 DSH_HOME + 独立端口),沙盒内任何崩溃/死循环/误操作**零影响本体**(3080)。待测代码只进沙盒进程,本插件自身只做编排。

> **路径约定**:下文出现的 `D:\DeepseekHarness_*`、`D:\ai-temp` 等为默认值示例,均可在插件设置(命名空间 `sandbox`)中修改;不同部署环境的路径以其实际配置为准。

## 核心原则(先读)

- **隔离边界是操作系统进程**:沙盒由 `node <sandbox-program>\node_modules\@deepseek-ai\dsh\lib\bin.js web --port <p>` 直接拉起,独立 home + 独立端口(默认 3182 起;本体 3080、固定副本 3181 永不占用)。
- **绝不触碰本体**:所有写操作只落在沙盒目录、注册表(`D:\ai-temp\dsh-sandbox-registry.json`)与备份根(`D:\DeepseekHarness_Backup`)。
- **合回有机器门禁**:改动要回流本体必须走 `sandbox_merge`,门禁不过就进不了本体。
- **用完即弃**:临时性/一次性测试用沙盒;长期开发副本(`D:\DeepseekHarness_Test`,3181)保持不变。

## 九工具清单

| 工具 | 签名(草案) | 用途 |
| --- | --- | --- |
| `sandbox_list` | `{}` | 列出所有沙盒:名称/状态/端口/home/年龄/最近报告结论(含 48h 超龄标记) |
| `sandbox_create` | `{ name?, basePort?, fullCopy? }` | 从本体程序目录复制出沙盒(默认裁剪,`fullCopy:true` 全量)+ 独立 home + 自动分配端口 + 写启动脚本与 meta |
| `sandbox_inject` | `{ name, patch }` | 把补丁打进沙盒 program(先备份 + 写回滚清单,严格校验路径在沙盒内) |
| `sandbox_run` | `{ name, qa? }` | 预检本体 3080 → 拉起沙盒 → 轮询 HTTP 200;`qa:true` 接跑 CDP 冒烟并出报告 |
| `sandbox_health` | `{ name }` | 端口监听 + HTTP 200 + 可选 client bundle 探测,产出结构化 report |
| `sandbox_stop` | `{ name }` | 停止沙盒进程树(仅沙盒 PID 树,终止前校验树内不含 3080 本体 PID) |
| `sandbox_destroy` | `{ name, confirm }` | stop + 删除沙盒目录与 home(需 `confirm:true` 防误删) |
| `sandbox_prune` | `{ dryRun? }` | 清理孤儿沙盒(进程已死且超龄);`dryRun:true` 仅列出候选不删除 |
| `sandbox_merge` | `{ name, targets }` | 门禁式合回(白名单 + 语法 + bundle 校验 + 备份 + 回滚清单) |

### 典型流程

1. `sandbox_create({ name: 'my-test' })` → 记下返回的 port;
2. `sandbox_inject({ name: 'my-test', patch: { files: [{ path: 'node_modules/.../index.js', content: '...' }] } })`;
3. `sandbox_run({ name: 'my-test', qa: true })` → 看 `qa.conclusion` 与 `lastReport`;
4. 需要回流本体时 `sandbox_merge({ name: 'my-test', targets: [{ src: '<沙盒program>/.../index.js', dst: 'node_modules/@deepseek-ai/.../index.js' }] })`(默认 dryRun,先看报告);
5. 收尾 `sandbox_stop` 或 `sandbox_destroy({ name, confirm: true })`,或 `sandbox_prune({ dryRun: true })` 确认后清理。

## 合回门禁说明(sandbox_merge)

门禁是**机器强制的,不可绕过**,顺序如下,任一步失败即中止并自动恢复:

1. **目标白名单**:仅允许 11 个本体补丁面文件 + `targets` 显式声明的新增文件;其它任何既有本体文件一律拒绝;
2. **语法门禁**:对每个待合回文件 `node --check`(HTML 做结构校验),任一失败即拒绝;
3. **bundle 门禁**:校验受影响 bundle 的注册形态(参照 `_dsh-recovery` 的 check 手法);
4. **备份先行**:合回前把目标文件备份到 `D:\DeepseekHarness_Backup\merge-<ts>\`;
5. **回滚清单**:写出本次 apply/rollback 脚本对;
6. **失败即停**:任何一步失败,立即从备份恢复,绝不带着坏状态收工。

**开发阶段安全阀**:`sandbox_merge` 默认 `dryRun:true`(仅校验 + 出报告,绝不写本体);真实写入必须显式设置环境变量 `DSH_SANDBOX_MERGE_ALLOW=1` 且 `dryRun:false`,否则抛错拒绝。

## 政策红线摘要(必须遵守)

- ❌ 禁止写 `D:\DeepseekHarness_WorkSpace\`(真实工作区,只读)、`D:\Deepseek harness\`(本体程序)、`D:\DeepseekHarness_Data\.dsh`(本体数据)。
- ❌ 禁止 Stop-Process / taskkill 任何监听 **3080** 端口的进程;`sandbox_stop` 内部已做 3080 保护。
- ❌ 禁止直接运行 `D:\DeepseekHarness_Test\DeepSeekHarness-Launcher.exe`;副本只能 `cmd /c D:\DeepseekHarness_Test\start-test.bat`(强制独立 home + 3181)。
- ✅ 允许写:`D:\DeepseekHarness_Test_Work\`(插件源码)、`D:\ai-temp\`(日志/注册表)、`D:\DeepseekHarness_Sandboxes\`(沙盒产物)、`D:\DeepseekHarness_Test\`(仅限装插件/打补丁且先备份)。
- ✅ 本体 3080 全程 HTTP 200 是每次操作后应复核的硬指标。

## 收工自检

1. 产出文件路径前缀是否都在允许写区(未写任何禁区)?
2. 3080 监听 PID 是否与开工时一致?本体 3080 HTTP 仍 200?
3. 自己拉起的沙盒进程:留着要写明用途,停了要写明 PID?
