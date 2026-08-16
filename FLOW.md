# dsh-sandbox 工作流程图

> 本文件用 Mermaid 绘制,在 GitHub / VS Code / 支持 Mermaid 的阅读器中可直接渲染。

## 1. 总体架构:本体与沙盒的进程级隔离

```mermaid
flowchart LR
    subgraph BODY["🛡️ 本体 DSH(端口 3080,日常使用,零测试风险)"]
        HOST["宿主插件 dsh-sandbox<br/>(只做编排,自身永不执行危险代码)"]
        TOOLS["9 个原生工具<br/>sandbox_list/create/inject/run/health/<br/>stop/destroy/merge/prune"]
        UI["设置页「测试沙盒」区段<br/>(卡片管理 + 报告徽标 + 48h 超龄提示)"]
        HOST --> TOOLS --> UI
    end

    subgraph SB["🧪 沙盒实例(端口 3182+,用完即弃)"]
        P["独立程序副本<br/>(默认裁剪复制,可切全量)"]
        H["独立 DSH_HOME<br/>(全新初始化)"]
        PROC["独立进程 + 独立端口"]
        TEST["待测插件 / 补丁<br/>(只进沙盒,永不碰本体)"]
        P --> H --> PROC --> TEST
        TEST -. "死循环 / 崩溃 / 误操作" .-> CRASH["只死沙盒进程<br/>本体 3080 全程 200"]
    end

    TOOLS -- "create / run / inject / stop / destroy" --> P
    PROC -- "health / QA report" --> TOOLS
    TOOLS -- "merge(门禁通过后)" --> BODY

    GUARD["bin-guard 启动守卫<br/>(本体启动自愈:<br/>11 文件校验 + 坏文件回滚)"]
    TOOLS -. "merge 成功后同步回滚源" .-> GUARD
```

## 2. 沙盒生命周期状态机

```mermaid
stateDiagram-v2
    [*] --> creating : sandbox_create
    creating --> stopped : 复制完成 + 端口分配 + 注册表写入
    stopped --> running : sandbox_run(预检 3080 → 拉起进程 → 轮询 200)
    running --> stopped : sandbox_stop / 沙盒崩溃
    running --> running : sandbox_health / sandbox_inject(应用补丁)
    running --> [*] : sandbox_destroy(confirm=true)
    stopped --> [*] : sandbox_destroy(confirm=true)
    stopped --> [*] : sandbox_prune(48h 未运行或进程已死)
    creating --> [*] : 创建失败自动回滚半成品
```

## 3. 开发任务自动路由(政策 6 的机器执行形态)

```mermaid
flowchart TD
    A["开发/调试/补丁任务来了"] --> B{"目标是谁?"}
    B -->|"改本体程序/数据/杀 3080"| X["❌ 直接拒绝<br/>(merge 白名单 + 进程树校验双重拦截)"]
    B -->|"待测改动"| C["sandbox_create<br/>复制本体程序目录(只读源)"]
    C --> D["sandbox_inject<br/>把待测插件/补丁打进沙盒"]
    D --> E["sandbox_run<br/>预检本体 3080 → 拉起沙盒"]
    E --> F{"健康检查 / 一键 QA"}
    F -->|"失败"| G["崩溃只在沙盒内<br/>读日志 → 改 → 重跑"]
    G --> D
    F -->|"通过"| H{"要合回本体?"}
    H -->|"否"| I["sandbox_destroy<br/>用完即弃"]
    H -->|"是"| J["sandbox_merge<br/>(进入合回门禁)"]
```

## 4. 合回门禁(sandbox_merge,机器强制,不可绕过)

```mermaid
flowchart TD
    M0["sandbox_merge(name, targets, dryRun=true)"] --> M1{"目标白名单校验<br/>仅 11 个补丁面文件 + 显式新增"}
    M1 -->|"越界/路径穿越"| F1["❌ 拒绝合回"]
    M1 -->|"通过"| M2{"逐文件 node --check<br/>(HTML 结构校验)"}
    M2 -->|"语法坏"| F2["❌ 拒绝 + 自动恢复"]
    M2 -->|"通过"| M3{"bundle 校验<br/>(从 3080 抓取受影响 bundle)"}
    M3 -->|"注册异常"| F3["❌ 拒绝 + 自动恢复"]
    M3 -->|"通过"| M4["生成备份计划<br/>D:\\DeepseekHarness_Backup\\merge-&lt;ts&gt;\\<br/>+ 回滚清单"]
    M4 --> M5{"dryRun?"}
    M5 -->|"true(默认)"| OK["✅ 只校验出报告<br/>绝不写本体"]
    M5 -->|"false"| M6{"DSH_SANDBOX_MERGE_ALLOW=1?"}
    M6 -->|"否"| F4["❌ 拒绝真实写入<br/>(开发期禁止)"]
    M6 -->|"是"| M7["备份先行 → 写入 → 失败即回滚"]
    M7 --> M8["✅ 合回完成<br/>robocopy 同步守卫回滚源"]
```

## 5. 两路对照:为什么必须走沙盒

```mermaid
flowchart TD
    subgraph BAD["❌ 直接改本体(事故路径)"]
        A1["改坏一行代码"] --> A2["本体插件树加载失败"]
        A2 --> A3["主进程崩溃 / 页面打不开"]
        A3 --> A4["用户反复重启 Launcher"]
        A4 --> A5["拒绝连接 + 400 连环暴击"]
    end

    subgraph GOOD["✅ 走测试沙盒(本插件路径)"]
        B1["改坏一行代码"] --> B2["沙盒启动失败 / 崩溃"]
        B2 --> B3["本体 3080 全程 HTTP 200"]
        B3 --> B4["沙盒日志定位 → 修复 → 重跑"]
        B4 --> B5["门禁通过才合回"]
    end
```

## 6. 一键 QA 时序(CDP 9223 驱动真实浏览器)

```mermaid
sequenceDiagram
    participant T as sandbox_run(qa=true)
    participant S as 沙盒实例(3182+)
    participant E as headless Edge(9223)
    participant B as 本体 3080
    T->>B: 预检:记录 3080 owner + HTTP 200
    T->>S: 拉起沙盒进程(独立 env)
    T->>S: 轮询首页 200(60s 超时)
    T->>E: 连接 CDP → 打开沙盒页面
    E->>S: 检查:首页 200 / client.js 200 /<br/>设置页渲染 / 控制台无未捕获异常
    E-->>T: report.json(conclusion: pass|fail)
    T->>B: 复验:3080 owner 未变 + HTTP 200
```

## 7. 发布与安装流程(最终用户视角)

```mermaid
flowchart LR
    U1["下载 Release zip<br/>或 git clone"] --> U2["node install.mjs<br/>--target &lt;DSH_INSTALL_DIR&gt;"]
    U2 --> U3["幂等四步接线:<br/>① bundle 行 ② junction<br/>③ apiproxy 白名单 ④ client 挂载"]
    U3 --> U4["重启 DSH"]
    U4 --> U5["设置 → 测试沙盒<br/>+ 9 个工具注册"]
    U5 --> U6["Agent 会话内直接调用<br/>sandbox_* 工具"]
```
