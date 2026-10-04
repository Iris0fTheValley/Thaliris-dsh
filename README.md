# Thaliris for DeepSeek Harness

语言：简体中文 | [English](README.en.md)

@thaliris/dsh-plugin 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)加入 Thaliris task records 和显式 Controller 工具。它使用 DSH 原生 Workspace、持久 Session、Agent、subagent、Settings、model catalog、Plugin Manager 和 lifecycle。Python Core 是单独的 [Thaliris distribution](https://github.com/Iris0fTheValley/Thaliris)；本仓库不包含 Core 或 Codex adapter 代码副本。

Runtime package 提供可选的 Remote API 和共享 Web/Desktop client。策略页编辑原生 role、model、workspace 和 memory 设置。Memory capability 与默认本地 provider 是独立可选 package；没有它们或 client UI 时，task routing 和 close 仍可用。契约与验证边界见 [CLIENT-CONTRACT.md](CLIENT-CONTRACT.md)、[CAPABILITIES.md](CAPABILITIES.md) 和 [CORE-BASELINE.md](CORE-BASELINE.md)。

## 安装与配置

需要 Node.js 22.x 的 22.19 或更高版本，或 Node.js 24+，以及 Python 3.11+。该适配器对应 DSH source revision 639ed015397290b3745d163aafe02ffee4aa3f84，并使用 Thaliris Core 0.4.2，对应 Core source revision 751ccea498ad89c6c77c622fb4efaee9be469326。Core 为插件配置的 Python 环境提供 thaliris.core 和 thaliris.authority。包来源与提取仓库集成检查见 [CORE-BASELINE.md](CORE-BASELINE.md)。

Runtime、Remote API 和可选 memory entries 默认禁用。通过原生 Plugin Manager 将本地 archives 安装到指定 profile：

    dsh plugin --profile <profile> add <artifact-dir>/thaliris-dsh-plugin-0.2.0.tgz <artifact-dir>/thaliris-dsh-memory-0.1.0.tgz <artifact-dir>/thaliris-dsh-memory-local-0.1.0.tgz

启用 runtime 前，配置 pythonExecutable、corePath 和 authorityDirectory 的绝对路径。corePath 指向该 Python 环境所用的 Core 安装。将外部 authority directory 放在受治理 Workspace 之外，也不要把凭据放入插件配置。把规范 Git root 注册为原生 DSH Workspace，创建或恢复持久 root Session，再在 policy.workspaces 下绑定该 Workspace ID 和精确 root。

在 pinned DSH checkout 上运行 npm run build:bundle，并设置 DSH_SOURCE=<checkout> 后运行 npm run build:client，以构建 profile patch 和 client bundle。client build 使用 DSH Web client preset，Desktop 共用该 bundle。之后在本仓库和两个可选组件目录分别运行 npm pack，生成三个本地 archives。patch 从可见 role templates 生成，且 runtime/API 默认禁用。捆绑的 Zod 许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

Role records、prompt、tool allowlist、model route、memory grant 和 context permission 可在原生策略表单中编辑。路由使用 DSH model catalog：inherit 采用原生 parent 配置；fixed 选择一个已配置 route；allowed 允许 Controller 在用户配置的 route 集合中为一个 slice 选择。Thaliris 不会对模型排序或改写这些设置。

## 行为与边界

原生 root Agent、持久 Session ancestry 和配置的 native Workspace 必须与 Core authority anchor 相符。同路径但无关的 Session 不能接续任务。委派会启动新的原生 child，只传递选定的有界 handoff、完整 role prompt 和明确选择的 memory context。Controller 显式判断是否接受；child 返回结果后，task 仍保持 active，直至 Controller close。

恢复依赖精确的原生 child correlation 和持久 terminal Session evidence。仅在 catalog 中可见或暂时不活跃不能证明 child 已结束。若身份、持久记录或 terminal reason 缺失，结果保持 UNKNOWN，reservation 继续保留。尚未实现范围更广的 UNKNOWN abandonment 路径。共享 OS 访问与 writer lease 是治理事实，不构成普遍的 actor 身份认证。

Memory 默认禁用。可选 capability 接收可替换的异步 provider；@thaliris/dsh-memory-local 在 native storage 上提供有界文本 provider。系统没有 embeddings、vector/RAG、凭据管理或自动检索。manual 和 review 写入会创建 Core proposal；auto 写入需要独立持久记录的 autoAuthorized: true 明确 opt-in。移除任一可选 memory package 后，task routing 和 close 仍可用。

提取仓库的 bridge、native composition、packed package-install 和 client 检查使用 scripted LLM 及 pinned DSH source，不使用在线模型或当前安装 profile。原始 source repository 另行针对 Core source revision 256f760 验证了 live Web integration：真实 task 执行到第五个 child，拒绝该 child 调用 native root tools，并显式 close 为 DONE。这不表示提取仓库的 package smoke 启动过 browser。Desktop 共用 Web client bundle，但没有启动 Desktop binary。

## 开发与验证

检出 pinned DSH source 与 Core source，或安装匹配版本的 Core distribution。将 DSH_SOURCE 设为 DSH checkout，将 THALIRIS_CORE_PATH 设为包含 thaliris 源码包的目录，并将 THALIRIS_TEST_PYTHON 设为隔离的 Python 3.11+ 环境。Bridge 与 native source-composition 检查使用该源码路径。Packed activation smoke 需要从 pinned upstream source 构建新的 Core wheel 并安装到隔离 Python 环境；将 THALIRIS_TEST_CORE_PATH 设为已安装 package 的目录，使 smoke 检查该 wheel。然后运行：

    npm run build:bundle
    npm run build:client
    npm run test:native
    npm run test:client
    python -m pytest tests/test_bridge.py -q

Client build 和 client test runner 会在 DSH checkout 内创建临时 package workspace，并在结束时清理。Native tests 使用临时 fixture repositories。Packed activation smoke 还需要 THALIRIS_PACK_DIR（包含三个本地 archives）、THALIRIS_TEST_CORE_PATH（测试环境内已安装的 Core package）和 THALIRIS_TEST_TMP_ROOT（任务专属临时目录），然后运行 npm run test:install。该 smoke 验证 packed runtime 导入已安装 Core，通过 DSH 启动、检查并关闭 task；移除可选 memory bundles 后，这些工具仍可用。

Core 仓库包含 [ABCD 基准协议](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-benchmark-protocol.md)和规范结果。兄弟仓库 [Thaliris Codex adapter](https://github.com/Iris0fTheValley/Thaliris-codex) 使用同一个 Core。


## Shared Thaliris Core

Thaliris 是一个 Git-native 的机械上下文与生命周期层。它不运行 Agent，
也不替模型判断什么重要、正确或足以完成任务。

> 模型负责语义。机械层负责执行。

0.4.2 runtime drift, current Host identity limits, and offline recovery:
[Runtime drift and recovery](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-runtime-recovery.md).

Persistent human task intent, reconnect recovery, explicit Controller-direct
and single-agent modes: [Task authority](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-task-authority.md).

## 生产信息流

```text
Controller
    │ explicit task + selected information
    ▼
selected role session
    ├── private working set
    ├── optional detailed Artifact
    └── distilled result
            │
            ▼
        Controller
            └── decides next handoff
```

授权父级的原生 spawn message 是各角色唯一的 task-specific 语义输入。
`SubagentStart` 只验证授权、身份、角色与 session，绑定 lifecycle 和 handoff
metadata；它不构建 task-specific `additionalContext`。

不存在以下生产路径：

```text
task state -> role projection -> automatic native Codex child injection
hidden model auditor -> Controller correction/block
```

## 职责

Controller 负责路由、上下文选择、解释、接受与完成判断。无论 ACTIVE 还是 degraded，
Controller 都只选择完成任务所需的最少 fresh roles；role 是认知分工，不是必经的
workflow stage。当前设计把主要认知负载分开：Controller 维持目标并选择上下文；
Investigator 承担大 working set、仓库扫描和事实压缩；Implementer 承担实现；
Reviewer 独立挑战结果。复杂实现可以使用更聚焦、更高能力的执行绑定，但实现决策仍由
执行角色负责。Reasoning Specialist 只在问题定义、抽象或前提本身不清楚时用于元认知
重构；Curator 用于把已选择材料压缩成可复用知识。兼容或专用 profile 可以存在，但
不构成 mandatory workflow。

Implementer 与 Focused Implementer 都负责实现，保持聚焦的 working set；
Investigator 可以拥有较大的私有 working set，将广泛扫描、调用点和残留引用
压缩成事实、位置、证据和未知项。执行角色利用这些证据，并保留实现决策权。
Reasoning Specialist 用于重构不明确的问题。Verifier 仅保留只读兼容，
不推荐作为流程阶段。Focused Implementer 负责语义收敛；当核心实现和不变量已落实、
会改变方向的未知已解决、证据能说明核心语义，而且剩余工作不太可能改变已定架构、因果模型、安全边界、
范围或验收时，可以带上候选状态、证据限制和剩余任务返回 FINAL。测试通过本身不会切换角色。
安装或 smoke 检查若仍用于证明核心语义，仍属于 Focused Implementer 的收敛工作。
Root 决定后续是否仍需 Focused reasoning，或可将独立且确定的收尾交给普通 Implementer。
小型直接常规操作无需仅为流程而建立子角色；这仍受既有执行模式约束。

Controller 的 model、effort、native profile 均无固定值，由 Host/用户选择。
Investigator、Curator 和标准 Implementer 默认 `gpt-6-luna/xhigh`；Focused
Implementer、Reasoning Specialist 和 Reviewer 默认 `gpt-6.1-sol/high`；兼容 Verifier
为 `gpt-6-luna/xhigh`。只有 Controller 可以在 spawn 前为特殊推理明确选择固定的
Astra medium 或 xhigh profile，但必须获得当前任务的用户授权；自动路由止于 Sol，
跨领域不确定性也不会自动启用 Astra。子角色不能自行选择 model/effort。
这些 profile 仍映射至相同 role ID；不允许
通过每次 spawn 的 model/effort 参数覆盖 profile。

所有 role session 保留私有中间工作，默认只返回精炼结论、关键发现、会改变
决策的未知、矛盾、验证与 Artifact pointer。

Core 只提供：

- task / native Codex child / handoff / artifact identity
- revision 与 compare-and-swap
- lock、atomic write、backup 与 rollback
- hash、provenance、supersedes/history
- 文件的 `FRESH` / `PARTIAL` / `RECORDED` / `CHANGED` / `MISSING` / `UNKNOWN` 客观事实
- verification 与 task surface 的机械 observation
- 显式 store / catalog / exact-path get

Core 不判断 relevance、importance、correctness、role applicability、task
completion，也不根据 stale evidence 自动改写 decision、constraint 或 workflow。

Codex adapter 只负责 fresh spawn、`fork_turns="none"`、授权的有限二层 native Codex child lifecycle、
handoff hash、SubagentStart/Stop identity、missing-stop reconciliation 和 native
wait。Controller 本身由 Host/user 当前选择的根 session 承载；child profile 的模型与
reasoning effort 由 adapter 的 role binding 管理。短 wait 只有在确实存在 pending
reservation 或 managed native Codex child，且当前 session effective maximum 已被机械验证时，
才会被规范化为长 blocking wait。当前 Host hook 尚未暴露该 maximum，因此会保留请求的
timeout，不会自动扩展。`SubagentStop` 本身不是成功；
只有明确观测到 native `Completed` 才满足 lifecycle completion。

Controller 可以选择注册角色；仅 Implementer、Focused Implementer 和 Reviewer
可以再委派一个 fresh Investigator/Scanner。最多一个顶层子角色与一个 Scanner
同时活动，Scanner 结果归请求它的父级。嵌套授权要求父级精确的 agent、role、
session、turn 身份，缺失或冲突即拒绝。一个 live managed Codex CLI
`0.155.0-alpha.9.2` probe 已验证二层 Scanner 的精确 reservation、Start 和绑定的
PreToolUse 接受，Scanner 结果已返回且 Focused parent 继续执行；详见
[durable probe evidence](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/codex-nested-scanner-live-20260925.md)。该证据只覆盖这一个
CLI 构建与 probe；raw Host wire-byte equality、其他 Host 构建和其他 Desktop 场景仍为
UNKNOWN。另一次 2026-09-28 Codex Desktop probe 观察到 `list_agents` 返回精确 child name
和 native `completed` status；端到端 Desktop `task-close` 尚未观测。`task-close` 要求最后一个
Controller 直接 handoff 有匹配的 Start、Stop 和 native `Completed` observation，且没有
pending 或 active 后代。

## Task ledger

Task state 是一个带 revision 的机械账本。Controller 可以保存含 `id`、`kind`、
`text`、`producer`、`status`、`source_refs`、`supersedes` 的记录。`kind` 和
`status` 是模型写入的标签；Core 只验证 schema、identity 与引用完整性。

`task-close` 检查 task identity、revision、基本状态一致性，以及 adapter 的授权
lifecycle。它不判断测试是否充分，也不裁决任务语义上是否完成。

## Artifact、Memory 与 Milestone

Artifact 正文位于显式路径中；账本只保存 ID、producer、path、content hash、
created revision、source refs 与 optional supersedes。Artifact 不会被自动读取或
传播。Controller 显式取回正文，并自行选择是否交给后续被选中的 role session。

Memory 默认不注入。模型自行维护 `.agent-memory/INDEX.md` 和
`.milestones/INDEX.md` 里的薄语义导航地图，而不是单纯的文件清单。条目简要说明所链知识
涵盖什么、何时适合读取，以及在有帮助时说明当前或历史/已取代的适用范围；让当前相关知识
优先可见。Controller 读取描述后，选择要通过 `document-get` 明确恢复的文档。模型自行选择
目录、层级与措辞，不设固定格式或 taxonomy。Core 不解释、生成或重建 INDEX 内容，只做路径、
CAS、大小、链接与原子写入的机械检查。SessionStart 只提示两个 root INDEX 的路径，不注入
完整地图。开始 managed task 前，Controller 应显式读取 root navigation；若 INDEX 尚不存在，
先建立最小薄 INDEX 再开始 task。
任务进行中不会自动重复读取，除非地图已修改、信息不足、freshness 失效，或 resume/compact
需要恢复导航。
`document-get` 可一次读取最多 8 个由 Controller 明确给出的 path，并受总返回大小
限制；它不自动搜索、排序或补充文档。ACTIVE Controller 使用 bounded
`task-status` 和单对象 `task-get`；`init`、`uninstall`、`rollback`、再次
`task-start` 与完整 `task-show` 均不属于 ACTIVE allow-set。
`Status` 是有界的记录标签。旧文档中的其它 metadata 仍可读取，但只作为不透明兼容字段，
不是传播权限。

长期知识是否需要准入由 Controller 独自判断。正常任务进行中，Root 留意用户指令、自己的架构或治理
决策、Investigator 证据、Executor FINAL、Reviewer 发现和 Specialist 挑战中出现的可复用知识。这只是
Controller 当前工作上下文中的判断；不建立候选清单、持久准入状态、分数、计数器、阈值或额外检查点，
也不为记忆审查中断正在执行的 Workstream。Executor 返回正常结果、证据和会改变决策的信息，不追踪
记忆候选、不生成 Curator、不维护 durable INDEX 导航，也不在 FINAL 增加单独的长期治理内容。

接近任务自然结束时，Controller 在正常收尾中判断证据是否建立、修订、推翻或实质澄清了可复用的项目
知识，以及简明、有来源且容易检索的记忆条目是否能改善、约束或加快未来决策或恢复。这不限于未来
Agent 否则需要重新调查的知识。若选定的候选值得保留，Root 向新的 Curator 提供候选知识、事实与支撑
证据、精确相关的既有 memory 与 INDEX 导航，以及需要对照的规范来源和文档；没有候选或没有未来决策价值时则跳过。普通小任务可以完全
跳过 Curator；任务规模或架构工作本身不会触发必经阶段。

现有文档、源码、指令、测试、提交和 rollout 既不是自动排除理由，也不代表必须另建 memory；把它们当作
证据，并避免照抄规范文本。Memory 可以作为未来 Agent 的恢复入口，概述并链接容易找到的规范材料，或
压缩散落在代码、Host、历史和设计中的决策依据。Curator 应把选定候选与提供的资料对照；若既有知识
已经足够，应明确说明无需写入。添加、修订、合并、拆分、收窄、取代或删除选定 memory 时，Curator
也判断相关 INDEX 导航是否要更新，并在需要时更新。保留每条结论的来源和适用范围；新证据修订或取代旧结论时，在相关情况
下保留旧结论的历史适用性。任务时间线、实现日志、普通提交历史、临时测试输出或瞬时失败不应作为日志
保存；但如果它们能建立会改善、约束或加快未来决策或恢复的可复用知识，也不能自动排除。正式产品/协议
文档和 README 的行为同步由 Implementer 或 Focused Implementer 负责。详细原始证据保留在规范来源、
Artifact、Git 或 rollout 记录中；memory 只保留未来恢复所需的简明依据和引用。`CHANGED` 仅表示证据
变化；当依赖该证据的决策不再可靠时，Controller 可要求重新验证。Reviewer 被选用时检查文档与实现的
语义偏差。
`task-promote` 保存 Controller 明确选择的记录；Core 不裁决其 epistemic legitimacy。
当 Controller 通过 `task-promote` 写入会改变 durable navigation 的记录时，应在同一次
调用中提供 optional `index_update`。Curator 在单独整理 memory 时负责判断并维护相关导航。
Core 不生成 INDEX 内容，只机械验证路径、CAS、大小、链接并原子提交。
若 Codex 在 `SubagentStart` 前明确返回 native spawn failure，Controller 可针对
该 handoff 调用 `thaliris recover-pending-spawn HANDOFF_ID`；Core 不从缺失事件、超时或重试推测失败。

## Verification 与 task surface

Verification 记录 command/tool、outcome、candidate identity、observed files、
timestamp 与 result hash。Task surface 记录 start HEAD、dirty baseline、current
state 与 delta。两者都只提供事实，不成为 correctness、ownership 或 close gate。

## 持久任务授权

Controller 通过 task-start 明确选择实际的人类任务意图、工作边界、不变量、验收条件和执行模式（delegated、controller-direct 或 single-agent），并在项目仓库之外保存任务锚点。当前 Host actor 是否为 Controller 仍可能 UNKNOWN；提示词字段、session 相同、PID、环境或 SessionSource 都不证明人类身份。普通的换轮次、网络、Hook、session 或 daemon 中断后可继续同一任务，无需重复证明 Root 身份。human revocation、任务关闭、Controller abandonment 或 replacement 会结束这项授权。

task-recover-authority 只接受精确的外部 authority hash 与原因；它会归档冲突、恢复记录的字节并 fence 已知旧子角色。它不能把变化的安全配置当作新基线，也不会证明旧进程已终止。更改目标、范围、验收、执行模式、解除 fence 或建立新安全基线需要新的上级人类决定。子角色不能自行授权这些变化。

## 命令

READY 时先在独立步骤创建 UTF-8 JSON contract 文件，再在单独 task-start 调用中传入其绝对路径。

Git repository 中的 substantive work 应先运行已安装的
`thaliris-run.cmd --root <repo> codex-bootstrap`。若返回 READY，在同一 session
将返回的 bootstrap receipt 传给 `thaliris-run.cmd --root <repo> task-start "goal" --bootstrap-receipt <receipt> --authority-contract <absolute-path-to-contract.json>`。
DEFINITION_READY_ACTOR_UNKNOWN 也可用此显式 Controller 操作建立任务意图；
Host Root 身份仍 UNKNOWN。外部授权保存 human instruction、boundary、invariants、
acceptance、execution_mode，断线重连无需重复 Root 证明。

```text
thaliris init
thaliris-run.cmd --root <repo> task-start "goal" --bootstrap-receipt <receipt> --authority-contract <absolute-path-to-contract.json>
thaliris task-status
thaliris task-get OBJECT_ID
thaliris task-update --role controller --base-revision N --input update.json
thaliris task-artifact --base-revision N --id A-001 --path path/to/file.md --summary "..."
thaliris catalog
thaliris document-get .agent-memory/model-chosen/a.md .milestones/current/status.md
thaliris task-promote --role controller --base-revision N --input promotion.json
thaliris task-close --base-revision N
thaliris task-recover-authority --expected-authority-sha256 <hash> --reason "recover interrupted work"
thaliris recover-pending-spawn HANDOFF_ID
thaliris stale
thaliris rollback BACKUP_ID
thaliris doctor
```

`task-promote` 输入中的每条记录必须由 Controller 明确给出 `.agent-memory/**.md`
目标 path；Core 不按文档 metadata 自动分类。Controller 的 native handoff 是
被选中 role session 的唯一 task-specific 工作输入。

## ABCD 基准测试结果

我们运行了一项受控的单任务基准测试，以区分**模型能力**、**编排**和**异构智能分配**。A/B/C 使用相同任务、BASE 修订、Codex 版本、隔离的工作区/CODEX_HOME 和环境；D 是此前封存的生产架构运行，没有重新运行。

四个已完成的实验组检验两个主要假设：

**编排收益 — B → C：** 对 Luna-only 系统而言，角色拆分和隔离的多 Agent 执行是否比单个 Luna Agent 更好？

**智能分配收益 — C → D：** 已有编排后，在语义实现、评审和收尾环节有选择地使用更强模型，是否会实质改善结果？

### 结果

| 实验组 | 配置 | 覆盖度 | 正确性 | 兼容性 | 实现 | 验证 | 均值 | 完成情况 | 墙钟时间 | 成本代理值 |<br>
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|
| **A** | Sol medium，单 Agent | 6 | 4 | 6 | 6 | 7 | **5.8** | 部分 | **21m36s** | **$0.883** |
| **B** | Luna xhigh，单 Agent | 6 | 5 | 6 | 6 | 4 | **5.4** | 部分 | **54m09s** | **$0.232–0.235** |
| **C** | Thaliris，Luna-only | 4 | 6 | 7 | 6 | 4 | **5.4** | Managed DONE / 产品部分完成 | **41m11s** | **$0.272** |
| **D** | Thaliris，异构路由 | **9** | **8** | **8** | **8.5** | **8** | **8.3** | 基本完成；仍有一个 P2 | **64m47s** | **$2.475** |
| **E?** | D 拓扑，**全 Sol 工作节点** | **9?** | **8?** | **8?** | **8.5?** | **8?** | **8.3?** | 类似 D？ | **64m47s?** | **~$3.67 预测** |
| **F?** | D + **语义收敛切换** | **9?** | **8?** | **8?** | **8.5?** | **8?** | **8.3?** | 类似 D？ | **64m47s?** | **~$2.06–2.07 预测** |

A/B/C 的独立评分、运行时间和成本测量来自新一轮基准评估。D 最初封存的评估将五个维度都评为 GOOD；上表 8.3/10 是后来用 A/B/C 评分标准对同一个冻结候选做的只读重评。D 的原始运行仍保持封存且未修改。它的生产路由为 Luna Investigator → Sol Focused Implementer → Sol Reviewer → Luna repair → Sol Reviewer → Luna repair。

### Token 结构

cached input 是 input 的子集，不是额外 token。

| 实验组 | 输入 | 缓存 | 新鲜输入 | 输出 | 推理输出 | 模型分布 |
|---|---:|---:|---:|---:|---:|---|
| **A** | **3.104M** | 2.962M | 0.142M | 30.3k | 7.1k | 100% Sol medium |
| **B** | **16.70M** | 16.39M | 0.309M | 79.8k | 46.8k | 100% Luna xhigh |
| **C** | **15.73M** | 15.03M | 0.695M | 105.0k | 66.3k | 100% Luna xhigh |
| **D** | **15.22M** | 14.51M | 0.706M | 108.2k | 44.2k | Sol：9.96M 输入 / 64.3k 输出；Luna：5.26M / 43.9k |
| **E? 全 Sol** | **~15.22M?** | ~14.51M? | ~0.706M? | **~80.9k 预测** | ? | 相同 D 拓扑，Luna 节点替换为 Sol |
| **F? 语义切换** | **~14.05–14.65M 预测** | ? | ? | **~100.9–108.9k 预测** | ? | Sol ~8.09M 输入；Luna ~5.96–6.56M |

D 的实际用量为 15.219M 输入，其中 14.513M 为缓存。Luna 消耗 5.260M 输入 / 43.9k 输出；Sol 消耗 9.959M 输入 / 64.3k 输出。

### 各实验组的表现

| 实验组 | 优点 | 主要弱点 |
|---|---|---|
| **A — Sol 单 Agent** | 运行最快；实现能力强，并自行生成了广泛的验证。 | 单条执行轨迹形成了连贯但不完整的语义模型。测试大多验证了自身假设，遗漏跨表面的所有权、重放和关闭缺陷。 |
| **B — Luna 单 Agent** | 成本极低。投入更多计算和时间后，Luna 的总分几乎与 A 相同。 | 输入量约为 A 的 5.4 倍，墙钟时间约为 2.5 倍；全局语义收敛和验证较弱。大量计算仍未消除生命周期/authority 缺口。 |
| **C — Luna 编排** | 角色分工清楚，managed lifecycle 完整；比 B 快约 13 分钟，正确性/兼容性略好。 | **总质量没有比 B 提升。** 覆盖度从 6 降到 4。Treatment review 错误地判定可以关闭，managed task 已到 DONE，但产品验收仍未完成。 |<br>
| **D — Thaliris 异构模型** | 这是唯一实现了显著更高完成度的配置。独立评审 → 修复 → 再评审确实改变了候选并关闭了缺陷。 | 在已观测实验组中耗时和成本最高。Sol 累积了大量缓存上下文重放；之后仍有一个 P2 presentation-lifecycle 缺陷，真实 GPU/audio/UI 行为也未验证。 |

A/B/C 各自的主要独立缺陷记录在评估材料中：它们分别实现了不同的部分正确方案，并非都以完全相同的方式失败。

### 假设 1 — 编排收益

**方法：** 在实际执行能力固定为 Luna xhigh 时比较 **B 与 C**。B 是单个 Luna Agent；C 使用 Thaliris 角色、隔离的子 Agent 上下文和 managed lifecycle，但所有已观测工作节点都是 Luna xhigh。

**观测结果：**

5.4 → 5.4

没有观察到产品质量提升。C 快了约 **13 分钟**，总 token 略少，但因为未缓存输入更多，估算成本**高约 16–18%**。质量分布发生变化，却没有总体改善：覆盖度 −2，正确性 +1，兼容性 +1。<br>

**结论：** 在这个样本中，单靠编排没有实质增强较弱模型。它展示了工作流/lifecycle 和吞吐量方面的好处，但没有提高总质量。

### 假设 2 — 智能分配收益

**方法：** 比较 **C 与 D**。两者都使用 Thaliris 编排；D 有选择地将 Sol 分配给 Controller、核心语义实现和独立评审，同时保留 Luna 处理调查和有界修复。

**观测结果：**

5.4 → 8.3

评分变化最大的维度为：

覆盖度：4 → 9（+5）<br>
验证：4 → 8（+4）<br>
实现：6 → 8.5（+2.5）<br>
正确性：6 → 8（+2）<br>
兼容性：7 → 8（+1）<br>

D 的成本约为 C 的 **9.1 倍**，时间约为 **1.57 倍**，但它是唯一显著越过产品完成门槛的实验组。D 没有并行执行；主要可观测机制是反复的 **Reviewer → 有界修复 → 再评审**，而不是 Agent 数量或并行计算。

**结论：** 结果支持的是**选择性智能分配**，而不是“Agent 越多越好”。

### 接下来要验证的两个成本假设

**E — 全 Sol 反事实。** 保持 D 的任务、拓扑、角色顺序和 lifecycle 不变，仅把 Luna Investigator/Implementer 节点替换成 Sol。输入/上下文重放量近似不变；仅按 A/B 输出效率比（79.8k / 30.3k ≈ 2.64×）调整输出。这预测全 Sol 的 D 型运行成本约为 **$3.67**，相对于**观测到的 $2.475**，若保持 D 级质量，异构执行约可节省 **32.6%**。不做输出效率调整时，简单的同 token 估算约为 **$3.94**。这仍是反事实，尚未运行。

**F — 语义收敛切换。** 保留 D 的架构和高能力语义节点，但在 Sol Focused Implementer 建立核心实现和硬不变量后结束其执行。广泛测试、构建/lint 收尾、确定性的兼容问题和小修复交给新的 Luna Implementer；新的 Sol Reviewer 仍负责语义验收。基于 trace 的估算移除约 **1.87M Sol 输入 / 15.3k Sol 输出**，增加约 **0.7–1.3M Luna 输入 / 8–16k 输出**，预测成本为 **~$2.06–2.07**，比 D 低约 **16–17%**，目标是同样的 8.3 水平。实际测试前，质量仍明确未知。

### 结语

当前基准支持一个比“多 Agent 更好”更窄的结论：

> **弱模型编排本身没有改善总质量。把更强智能有选择地放在语义实现、评审和收尾环节，确实带来了提升。**

它也指出了下一步优化目标：**不是减少高能力实现，而是缩短昂贵上下文的生命周期**。高能力模型应继续用于执行期间确实需要其推理的工作；语义方案收敛后，可以把确定性的收尾交给成本更低的新工作节点，避免反复重放庞大的 Sol 上下文。

## Benchmark 边界

`benchmarks/abcd/` 可以包含复杂 collector、formal authority 与离线评分。
Production `thaliris` package 不依赖 D11、formal registry、capture authority 或
benchmark receipt issuer。Benchmark 观察 production；它不定义 production 架构。

完整契约见 [DESIGN.md](https://github.com/Iris0fTheValley/Thaliris/blob/main/DESIGN.md) 与
[docs/thaliris-routing-protocol.md](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-routing-protocol.md)。

## README 维护

本仓库的共享内容和完整 ABCD 结果继承自 [Thaliris Core 中文 README](https://github.com/Iris0fTheValley/Thaliris/blob/main/README.md)与[英文 README](https://github.com/Iris0fTheValley/Thaliris/blob/main/README.en.md)。只在此维护 DSH 特有的功能、依赖和限制；修改共同说明时同步 Core 两种语言版本，并保持本仓库的中英文 README 对齐。
