# Thaliris for DeepSeek Harness

语言：简体中文 | [English](README.en.md)

@thaliris/dsh-plugin 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)加入 Thaliris task records 和显式 Controller 工具。它使用 DSH 原生 Workspace、持久 Session、Agent、subagent、Settings、model catalog、Plugin Manager 和 lifecycle。Python Core 是单独的 [Thaliris distribution](https://github.com/Iris0fTheValley/Thaliris)；本仓库不包含 Core 或 Codex adapter 代码副本。

Runtime package 提供可选的 Remote API 和共享 Web/Desktop client。策略页编辑原生 role、model、workspace 和 memory 设置。Memory capability 与默认本地 provider 是独立可选 package；没有它们或 client UI 时，task routing 和 close 仍可用。契约与验证边界见 [CLIENT-CONTRACT.md](CLIENT-CONTRACT.md)、[CAPABILITIES.md](CAPABILITIES.md) 和 [CORE-BASELINE.md](CORE-BASELINE.md)。

## 安装与配置

需要 Node.js 22.x 的 22.19 或更高版本，或 Node.js 24+，以及 Python 3.11+。该适配器对应 DSH source revision 639ed015397290b3745d163aafe02ffee4aa3f84，并使用 Thaliris Core 0.4.3，对应 Core source revision 7f4d9acf2e642e7b3c987d4ee45ebc6589d7cc15。Core 为插件配置的 Python 环境提供 thaliris.core 和 thaliris.authority。包来源与提取仓库集成检查见 [CORE-BASELINE.md](CORE-BASELINE.md)。本指南和后文的共享语义链接不会自动把更新后的 Codex-specific admission、Hook、wait、profile 或语义验收契约移植到此 DSH pin；本仓库仅声明列出的 revision 与已记录检查所覆盖的兼容性。

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


## 原生策略与提示词边界

DSH 使用原生持久化的 Workspace/Session/Agent 及 subagent 关联信息、显式的 Python Core bridge，以及由用户编辑的 Controller/role 策略。`policy.mjs` 管理 Controller 模板；`role-templates.mjs` 管理初始角色提示词。模型路由、工具 allowlist、memory/context 授权和启用记录仍属于用户策略。模板变更不会静默覆盖已有存储角色；显式空数组也会保持为空。`build-bundle.mjs` 根据这些模板生成默认禁用的 bundle patch。Client 输出来自 `client/*`。该适配器不会安装 Codex hooks、TOML profiles 或 Codex lifecycle 契约。本地未跟踪的 Codex 指令副本不构成 DSH 的权威来源。

Controller 负责方向、范围、验收和后续路由；执行角色负责实现方法。普通 Implementer 收敛已接受的稳定方向。Focused Implementer 负责推理、实现、运行时反馈和修订，直到核心语义收敛；剩余确定性收尾交给新的普通 Implementer。Reviewer 独立且只读：READY 需要关键验收的支持证据，不能仅凭没有阻塞项来判定。见[共享语义](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-routing-protocol.md)和[上下文设计](https://github.com/Iris0fTheValley/Thaliris/blob/main/docs/thaliris-prompt-design.md)。
原生完成状态属于证据，不等于语义验收。Core 授权和 DSH 恢复继续使用现有的精确身份与证据检查。见 [CLIENT-CONTRACT.md](CLIENT-CONTRACT.md)。本次模板规范化没有压缩基准测试或运行中 profile 激活方面的结论。

## 历史基准证据

历史 ABCD 证据属于 [Core](https://github.com/Iris0fTheValley/Thaliris#readme)，不能用于验证本次 DSH 模板规范化。
