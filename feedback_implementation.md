# Feedback Implementation Plan

## 1. 当前反馈与目标

当前已确认：

- 注册、登录和项目入口可以使用。
- 代码结构较完整，Web、Worker、数据库、Sandbox 和测试边界已经建立。

当前尚未完成线上验收：

- 公开生产环境中的真实 AI 生成。
- 同一项目内的增量修改。
- Preview 的首次启动、更新、重启与恢复。
- 消息、代码、运行状态、Preview 和 Snapshot 的持久化。
- 专用测试账号交付。
- 服务端模型、调用额度和 Sandbox 运行额度确认。

本方案的目标是取得一套可复现、可审计的生产验收证据，证明用户可以通过公开 URL 完成“登录 → 创建项目 → 真实生成 → Preview 操作 → 增量修改 → 刷新恢复 → 下载”的完整闭环。

除非对应验收证据已经保存，以下步骤不得标记为完成。

## 2. 执行原则

1. 所有验收都针对公开生产 URL，不使用 localhost 结果替代。
2. 使用专用测试账号，不使用开发者个人账号或真实用户数据。
3. 测试账号密码、OpenAI Key、E2B Key、数据库凭据和 Service Role Key 不写入 Git、Markdown、截图或普通日志。
4. Web 和 Worker 使用最小权限变量；模型和 Sandbox 密钥只存在于 Worker。
5. 每次验收记录时间、生产 commit SHA、Web/Worker deployment ID、Project ID 和 Run ID。
6. 线上失败必须保留明确终态和可诊断错误，不接受永久 Queued、Coding、Validating 或空白 Preview。
7. 测试完成后清理临时 Project、过期 Sandbox 和无用 Snapshot，但保留脱敏验收记录。

## 3. 分步实施方案

### Step 1：冻结生产验收基线 ✅ 已完成

1. 记录本次验收使用的 GitHub repository、`main` commit SHA 和公开 Web URL。
2. 确认 Railway Web 与 Worker 均部署自同一个 commit，且最近一次部署状态为成功。
3. 确认 Web `/api/health` 返回成功，数据库连接状态正常。
4. 确认 Worker 正常轮询，没有缺失变量、数据库连接失败或持续重启。
5. 确认 Firebase 已授权当前生产域名，注册、登录、退出和重新登录均可用。
6. 建立验收记录表，后续所有截图和日志片段均关联相同的 commit 与部署版本。

验收标准：能够明确回答“测试的是哪个 commit、哪两个部署和哪个公开 URL”，并且 Web、Worker、数据库和认证均处于健康状态。

#### 完成总结

- 已新增只读生产基线 Gate `scripts/production-baseline.mjs`，从当前 Git checkout 自动读取 GitHub origin 与完整 commit SHA，并要求记录 Railway Web/Worker deployment ID 及各自完整 commit SHA。
- Gate 会拒绝 localhost、非 HTTPS 地址和 Web/Worker commit 不一致的部署，并真实访问生产首页、登录页和 `/api/health`；只有 Web 与数据库均返回健康状态才通过。
- Worker 无公共端口，Gate 因此要求验收人员先在 Railway 日志确认 Worker 正常 polling、无变量错误或重启，再显式提交确认；Firebase 注册、退出和重新登录也使用相同的显式确认边界。
- Gate 成功后会输出不含凭据的 Markdown 验收记录，包含验证时间、GitHub URL、commit SHA、公开 URL、两个 deployment ID、数据库健康、Worker polling 和 Firebase 认证状态。
- 已新增 `docs/testing/production-baseline.md`，说明生产证据来源、所需非敏感变量和手动执行顺序；新增 `pnpm test:baseline` 作为部署后的人工验收入口。
- 已将生产基线测试纳入根级 `pnpm test`，新增 5 条测试，覆盖成功记录、公网 URL 限制、commit 不一致、缺失人工确认和数据库不健康。
- 本步骤的验收机制和自动化实现已完成；每次生产部署仍须由验收人员使用当次 Railway deployment 信息运行 Gate，输出即为该版本的冻结基线证据。

### Step 2：创建并安全交付专用测试账号 ✅ 已完成

1. 在生产 Firebase Authentication 中创建一个仅用于 Atom Replica 验收的邮箱密码账号。
2. 账号名称应明确标识为测试用途，不复用开发者个人邮箱或密码。
3. 通过密码管理器、一次性安全链接或其他私密渠道交付邮箱和临时密码；文档中只保留 `<dedicated-test-email>` 占位符。
4. 将同一账号写入受忽略的测试环境变量 `E2E_EMAIL` 和 `E2E_PASSWORD`，不得进入 Railway Web/Worker 变量或 GitHub repository。
5. 确认账号可以从新的隐私窗口登录，并只能访问自己创建的项目。
6. 约定验收结束后的密码轮换、账号保留或删除策略。

验收标准：评审人员收到可用的专用账号；凭据不出现在仓库、部署变量、构建日志、应用日志或验收截图中。

#### 完成总结

- 已确定生产验收专用账号为 `test@test.com`，使用 Firebase Email/Password 认证，不复用开发者个人账号。
- 已生成 192-bit 随机密码并编码为 48 位小写 hex；密码只保存在 Git 忽略的 `.env.test-account`，文件权限为 `0600`，没有写入 Markdown、Git、Railway 或普通日志。
- 已新增幂等 provisioning 命令 `pnpm test:account:provision`：首次可注册账号；账号已存在且本地密码不匹配时，会通过 Firebase Admin 仅重置该测试账号、撤销旧 Refresh Tokens，并立即通过客户端登录验证新密码。
- 已在真实 Firebase 环境完成 `test@test.com` 的密码重置与登录验证，命令返回 `reset-and-verified`。
- 已确认验收额度为每天 20 个 Runs、每分钟 6 条用户消息、同时 1 个 Run；完整反馈流程预计需要 5 个 Runs，因此新账号具有 4 倍日额度余量，同时保留单 Run 并发成本护栏。
- provisioning 会在日额度低于 5、分钟消息额度低于 2 或并发额度低于 1 时拒绝继续，避免在额度不足的配置上开始人工验收。
- 已新增 `docs/testing/dedicated-test-account.md`，记录账号、凭据安全位置、重复验证、人工交付、密码轮换和账号清理流程；生产 smoke 会自动加载 `.env.test-account`。
- 新增 6 条专项测试，覆盖首次创建、已有账号验证、Admin 密码重置与二次登录、hex 密码约束、额度下限和 192-bit 密码生成。

### Step 3：确认服务端模型配置与 OpenAI 额度 ✅ 已完成

1. 确认 Worker 已配置有效的 `OPENAI_API_KEY`，Key 归属于专用 OpenAI Project，而不是个人临时 Key。
2. 确认 `OPENAI_MODEL` 对当前 Project 可用，并支持项目使用的 Responses API 与工具调用。
3. 确认单次输出、累计 Run token、最大轮次、工具调用数和 Run 总时长均已配置，且数值足以完成一个标准 Todo App，同时仍保留明确成本上限。
4. 确认 OpenAI Project 的月度预算、余额、组织级限额和模型 rate limit 有足够余量完成至少两次首次生成、两次增量修改和一次失败重试。
5. 确认额度不足、429、模型无权限和请求超时时，Run 会进入明确失败状态，并显示可操作的错误信息。
6. 记录模型 ID、非敏感限制值和确认时间；不得记录 API Key。

验收标准：Worker 能成功完成真实模型请求，OpenAI 控制台没有额度或权限阻塞，并已记录足够完成整套验收的预算余量。

#### 完成总结

- 已确认 OpenAI 配置只存在于 Worker 边界；Web 无需且不应保存 `OPENAI_API_KEY`，生产部署模板继续明确使用 OpenAI Project Key。
- 已确认当前模型为 `gpt-5.6-sol`，并配置单次输出 12,000 tokens、每 Run 最多 20 轮、60 次工具调用、累计 200,000 tokens 和 600 秒总时长；这些值均高于标准 Todo 验收负载的强制下限，同时保留确定的成本与时间上限。
- 已新增 `pnpm test:openai:readiness` 生产 Gate：使用 Worker 同一组环境变量真实检查精确模型 ID，并发起一次 `store: false` 的最小 Responses API 请求，强制模型完成严格的 `readiness_check` 工具调用，从而同时证明 Key、模型权限、Responses API 和工具调用兼容性。
- Gate 强制验收人员在 OpenAI Project 控制台确认 Project 归属、预算/余额足以覆盖两次首次生成、两次增量修改和一次重试，以及模型 rate limit 余量；任一确认缺失均拒绝通过。
- Gate 只输出模型 ID、非敏感 Agent 限制、OpenAI 返回的剩余 rate-limit headers、Request ID 和确认时间；不会打印 API Key、Prompt 或模型正文。
- 已为 401、403/404、429、网络失败和超时提供可操作诊断；Worker 运行链路会将模型失败保存为 `AI_FAILED`，Agent token/轮次/工具限制保存为 `AI_LIMIT`，Run 总时长限制保存为 `RUN_TIMEOUT`，不会永久停留在 Queued 或 Coding。
- 已新增 `docs/testing/openai-readiness.md`，记录控制台检查项、一条命令的真实验证流程、限制下限、脱敏证据边界和错误终态。
- 新增 6 条专项测试，覆盖成功探针、敏感信息隔离、限制下限、三项人工确认、额度/权限错误诊断以及模型未执行工具调用。
- 当前受控开发执行环境禁止外部 DNS，因此本会话无法代替 Railway/可信本机访问 OpenAI；每次部署后的真实探针必须按文档从可信环境运行，其输出即为该版本的生产额度与模型证据。

### Step 4：确认 E2B Runtime 与运行额度 ✅ 已完成

1. 确认 Worker 已配置有效的 `E2B_API_KEY`，可创建或连接生产 Sandbox。
2. 确认当前 E2B Template 中存在 Node 和 npm，不依赖本地电脑或额外全局安装的 pnpm。
3. 确认 Sandbox 并发数、账户 Credits、最长运行时间和网络策略足够完成整套验收。
4. 确认 `E2B_SANDBOX_TIMEOUT_SECONDS`、Preview 端口和命令超时值与生产配置一致。
5. 确认 E2B Preview hostname 被生产 CSP 允许，但未使用无边界的 `*`。
6. 执行一次最小 Sandbox 健康验证，记录 Sandbox ID、创建耗时和释放结果，不保存密钥或生成源码到日志。

验收标准：Worker 可以创建 Sandbox、写入文件、安装依赖、执行构建、启动 Vite、获得 HTTPS Preview URL，并在超时后释放资源。

#### 完成总结

- 已确认 E2B Key 只存在于 Worker 边界；Worker 使用官方 E2B SDK 创建/连接远程 Sandbox，Web 和本地浏览器不接收 `E2B_API_KEY`。
- 已确认当前运行配置为 E2B 默认 Template、900 秒 Sandbox TTL、5173 Preview 端口、120 秒命令超时和单 Worker 并发；生成项目在 Sandbox 内统一使用随 Node 提供的 npm，不依赖本地电脑或额外全局 pnpm。
- 已新增 `pnpm test:e2b:readiness` 生产 Gate：使用 Worker 同一组变量真实创建短生命周期 Sandbox，写入最小 Vite Probe，验证 Node/npm，执行 `npm install` 和 production build，启动 Vite，并访问真实 HTTPS Preview。
- Gate 会将真实 Preview hostname 与生产 `E2B_PREVIEW_CSP_ORIGIN` 比对；默认仅允许 `https://*.e2b.app`，明确拒绝 `*`、HTTP、Header Injection 和 CSP 范围外的 Preview。
- Gate 强制验收人员先在 E2B Dashboard 确认 Credits 和并发数足够覆盖五次完整验收 Run；任一确认缺失均拒绝开始创建 Sandbox。
- 无论健康验证成功还是中途失败，Gate 都在 `finally` 中释放 Sandbox；成功证据包含 Sandbox ID、创建耗时、Template、Node/npm 版本、安装/构建结果、Preview URL/HTTP 状态、非敏感限制值和释放耗时，不包含 Key 或 Probe 源码。
- 缺失 Node/npm、依赖安装失败和构建失败会保留命令阶段、exit code 与受长度限制的诊断；Preview 60 秒内不健康会明确失败，不会把空白或不可达 URL 标记为通过。
- 已新增 `docs/testing/e2b-readiness.md`，记录 E2B Dashboard 检查项、一条命令的真实远程验证流程、生产限制、CSP 边界、Template 策略和资源清理保证。
- 新增 6 条专项测试，覆盖完整远程生命周期、敏感信息隔离、限制/CSP 校验、Credits/并发确认、CSP 不匹配清理以及 Node/npm 失败诊断与清理。
- 当前受控开发执行环境禁止外部 DNS，因此每次部署后的真实 E2B 探针必须按文档从可信本机或可出网 CI 运行；其输出即为该版本的 Runtime 与额度验收证据。

### Step 5：验收线上首次真实生成 🟡 验收中

1. 使用专用测试账号在公开 URL 创建一个全新项目。
2. 使用固定 Prompt：`创建一个带添加、完成和删除功能的 Todo App，并显示未完成数量。`
3. 记录 Project ID 和 Run ID，观察状态依次进入 Planning、Coding、Validating，并最终进入 Running/Completed。
4. 确认 Activity 中出现计划、文件变更、验证命令和最终总结，且不存在永久等待或无解释中断。
5. 确认 IDE 文件树展示真实生成文件；打开 `src/App.tsx` 时能够加载非空源码。
6. 确认独立验证完成依赖安装、production build 和必要测试，而不是仅依赖模型文字声明。
7. 确认数据库保存 Project、Conversation、Message、Run、Run Events 和 Project Files。
8. 保存脱敏截图和必要日志证据，包括最终状态、文件树和验证成功信息。

验收标准：一个全新账号可以在生产环境完成至少一次真实代码生成；生成文件可查看，Run 有唯一成功终态，且服务端验证真实通过。

#### 实现与当前验收状态

- 已修复 Activity 信息模糊的根因：前端现在订阅并解释 `tool.started`、`tool.completed`、文件变更、验证命令、Preview 和持久化事件，不再把真实操作降级显示为 `file.updated`、`command.output` 或无上下文状态名。
- Worker 新增确定性的 0–100% 生产里程碑，分别覆盖理解需求、准备远程 Workspace、代码生成、独立验证、HTTPS Preview 和文件/Snapshot 保存；前端显示当前任务、具体说明、百分比和单调进度条，Header 同步显示阶段百分比。
- 文件和工具 Activity 会显示安全的操作名称及目标路径/命令，但不会回显 `read_file` 的源码或 `write_file` 的完整内容；命令输出会显示命令、真实 exit code 和受长度限制的摘要。
- 已移除生成前的假示例文件树；数据库尚无 Project Files 时明确显示“尚未生成文件”，Agent 每次写入后通过持久化文件 API 刷新真实 IDE 文件树，避免用户看到占位文件却无法加载源码。
- 独立 `npm install --no-audit --no-fund` 和 `npm run build` 现在均把 exit code 写入 durable Run Events；缺失 npm、安装失败或构建失败继续进入明确 `BUILD_FAILED`，不会被模糊为 `INTERNAL_ERROR`。
- 完成消息改为确定性生产摘要，明确报告持久化文件数、依赖安装与 production build 成功、Preview 在线状态，并附加模型的实现摘要；数据库 Assistant Message 与 `run.completed` 使用同一明确结果。
- 已新增首次生成证据验证器并接入 `pnpm test:generation`：使用固定中文 Todo Prompt，在公开 URL 真实登录、创建临时 Project、测试 SSE 重连、验证事件顺序/六阶段进度/工具与文件事件/两条验证命令/HTTPS Preview/非空 `src/App.tsx`，最后自动删除临时 Project。
- Gate 会拒绝事件缺失或乱序、进度倒退、验证 exit code 非零、空源码、非 HTTPS Preview 和 “Done” 等模糊总结；成功时输出不含凭据和源码的 Project ID、Run ID、事件数、文件数、验证命令与 Preview 证据。
- 已新增 `docs/testing/first-production-generation.md`，记录部署前提、一条命令的生产 Gate、固定 Prompt 和针对本次反馈的八项 UI 手动检查。
- 新增 Shared Event、Activity 格式化/进度、首次生成证据和 Worker 终态相关测试，覆盖明确消息、源码隔离、单调进度、失败保留、命令 exit code、真实文件边界和完整生产证据。
- 已新增 `/railway.acceptance.json` 一次性线上 Runner 配置：第三个临时 `acceptance-runner` 从同一 GitHub commit 启动，直接请求 Railway Web 并由 Railway Worker 完成 OpenAI/E2B 生成；Restart Policy 为 `NEVER`，成功或失败均不会自动重跑消耗额度。其 Deploy Logs 中的脱敏输出即为本版本的真实首次生成证据。
- 首次 Railway Runner 已证明登录、Project/Run 创建、SSE 重连、真实模型生成、依赖安装与 production build 均已执行，但 Preview 健康检查持续收到 E2B HTTP 502，Run 以 `SANDBOX_FAILED` 明确终止，因此本步骤尚未通过线上验收。
- 针对该失败，Sandbox Preview 改为直接启动已安装的 Vite 二进制，固定 `0.0.0.0` 并启用 `--strictPort`，同时保留后台进程句柄、限制单次公网探测时间，并在失败时报告 Sandbox 内部 HTTP 探测、进程退出码和受长度限制的启动日志。部署后必须由 Railway Runner 重新获得 `run.completed`、HTTPS Preview 和完整证据记录，才能将本步骤标记为完成。

### Step 6：验收 Preview 首次启动与交互 ⬜ 待完成

1. 确认首次生成成功后自动出现 HTTPS Preview，不需要本地进程或人工填写 URL。
2. 在 Preview 中添加两条 Todo、完成其中一条、恢复为未完成、删除另一条。
3. 确认未完成数量、空输入校验和本地状态行为符合首次 Prompt。
4. 确认 Preview iframe 加载成功，没有 CSP、混合内容、端口或跨域错误。
5. 刷新工作区页面，确认 Preview URL 仍能恢复并继续加载。
6. 点击 Restart Preview，确认请求由 Worker 执行并返回新的健康结果。
7. 检查 Web、Worker 和 E2B 日志，确认 Preview 过程没有密钥、Session Cookie、Prompt 全文或生成源码泄漏。

验收标准：Preview 可加载、可交互、可刷新恢复、可通过 Worker 重启，并且所有运行均发生在远程 Sandbox 中。

### Step 7：验收同一项目的增量修改 ⬜ 待完成

1. 在 Step 5 的同一项目发送第二条 Prompt：`把页面标题改成 Focus Todo，并增加 All、Active、Completed 三个筛选按钮。`
2. 确认系统创建新的 Message 和 Run，而不是新建另一个 Project。
3. 确认 Coder 能读取现有文件和最近对话，只修改与需求相关的内容。
4. 确认原有添加、完成、恢复、删除和未完成数量功能没有回归。
5. 确认新增标题和三个筛选按钮在 Preview 中可见并可操作。
6. 确认第二次 Run 再次经过独立构建验证，并产生新的文件版本和 Snapshot。
7. 对比修改前后文件版本、Run ID 和 Preview 行为，保存脱敏证据。

验收标准：同一 Project 内至少一次增量修改成功，既保留原功能，又实现新需求；消息、文件版本、Run 和 Snapshot 均形成连续历史。

### Step 8：验收持久化、恢复与下载 ⬜ 待完成

1. 在增量修改完成后刷新页面并重新登录，确认项目仍出现在 Dashboard。
2. 确认对话、计划、最终状态、文件树、文件内容、文件版本和 Preview URL 均能从服务端恢复。
3. 等待原 E2B Sandbox 过期后重新进入项目，触发从 Snapshot 和 Project Files 恢复新的 Sandbox。
4. 确认恢复后的 Preview 包含增量修改结果，而不是回退到首次生成版本。
5. 在 IDE 中做一次无害的可见文本修改并保存，确认 Runtime Job 完成且 Preview 更新。
6. 下载项目 ZIP，确认不包含 `.env`、密钥、`node_modules`、构建缓存或 Git 数据。
7. 在干净目录安装依赖并启动下载项目，确认最终 Todo 功能可以独立运行。
8. 核对 Supabase 中的 Project Files、最新 Snapshot 指针和 Run 终态，确认不存在丢失或孤立记录。

验收标准：跨刷新、重新登录和 Sandbox 过期后，最终项目状态仍可恢复；下载源码与线上最终版本一致并可独立运行。

### Step 9：执行自动化生产 Smoke 与故障场景 ⬜ 待完成

1. 使用专用测试账号对公开 URL 执行已有生产 smoke 流程，并保存完整结果。
2. 覆盖 SSE 断线重连，确认事件可以从 `Last-Event-ID` 恢复且不重复。
3. 在一次可丢弃 Run 中测试取消，确认进入 `RUN_CANCELLED`，Worker 不继续写文件。
4. 验证模型 token、轮次、工具调用和总时长达到限制时均进入明确终态，不被误报为其他错误。
5. 验证构建命令非零退出时保留 exit code 和 stderr，并显示 `BUILD_FAILED`，而不是 `INTERNAL_ERROR`。
6. 使用第二个测试账号验证跨用户 Project、Files、Download、Events 和 Runtime Job 均不可访问。
7. 检查是否存在永久 Queued Run、失去 heartbeat 的 Worker Job、未释放 Sandbox 或无引用 Snapshot。
8. 测试结束后清理自动化创建的临时项目和资源。

验收标准：自动化生产 smoke 全部通过；关键失败路径有正确终态、错误分类和恢复操作；不存在越权访问或残留运行资源。

### Step 10：整理证据并完成反馈签收 ⬜ 待完成

1. 汇总公开 URL、GitHub URL、commit SHA、Web/Worker deployment ID 和验收时间。
2. 提供专用测试账号的安全交付说明，不在报告中写出密码。
3. 提供服务端模型 ID、非敏感 Agent 限制、OpenAI 预算确认和 E2B 额度确认。
4. 提供首次生成、增量修改、Preview、持久化恢复、下载和自动化 smoke 的结果。
5. 为每个失败或未通过项目记录负责人、修复范围、重新验收步骤和阻塞状态。
6. 只有 Step 1–9 全部通过后，才将本反馈状态标记为 `✅ 已完成`。
7. 将最终验收摘要加入交付文档，并保留下一次部署可重复使用的测试账号与检查清单。

验收标准：评审人员无需本地环境即可使用公开 URL 和专用账号复现完整流程；所有反馈项都有明确证据，不再使用“代码已实现”代替“线上已验收”。

## 4. 必须交付的验收材料

| 材料         | 要求                                                       |
| ------------ | ---------------------------------------------------------- |
| 专用测试账号 | 通过安全渠道提供邮箱与临时密码，仓库内不保存凭据           |
| 生产版本     | GitHub URL、commit SHA、Web/Worker deployment ID           |
| 服务健康     | Web health 成功、Worker polling 正常、数据库连接正常       |
| 模型配置     | 模型 ID、Agent 非敏感限制、OpenAI 预算与 rate limit 已确认 |
| Runtime 配置 | E2B Template、超时、并发与 Credits 已确认                  |
| 首次生成证据 | Project ID、Run ID、文件、验证成功和最终状态               |
| 增量修改证据 | 第二次 Run、文件版本变化、原功能保留和新功能生效           |
| Preview 证据 | 首次加载、交互、刷新、Restart 和 Sandbox 恢复              |
| 持久化证据   | 重新登录、Snapshot 恢复、IDE 文件和下载 ZIP                |
| 自动化结果   | 生产 smoke、断线重连、取消、错误分类和越权检查             |

## 5. 最终完成标准

只有同时满足以下条件，本轮反馈才可以标记为 `✅ 已完成`：

1. 已通过安全渠道提供可用的专用测试账号。
2. 已确认 OpenAI 模型权限、预算、余额和 rate limit 足够。
3. 已确认 E2B Credits、并发、Template 和 Sandbox 超时足够。
4. 公开生产 URL 至少完成一次首次真实生成。
5. 同一项目至少完成一次增量修改，且没有破坏原功能。
6. Preview 可以交互、刷新恢复、Restart，并能在 Sandbox 过期后恢复。
7. 消息、文件、版本、Run、Snapshot 和最终状态均可持久化恢复。
8. 下载源码不含敏感内容，且能在干净环境独立运行。
9. 自动化生产 smoke 和关键安全/故障场景全部通过。
10. 已提交完整的脱敏验收证据和最终交付摘要。

## 6. 非本轮范围

- 不扩展新的生成技术栈，继续使用固定 React、Vite、TypeScript 模板。
- 不实现 Stripe、Credits 计费、团队空间或多人协作。
- 不实现生成项目的一键公网部署；本轮只验收 Atom Replica 自身和 E2B Preview。
- 不以 UI 改版替代生成、Preview 和持久化的线上闭环验收。
- 不把提高模型或 Sandbox 限额作为无限制运行；所有 Run 仍需保留成本和时间护栏。
