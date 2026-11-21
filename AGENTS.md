# AGENTS.md

给在本仓库里工作的编码 agent 的说明书。内容以当前代码为准；改动行为后请顺手更新这里。

## 项目定位

MONOFORM（素形）是一个纯浏览器端的三维白模预演工作台：搭建白模场景、摆放带骨骼人物、管理多个独立镜头、制作人物与摄像机关键帧，并导出 PNG、MP4 或 `.monoform.json` 工程。可选的本机 Python 服务负责把参考图/文字转成可编辑的白模场景、姿势和物体，但它永远不是成片流程的必需组件。

技术栈：React 19 + Three.js 0.170 + React Three Fiber/drei + Vite 8（`"type": "module"`）。没有 TypeScript、ESLint、Prettier 配置，也没有状态管理库；构建/运行不依赖任何后端（AI 服务除外，且可选）。

## 常用命令

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 开发 | `npm run dev` | Vite，`127.0.0.1:5173`；`/api` 代理到 `127.0.0.1:8891` |
| 构建 | `npm run build` | 产物在 `dist/`（已 gitignore） |
| 预览产物 | `npm run preview` | `127.0.0.1` |
| 单元测试 | `node --test tests/` | 没有 `npm test` 脚本；测试用 Node 内置 `node:test` |
| 跑单个测试文件 | `node tests/cameraMotion.test.mjs` | runner 无法 spawn 子进程时的替代跑法 |
| 重建骨骼动画 | `npm run build:animations` | 用 `scripts/assets/` 里的固定源文件重写 `public/models/xbot-animated.glb` |
| 本机 AI 服务 | `python server/server.py` | `127.0.0.1:8891`，可选；无前端 dev server 时同时托管 `dist/` |

依赖安装遵循锁文件 `package-lock.json`（`npm ci`）。README 面向用户，`docs/USER_GUIDE.md` 是操作手册。

## 目录与职责

| 路径 | 职责 |
| --- | --- |
| `src/App.jsx` | 约 2900 行。全部应用状态、面板、时间轴、镜头管理、撤销/自动保存、PNG/MP4/JSON 导出。应用层都在这里 |
| `src/Viewport.jsx` | 约 1450 行。全部 Three.js 场景；导出 `MainViewport`、`CameraPreview`。人物白模与骨骼、IK、几何体、光照、路线预览；按 `bodyType === 'minimal'` 切换到极简模型 |
| `src/MinimalPersonModel.jsx` | 极简模型渲染：圆柱身体、球头、正面球面片与 `CanvasTexture` 面部文字（不加载 Mixamo GLB） |
| `src/minimalPerson.js` | 纯函数：极简模型尺寸、面部文字归一化（1–5 字）与字号自适应 |
| `src/cameraMotion.js` | 纯函数：跟随镜头、景别预设、朝向求解 |
| `src/transformValues.js` | 纯函数：变换轴锁定归一化、锁定感知归零/复位、相机帧锁定合并、数值格式化/解析/步进 |
| `src/previsMotion.js` | 纯函数：地面路线 → 弧长重采样的角色关键帧 |
| `src/routeOwnership.js` | 纯函数：路线关键帧与手工关键帧的所有权判定与合并 |
| `src/sceneToMonoform.js` | 纯函数：AI 场景 Z-up → MONOFORM Y-up 的物体/相机转换 |
| `src/rig.js` | mixamorig 骨骼定义、动作预设、姿势克隆/插值 |
| `src/ShotsPanel.jsx` | 镜头列表 UI（纯展示，状态由 App 传入） |
| `src/styles.css` | 全局样式；深色主题色值集中在 `:root` 变量 |
| `server/server.py` | 可选 AI 服务（仅标准库）；`server/perspective_prompt.py` 是场景提示词 |
| `tests/*.test.mjs` | Node 原生测试，只覆盖上面的纯逻辑模块 |
| `scripts/` | 动画烘焙脚本；`scripts/assets/` 存固定版本的源资产 |
| `public/` | 运行时静态资源（模型、品牌图），必须经 `import.meta.env.BASE_URL` 引用 |
| `.github/workflows/deploy-pages.yml` | push 到 `master` 时 `npm ci` + `npm run build` → GitHub Pages |
| `docs/` | 用户手册与界面截图 |

## 改代码前必须守住的不变量

1. **状态只有一个来源。** `App.jsx` 用 `useState` 存工程状态，用 `useMemo` 在渲染期派生当前帧的物体/摄像机/导出尺寸。不要引入 Redux/Zustand/Context 之类的第二层状态，也不要另写一套动画求值路径。
2. **纯逻辑要能单测。** 任何可脱离 React 的几何、插值、时间轴、转换逻辑，抽成独立 `.js` 模块（不含 JSX）并在 `tests/` 加 `node:test` 用例。测试无法 import JSX，所以逻辑留在组件里就等于不可测。
3. **资源路径永远走 `BASE_URL`。** Vite 配置是 `base: './'`，站点部署在 GitHub Pages 子路径下；写死 `/models/...`、`/branding/...` 会在子路径部署时 404。现有写法见 `BUILT_IN_MODEL_URL`、`BRAND_MARK_URL`。
4. **工程 schema 只增不破。** `PROJECT_VERSION` 当前是 16。新增/改动字段时，同步更新 `normalizeProjectData` 与各 `normalize*` 函数，并保证改动前导出的 `.monoform.json` 仍能打开（README 明确承诺旧版工程可直接打开）。历史别名要保留：`characterKeyframes` ↔ `objectKeyframes`、`stageframe-project` → `monoform-project`。
5. **localStorage 键名是用户数据的地址。** `monoform-project`、`monoform-custom-poses`；带 `?key=` 嵌入时在键后加后缀（多实例隔离）。改前缀等于让所有用户的本地工程消失。
6. **多镜头语义要保住。** 每个镜头完整保存 objects/camera/lighting/reference/keyframes/objectKeyframes/routeTracks 与自己的 fps、时长、循环；切换镜头前先用 `liveShotRecord` 落盘当前状态并更新缩略图；上限 30 个镜头；“新建镜头”复制布局但清空关键帧与参考图，“复制镜头”全量复制。这些行为直接对应用户手册里的描述。
7. **预览 = 导出。** PNG/MP4 必须与右下监视器同源：同一帧求值、同一画幅、同一 fps。导出尺寸走 `exportDimensionsForAspect`（宽高取偶数）；MP4 用 `mediabunny` 动态 `import()`，不要静态引入进主包。
8. **路线关键帧有所有权。** 地面路线烘焙出的关键帧与手工关键帧分开管理（`routeOwnership.js`）；重新烘焙或清除路线时不能吃掉手工关键帧。
9. **骨骼 id 必须稳定。** 工程 JSON、自定义姿势、AI 姿势都存 `mixamorig*` 骨骼 id；重命名或调整层级会让所有旧工程与姿势库失效。
10. **边界值写死在这些范围：** fps ∈ {24, 25, 30}，镜头时长 1–60 秒，焦距 18–120 mm，撤销 50 步（280 ms 合并），自动保存 900 ms 防抖。缩短时长前必须先检查关键帧是否放得下，放不下就拒绝并提示，不能静默删除动画。
11. **AI 结果必须可审计。** 服务端会校验相机与结构 evidence，不合格时保持原工程不变。不要为了“能导入”而放宽或删掉这层校验。

## 代码风格

- 纯 JS + JSX；**不写行尾分号**、字符串用单引号、2 空格缩进；小组件与工具函数用 `const f = (...) => ...`，顶层组件用 `function Name()`。
- `App.jsx` / `Viewport.jsx` 的密集单行 JSX 是刻意保留的现状。只改必要的行，不要整文件格式化，否则 diff 不可读、review 无从下手。
- 面向用户的文案、报错、toast 用中文；与用户沟通、文档也用中文。注释解释“为什么”，不写“做了什么”。
- 图标统一 `lucide-react`；样式写进 `styles.css` 并复用 `--accent`、`--panel` 等现有变量，不要另起配色体系。
- 不轻易新增运行时依赖；测试只用 `node:test` + `node:assert/strict`，不引入测试框架。

## 可选 AI 服务

- 只绑定 `127.0.0.1:8891`，不监听外网。
- 配置来源：`server/model-config.local.json`（已 gitignore）或 `MONOFORM_MODEL_KEY_FILE` 指向的 key 文件（默认 `F:\hermes-sceneTo 3d\model-key.txt`）。密钥只允许存在这两处，绝不写进源码、工程 JSON、截图、日志或提交。
- 接口：`GET /api/health`、`/api/model-config`、`/api/models`；`POST /api/model-config`、`/api/generate-scene`、`/api/generate-pose`、`/api/generate-object`。
- 错误以中文 `{"error": ...}` 返回给 UI，最多截断 2000 字符；只对 5xx 与网络错误重试，4xx 立即抛出。
- 场景提示词固定在 `server/perspective_prompt.py`；姿势/物体提示词从仓库根目录的 `skills/*.json` 读取——该目录未纳入版本控制、默认不存在，此时返回空字符串属正常现象，不要因此报错或把它加进提交。
- 没有 Python、没有密钥、没有网络时，普通编辑、动画、导出必须照常可用——这是硬性要求。

## 验证清单

按改动影响面执行：

1. `node --test tests/`（受限环境下逐文件运行）——纯逻辑必须全绿。
2. `npm run build`——确认没有 import/语法错误。主 chunk 约 1.3 MB 是 three.js 的既有体积，不是回归。
3. `npm run dev` 后手动走一遍受影响的流程：加人物/摆姿、镜头切换、关键帧记录与播放、PNG、MP4、打开与导出工程；刷新页面确认自动恢复。
4. 改了工程结构时，用**改动前**导出的 `.monoform.json` 打开一次，确认旧工程仍可用。
5. 改了 AI 相关代码时，在无 Python / 无密钥的环境下确认编辑器功能不受影响。

若本机沙箱禁止写 `node_modules`，Vite 会在 `node_modules/.vite-temp` 报 `EPERM`；这是环境限制而非仓库问题，可用 `npx vite build --configLoader runner` 验证构建是否通过。

## 发布与仓库状态

- 发布分支是 `master`（由 `main` 合并 `develop` 后建立）；上线 = 合入 `master` 并 push，Actions 构建后发布到 GitHub Pages。日常开发常在 `develop`，不要直接向 `master` 强推。
- `package-lock.json` 是 CI 使用的锁文件；`pnpm-lock.yaml` 已随 `develop` 进入仓库，但 CI 仍以 npm 锁文件为准。
- 本仓库 `origin` 指向 `nivenice/monoform-previs-studio`，`upstream` 是原作者仓库 `GuiYi-Xi/monoform-previs-studio`；README 开头保留了原仓库地址说明。
- 替换模型资产时，同步更新 `public/models/ANIMATION_SOURCES.md` 的出处与许可证，并保留 `scripts/assets/` 里的固定源文件，保证可离线重建。

## 相关文档

- `README.md`：产品定位、功能清单与用户向的使用流程。
- `docs/USER_GUIDE.md`：逐面板的操作手册，改 UI 行为时要与之对齐。
- `public/models/ANIMATION_SOURCES.md`：动画资产来源与许可证。
