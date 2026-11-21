# Koma Live 维护交接 · 2026-11-21

当前主线是离线切片与像素复验 → Studio 搭骨、绑层并校准轮廓网格 → 导出 `rig-spec.json` → 用单文件演出脚本驱动 Koma Live 或游戏宿主 → 用 `inspect:live` 抓帧验收。现行功能规格 §3、§5.2 仍承诺可选 FFD / Ribbon 和静态动作发布。下列清理项按当前工作区的调用关系整理。[功能规格](implementation-plan.md) · [演出契约](performance-contract.md)

## 已经落地

下表汇总当前仓库主线（`main`）已验证落地的核心能力：

| 环节 | 当前行为 |
| --- | --- |
| 源目录、载入与 AI 清单 | Studio 与 Koma Live 统一兼容 `koma-work.json` 作品根目录与切片目录，支持 IndexedDB 最近打开句柄记忆与一键恢复、画布拖放、Studio ↔ Live 切换状态保活、全量自动热重载（`koma-work.json` / `rig.json` / `.js` / 变更贴图缓存）及开发态 `?work=` 与本地工作区发现；CLI 提供 `rig spec`、`rig auto-mesh`（零新依赖 PNG Alpha 轮廓网格批量生成）、`rig check-bend`（骨链安全转角体检），PSD 导出支持 `--trim-stray --bake-reference` 单命令去噪烘焙。[CLI](../apps/rig-cli/rig.mjs) · [本地会话](../apps/rig-studio/src/local-session.ts) · [Studio 加载](../apps/rig-studio/src/project.ts) · [Live 加载](../apps/rig-studio/src/live-work.ts) · [PSD 切片](../tools/psd/src/layer_rig_psd/slices.py) |
| 运行时与 M4 Mesh Field | Studio 可试调骨骼 TRS 与骨链一键轮廓网格，Live、独立网页和审片器共用 `mountPerformance` / `mountLiveRig`。支持骨骼 TRS、演出状态与触发、同轴前后景对齐、指针跟随开关、显式指针注入、固定步进，以及 **M4 代码原生顶点变形口（`deform` Mesh Field）**：统一按静止空间 `(u, v, x, y) => [dx, dy]` 在骨骼/骨链前施加、带轮廓网格平面细分防碎裂与 `checkGeometry` X 轴扫描裁剪加速、省略 `deform` 时渲染几何与 `gelGroups` 覆盖层 0 像素残差回退。[实时挂载](../packages/rig-renderer/src/game.ts) · [演出控制](../packages/rig-renderer/src/performance.ts) · [顶点变形口](../packages/rig-core/src/mesh-field.ts) |
| 审片与样板 | `inspect:live` 接受作品或切片目录简写，源目录的坏 setup 在启动 Chromium 前报错。同刻状态和指针会反映在目标帧。裁切保留横纵参考线标签，运动弧区分起终点，overlay 叠加骨架与图例，洋葱皮和叠差的 Alpha 剪影保留透明度。回归覆盖 GBot 刚体焊地、P0 零摩擦载入与保活、以及 M4 Mesh Field 在普通层与 `gelGroups` 下的 WebGL 变形与回退；仓库另含完整 48 层分层立绘样板 `examples/dkh`。[审片合成器](../apps/rig-cli/inspect-composer.mjs) · [浏览器回归](../tests/koma-live.browser.mjs) |
| 制作说明与 Agent Skill | README、离线制作、Studio、演出与审片文档已收口同步；Agent Skill 已重构为「总览激活 + 工具契约详细 + 实战经验与物理配方」三段式结构。网页端暂停态洋葱皮、编辑态未保存草稿自动恢复与企划 ZIP 仍列为按需后续项。[审片说明](live-inspection-plan.md) · [工作台说明](studio-layout-plan.md) · [Agent 技能](../.agents/skills/koma-rig-animation/SKILL.md) |

**导入与审片修复**

- GBot 现有一张 625 × 995 的独立参考图，按原始 Godot 切片及 Koma 样板制作时的静止摆位导出。离线预乘 RGBA 比对为 0 个超差像素，最大通道误差 1。Studio 打开本地 GBot 源目录时走完整 Worker 复验，内置 Live 作品也能取这张图作海报。[参考图](../apps/rig-studio/src/samples/gbot/reference.png) · [素材来源](../apps/rig-studio/public/credits.txt)
- 审片服务读取成功后才发送 HTTP 200。浏览器通过实际审片入口验证了缺失贴图返回 404、磁盘路径无法作为文件读取时返回 500。坏 setup 仍在启动 Chromium 前报错。[审片服务](../apps/rig-cli/inspect-live.mjs) · [回归用例](../tests/koma-live.browser.mjs)

## 第一批 · 已清理

| 对象 | 处理结果 |
| --- | --- |
| 重复动作夹具 | `agent.test.ts`、编辑与运行时测试共用 `examples/paper/motions/tilt.json`，已删除原副本。两份涵盖不同槽位和绑定的 rig 继续用于原有断言。[动作夹具](../examples/paper/motions/tilt.json) · [契约测试](../packages/rig-core/test/agent.test.ts) |
| 早期 PSD 几何预检 | 已移除 `layer-rig.inspection.v1` 的 Python console script、Node 检查器、Schema、示例和专属测试。现役 PSD 导出继续使用 `python -m layer_rig_psd.slices`，像素复验使用 `rig verify-slices`。[离线制作](offline-authoring.md) · [PSD 测试](../tools/psd/tests/test_slices.py) |
| 矩形预览接口 | 已移除 `createBoundsPreview` 导出。兼容接口 `mount(target)` 可接收 canvas 或容器，仍支持 `update` 和 `destroy`，现已标记为弃用。`CanvasSize` 和 `PixelRect` 由切片清单推导。角色渲染入口为 `mountCharacter`。[渲染器入口](../packages/rig-renderer/src/index.ts) · [切片类型](../packages/rig-core/src/slices.ts) |

## 第二批 · Studio 入口已收起

- 移除静态 JSON 动作选择、播放按钮、试听时钟、样板动作注入和目录中的专用动作枚举。试动仍支持拖拽、数值调骨和姿势复位。静态动作文件继续供 CLI 采样和归档，骨链样板根目录的 `bend.json` 仍用作离线单姿势输入。[工作台](../apps/rig-studio/src/App.vue) · [样板装载](../apps/rig-studio/src/project.ts)
- 移除「纸条 · 晶格网格」菜单和示例装载分支。导入已有 FFD / Ribbon 资产仍能看到类型及参数滑块，`examples/hinge/grid.json` 继续验证轮廓与 FFD 的叠加。[树节点](../apps/rig-studio/src/Hierarchy.vue) · [轮廓网格回归](../packages/rig-core/test/mesh-authoring.test.ts)

FFD / Ribbon 的内核退役需要单独决策。实时 `pose` 也会对有 `deformer` 的图层求值，已保存的局部变形可以和骨链、轮廓网格叠加。若未来缩小文件格式，先迁移这些资产并对照静止、极值姿势与透明边缘；保留 `geometry.ts` 中独立使用的轮廓拓扑、翻面和自交检测。旧的图层父级 `bindings[].parentId` 同样需要先迁移静止世界变换。[图层求值](../packages/rig-core/src/pose.ts) · [几何实现](../packages/rig-core/src/geometry.ts) · [旧资产夹具](../tests/fixtures/layered-parts/rig.json)

## 第三批 · 迁移调用方后才能退役的静态发布链

1. **先处理外部宿主与归档承诺**。外部宿主项目 `project-lutie/prototype/js/rig-host.js`（及 `project-lutie/prototype/index.html`）仍导入 `mountPublished`，推进时间、触发敲玻璃并负责 PNG 回退。当前 HTML 未配置 `data-rig-package`，实际显示 PNG。若迁到 `mountPerformance`，用同一角色验证任意待机相位敲击、手部退场、返回待机与加载失败回图，并决定已交付的 `release.json` / SHA-256 发布包由哪个版本继续读取。[离线发布契约](offline-authoring.md)
2. **先拆出实时路径的共享代码**。`pose.ts` 建模调用 `exportCapabilities` 和 `neutral`；`exportRigSpec` 复用槽位 Schema 和已校验参数；`authoring.ts` 依赖参数 Schema 与静止默认值；`mountLiveRig.setPose` 合并默认参数和槽位。迁移这些共享定义、默认值和约束，保住槽位状态引用与可返回性校验。现役 hinge、chain-strip 源样板本身还用 `set-parameter` 和 `drives`。[求值](../packages/rig-core/src/pose.ts) · [清单](../packages/rig-core/src/spec.ts) · [编辑](../packages/rig-core/src/authoring.ts) · [实时挂载](../packages/rig-renderer/src/game.ts)
3. **再按调用链删除**。宿主迁完且规格 §5.2 正式退役后，依次收掉 `mountPublished` 导出、CLI 的 `capabilities / check-motion / sample / audit / review / publish`、`assets.mjs` 的发布分支，再删除 `release.ts / interaction.ts / player.ts` 和已隔离的静态采样、旧 capabilities 版本与动作校验。手部驻留、退场窗口及防跳帧原由静态播放器执行，新演出需有等价验证。最后处理 `reimport` 对旧动作文件的复制，防止仍在迁移的企划换图时丢动作。[CLI](../apps/rig-cli/rig.mjs) · [归档与换图](../apps/rig-cli/assets.mjs) · [静态播放器](../packages/rig-core/src/player.ts)
4. **按断言迁移测试**。`agent.test.ts` 有槽位回默认态的校验，`runtime.test.ts` 有几何翻面、自交与眼睑对齐覆盖。`examples/paper` 还供 `authoring.test.ts`、`chain.test.ts` 使用；`layered-parts` 同时服务面部、手部与归档回归。先给继续维护的行为留下等价夹具，再删专属样例及断言，同批更新 README、功能规格、离线制作及宿主说明。[运行时回归](../packages/rig-core/test/runtime.test.ts) · [编辑回归](../packages/rig-core/test/authoring.test.ts) · [骨链回归](../packages/rig-core/test/chain.test.ts)

## 清理后的验收基线

- 保留 v2 切片与独立像素参考、PMA 和 `gelGroups`、骨骼 TRS、骨链蒙皮、轮廓网格、几何体检、差分槽，以及离线编辑、保存、重导与渲染。保留两套工作台、实时驱动清单、独立运行时、审片工具和 Agent 技能。小幅呼吸、眨眼、视线与发梢跟随可以直接走这条主线。其穿帮风险取决于补画、眼部遮罩和状态切换，当前没有能支持“容错率高一个数量级”的测量。
- 本次用 Node 26 复跑通过严格类型检查、两项生产构建、Vitest **14 个文件 / 75 项**、离线 CLI **5 项**、Python PSD 与像素测试 **6 项**、Live 与审片及 M4 WebGL 浏览器 **6 项**、Studio 布局与导入浏览器 **3 项**。Vite 仍提示 Studio 主 JS 块超过 500 kB。
- 清理批次可复用 `npm run build`、`npm test`、`npm run test:offline`、`npm run test:live`、`npm run test:studio-layout`，以及 `uv run --locked --project tools/psd python -m unittest discover -s tools/psd/tests`。按现有测试保留包依赖白名单、无 DOM 的内核、深浅主题布局以及运行时独立构建。[包边界回归](../tests/dependencies.test.mjs)
