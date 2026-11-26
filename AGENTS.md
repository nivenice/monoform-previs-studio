# AGENTS.md

给在本仓库里工作的编码 agent 的说明书。内容以当前代码为准；改动行为后请顺手更新这里。

## 项目定位

MONOFORM · AGENT 是一个以 Electron 桌面应用为主、同时保留浏览器构建的三维白模预演工作台：搭建白模场景、摆放带骨骼人物、管理多个独立镜头、制作人物与摄像机关键帧，并导出 PNG、MP4 或 `.monoform.json` 工程。可选的本机 AI 服务（Node + TypeScript）负责把参考图/文字转成可编辑的白模场景、姿势和物体，但它永远不是成片流程的必需组件。桌面版会自动启动该服务；浏览器版可通过独立的 `npm run server` 使用同一套服务。

技术栈：React 19 + Three.js 0.170 + React Three Fiber/drei + Vite 8 + Electron 40 + electron-vite 6（`"type": "module"`）。Electron 主进程、preload 与 `server/` 使用 TypeScript；`src/` 渲染层仍是 JS/JSX（没有 ESLint、Prettier 配置，也没有状态管理库）。本地 Node 版本要求 `>=22.13.0`（会话 SQLite 使用内置 `node:sqlite`；Vite 8 / electron-vite 6 的下限更低）；构建/运行不依赖任何后端（AI 服务除外，且可选）。

## 常用命令

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 开发桌面版 | `npm run dev` | electron-vite，打开 Electron 窗口；渲染层 HMR |
| 开发浏览器版 | `npm run dev:web` | Vite，`127.0.0.1:5173`；`/api` 代理到 `127.0.0.1:8891` |
| 构建桌面版 | `npm run build` | 先 `typecheck`，产物在 `out/`（已 gitignore） |
| 预览桌面产物 | `npm run start` | `electron-vite preview`，走生产 `app://` 加载 |
| 打包 Windows | `npm run dist:win` | electron-builder，产物在 `release/` |
| 构建浏览器版 | `npm run build:web` | 产物在 `dist/`（GitHub Pages 使用） |
| 预览浏览器产物 | `npm run preview:web` | `127.0.0.1`，`/api` 代理到 8891 |
| 单元测试 | `npm test` | `node --test`（渲染层纯逻辑）+ `tsx --test`（服务端） |
| 单跑渲染层测试 | `npm run test:node` | Node 自动发现 `tests/*.test.mjs`；不要传目录参数 |
| 单跑服务端测试 | `npm run test:server` | `tests/server/*.spec.ts` |
| 类型检查 | `npm run typecheck` | `tsc -p tsconfig.node.json --noEmit` |
| 重建骨骼动画 | `npm run build:animations` | 用 `scripts/assets/` 里的固定源文件重写 `public/models/xbot-animated.glb` |
| 独立 AI 服务 | `npm run server` | `127.0.0.1:8891`，可选；同时托管 `dist/` |

依赖安装遵循锁文件 `package-lock.json`（`npm ci`）。仓库根目录的 `.npmrc` 将 registry 指向 npmmirror（淘宝源）。npm 11 会在 `package.json` 的 `allowScripts` 中记录已批准的安装脚本（当前为 electron / electron-winstaller / esbuild）；pnpm 11 则在 `pnpm-workspace.yaml` 的 `allowBuilds` 中放行同一组包；升级这些包后需同步更新两处。`pnpm-workspace.yaml` 还将 app-builder-lib 的 `@electron/get` 覆盖为 `3.1.0`：electron-builder 26.18 需要该版本的 `ElectronDownloadCacheMode`，3.0.0 会导致打包时报 `ReadWrite` 未定义。README 面向用户，`docs/USER_GUIDE.md` 是操作手册。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `electron/main/index.ts` | Electron 生命周期、单实例、启动本机 AI 服务、创建窗口、下载/权限策略 |
| `electron/main/app-protocol.ts` | 生产环境的 `app://monoform/...` 协议：托管 `out/renderer`、MIME、CSP、路径穿越防护 |
| `electron/main/window.ts` | BrowserWindow、preload、运行时参数注入、自定义标题栏（原生 caption 按钮深色 overlay）、导航与 DevTools 限制 |
| `electron/preload/index.ts` | 通过 `contextBridge` 只暴露 `window.monoform`（api base/token/error/platform） |
| `server/index.ts` | `createAiService`：配置、模型调用、场景校验、agent 服务的统一入口 |
| `server/http.ts` | Node HTTP 服务：路由、CORS、token、multipart、静态文件、SSE 委派（独立服务用） |
| `server/http-body.ts` | 共享 HTTP body 读取、`HttpError` 与错误/截断工具 |
| `server/agent/store.ts` | 会话/消息/附件 SQLite（`node:sqlite`，WAL、级联删除、schema v1） |
| `server/agent/service.ts` | agent 配置、模型列表、turn/SSE、场景工具、骨骼动画师 turn、并发与 abort |
| `server/agent/upstream.ts` | 兼容 OpenAI 的流式 `chat/completions` 与 tool_calls 聚合（可传不同 tools） |
| `server/agent/routes.ts` | `/api/agent/*` 路由、SSE 写事件、multipart 附件、骨骼动画师 SSE |
| `server/agent/prompt.ts` / `types.ts` | 主 agent system prompt、7 个工具（`scene_to_white_model` + 5 个场景编辑工具 + `delegate_character_pose`）的 OpenAI schema、共享类型 |
| `server/agent/rigPrompt.ts` | 骨骼动画师 subagent 的 system prompt、3 个骨骼工具 schema、真实骨架轴向表 |
| `server/agent/specialist.ts` | 骨骼动画师请求输入校验、history 配对校验、轮数上限 |
| `server/config.ts` | key 文件 / `model-config.local.json` / userData 配置读写；chat 与 vision 两套键 |
| `server/scene.ts` | 场景规范化、结构校验、几何修复与 evidence 审计（纯逻辑） |
| `server/upstream.ts` | 兼容 OpenAI 的模型调用、重试、超时与 JSON 解析 |
| `server/prompts/` | 场景提示词原文与 `skills/*.json` 的姿势/物体提示词加载 |
| `server/standalone.ts` | 浏览器版独立服务入口（`npm run server`）；会话 DB 在 `.monoform-runtime/agent.db` |
| `src/App.jsx` | 约 2900 行。全部应用状态、面板、时间轴、镜头管理、撤销/自动保存、PNG/MP4/JSON 导出。应用层都在这里 |
| `src/Viewport.jsx` | 约 1250 行。全部 Three.js 场景；导出 `MainViewport`、`CameraPreview`。人物白模与骨骼、IK、几何体、光照、路线预览；标准人物走 Mixamo GLB，极简模型走 `MinimalPersonModel` |
| `src/MinimalPersonModel.jsx` | 极简模型渲染：圆柱身体、球头、正面球面片与 `CanvasTexture` 面部文字（不加载 Mixamo GLB） |
| `src/minimalPerson.js` | 纯函数：极简模型尺寸、面部文字归一化（1–5 字）与字号自适应 |
| `src/cameraMotion.js` | 纯函数：跟随镜头、景别预设、朝向求解 |
| `src/transformValues.js` | 纯函数：变换轴锁定归一化、锁定感知归零/复位、相机帧锁定合并、数值格式化/解析/步进 |
| `src/previsMotion.js` | 纯函数：地面路线 → 弧长重采样的角色关键帧 |
| `src/routeOwnership.js` | 纯函数：路线关键帧与手工关键帧的所有权判定与合并 |
| `src/sceneToMonoform.js` | 纯函数：AI 场景 Z-up → MONOFORM Y-up 的物体/相机转换 |
| `src/api.js` | 渲染层 API 传输：Electron 用 preload 注入的绝对地址+token，浏览器版回退相对 `/api` |
| `src/apiClient.js` | 渲染层 JSON 请求/超时/中文网络错误归一化 |
| `src/AgentPanel.jsx` | 右侧 AI 助手：会话历史、流式消息、工具卡片、骨骼动画师子步骤、附件输入 |
| `src/AgentConfigDialog.jsx` | 对话/识图两套模型配置弹窗（供应商预设、拉取模型、密钥不回显） |
| `src/agentApi.js` | 会话/附件/配置/turn SSE/场景工具/骨骼动画师 SSE 的渲染层 API |
| `src/agentSse.js` | 纯函数 SSE 解析与 fetch 流读取 |
| `src/agentContext.js` | 纯函数：当前工程 → 紧凑场景摘要（最多 40 个对象，含关键帧帧号与动作） |
| `src/agentTools.js` | 主 agent 工具注册表与执行器：`scene_to_white_model` + 5 个场景编辑工具 + `delegate_character_pose`、结果截断 |
| `src/agentSceneCommands.js` | 纯函数：`get_scene_info` / `transform_objects` / `set_pose` / `manage_keyframes` / `set_timeline` 的参数校验与状态补丁 |
| `src/personBodyType.js` | 纯函数：人物体型归一化（标准人物 / 极简模型）与旧体型兼容 |
| `src/rigAgentContext.js` | 纯函数：标准人物 → 骨骼动画师可读的紧凑 rig 上下文（目标、轨道、预设、骨骼层级、帧范围） |
| `src/rigAgentCommands.js` | 纯函数：骨骼动画师的 3 个命令（读取状态、改基础关节、写姿态关键帧）与范围/字段/路线/锁定校验 |
| `src/rigAgentTools.js` | 骨骼动画师工具注册表与执行器，结果截断到 6500 字符 |
| `src/rigSubagent.js` | 渲染层驱动的骨骼动画师循环（最多 5 轮）、进度事件、摘要与 abort |
| `src/keyframeOps.js` | 纯函数：关键帧创建与求值（`objectAtFrame`、`resolveCameraAtFrame`、插值/姿势兼容规则） |
| `src/rig.js` | mixamorig 骨骼定义与父子关系、动作预设（含 `aim_pistol`）、姿势克隆/插值 |
| `src/ShotsPanel.jsx` | 镜头列表 UI（纯展示，状态由 App 传入） |
| `src/styles.css` | 全局样式；深色主题色值集中在 `:root` 变量 |
| `tests/*.test.mjs` | 渲染层纯逻辑测试（`node:test`），含 `agentSse` / `agentContext` / `agentTools` / `agentSceneCommands` / `rigAgent*` / `rigSubagent` / `personBodyType` / `keyframeOps` |
| `tests/server/*.spec.ts` | 服务端配置/场景/HTTP/上游/agent SQLite/agent turn/骨骼动画师测试（`tsx --test`） |
| `scripts/` | 动画烘焙脚本；`scripts/assets/` 存固定版本的源资产 |
| `scripts/pose/author-aim-pose.mjs` | 用真实骨架解算 `aim_pistol` 姿势的骨骼增量（改姿势后重跑并更新 `rig.js`） |
| `scripts/pose/rig-axis-guide.mjs` | 用真实骨架在 idle@0.08 下探测各骨骼局部轴方向，生成 `rigPrompt.ts` 的轴向表 |
| `scripts/verify/agent-shot.mjs` | 手动端到端验收：在真实界面里跑交付提示词、导出工程与关键帧截图（需要本机模型 key） |
| `public/` | 运行时静态资源（模型、品牌图），必须经 `import.meta.env.BASE_URL` 引用 |
| `electron.vite.config.ts` | 主进程/preload/渲染层三段构建配置；渲染层源码仍在仓库根 `src/` |
| `electron-builder.yml` | Windows NSIS 安装包配置 |
| `downloads/` | 提交到仓库的 Windows 安装包与 `SHA256SUMS.txt`；README 直接下载入口 |
| `pnpm-workspace.yaml` | pnpm `allowBuilds` 白名单与 `@electron/get` override |
| `.npmrc` | npm registry 指向 npmmirror（淘宝源） |
| `.github/workflows/deploy-pages.yml` | push 到 `master` 时 `npm ci` + `typecheck` + `test` + `npm run build:web` → GitHub Pages |
| `docs/` | 用户手册与界面截图 |

## 改代码前必须守住的不变量

1. **状态只有一个来源。** `App.jsx` 用 `useState` 存工程状态，用 `useMemo` 在渲染期派生当前帧的物体/摄像机/导出尺寸。不要引入 Redux/Zustand/Context 之类的第二层状态，也不要另写一套动画求值路径。
2. **纯逻辑要能单测。** 任何可脱离 React 的几何、插值、时间轴、转换逻辑，抽成独立 `.js` 模块（不含 JSX）并在 `tests/` 加 `node:test` 用例。测试无法 import JSX，所以逻辑留在组件里就等于不可测。
3. **资源路径永远走 `BASE_URL`。** Vite 配置是 `base: './'`，站点部署在 GitHub Pages 子路径下；写死 `/models/...`、`/branding/...` 会在子路径部署时 404。现有写法见 `BUILT_IN_MODEL_URL`、`BRAND_MARK_URL`。
4. **工程 schema 只增不破。** `PROJECT_VERSION` 当前是 16。新增/改动字段时，同步更新 `normalizeProjectData` 与各 `normalize*` 函数，并保证改动前导出的 `.monoform.json` 仍能打开（README 明确承诺旧版工程可直接打开）。历史别名要保留：`characterKeyframes` ↔ `objectKeyframes`、`stageframe-project` → `monoform-project`。人物体型只有 `standard` / `minimal`；旧 `tall` / `broad` / `female` / `male` 在 `normalizePerson` 中归一化为 `standard`，**不要为此升 `PROJECT_VERSION`**：升版会让旧版 5 秒工程被 `migrateLegacyDefaultDuration` 误迁移到 15 秒。
5. **localStorage 键名是用户数据的地址。** `monoform-project`、`monoform-custom-poses`；带 `?key=` 嵌入时在键后加后缀（多实例隔离）。改前缀等于让所有用户的本地工程消失。
6. **多镜头语义要保住。** 每个镜头完整保存 objects/camera/lighting/reference/keyframes/objectKeyframes/routeTracks 与自己的 fps、时长、循环；切换镜头前先用 `liveShotRecord` 落盘当前状态并更新缩略图；上限 30 个镜头；“新建镜头”复制布局但清空关键帧与参考图，“复制镜头”全量复制。这些行为直接对应用户手册里的描述。
7. **预览 = 导出。** PNG/MP4 必须与右下监视器同源：同一帧求值、同一画幅、同一 fps。导出尺寸走 `exportDimensionsForAspect`（宽高取偶数）；MP4 用 `mediabunny` 动态 `import()`，不要静态引入进主包。
8. **路线关键帧有所有权。** 地面路线烘焙出的关键帧与手工关键帧分开管理（`routeOwnership.js`）；重新烘焙或清除路线时不能吃掉手工关键帧。
9. **骨骼 id 必须稳定。** 工程 JSON、自定义姿势、AI 姿势、骨骼动画师子代理都存 `mixamorig*` 骨骼 id；重命名或调整层级会让所有旧工程与姿势库失效。`RIG_BONE_PARENTS` 必须覆盖 `JOINT_DEFINITIONS` 的每根骨骼。
10. **边界值写死在这些范围：** fps ∈ {24, 25, 30}，镜头时长 1–60 秒，焦距 18–120 mm，撤销 50 步（280 ms 合并），自动保存 900 ms 防抖。缩短时长前必须先检查关键帧是否放得下，放不下就拒绝并提示，不能静默删除动画。
11. **AI 结果必须可审计。** 服务端会校验相机与结构 evidence，不合格时保持原工程不变。不要为了“能导入”而放宽或删掉这层校验。
12. **聊天状态不在工程里。** 会话、消息、图片附件只由本地 AI 服务的 SQLite 持久化；`App.jsx` 不把聊天写进工程 JSON 或 localStorage。会话历史全局共享，场景摘要每轮由 `src/agentContext.js` 注入。
13. **agent 工具是白名单。** 主 agent 工具名以 `server/agent/prompt.ts` 的 `AGENT_TOOLS` 为准，渲染层 `src/agentTools.js` 只注册这些名字：`scene_to_white_model`、`get_scene_info`、`transform_objects`、`set_pose`、`delegate_character_pose`、`manage_keyframes`、`set_timeline`。参数校验与补丁计算放在纯函数 `src/agentSceneCommands.js`，App 通过 `agentSceneToolkit` 的 `snapshot()` / `applyScenePatch()` 用正常 setState 落盘，保持可撤销、可自动保存；同一轮多次工具调用靠同步更新的快照看到前一次结果。`delegate_character_pose` 只能作用于标准人物，由渲染层 `src/rigSubagent.js` 调 `/api/agent/specialist/turn` 驱动子代理；子代理只注册 `server/agent/rigPrompt.ts` 的 `RIG_AGENT_TOOLS`：`get_character_state`、`set_character_joints`、`write_pose_keyframes`，由 `src/rigAgentCommands.js` 校验，只能改目标人物的关节/姿态关键帧，不能改位置、朝向、镜头或时间轴。子代理请求是**无状态**的，中间消息不写入 SQLite，只有主 agent 的委派工具调用与结果进入会话历史。不要给模型任意属性写入、删除对象、shell 或文件能力；锁定对象/轴、路线驱动的关键帧必须拒绝或跳过。
14. **密钥永不回显。** `/api/agent/config` 只返回 `apiKeyConfigured` 布尔值；更换 baseUrl/provider 时必须重新填写 key，避免把旧 key 发到新域名。工具与 turn 的请求/日志里不打印密钥。

## 代码风格

- 渲染层沿用纯 JS + JSX；`electron/`、`server/` 用 TypeScript。两者都**不写行尾分号**、字符串用单引号、2 空格缩进；小组件与工具函数用 `const f = (...) => ...`，顶层组件用 `function Name()`。
- `App.jsx` / `Viewport.jsx` 的密集单行 JSX 是刻意保留的现状。只改必要的行，不要整文件格式化，否则 diff 不可读、review 无从下手。
- 面向用户的文案、报错、toast 用中文；与用户沟通、文档也用中文。注释解释“为什么”，不写“做了什么”。
- 图标统一 `lucide-react`；样式写进 `styles.css` 并复用 `--accent`、`--panel` 等现有变量，不要另起配色体系。
- 不轻易新增运行时依赖；测试只用 `node:test` + `node:assert/strict`，不引入测试框架。服务端测试用 `.spec.ts` 命名并由 `tsx --test` 显式运行，避免 Node 24 自动发现 `.test.ts` 时重复执行。

## 可选 AI 服务

- 桌面版由 Electron 主进程自动启动 AI 服务，只绑定 `127.0.0.1` 的随机端口，并生成随机 Bearer token；渲染层通过 preload 注入的 base URL + token 访问。浏览器版用 `npm run server` 启动独立服务，默认 `127.0.0.1:8891`。
- 独立服务仍可托管 `dist/`，保留“没有 Vite dev server 时直接打开 8891”的旧工作流；Electron 不使用该静态托管。
- 配置来源：开发/`electron-vite preview` 用 `server/model-config.local.json`（已 gitignore）；打包后用 `app.getPath('userData')/model-config.json`；`MONOFORM_MODEL_CONFIG_FILE` 可覆盖。key 文件由 `MONOFORM_MODEL_KEY_FILE` 指定（默认 `F:\hermes-sceneTo 3d\model-key.txt`）。会话 DB 由 `MONOFORM_AGENT_DB_FILE` 覆盖；桌面版默认 `app.getPath('userData')/agent.db`，独立服务默认 `.monoform-runtime/agent.db`。密钥只允许存在这些本机文件，绝不写进源码、工程 JSON、截图、日志或提交。
- 配置键：识图沿用 `base-url` / `api-key` / `model`（兼容旧 key 文件）；对话模型用 `chat-base-url` / `chat-api-key` / `chat-model`；供应商展示用 `provider` / `chat-provider`。识图配置不完整时整体回退到对话配置（要求对话模型支持图片）。
- 接口：`GET /api/health`、`/api/model-config`、`/api/models`；`POST /api/model-config`、`/api/generate-scene`、`/api/generate-pose`、`/api/generate-object`。`/api/health` 不需要 token；其余在 token 模式下要求 `Authorization: Bearer ...`。
- Agent 接口（`server/agent/routes.ts`）：`GET/POST /api/agent/config`、`POST /api/agent/models`、`GET/POST /api/agent/conversations`、`GET/DELETE /api/agent/conversations/:id`、`POST /api/agent/conversations/:id/attachments`、`GET /api/agent/attachments/:id`、`POST /api/agent/turn`（SSE）、`POST /api/agent/scene-to-white-model`、`POST /api/agent/specialist/turn`（SSE）。turn 事件为 `conversation`/`delta`/`message`/`error`/`done`；一次请求只做一轮 LLM 调用，工具循环由渲染层驱动（最多 8 轮工具结果，服务端 `MAX_TOOL_ROUNDS` 同步限制；单条工具结果截断到 8000 字符）。`specialist/turn` 是无状态的骨骼动画师端点，事件为 `delta`/`message`/`error`/`done`，请求带 `context` / `brief` / `history`，最多 5 轮工具调用；它复用对话模型，不新增模型配置，中间消息不写 SQLite。
- 骨骼动画师由主 agent 的 `delegate_character_pose` 触发；只有 `bodyType === 'standard'` 的目标可用，极简模型、锁定人物、路线驱动关键帧会被拒绝。子代理只改目标人物的关节与姿态关键帧，最终摘要作为主工具结果返回。
- 会话 SQLite 使用 `process.getBuiltinModule('node:sqlite')` 动态取模块；Node < 22.13 或 DB 打开失败时只禁用聊天（503 中文错误），`/api/health`、场景生成、编辑/导出不受影响。DB 为 schema v1，删除会话级联删除消息与附件。
- 场景工具端点只返回原始 scene；渲染层用 `sceneToMonoform` 映射并写入 App 状态，保持现有“追加、可撤销、可自动保存”的语义。
- 错误以中文 `{"error": ...}` 返回给 UI，最多截断 2000 字符；只对 5xx 与网络错误重试，4xx 立即抛出。multipart 上传上限 25 MB（图片 20 MB），配置 JSON 8 KB；agent turn 256 KB。
- 场景提示词固定在 `server/prompts/perspective.ts`；姿势/物体提示词从仓库根目录的 `skills/*.json` 读取——该目录未纳入版本控制、默认不存在，此时返回空字符串属正常现象，不要因此报错或把它加进提交。
- 没有模型密钥、没有网络时，普通编辑、动画、导出必须照常可用——这是硬性要求。AI 服务启动失败时桌面窗口仍要打开，AI 面板给出中文错误。

## 验证清单

按改动影响面执行：

1. `npm test`——渲染层 `tests/*.test.mjs` 与服务端 `tests/server/*.spec.ts` 必须全绿。
2. `npm run typecheck`——Electron 主进程、preload、server 与 TS 测试必须无类型错误。
3. `npm run build`——确认 `out/main/index.js`、`out/preload/index.cjs`、`out/renderer/index.html` 产出；`npm run build:web` 确认 `dist/` 仍可部署。
4. `npm run dev` 或 `npm run start` 后手动走一遍：加人物/摆姿、镜头切换、关键帧记录与播放、PNG、MP4、打开与导出工程；重启应用确认自动恢复。生产模式要确认 `app://` 下内置 GLB、品牌图和 `mediabunny` 动态 chunk 都能加载。
5. 改了工程结构时，用**改动前**导出的 `.monoform.json` 打开一次，确认旧工程仍可用；本次还要用带 `bodyType: "female" / "tall"` 的旧工程确认会自动变成标准人物且动作/关键帧保留。
6. 改了 AI 相关代码时，在无密钥 / 断网环境下确认编辑器功能不受影响；有密钥时确认 CORS 预检、token、multipart 上传、SSE 流式与工具调用正常。Agent 的关键手测：AI 助手 tab → 配置对话模型 → 附场景图 → 说“转白模” → 工具卡片完成、场景新增体块、原图对照出现 → 撤销可恢复 → 重启后历史/消息仍在 → 历史删除二次确认后 SQLite 级联清理。场景工具的手测：`npm run test:node` 里的 `agentShotRecipe` 覆盖 5 秒侧方转身举枪配方；再跑一次真实提示词验收——“场景内包含一个人物模型，镜头在她的侧方，他突然转身举枪对着镜头，帮我完成 5 秒的镜头”，确认 `set_timeline` → `manage_keyframes` → `get_scene_info` 工具卡片依次完成、时间轴变成 5 秒 / 120 帧、人物与镜头两条轨道都有关键帧、播放能看出转身与举枪，并可用 `npx electron scripts/verify/agent-shot.mjs`（先 `npm run build:web` + `npm run server`）自动导出工程与截图。骨骼动画师手测：选中标准人物 → 说“让主角在 1 秒内抬起右手挥两下，再放下” → 出现「骨骼动画师」卡片与子步骤 → 播放可见挥手、人物朝向/镜头未被改动 → `Ctrl+Z` 可撤销；再对极简模型说同样的话，确认不会委派并给出中文说明。
7. 改了打包配置时运行 `npm run dist:win`，安装后启动确认加载与下载对话框正常。
8. 如果 Electron 报 `does not provide an export named 'BrowserWindow'`，通常是终端设置了 `ELECTRON_RUN_AS_NODE`；清除该变量后再启动。

若本机沙箱禁止写 `node_modules`，Vite 会在 `node_modules/.vite-temp` 报 `EPERM`；这是环境限制而非仓库问题，可用 `npx vite build --configLoader runner` 验证构建是否通过。

## 发布与仓库状态

- 发布分支是 `master`（由 `main` 合并 `develop` 后建立）；上线 = 合入 `master` 并 push，Actions 构建后发布到 GitHub Pages。日常开发常在 `develop`，不要直接向 `master` 强推。
- `package-lock.json` 是 CI 使用的锁文件；`pnpm-lock.yaml` 已随 `develop` 进入仓库，但 CI 仍以 npm 锁文件为准。改动依赖时两个锁文件都要更新（`npm install` + `pnpm install --lockfile-only`）。
- 本机 Node 要求 `>=22.13.0`（`node:sqlite` 自该版本起无需实验 flag）；Electron 40 自带 Node 24，桌面端不受影响。Electron 40 保持现状，不要为了 Node 20 兼容性升级/降级运行时。
- 本仓库 `origin` 指向 `nivenice/monoform-previs-studio`，`upstream` 是原作者仓库 `GuiYi-Xi/monoform-previs-studio`；README 开头保留了原仓库地址说明。
- 替换模型资产时，同步更新 `public/models/ANIMATION_SOURCES.md` 的出处与许可证，并保留 `scripts/assets/` 里的固定源文件，保证可离线重建。

## 相关文档

- `README.md`：产品定位、功能清单与用户向的使用流程。
- `docs/USER_GUIDE.md`：逐面板的操作手册，改 UI 行为时要与之对齐。
- `public/models/ANIMATION_SOURCES.md`：动画资产来源与许可证。
