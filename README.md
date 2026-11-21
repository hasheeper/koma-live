# Koma Rig

通用分层 2D 绑骨底盘、代码原生软体形变与实时 WebGL 驱动运行时。面向「精绘分层立绘 + 前端程序化代码美术」工作流：通过工作台或离线 CLI 完成 PSD 去噪切图与像素核验、骨架与骨链自动蒙皮、轮廓网格与绘制顺序校准，再通过 `mountPerformance` / `mountLiveRig` 将整套骨架的完整 **TRS（平移 / 旋转 / 缩放）** 与 **M4 代码原生顶点变形口（`deform` Mesh Field）** 暴露给前端或 AI 编写的实时动画与同轴前后景光效代码。[功能规格](docs/implementation-plan.md) · [工作台说明](docs/studio-layout-plan.md) · [演出契约与 Koma Live](docs/performance-contract.md) · [动帧视觉验收](docs/live-inspection-plan.md) · [离线制作与验收](docs/offline-authoring.md) · [维护交接](docs/maintenance-handoff.md) · [编辑器参考](docs/editor-references.md) · [AI 演出技能](.agents/skills/koma-rig-animation/SKILL.md)

## 打开工作台

用 Node.js 26 在仓库根目录运行 `npm ci`，再运行 `npm run dev -- --host 127.0.0.1 --port 5186`。打开 [Koma Rig 本地工作台](http://127.0.0.1:5186/)。

- **搭建模式**：左侧层级树管理图层显隐/锁定与绘制顺序拖拽，中央画布建骨（按住 `Alt` 可建偏移子骨）与拖动调整，右侧检查器支持骨名原地重命名、拾取改父骨/设为根骨、删骨、单骨与连续骨链绑定及关节柔化、骨链一键安全轮廓网格与轮廓网格手绘/自动描绘/清除。
- **试动模式**：画布拖拽旋转骨骼，右侧检查器实时试调骨骼完整 **TRS（旋转 / 平移 X·Y / 缩放 X·Y）**，网格翻面或自交会在画布直接标红高亮。
- **动帧模式（Koma Live）**：顶栏右上角一键切换「绑骨 ↔ 动帧」（支持 `?view=live` 与开发态 `?work=examples/dkh` 直达），切换时自动保活已打开的作品与状态。直接基于同一 `mountPerformance` 运行内置样板或本地作品目录（统一兼容 `koma-work.json` 根目录与纯 `manifest.json` 切片目录、支持画布拖放、全量热重载 `rig.json / koma-work.json / .js` 与自动监听同步）、自动渲染脚本 `meta.states / triggers` 控件、提供鼠标跟随开关（`pointerTracking`）、竖卡/横卡无漂移实测、底色快切与同轴审查叠加层。
- **零摩擦载入与导出**：Studio 与 Live 共用 IndexedDB「最近打开」目录句柄持久化（刷新自动/一键恢复免再翻 Finder），开发态自动发现 `examples/*` 本地工作区；Studio 支持原位保存、外部改动自动同步或手动从目录重载 `rig.json`，以及导出 `rig.json` / `rig-spec.json`（CLI：`npm run rig -- spec <目录> [输出.json]`、`auto-mesh`、`check-bend`）。

`npm run build:studio` 生成可静态部署的 `apps/rig-studio/dist/`。求值内核（`rig-core`）、独立 PixiJS 渲染运行时（`rig-renderer`）、Node CLI 和离线 PSD 导出器各自独立使用。

## 前端实时驱动运行时

运行 `npm run build:runtime` 生成零编辑器依赖的独立渲染模块 `packages/rig-renderer/dist/runtime/player.js`，同时导出三个入口：

- **`mountPerformance(host, options)`**（推荐，零漂移完整演出承载）：加载 `koma-work.json` 或任意路径的 `rig` + 单文件自包含演出脚本（`koma-rig.performance.v1`），提供同轴 1:1 DPR 适配 `back / puppet / front` 三层画箱、逻辑指针逆变换、`stepTo(timeMs)` 固定步确定性采样与 `errorPolicy: 'pause' | 'throttle'` 防异常风暴，与 **Koma Live** 跑完全同一份代码：

```js
import { mountPerformance } from './rig-runtime/player.js'

const live = await mountPerformance(containerEl, {
  work: './examples/live-demo/koma-work.json',
  viewport: { fit: 'contain', anchor: [0.5, 1.0] },
})
live.trigger('flick')
live.setState('gust')
```

- **`mountLiveRig(host, source)`**（底层单帧直驱）：直接加载切片目录（`manifest.json` + `rig.json` + `textures/*.png`）或内存资产，每帧传入骨骼 **TRS**、差分槽与可选的 **代码原生顶点变形口（`deform` Mesh Field）** 实时渲染，并返回带骨骼世界坐标与部件中心点的 `Pose`：

```js
import { mountLiveRig } from './rig-runtime/player.js'

const puppet = await mountLiveRig(canvas, './assets/character/')
// puppet.spec 包含坐标系、骨骼树、图层绑定与差分槽摘要

function tick(now) {
  const t = now / 1000
  const pose = puppet.setPose({
    bones: {
      hip: { y: Math.sin(t * 1.1) * 6, scaleX: 1.03, scaleY: 0.97 },
      head: { rotation: Math.sin(t * 0.8) * 5, x: Math.sin(t * 0.8) * 2 },
    },
    // 可选 M4 Mesh Field：(u, v) 为切片局部 [0..1]，(x, y) 为原画布静止像素坐标
    deform: {
      ribbon_l: { grid: [3, 10], field: (_u, v) => [Math.sin(v * 5.5 - t * 3.8) * v * v * 12, 0] },
    },
  })
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
```

- **`mountPublished(host, root)`**：加载经哈希校验与离线审计打包的静态发布目录（含 `release.json` 与 `motions/*.json`）。

## 复验底层功能

使用 `.nvmrc` 指定的 Node.js 26，在仓库根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run test:studio-layout
npm run test:live
npm run build:runtime
npm run rig -- spec apps/rig-studio/src/samples/gbot
npm run rig -- auto-mesh examples/chain-strip --dry-run
npm run rig -- check-bend examples/dkh
npm run inspect:live -- examples/live-demo/koma-work.json --trigger flick@120 --times 0,120,260,420 --onion 120..360:5 --arcs tip.end --out .tmp/inspect-demo
```

离线 PSD 导出与像素复原使用 Python 3.11+ 和 uv。准备同版分层源稿及独立参考图后运行：

```sh
uv run --locked --project tools/psd python -m layer_rig_psd.slices drawing.psd reference.png character --source-id paper
# 或单命令去孤立噪点并直接按 sRGB PMA 烘焙干净 reference.png（含 0 误差复验与雾噪体检报告）：
uv run --locked --project tools/psd python -m layer_rig_psd.slices drawing.psd character --source-id paper --trim-stray --bake-reference
uv run --locked --project tools/psd python -m unittest discover -s tools/psd/tests
npm run test:offline
```
