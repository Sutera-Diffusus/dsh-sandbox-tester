/**
 * dsh-sandbox 客户端插件:DSH 设置页「测试沙盒」区段。
 *
 * 设计:完整照抄 dsh-github v4/v5 验证过的客户端模式(settings.section 注册 +
 * HelpTip 悬浮提示 + DSW token 视觉语言 + 卡片组件 + settings 命名空间读写),
 * 把 github 域换成 sandbox 域:
 *
 * 1. 沙盒卡片列表:名称 / 状态徽标(运行中·已停止·已销毁·创建中)/ 最近报告徽标
 *    (通过·失败 + 摘录,来自 verify/QA/merge)/ 端口 / 年龄 / 操作按钮(启动·停止·健康检查·销毁);
 * 2. 「新建沙盒」表单(名称 + 可选端口 + 完整复制开关);
 * 3. 合回门禁摘要卡(最近一次 merge 的结论);
 * 4. 一键「清理孤儿沙盒」+ 48h 超龄标记提示。
 *
 * 数据通道(与宿主 M0 的契约,见 CONTRACT.md §4 / DESIGN.md §3.2、§4.1):
 * - 读:settings 命名空间 "sandbox"(settingsScope.bind({ namespace: "sandbox" })),
 *   宿主把沙盒注册表 / 最近 merge 结论 / 配置投影进该命名空间;本 UI 只读展示。
 * - 写(操作下发):优先尝试专用 RPC 域 sandbox.<op>(POST /api/sandbox.<op>),
 *   未就绪时退回 settings 命令意图字段 command(宿主 onChange 消费执行后清空)。
 *   信封形态见下方 invokeHost 注释;两处均在「待集成阶段收敛」范围内。
 */
window.__ModuleLoader__.load({
  id: "dsh-sandbox",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // 沙盒名规则:字母/数字开头,允许 . _ -,不超过 64 字符(与目录名兼容)。
    const SANDBOX_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    // 端口允许范围(1024-65535;本体 3080 / 固定副本 3181 永不占用,端口池默认 3182 起)。
    const PORT_MIN = 1024;
    const PORT_MAX = 65535;
    // 客户端硬编码的默认值(镜像 CONTRACT.md §3 常量;客户端 bundle 纯度门禁禁止跨插件导入,
    // 故在此本地固化,宿主 settings 命名空间里的配置可覆盖)。
    const DEFAULT_PORT_START = 3182;
    const DEFAULT_AGE_HOURS = 48;
    const MS_PER_HOUR = 3600 * 1000;

    // 命令序号(每次下发自增,供宿主按序/去重;客户端为单用户串行点击)。
    let commandSeq = 0;

    function isValidSandboxName(name) {
      return SANDBOX_NAME_PATTERN.test(name) && !/[. ]$/.test(name);
    }

    function positiveNum(value, fallback) {
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    }

    /** 沙盒年龄基准:优先最近运行时间,回退创建时间;返回 epoch ms 或 null。 */
    function stampOf(record) {
      const stamp = record?.lastRunAt ?? record?.createdAt;
      if (typeof stamp === "number" && Number.isFinite(stamp)) return stamp;
      if (typeof stamp === "string") {
        const t = new Date(stamp).getTime();
        return Number.isFinite(t) ? t : null;
      }
      return null;
    }

    function ageMsOf(record) {
      const t = stampOf(record);
      return t == null ? null : Math.max(0, Date.now() - t);
    }

    /** 是否超过 ageHours 小时未运行(48h 超龄标记)。 */
    function isOverAge(record, ageHours) {
      const ms = ageMsOf(record);
      return ms != null && ms > ageHours * MS_PER_HOUR;
    }

    /** 人类可读年龄(秒/分钟/小时/天)。 */
    function formatAge(record) {
      const ms = ageMsOf(record);
      if (ms == null) return "—";
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + " 秒";
      const min = Math.floor(sec / 60);
      if (min < 60) return min + " 分钟";
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + " 小时";
      return Math.floor(hr / 24) + " 天";
    }

    function portText(record) {
      return record?.port ? "端口 " + record.port : "端口 未分配";
    }

    // ── 视觉语言(全部走 DSW token,与设置页其它区段一致)────────────────────
    const style = {
      wrap: { padding: "4px 2px 8px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 760 },
      badge: { fontSize: 11, fontWeight: 500, lineHeight: "17px", borderRadius: 999, padding: "0 10px", whiteSpace: "nowrap" },
      badgeOn: { background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)" },
      badgeOff: { background: "transparent", color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l2)" },
      badgeWarn: { background: "transparent", color: "var(--dsw-alias-state-warn-label, #d98629)", border: "1px solid var(--dsw-alias-border-l2)" },
      badgeRun: { background: "var(--dsw-alias-state-success-tertiary, #e6faed)", color: "var(--dsw-alias-state-success-primary, #22c55e)" },
      badgeDanger: { background: "transparent", color: "var(--dsw-alias-state-error-primary, #ef4444)", border: "1px solid var(--dsw-alias-border-l2)" },
      badgePass: { background: "var(--dsw-alias-state-success-tertiary, #e6faed)", color: "var(--dsw-alias-state-success-primary, #22c55e)" },
      badgeFail: { background: "transparent", color: "var(--dsw-alias-state-error-primary, #ef4444)", border: "1px solid var(--dsw-alias-border-l2)" },
      warnBanner: { margin: 0, border: "1px solid var(--dsw-alias-state-warn-tertiary, #fef5e7)", background: "var(--dsw-alias-state-warn-tertiary, #fef5e7)", borderRadius: 10, padding: "8px 12px", fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-state-warn-label, #d98629)" },
      group: { display: "flex", flexDirection: "column", gap: 12 },
      groupHead: { display: "flex", alignItems: "center", gap: 8, minHeight: 24 },
      groupTitle: { margin: 0, fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      fieldLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
      helpIcon: { width: 15, height: 15, fontSize: 10, lineHeight: 1, fontWeight: 500, borderRadius: "50%", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-tertiary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "help", fontFamily: "inherit", background: "transparent" },
      tooltip: { position: "absolute", display: "block", top: "calc(100% + 6px)", left: "0", width: "300px", maxWidth: "300px", boxSizing: "border-box", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l2)", boxShadow: "var(--dsw-shadow-lv2)", borderRadius: 10, padding: "9px 12px", fontSize: 12, lineHeight: 1.7, color: "var(--dsw-alias-label-secondary)", zIndex: 999, pointerEvents: "none", textAlign: "left", whiteSpace: "normal" },
      row: { display: "flex", gap: 8, alignItems: "center" },
      input: { flex: 1, height: 34, boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "0 12px", fontSize: 13, lineHeight: 1.5, fontFamily: "inherit" },
      inputWide: { width: "100%", height: 34, boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "0 12px", fontSize: 13, lineHeight: 1.5, fontFamily: "inherit" },
      btn: { height: 32, boxSizing: "border-box", borderRadius: 8, padding: "0 14px", fontSize: 13, fontWeight: 500, fontFamily: "inherit", cursor: "pointer", border: "1px solid transparent", background: "var(--dsw-alias-button-contrast-fill, #43454a)", color: "var(--dsw-alias-label-primary-inverted, #f9fafb)" },
      btnGhost: { height: 28, boxSizing: "border-box", borderRadius: 8, padding: "0 11px", fontSize: 12, fontWeight: 500, fontFamily: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-primary)" },
      btnDanger: { height: 28, boxSizing: "border-box", borderRadius: 8, padding: "0 11px", fontSize: 12, fontWeight: 500, fontFamily: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-state-error-primary, #ef4444)" },
      msg: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" },
      err: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-state-error-primary, #ef4444)" },
      subtle: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)" },
      divider: { border: "none", borderTop: "1px solid var(--dsw-alias-border-l2)", margin: 0 },
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 },
      cardHead: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
      cardName: { margin: 0, fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" },
      cmd: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 6, padding: "1px 7px", whiteSpace: "nowrap" },
      cardDesc: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      cardActions: { display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" },
      form: { display: "flex", flexDirection: "column", gap: 8 },
      empty: { border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: 12, padding: "14px", margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)", textAlign: "center" },
    };

    // ── 悬浮提示(? 图标)───────────────────────────────────────────────────
    function HelpTip(props) {
      const [open, setOpen] = react.useState(false);
      return react_jsx_runtime.jsxs("span", {
        style: { position: "relative", display: "inline-flex" },
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        children: [
          react_jsx_runtime.jsx("span", { style: style.helpIcon, children: "?" }),
          open ? react_jsx_runtime.jsx("span", { style: style.tooltip, children: props.text }) : null,
        ],
      });
    }

    const SANDBOX_LIST_HELP = "沙盒是完全隔离的 DSH 测试实例(独立进程 + 独立 home + 独立端口),内部任何崩溃/死循环/误操作都不会影响本体 3080。每张卡片显示状态、最近一次健康/QA/合回报告(通过·失败 + 摘录)、端口与年龄;可在此启动、停止、健康检查或销毁。超过 48 小时未运行的沙盒会被标记,可一键清理。";
    const CREATE_HELP = "新建沙盒会从本体程序目录复制一份(默认裁剪:排除 Launcher.exe / WebView2 / backups / .npm-cache 与运行态文件),创建全新独立 home 并自动分配端口(默认从 3182 起,本体 3080 与固定副本 3181 永不占用)。「完整复制」会复制全部文件(占用更多磁盘)。创建是重活,在宿主侧异步执行。";
    const PRUNE_HELP = "清理「孤儿沙盒」:进程已死且超龄(默认 48 小时未运行)的沙盒目录会被删除以回收磁盘。默认仅标记,由你确认后执行;超龄阈值与保留策略可在宿主设置中调整。";
    const MERGE_HELP = "合回门禁是机器强制的:目标白名单 + 语法校验(node --check)+ bundle 校验 + 备份先行 + 回滚清单,任何一步失败即拒绝并自动恢复。这里显示最近一次 sandbox_merge 的结论。";

    // 状态徽标映射(运行中·已停止·已销毁·创建中)。
    const STATUS_META = {
      creating: { label: "创建中", badge: style.badgeWarn },
      running: { label: "运行中", badge: style.badgeRun },
      stopped: { label: "已停止", badge: style.badgeOff },
      destroyed: { label: "已销毁", badge: style.badgeDanger },
    };

    // 操作命令 → 宿主工具名 / UI 文案(与 CONTRACT §5 工具签名对齐)。
    const OP_LABEL = { create: "新建沙盒", run: "启动", stop: "停止", health: "健康检查", destroy: "销毁", prune: "清理孤儿沙盒" };

    function kindLabel(kind) {
      if (kind === "health") return "健康";
      if (kind === "qa") return "QA";
      if (kind === "merge") return "合回";
      return kind || "报告";
    }

    /** 最近一次报告摘要徽标(通过/失败 + 失败摘录,title 悬浮展示摘录)。 */
    function reportBadge(report) {
      if (!report || typeof report !== "object") {
        return react_jsx_runtime.jsx("span", { style: { ...style.badge, ...style.badgeOff }, children: "无报告" });
      }
      const pass = report.conclusion === "pass";
      const label = (pass ? "通过" : "失败") + " · " + kindLabel(report.kind);
      const excerpt = !pass && report.excerpt ? report.excerpt : (report.at ? "at " + report.at : "");
      return react_jsx_runtime.jsx("span", {
        title: excerpt,
        style: pass ? { ...style.badge, ...style.badgePass } : { ...style.badge, ...style.badgeFail },
        children: label,
      });
    }

    // ── 沙盒卡片 ─────────────────────────────────────────────────────────
    function SandboxCard(props) {
      const { record, ageHours, busy, onStart, onStop, onHealth, onDestroy } = props;
      const status = record?.status ?? "stopped";
      const meta = STATUS_META[status] ?? STATUS_META.stopped;
      const overAge = isOverAge(record, ageHours);
      const opBusy = busy?.op;
      const locked = Boolean(busy);

      return react_jsx_runtime.jsxs("div", { style: style.card, children: [
        react_jsx_runtime.jsxs("div", { style: style.cardHead, children: [
          react_jsx_runtime.jsx("h4", { style: style.cardName, children: record?.name ?? "?" }),
          react_jsx_runtime.jsx("span", { style: { ...style.badge, ...meta.badge }, children: meta.label }),
          overAge
            ? react_jsx_runtime.jsx("span", { style: { ...style.badge, ...style.badgeWarn }, children: "超龄 " + ageHours + "h" })
            : null,
          reportBadge(record?.lastReport),
          react_jsx_runtime.jsx("span", { style: { ...style.cmd, marginLeft: "auto" }, children: portText(record) }),
        ] }),
        react_jsx_runtime.jsxs("p", { style: style.cardDesc, children: [
          "年龄 " + formatAge(record),
          record?.home ? " · home " + record.home : "",
          record?.pid ? " · pid " + record.pid : "",
        ] }),
        react_jsx_runtime.jsxs("div", { style: style.cardActions, children: [
          status === "running"
            ? react_jsx_runtime.jsx("button", { type: "button", style: style.btnGhost, disabled: locked, onClick: onStop, children: opBusy === "stop" ? "停止中…" : "停止" })
            : react_jsx_runtime.jsx("button", { type: "button", style: style.btn, disabled: locked || status === "destroyed" || status === "creating", onClick: onStart, children: opBusy === "run" ? "启动中…" : "启动" }),
          status === "running"
            ? react_jsx_runtime.jsx("button", { type: "button", style: style.btnGhost, disabled: locked, onClick: onHealth, children: opBusy === "health" ? "检查中…" : "健康检查" })
            : null,
          status !== "destroyed"
            ? react_jsx_runtime.jsx("button", { type: "button", style: style.btnDanger, disabled: locked || status === "creating", onClick: onDestroy, children: opBusy === "destroy" ? "销毁中…" : "销毁" })
            : null,
        ] }),
      ] });
    }

    // ── 新建沙盒表单 ─────────────────────────────────────────────────────
    function CreateSandboxForm(props) {
      const { onSubmit, onCancel, busy, defaultPortStart } = props;
      const [name, setName] = react.useState("");
      const [port, setPort] = react.useState("");
      const [fullCopy, setFullCopy] = react.useState(false);

      const trimmedName = name.trim();
      const nameValid = isValidSandboxName(trimmedName);
      const portValid = port.trim() === "" || (Number.isInteger(Number(port.trim())) && Number(port.trim()) >= PORT_MIN && Number(port.trim()) <= PORT_MAX);
      const valid = nameValid && portValid;

      const submit = () => {
        if (!valid || busy) return;
        onSubmit({
          name: trimmedName,
          ...(port.trim() ? { basePort: Number(port.trim()) } : {}),
          fullCopy,
        });
      };
      const onKeyDown = (e) => { if (e.key === "Enter") submit(); };

      return react_jsx_runtime.jsxs("div", { style: style.card, children: [
        react_jsx_runtime.jsxs("div", { style: style.form, children: [
          react_jsx_runtime.jsx("span", { style: style.fieldLabel, children: "名称(字母/数字开头,可用 . _ -,最长 64 字符)" }),
          react_jsx_runtime.jsx("input", {
            type: "text", style: style.inputWide, placeholder: "my-sandbox",
            value: name, autoFocus: true, onChange: (e) => setName(e.target.value), onKeyDown,
          }),
          react_jsx_runtime.jsx("span", { style: style.fieldLabel, children: "端口(可选,留空自动分配,默认从 " + defaultPortStart + " 起)" }),
          react_jsx_runtime.jsx("input", {
            type: "text", style: style.inputWide, placeholder: String(defaultPortStart),
            value: port, onChange: (e) => setPort(e.target.value), onKeyDown,
          }),
          react_jsx_runtime.jsxs("label", { style: { ...style.fieldLabel, cursor: "pointer", userSelect: "none" }, children: [
            react_jsx_runtime.jsx("input", { type: "checkbox", checked: fullCopy, onChange: (e) => setFullCopy(e.target.checked) }),
            "完整复制(默认裁剪:排除 Launcher.exe / WebView2 / backups / .npm-cache / 运行态文件)",
          ] }),
        ] }),
        react_jsx_runtime.jsxs("div", { style: style.cardActions, children: [
          react_jsx_runtime.jsx("button", { type: "button", style: style.btnGhost, onClick: onCancel, children: "取消" }),
          react_jsx_runtime.jsx("button", { type: "button", style: style.btn, disabled: busy || !valid, onClick: submit, children: busy ? "创建中…" : "创建" }),
        ] }),
      ] });
    }

    // ── 合回门禁摘要卡 ───────────────────────────────────────────────────
    function MergeGateCard(props) {
      const gate = props.gate;
      if (!gate || typeof gate !== "object") {
        return react_jsx_runtime.jsxs("div", { style: style.card, children: [
          react_jsx_runtime.jsxs("div", { style: style.cardHead, children: [
            react_jsx_runtime.jsx("h4", { style: style.cardName, children: "合回门禁" }),
            react_jsx_runtime.jsx("span", { style: { ...style.badge, ...style.badgeOff }, children: "暂无记录" }),
          ] }),
          react_jsx_runtime.jsx("p", { style: style.cardDesc, children: "尚无合回记录。沙盒验证通过后,经 sandbox_merge 门禁合回本体会在这里留下最近一次结论。" }),
        ] });
      }
      const pass = gate.conclusion === "pass";
      const checks = Array.isArray(gate.checks) ? gate.checks : [];
      return react_jsx_runtime.jsxs("div", { style: style.card, children: [
        react_jsx_runtime.jsxs("div", { style: style.cardHead, children: [
          react_jsx_runtime.jsx("h4", { style: style.cardName, children: "合回门禁" }),
          react_jsx_runtime.jsx("span", {
            style: pass ? { ...style.badge, ...style.badgePass } : { ...style.badge, ...style.badgeFail },
            children: pass ? "通过" : "拒绝",
          }),
        ] }),
        react_jsx_runtime.jsx("p", { style: style.cardDesc, children: "最近一次:" + (gate.sandbox || "—") + " · " + (gate.at || "—") }),
        checks.length > 0
          ? react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: checks.map((check, i) => {
              const ok = check && check.ok === true;
              return react_jsx_runtime.jsxs("p", { key: i, style: ok ? style.subtle : style.err, children: [
                ok ? "✓ " : "✗ ",
                (check && check.name) || ("检查 " + (i + 1)),
                check && check.detail ? " — " + check.detail : "",
              ] });
            }) })
          : null,
        (!pass && gate.excerpt) ? react_jsx_runtime.jsx("p", { style: style.err, children: gate.excerpt }) : null,
      ] });
    }

    // ── 宿主调用信封 ─────────────────────────────────────────────────────
    /**
     * 向宿主下发一个沙盒操作(create / run / stop / health / destroy / prune)。
     *
     * 【待集成阶段收敛】客户端无法直接调用原生工具(sandbox_*),标准 RPC 映射
     * (dsh-host-apiproxy 的 fetch/handler.js method map)里没有 tool-call 通道,
     * connection.api 也只暴露固定域(sessions/settings/credentials/…)。
     *
     * 因此这里做双通道,集成阶段二选一或择优:
     *  1) 专用 RPC 域(首选,若集成提供):POST /api/sandbox.<op>,body 信封:
     *     { type: "client-request", rpcId, method: "sandbox.<op>", payload: args }
     *     由宿主新增一个 client-request 域(sandbox 域:list/create/run/stop/health/destroy/prune/merge),
     *     直接桥接到对应原生工具。
     *  2) settings 命令意图(退回,当前默认):POST /api/settings.mutate,body 信封:
     *     { type: "client-request", rpcId, method: "settings.mutate",
     *       payload: { ns: "sandbox", ops: [{ op: "set", path: ["command"], value: { op, args, seq } }] } }
     *     宿主 M0 侧 installSettingsSection 的 onChange 观察 command 字段 → 执行对应工具 →
     *     写回 sandboxes / mergeGate 投影并清空 command。
     *     需宿主 settings 命名空间 "sandbox" 的 schema 包含 command / sandboxes / mergeGate 字段。
     */
    async function invokeHost(api, scope, op, args) {
      const domain = api && api.sandbox;
      if (domain && typeof domain[op] === "function") {
        const res = await domain[op](args ?? {});
        if (!res || !res.result || !res.result.ok) {
          throw new Error(res?.result?.error?.message ?? "RPC 调用失败");
        }
        return res.result.value;
      }
      await scope.set("command", { op, args: args ?? {}, seq: ++commandSeq });
      return null;
    }

    // ── 区段主体 ─────────────────────────────────────────────────────────
    function SandboxSection({ injected }) {
      const api = injected.api;      // connection.api(API 信封宿主,见 invokeHost 注释)
      const scope = injected.scope;  // settingsScope,namespace "sandbox"

      const snapshot = react.useSyncExternalStore(
        (cb) => scope.subscribe(cb),
        () => scope.getSnapshot(),
      );

      // 宿主命名空间投影(见文件头「数据通道」注释;字段缺失时安全兜底)。
      const value = snapshot?.value ?? {};
      const ageHours = positiveNum(value.ageHours, DEFAULT_AGE_HOURS);
      const portStart = positiveNum(value.portStart, DEFAULT_PORT_START);
      const sandboxes = (value.sandboxes && typeof value.sandboxes === "object") ? value.sandboxes : {};
      const mergeGate = (value.mergeGate && typeof value.mergeGate === "object") ? value.mergeGate : null;

      const [adding, setAdding] = react.useState(false);
      const [busy, setBusy] = react.useState(null); // { op, name }
      const [error, setError] = react.useState("");
      const [notice, setNotice] = react.useState("");

      const dispatch = react.useCallback(async (op, args, name) => {
        setBusy({ op, name: name ?? args?.name ?? null });
        setError("");
        setNotice("");
        try {
          await invokeHost(api, scope, op, args ?? {});
          await scope.load();
          setNotice("已下发「" + (OP_LABEL[op] ?? op) + "」,宿主正在执行…");
          return true;
        } catch (e) {
          setError("操作失败:" + (e?.message ?? String(e)));
          return false;
        } finally {
          setBusy(null);
        }
      }, [api, scope]);

      const names = Object.keys(sandboxes).sort();
      const overAgeCount = names.filter((n) => isOverAge(sandboxes[n], ageHours)).length;

      return react_jsx_runtime.jsxs("div", { style: style.wrap, children: [
        // ── 合回门禁摘要卡 ──
        react_jsx_runtime.jsxs("div", { style: style.group, children: [
          react_jsx_runtime.jsxs("div", { style: style.groupHead, children: [
            react_jsx_runtime.jsx("h3", { style: style.groupTitle, children: "合回门禁" }),
            react_jsx_runtime.jsx(HelpTip, { text: MERGE_HELP }),
          ] }),
          react_jsx_runtime.jsx(MergeGateCard, { gate: mergeGate }),
        ] }),

        react_jsx_runtime.jsx("hr", { style: style.divider }),

        // ── 沙盒列表组 ──
        react_jsx_runtime.jsxs("div", { style: style.group, children: [
          react_jsx_runtime.jsxs("div", { style: style.groupHead, children: [
            react_jsx_runtime.jsx("h3", { style: style.groupTitle, children: "沙盒" }),
            react_jsx_runtime.jsx(HelpTip, { text: SANDBOX_LIST_HELP }),
            react_jsx_runtime.jsx("button", { type: "button", style: { ...style.btn, marginLeft: "auto" }, disabled: adding || Boolean(busy), onClick: () => setAdding(true), children: "新建沙盒" }),
          ] }),
          adding
            ? react_jsx_runtime.jsx(CreateSandboxForm, {
                busy: busy?.op === "create",
                defaultPortStart: portStart,
                onCancel: () => setAdding(false),
                onSubmit: async (args) => { const ok = await dispatch("create", args, args.name); if (ok) setAdding(false); },
              })
            : null,
          snapshot?.status === "unavailable"
            ? react_jsx_runtime.jsx("p", { style: style.empty, children: "沙盒数据不可用——宿主插件未加载沙盒支持,请重启 DSH 后查看。" })
            : null,
          snapshot?.status === "loading" && names.length === 0
            ? react_jsx_runtime.jsx("p", { style: style.empty, children: "沙盒加载中…" })
            : null,
          snapshot?.status === "ready" && names.length === 0 && !adding
            ? react_jsx_runtime.jsx("p", { style: style.empty, children: "还没有沙盒,点击「新建沙盒」创建一个隔离测试实例。" })
            : null,
          names.map((name) => react_jsx_runtime.jsx(SandboxCard, {
            key: name,
            record: sandboxes[name],
            ageHours,
            busy: busy && busy.name === name ? busy : null,
            onStart: () => dispatch("run", { name }, name),
            onStop: () => dispatch("stop", { name }, name),
            onHealth: () => dispatch("health", { name }, name),
            onDestroy: () => {
              // 销毁需用户二次确认(等价于 sandbox_destroy 的 confirm 参数,防误删)。
              if (!window.confirm("确定销毁沙盒「" + name + "」?将停止进程并删除其目录与 home,不可恢复。")) return;
              dispatch("destroy", { name, confirm: true }, name);
            },
          })),
        ] }),

        react_jsx_runtime.jsx("hr", { style: style.divider }),

        // ── 清理组 ──
        react_jsx_runtime.jsxs("div", { style: style.group, children: [
          react_jsx_runtime.jsxs("div", { style: style.groupHead, children: [
            react_jsx_runtime.jsx("h3", { style: style.groupTitle, children: "清理" }),
            react_jsx_runtime.jsx(HelpTip, { text: PRUNE_HELP }),
          ] }),
          overAgeCount > 0
            ? react_jsx_runtime.jsx("p", { style: style.warnBanner, children: "有 " + overAgeCount + " 个沙盒超过 " + ageHours + " 小时未运行,建议清理以回收磁盘。" })
            : null,
          react_jsx_runtime.jsx("div", { style: style.row, children: [
            react_jsx_runtime.jsx("button", {
              type: "button", style: style.btnGhost, disabled: Boolean(busy),
              onClick: () => dispatch("prune", {}, null),
              children: busy?.op === "prune" ? "清理中…" : "一键清理孤儿沙盒",
            }),
          ] }),
        ] }),

        notice ? react_jsx_runtime.jsx("p", { style: style.msg, children: notice }) : null,
        error ? react_jsx_runtime.jsx("p", { style: style.err, children: error }) : null,
      ] });
    }

    const inject = ["slots", "connection", "settingsScope"];

    function apply(ctx) {
      const connection = ctx.get("connection");
      const scope = ctx.settingsScope.bind({ namespace: "sandbox" });
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "sandbox",
        order: 80,
        label: "测试沙盒",
        inject: () => ({ injected: { api: connection.api, scope } }),
      }, SandboxSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
