# Feedback Implementation Plan ✅ 已完成

## 1. 当前反馈与目标

当前已确认：

- 注册、登录和项目入口可以使用。
- 代码结构较完整，Web、Worker、数据库、Sandbox 和测试边界已经建立。

当前线上验收状态：

- Step 1–9 的真实生产验收、故障场景、安全隔离和资源清理均已通过。
- Step 10 的脱敏证据汇总、公开交付摘要和无本地环境复现清单均已完成。
- 当前没有失败、待重验或阻塞的反馈项。

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

### Step 5：验收线上首次真实生成 ✅ 已完成

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
- 上述诊断随后确认 E2B 默认 Template 实际为 Node 20.9.0，而 Vite 7 dev server 要求 Node 20.19+，因此 production build 虽通过，Preview 仍会在依赖优化阶段因缺少 `crypto.hash` 退出。Preview 已进一步改为使用 Node 内置 HTTP 模块直接服务独立验证后的 `dist`，不再让生产 Preview 依赖 Vite dev runtime 或更高 Node minor；同一端口上的旧 Preview 会在启动前确定性停止。
- Preview 修复后的线上 Run 已到达 95% 文件/Snapshot 保存，但暴露出文件枚举先递归整个 `node_modules` 和 `dist`、再执行归档过滤的远程调用放大问题。Sandbox 文件树现已在递归入口剪枝依赖、构建、缓存、Git、coverage 和 `.env` 路径，只枚举并持久化真实项目源码。
- 最终 Railway 验收由 Runner commit `6afe731e4a6bf5023e002804fc34d94f169e4a07` 执行，目标 Web/Worker 修复版本为 `813423b24adfd8e40ab720a9982cd98ea51241d6`。固定中文 Todo Prompt 的真实 Run 成功保存 13 个项目文件，独立依赖安装、production build 和模型执行的测试均通过，HTTPS Preview 在线，明确完成摘要与 `First Production Generation Record` 已保存在 Runner Deploy Logs；临时验收 Project 随后自动清理，Step 5 正式通过。

### Step 6：验收 Preview 首次启动与交互 ✅ 已完成

1. 确认首次生成成功后自动出现 HTTPS Preview，不需要本地进程或人工填写 URL。
2. 在 Preview 中添加两条 Todo、完成其中一条、恢复为未完成、删除另一条。
3. 确认未完成数量、空输入校验和本地状态行为符合首次 Prompt。
4. 确认 Preview iframe 加载成功，没有 CSP、混合内容、端口或跨域错误。
5. 刷新工作区页面，确认 Preview URL 仍能恢复并继续加载。
6. 点击 Restart Preview，确认请求由 Worker 执行并返回新的健康结果。
7. 检查 Web、Worker 和 E2B 日志，确认 Preview 过程没有密钥、Session Cookie、Prompt 全文或生成源码泄漏。

验收标准：Preview 可加载、可交互、可刷新恢复、可通过 Worker 重启，并且所有运行均发生在远程 Sandbox 中。

#### 实现与当前验收状态

- 已新增 `pnpm test:preview` 浏览器级生产 Gate：沿用 Step 5 固定中文 Prompt 创建真实项目，在 Headless Chromium 中加载公开 Workspace 与 E2B Preview，而不是仅检查 Preview HTML 或源码。
- Gate 会真实执行空输入、添加两条 Todo、完成、恢复和删除交互，并要求未完成数量严格经历 `2 → 1 → 2 → 1`；同时确认 Preview 没有发出 POST/PUT/PATCH/DELETE 请求，证明这些 Todo 状态保持在浏览器本地。
- Gate 会从认证后的 Workspace 自动发现 iframe，要求 HTTPS Preview 文档真实返回 200；随后重载 Workspace 并再次要求同一服务端 Preview URL 成功加载，从而覆盖首次自动出现与刷新恢复。
- Restart 不再只通过 API 直调验收：Chromium 会点击 Workspace Header 的 Restart 按钮，截取脱敏后的同源 fetch 结果，确认 Web 创建 durable Runtime Job、Worker 将其以 `restart_preview` 完成，并再次探测返回的 HTTPS Preview 健康状态。
- 浏览器监听 Network 与 Log 事件，任何 CSP、Mixed Content、Origin 或 Frame Blocking 错误都会使 Gate 失败；证据只输出 Project/Run ID、HTTP 状态和行为布尔值，不输出 Session Cookie、请求头、Prompt、Todo 测试文本或生成源码。
- 已新增专用 Node 24/Chromium `Dockerfile.acceptance`，Railway 一次性 Runner 现在执行 Step 6 Gate，仍保持 `restartPolicyType: NEVER` 且只接收专用账号和 Firebase Browser Key，不接收任何 Worker/数据库特权密钥。
- Railway Docker Start Command 不解析 POSIX 环境变量前缀，因此 Preview-only 模式改由 `scripts/preview-smoke.mjs` 在 Node 进程内设置；Start Command 现在是可直接执行的 `node scripts/preview-smoke.mjs`。
- 首次浏览器 Runner 暴露出 E2B URL 字符串规范化差异：服务端 URL 可不含末尾 `/`，DOM `iframe.src` 会补全 `/`。Gate 已改为通过 `URL.href` 规范化后比较，并在后续失败中报告 iframe 是否存在、Origin 是否匹配和已观察到的 load 次数，避免把已加载 Preview 误判为超时。
- Web 与 Worker 均将 `/railway.acceptance.json` 纳入部署 Watch Pattern，因此推进验收 Gate 时三个服务会从同一个新 commit 重新部署，避免 Runner 与目标生产服务版本不一致。
- 已新增 `docs/testing/preview-production-acceptance.md` 和 5 条证据验证测试，记录可信本机与 Railway 执行方式、浏览器断言、脱敏边界以及 Web/Worker/E2B 日志人工复核要求。
- 当前代码与可重复验收机制已实现；必须将本 commit 部署至 Web/Worker，并由 Railway Runner 产出 `Preview Production Acceptance Record`，再核对对应时间窗口日志无凭据、完整 Prompt 或源码泄漏后，才可将 Step 6 标记为完成。
- 最新 Runner 已通过 iframe、刷新恢复与 Todo 交互，但在点击 Restart 后以 `Workspace restart did not complete` 超时；该表现与 SSR 按钮已出现、React hydration 尚未绑定点击处理器的竞态一致。Restart 现在会在 hydration 前保持禁用并暴露明确的 client-ready 状态，Runner 等待该状态后再点击，同时将 POST 入队、Runtime Job 成功/失败终态及 UI 成功反馈拆分验证；下一次部署若仍失败，将直接报告具体阶段、HTTP 或 Job 状态，而不再只有笼统的 180 秒超时。
- 随后的 crash 堆栈仍指向旧版 Runner 的第 619 行，证明 Railway 重启了旧 deployment，而非执行上述修复提交。Runner 现自报 release 与 `RAILWAY_GIT_COMMIT_SHA`，并通过 acceptance 配置变更强制 Web、Worker、Runner 同 commit 重新部署；同时将 Restart 等待预算扩展为 6 分钟，以覆盖 Sandbox 过期后最长 120 秒依赖安装与 120 秒 Preview 健康检查，连接仍存活的 E2B Sandbox 时会续租 TTL 并刷新数据库到期时间。
- 部署前还确认 Release gate 自首次提交起一直因两个 clean-checkout 问题失败：被跳过的 Supabase 集成测试仍过早解析密钥环境，且 Worker 测试前未构建 workspace packages。环境解析现延迟到集成 suite 真正运行时，根测试通过 `pretest` 先构建内部 packages；修复已在无 `.env` 的全新 Node 24 checkout 中通过，并由 GitHub Actions `30a914c` 首次取得成功终态。
- v4 Runner 已确认执行新代码，但在首次生成阶段收到 `RUN_TIMEOUT / Worker heartbeat expired`。根因是已配置的 `RUN_HEARTBEAT_INTERVAL_MS=5000` 从未接入 Agent Run，长于 30 秒的模型/Sandbox 调用在滚动部署的新旧 Worker 重叠期会被误判为 stale。Worker 现从认领 Run 到最终 usage 记录持续发送 heartbeat，Railway Runner 也会在健康检查后等待 45 秒部署稳定窗口再创建验收项目。
- v5 的 Railway 状态时间进一步证明部署竞态：Runner 于 08:21:59 启动并在 45 秒后放行，新 Worker 直到 08:22:53 才成功，旧 Worker 因而提前认领了 Run；Runner 在 stale 阈值后于 08:23:23 失败。Railway 默认稳定窗口现提高到 120 秒，覆盖本次实测 54 秒的服务启动差，并确保项目只在新 Worker 稳定轮询后创建。
- v6 已证明首次生成、持续 heartbeat、独立验证、HTTPS Preview 和持久化成功，随后浏览器 Gate 暴露模型合理生成了 3 条示例 Todo，且计数文案使用 aria-label `还有 N 项未完成`/可见文案 `还剩 N 项任务`。Gate 现先通过 UI 清空种子任务，再严格执行两条添加及 `2 → 1 → 2 → 1`；计数识别同时覆盖可见与无障碍文案，不再假设固定 Prompt 必然生成空列表或某一种措辞。
- 同一生产诊断还捕获到 Railway SSE socket 的真实传输中断；`consumeRun` 现对连接建立失败与 `reader.read()` 中断均使用最后一个 Event ID 自动恢复，保持事件去重与终态失败语义，不再因一次 `UND_ERR_SOCKET` 提前终止验收。
- v7 已通过种子 Todo 清理、两条 Todo、计数变化、Workspace 刷新恢复和 Restart UI 入队，失败推进到 Worker 的真实 `restart_preview` Runtime Job；旧错误只持久化通用重试文案，无法区分 E2B reconnect、TTL 续租、恢复、进程重启或公网健康检查。
- 已核对项目锁定的 E2B SDK 及官方接口：`Sandbox.connect(id, opts)` 负责连接/恢复，Sandbox 生命周期必须随后通过独立的 `setTimeout(timeoutMs, opts)` 续租。两次控制面请求现均使用显式 `requestTimeoutMs`，并分别记录 `SANDBOX_RECONNECT_FAILED` 与 `SANDBOX_TTL_RENEWAL_FAILED`。
- 代码审计确认过期 Sandbox 的恢复路径只执行了 `npm install`，却直接启动仅服务 `dist` 的静态 Preview；Snapshot 和 Project Files 本来就不保存 `dist`，因此恢复后的服务必然缺少构建输出。恢复现会在启动 Preview 前执行独立 `npm run build`，并对恢复文件、安装、构建、Preview prepare/stop/start/health 和数据库保存持久化脱敏阶段错误码。
- v8 修复已在 Node 24 完整 Release gate 中通过，且不新增数据库迁移；阶段码保存在 Runtime Job 现有 durable `result_json`，UI 与 Runner 会显示阶段码和安全消息，而 Provider 原始异常、源码与凭据不会进入 Runtime Job。仍须由同 commit 的 Railway Web/Worker/Runner 重新产出成功记录并完成日志边界复核后，Step 6 才能标记完成。
- v8 线上 Run 再次通过生成、交互与刷新，并首次把 Restart 精确定位为 `PREVIEW_PREPARE_FAILED`：E2B reconnect 与 TTL 续租已返回，但紧随其后的 `/tmp` Preview launcher 写入暂时不可用。同一 Sandbox 数秒后经 SDK 重新连接、续租、`isRunning()` 和无害 `/tmp` 写入探针全部成功，确认是 Sandbox resume 后控制面先于环境文件系统就绪的短暂竞态，而非路径或权限策略。
- v9 在 reconnect 后轮询 E2B 环境健康再暴露 Adapter，并对幂等的 Preview launcher 写入增加短时有界重试；新增测试覆盖环境健康连续两次未就绪后恢复，以及首次文件写入失败后重试成功。必须由 v9 Railway Runner 再次完成线上闭环后才能签收 Step 6。
- v9 证明 `isRunning()` 已成功但三次 launcher 写入仍在约 7 秒内全部失败；同一 Sandbox 随后通过 SDK 直接完成 `/tmp` 与 Workspace 两个无害写入探针，进一步确认 E2B health 早于 Files 服务稳定就绪。v10 仅将幂等 launcher 写入扩大为约 25 秒内最多十次，不重试可能已产生副作用的进程启动；新增 fake-timer 测试证明持续失败时严格止于十次并保持 `PREVIEW_PREPARE_FAILED`。
- v10 用完整约 25 秒重试窗口仍稳定停在 `PREVIEW_PREPARE_FAILED`，排除了就绪延迟。对同一 Sandbox 的精确对照显示：短文件、同长度中性内容和 launcher 源码写入新路径均成功；只有覆盖既有 `/tmp/atom-replica-preview.mjs` 会返回 E2B `SandboxError`（permission/HTTP 500），先删除再写入则立即成功且内容一致。v11 将 Restart 顺序改为“停止旧进程 → 删除旧 launcher（允许不存在）→ 写入 launcher → 启动 → 健康检查”，并以调用顺序测试锁定该回归。
- v11 commit `a3eb37c` 已通过 GitHub CI 与完整 Node 24 Release gate；同一修复还在此前失败的真实 E2B Sandbox 上直接完成 reconnect、TTL 续租、launcher 重建、进程启动和公网 HTTPS health。随后 Railway Runner 的 Project `ea4b6ebb-609b-46b7-9235-e4cda446fb3c`、Run `a2235462-651a-437f-a5f8-0173a77ce7d1` 与 Runtime Job `588f6264-89ab-4138-b088-1b19c4403117` 均取得成功终态；Job 在约 5.5 秒内以 `restart_preview` 和 HTTPS URL 完成，Runner 2.8 秒后自动删除临时 Project，证明自动化流程已越过 Restart、UI 反馈与最终健康探测。
- 已取得 v11 Runner 的正式 `Preview Production Acceptance Record`（2026-08-24T09:41:01.270Z）：Initial Preview HTTPS/HTTP 200；空输入拒绝、添加两条、完成、恢复和删除均通过；未完成计数严格为 `2 → 1 → 2 → 1`；Workspace iframe 首次加载及刷新恢复通过；Restart 由 UI 入队并由 Worker 完成，重启后 HTTP 200；浏览器安全错误为 0，Preview mutation requests 为 0。所交付 Runner 日志不含密码、Session Cookie、密钥或生成源码。
- 已核对并释放本轮三个不再被数据库 Project 引用的临时 E2B Sandbox。人工日志边界复核已于同一验收时间窗完成：Web deployment `6e255570-cd39-40eb-9db7-46752e072310`、Worker deployment `458337ba-fe97-499f-ad1b-5ae798c78106`、acceptance-runner deployment `8a4531dd-ec3d-4683-a651-ada84dcf0c75`；Web、Worker 与 E2B 日志均确认不含密码、Session Cookie、完整 Prompt、密钥或生成源码。至此 Step 6 的自动化记录、部署关联、日志边界与资源清理证据全部齐全，正式通过。

### Step 7：验收同一项目的增量修改 ✅ 已完成

1. 在 Step 5 的同一项目发送第二条 Prompt：`把页面标题改成 Focus Todo，并增加 All、Active、Completed 三个筛选按钮。`
2. 确认系统创建新的 Message 和 Run，而不是新建另一个 Project。
3. 确认 Coder 能读取现有文件和最近对话，只修改与需求相关的内容。
4. 确认原有添加、完成、恢复、删除和未完成数量功能没有回归。
5. 确认新增标题和三个筛选按钮在 Preview 中可见并可操作。
6. 确认第二次 Run 再次经过独立构建验证，并产生新的文件版本和 Snapshot。
7. 对比修改前后文件版本、Run ID 和 Preview 行为，保存脱敏证据。

验收标准：同一 Project 内至少一次增量修改成功，既保留原功能，又实现新需求；消息、文件版本、Run 和 Snapshot 均形成连续历史。

#### 完成总结

- 已新增 `pnpm test:incremental` 生产 Gate：使用固定首次 Todo Prompt 创建临时 Project，随后通过同一 Project 的 Messages API 发送本步骤指定的中文 Prompt；Gate 会拒绝 Project 变化、Message/Run ID 缺失或两个 Run ID 相同。
- Worker 的 `run.completed` 事件现记录成功持久化的 Snapshot ID，共享 SSE Schema 同步保留该字段；Gate 要求首次与增量 Run 的 Snapshot ID 均存在且不同，从 durable 事件直接证明 Snapshot 历史连续。
- Project File 持久化现通过内容 Hash 跳过无变化的 upsert，不再因 Run 最终枚举而给未修改文件制造虚假版本；Gate 在内存中比较前后内容 Hash，报告路径和版本但不输出 Hash 或源码，并要求修改文件版本前进、未修改文件版本保持不变。
- Chromium 增量验收会从同一 Workspace 恢复两条用户消息，并在更新后的真实 E2B Preview 中检查 `Focus Todo`、`All`、`Active`、`Completed`；随后真实执行空输入、添加两条、完成、Active/Completed/All 筛选、恢复、删除和未完成计数 `2 → 1 → 2 → 1`。
- Gate 同时要求 Coder 在第二次 Run 读取既有文件、只改变与本次 UI 需求相关的 `src/` 或 `index.html` 路径、再次完成独立依赖安装和 production build，并保持浏览器安全错误与 Preview 远程 Mutation Request 均为 0。
- 已新增 `docs/testing/incremental-production-acceptance.md`、6 条专项证据测试、Node 24/Chromium Railway Runner 入口和 Watch Pattern；完整 Release gate（测试、typecheck、lint、format、security scan、Web/Worker build）已在 commit `7e3f178` 通过，本次 GitHub Actions `32715188081` 亦成功。
- 正式公开生产验收记录生成于 `2026-08-24T10:21:25.663Z`：Project `eeaa4237-10f9-4acc-8162-ffad6bced797` 在首次 Run `d4ba6736-2fdf-415f-9616-0c1111d07e26` 后，以 Message `9a17aab5-11fe-475f-9703-6bec0515d378` 创建增量 Run `89c54b76-4cbf-45f8-a1b9-598af7d3cf33`；Snapshot 从 `2346d211-288f-41b9-bc98-4237324a11c6` 推进至 `365c2f66-ee58-41e9-aa59-a00d283f406c`。
- 增量 Run 仅改变 `index.html`、`src/App.test.tsx`、`src/App.tsx` 和 `src/styles.css`，9 个未修改文件保持原版本；独立安装与 build 均 exit 0，更新后的 HTTPS Preview HTTP 200，标题、三个筛选按钮与全部原 Todo 行为通过，Workspace 对话连续，浏览器安全错误和远程 Mutation Request 均为 0。
- Gate 在成功后自动删除临时 Project 与数据库/Snapshot 记录；随后只读核对确认两个本轮临时 Sandbox 均无 Project 引用，并已按精确 Sandbox ID 释放，不保留额外 E2B 运行成本。至此 Step 7 的代码、版本、消息、Run、Snapshot、Preview 行为与资源清理证据全部齐全，正式通过。

### Step 8：验收持久化、恢复与下载 ✅ 已完成

1. 在增量修改完成后刷新页面并重新登录，确认项目仍出现在 Dashboard。
2. 确认对话、计划、最终状态、文件树、文件内容、文件版本和 Preview URL 均能从服务端恢复。
3. 等待原 E2B Sandbox 过期后重新进入项目，触发从 Snapshot 和 Project Files 恢复新的 Sandbox。
4. 确认恢复后的 Preview 包含增量修改结果，而不是回退到首次生成版本。
5. 在 IDE 中做一次无害的可见文本修改并保存，确认 Runtime Job 完成且 Preview 更新。
6. 下载项目 ZIP，确认不包含 `.env`、密钥、`node_modules`、构建缓存或 Git 数据。
7. 在干净目录安装依赖并启动下载项目，确认最终 Todo 功能可以独立运行。
8. 核对 Supabase 中的 Project Files、最新 Snapshot 指针和 Run 终态，确认不存在丢失或孤立记录。

验收标准：跨刷新、重新登录和 Sandbox 过期后，最终项目状态仍可恢复；下载源码与线上最终版本一致并可独立运行。

#### 实现与当前验收状态

- 已实现完整的浏览器级生产 Gate，覆盖刷新、真实退出/重新登录、Dashboard 与 Workspace 服务端恢复、原 Sandbox 真实过期、Snapshot + Project Files 恢复到新 Sandbox、IDE 可见修改、Runtime Job、ZIP 精确比对以及干净目录独立安装/构建/测试/运行。
- 首次 Railway 执行已完成两个真实 Agent Runs、增量验收以及刷新和重新登录，但单个 Runner 在内存中等待完整 900 秒生产 TTL 时于最后 43 秒窗口内进入 `Crashed`；该次临时 Project 已由 `finally` 清理，没有可安全续跑的遗留 Project，且未取得恢复、编辑和下载终态证据，因此 Step 8 仍未通过。
- Gate 已改为同一 commit 的两次确定性部署：`prepare` 完成所有过期前检查，打印包含精确 Project/Run/Snapshot ID 与真实过期时间的脱敏 Checkpoint，保留且仅保留该临时 Project 后以成功状态退出；`resume` 强制要求该精确 Project ID，先验证 owner-scoped durable graph，再执行过期恢复及其余验收，不会重新创建或消耗 Agent Run。
- Railway `resume` 不再重复 120 秒部署稳定等待；本地 `pnpm test:persistence` 仍默认支持单进程 `full` Gate。恢复阶段新增边界日志，明确区分“已到达真实过期”“恢复完成”“IDE Runtime Job”和“干净下载验证”，避免下次失败只留下一个合并阶段名称。
- Checkpoint Runner commit `7135ab927c31c97507b6b3b6077011921eec2d32` 已在线完成 `prepare`：Project `8ff39ebf-4e1a-4140-8788-813b0bd8e2ab` 的两个 Runs 与两个 Snapshots 均为完整终态，13 个文件已保存，原 Sandbox 真实过期时间为 `2026-08-24T11:40:59.030Z`。随后的 `resume` 已执行恢复、IDE 同步、下载和干净项目验证，但最终证据校验发现重新登录后 Dashboard 的 Project 布尔值为 `false`，因此仍未签收；临时 Project 已按预期清理。
- 该布尔失败确认为 Gate 的渲染竞态：登录跳转刚到 `/projects` 即同步读取 `document.body`，早于服务端 Project 列表渲染；同一浏览器紧接着能够进入原 Project 并完整恢复 Workspace，证明并非认证或持久化丢失。Dashboard 验证现改为最长 30 秒显式等待精确 Project ID，并在过期恢复和昂贵的干净下载验证前立即失败；最终 Validator 同时新增可识别的断言消息与回归测试。
- 修复后的下一次 `prepare` 再次完成两个真实 Runs，并到达增量浏览器验证入口，但 Railway 只保留到 `7/10 Verifying versions...` 的最后日志后将进程标记为失败；数据库中临时 Project 已被 `finally` 删除，证明是可捕获错误而非绕过清理的 `SIGKILL`，但 Node 默认在 `finally` 之后输出未处理异常，终端错误尾部未被 Deploy Logs 保存，无法可靠区分 Chromium 启动和页面断言。
- Runner 现会在清理前输出长度受限且凭据脱敏的终端错误，并为 Chromium DevTools 启动提供两次确定性尝试及失败进程/Profile 清理。更重要的是，两个 Runs、Messages、Files、Plans、Snapshots 和 latest pointer 一经验证即先打印 Checkpoint 并启用精确 Project 保留，再进入任何 Chromium 检查；因此后续若仅浏览器失败，可用同一 Project 诊断或恢复，不再重复消耗两个生成 Runs。
- 新 Checkpoint `0c6c12f1-2990-4591-949f-f7fd383ef419` 成功保留两个 Runs 与两个 Snapshots，证实提前保留边界生效；`resume` 随后从新容器完成登录与过期 Sandbox 恢复，但恢复后的 Todo 浏览器交互报错 `Remaining count did not reach two`。两条新 Todo 均已渲染，失败来自计数文案的 DOM 换行：增量脚本只在单行内匹配数字和 `remaining/left` 标签，而首次 Preview 脚本已有跨空白归一化 fallback。该次 `resume` 仍使用旧清理语义，因此 Project 已删除，尚未取得最终签收记录。
- 两套 Todo 交互现共用同一可单元测试的计数匹配器，将换行和连续空白归一化后同时支持 `Remaining → 2` 与 `2 → items left`，并保留精确数字边界。Railway `prepare` 现在在 durable graph 后立即成功退出，不再在持有生成/SSE 状态的进程中启动 Chromium；`resume` 使用干净容器完成全部浏览器验证，且任何后续失败均保留精确 Checkpoint，只有完整最终记录通过才删除 Project。
- 最终生产验收由 Runner commit `779c8ea` 完成。Project `dbcb8091-b3cd-45c9-a5b8-e8005d8ae04e` 的首次 Run `20054157-0d86-467e-bf60-b3f32cc03396` 与增量 Run `6a7bd60f-212a-44ef-9c4a-d084ab1b1a1c` 均为带计划的 `completed`；Snapshot 从 `13452aae-0c9e-4074-ab55-9f4ae276d7b9` 推进至 `2596ab6e-fd16-4ce5-bda1-955d3101dfe0`，latest pointer 有效，原 Sandbox 在 `2026-08-24T13:33:29.948Z` 真实过期后恢复到不同 Sandbox。
- 最终 `Persistence, Recovery, and Download Production Acceptance Record` 已证明页面刷新与专用账号真实退出/重新登录后，Dashboard、对话、计划、Running 终态、文件树、非空源码、文件版本和 Preview URL 全部恢复；恢复后的 Preview 保留 Focus Todo 标题、All/Active/Completed 筛选与原 Todo 行为。IDE 对 `src/styles.css` 的可见修改通过 `sync_file` Runtime Job 完成并更新 Preview，浏览器安全错误与远程 Mutation Request 均为 0。
- 下载 ZIP 与最终服务端全部 Project Files 精确一致，不含 `.env`、`node_modules`、`dist`、缓存、coverage 或 Git 数据；在全新临时目录中的 `npm install`、production build、tests、独立 Vite server 和 Chromium Todo 交互全部通过。最终 Validator 同时确认 Messages、Runs、Project Files、Snapshots、latest pointer 与 Runtime Jobs 无缺失引用或活动孤儿状态，Runner 输出 `Persistence, recovery, and download production acceptance passed.`。
- Runner 随后自动删除临时 Project；特权只读复核确认 Project、Runs、Messages、Snapshots、Project Files 和 Runtime Jobs 均为 0 条残留。按精确 Project/Run 前缀识别并删除两个已无数据库引用的私有 Snapshot ZIP（93,415 与 95,966 bytes）后，该 Storage prefix 为空；E2B Sandbox 继续受真实 TTL 自动释放。至此 Step 8 的跨会话持久化、过期恢复、IDE 同步、下载独立运行、引用一致性与资源清理证据全部齐全，正式通过。

### Step 9：执行自动化生产 Smoke 与故障场景 ✅ 已完成

1. 使用专用测试账号对公开 URL 执行已有生产 smoke 流程，并保存完整结果。
2. 覆盖 SSE 断线重连，确认事件可以从 `Last-Event-ID` 恢复且不重复。
3. 在一次可丢弃 Run 中测试取消，确认进入 `RUN_CANCELLED`，Worker 不继续写文件。
4. 验证模型 token、轮次、工具调用和总时长达到限制时均进入明确终态，不被误报为其他错误。
5. 验证构建命令非零退出时保留 exit code 和 stderr，并显示 `BUILD_FAILED`，而不是 `INTERNAL_ERROR`。
6. 使用第二个测试账号验证跨用户 Project、Files、Download、Events 和 Runtime Job 均不可访问。
7. 检查是否存在永久 Queued Run、失去 heartbeat 的 Worker Job、未释放 Sandbox 或无引用 Snapshot。
8. 测试结束后清理自动化创建的临时项目和资源。

验收标准：自动化生产 smoke 全部通过；关键失败路径有正确终态、错误分类和恢复操作；不存在越权访问或残留运行资源。

#### 完成总结

- 已新增 `pnpm test:production-smoke` 公开生产 Gate，并将脱敏证据 Validator 接入根级 `pnpm test` 和一次性 Railway Runner；真实 Todo 生成继续复用 Step 5 的严格事件、文件、独立安装/build、HTTPS Preview 与完成摘要校验，不以模拟结果代替生产调用。
- SSE Gate 会在首个 durable event 后主动断开并使用 `Last-Event-ID` 恢复，同时能继续处理 Railway 的额外传输中断；最终记录要求 event ID 严格递增且不重复。本轮成功 Run 跨强制重连收到 71 个唯一事件。
- 取消验收只在 Worker 已发布 `run.planning` 后发起。数据库 Run 与 `run.cancelled` 事件现均持久化 `RUN_CANCELLED`；Gate 在终态后再次等待并比较文件路径/版本，要求不再写文件且不得产生 Snapshot。
- Gate 会创建一次性第二 Firebase 账号，对 Project 页面、Files、File Content、Download、Persistence、Messages、Events、Cancel、Preview Restart、Runtime Job 和 Delete 共 11 个边界执行越权请求；API 必须返回 404，Next.js 流式 not-found 页面只在正文明确为 404 且不含 Project 数据时归一化为拒绝。相同 signed-out 请求必须返回 401 或认证跳转，测试后立即删除第二账号。
- token、轮次、工具调用、Coder 时长、Run 总时长和 build 非零退出采用确定性 Release-gate 故障测试：token/turn/tool-call 均签收为 `AI_LIMIT`，Coder/Run duration 均签收为 `RUN_TIMEOUT`，build 保留真实 exit code 与 stderr 并签收为 `BUILD_FAILED`，不会依赖模型是否恰好触发限制。
- 修复了删除 Project 只级联数据库、却遗留 E2B Sandbox 和私有 Snapshot ZIP 的资源泄漏：Web 现只创建不含服务凭据的 durable cleanup job，Worker 使用 E2B/Supabase 凭据删除精确 Sandbox 与 Snapshot keys；删除 API 返回可轮询 cleanup job，活跃 Run/Runtime Job 时拒绝删除，Runner 成功和异常 `finally` 都会取消、重试删除并等待 cleanup 完成。
- 已新增受信维护机的只读 `pnpm test:production-resources`：将数据库及进行中 cleanup 引用与私有 Storage/E2B 账户交叉比对，只输出数量。显式维护模式清理了此前旧版本验收遗留的 28 个无引用 Snapshot ZIP；随后只读复核为 stale Runs 0、stale Runtime Jobs 0、stale cleanup jobs 0、Snapshot objects 0、active E2B Sandboxes 0。
- 目标 Web/Worker commit `6af8d03b1ac6d9ec3de18e7a6f50467d48f92754` 的 GitHub Actions Run `32736663205` 成功，公开 URL 健康且数据库为 `ok`。最终 `Automated Production Smoke and Fault Acceptance Record` 生成于 `2026-08-24T14:32:02.825Z`：完成 Project `3b5cdde5-1c99-4608-948d-c5d8f5871a38` / Run `6051bc84-7b85-4a84-af72-5882b3dc2cda` 保存 13 个文件、Preview HTTP 200、ZIP 92,346 bytes；取消 Project `f36ed46c-a0c2-4d45-9be3-1ec1162e23b9` / Run `6b52b9e3-288b-42dd-a565-a651ec7a2774` 正确进入 `RUN_CANCELLED`。
- 两个最终验收 Project 的 durable cleanup jobs 均完成，Dashboard 不再包含其 ID，第二测试账号已删除；最终全局资源复核时间为 `2026-08-24T14:32:33.915Z`。Runner 的额外断线恢复、失败清理和数量化资源审计固化于 commit `5d580de`，至此 Step 9 的生产 Smoke、关键故障分类、越权隔离和资源清理证据全部齐全，正式通过。

### Step 10：整理证据并完成反馈签收 ✅ 已完成

1. 汇总公开 URL、GitHub URL、commit SHA、Web/Worker deployment ID 和验收时间。
2. 提供专用测试账号的安全交付说明，不在报告中写出密码。
3. 提供服务端模型 ID、非敏感 Agent 限制、OpenAI 预算确认和 E2B 额度确认。
4. 提供首次生成、增量修改、Preview、持久化恢复、下载和自动化 smoke 的结果。
5. 为每个失败或未通过项目记录负责人、修复范围、重新验收步骤和阻塞状态。
6. 只有 Step 1–9 全部通过后，才将本反馈状态标记为 `✅ 已完成`。
7. 将最终验收摘要加入交付文档，并保留下一次部署可重复使用的测试账号与检查清单。

验收标准：评审人员无需本地环境即可使用公开 URL 和专用账号复现完整流程；所有反馈项都有明确证据，不再使用“代码已实现”代替“线上已验收”。

#### 完成总结

- 已新增 `docs/testing/final-production-acceptance.md`，将 Step 1–9 的脱敏线上记录合并为单一签收材料，包含公开 URL、GitHub repository、生产 commit、Release gate、Web/Worker deployment ID、验收时间、健康状态、测试账号安全交付、模型与 Sandbox 非敏感配置。
- 最终生产基线于 `2026-08-24T14:55:04.483Z` 重新验证：公开首页、登录页和 `/api/health` 均为 HTTP 200，数据库为 `ok`；生产 commit `c2368c08732283117c322d57a000749b69934854` 的 GitHub Actions `32739541925` 成功，Web deployment 为 `b75be1a8-ce6b-4de6-b89e-26c14a90f3bf`，Worker deployment 为 `86b6f5b3-e9e4-46d5-bd81-78632bbef921`。
- 汇总记录明确关联首次生成、Preview、增量修改、持久化/过期恢复/IDE 同步/下载和自动化 Smoke 的 Project、Run、Snapshot、Runtime Job、时间及最终结果；临时资源已清理，但 ID 保留用于与 Railway 脱敏日志关联。
- 已将历次未通过项按负责组件、修复范围、重新验收步骤和最终状态整理为闭环表；E2B 502/Node 兼容、Restart 恢复、Railway 长时验收、DOM 竞态、删除资源泄漏和 Smoke 重连/清理均为 `Resolved`，当前无失败、ownerless 或 blocked 项。
- README 已公布生产 URL 并链接最终签收材料。最终文档同时提供只使用公开 URL 和专用账号即可执行的浏览器复现步骤，以及下一次部署必须重新生成 commit-matched 证据、不得复用本轮 ID 的检查清单。
- 报告不包含密码、Cookie、API Key、完整 Prompt 日志、生成源码、Sandbox ID 或私有 Snapshot key；测试账号密码继续只通过密码管理器或一次性加密链接交付。至此十项最终完成标准全部满足，本轮反馈正式签收。

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
