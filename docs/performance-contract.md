# Koma Live 演出契约与动帧工坊规划

> **状态**：M1–M4 已落地并通过单元测试与浏览器端到端回归（`npm test`、`npm run test:live`）。  
> **品牌脉络**：以 **「动帧（Koma）」** 为核心统一整个产品家族——**Koma Image**（静帧）· **Koma Live**（动帧主平台，内置 **Koma Rig** 绑骨底盘）。底层稳定协议保持 `koma-rig.*.v1/v2` 与 `koma-work.json` 向后兼容，运行时入口采用与页面形态解耦的 **`mountPerformance`** 与 **`mountLiveRig`**。

本文定义 Koma Rig 体系的应用承载层：**演出与作品契约（Performance & Work Contract）** 与 **Koma Live 动帧展示 / 作品工坊**。目标是让任意目录结构下的角色切片与 AI 代码美术演出脚本，都能以 **100% 一致、零坐标系漂移、零硬编码** 的方式同时运行在 **Koma Live** 和 **真实网页 / 游戏作品** 中。[设计哲学与演进](design-philosophy.md) · [核心规格](rig-spec.md) · [工作台说明](studio-guide.md) · [AI 演出技能](../.agents/skills/koma-rig-animation/SKILL.md)

---

## 1. 为什么必须有应用契约：消灭 4 类漂移

仅靠底层的 `mountLiveRig(host, source)` 只能解决“给一套骨骼 TRS 画出单帧角色”，还不足以保证 **Koma Live 所见 = 最终作品所得**。跨宿主呈现发生漂移的根源集中在 4 件事上：

| 漂移根源 | 无契约时的典型失控 | 契约解法（依赖反转） |
|---|---|---|
| **1. 目录结构漂移** | 动画脚本里硬编码 `fetch('./assets/lutie/')` 或 `document.querySelector('img.hero')`，换到 Koma Live 或别的项目直接 404 / 报错。 | **路径彻底抽离**：演出脚本不负责加载资产、不碰宿主 DOM，只接收宿主注入的 `ctx.puppet`；任意目录结构通过可选 `koma-work.json` 或代码传参接入。 |
| **2. 坐标系与缩放漂移** | 特效按 `window.innerWidth` 或 CSS 像素定位，在全屏预览是对的，放进作品 400×600 卡片后粒子错位、高清屏发糊、鼠标点击歪掉。 | **单一逻辑画布 + 三层同轴画箱 + 透明 DPR 适配**：以 `manifest.canvas` 为唯一 1:1 逻辑像素基准；`back` / `puppet` / `front` 严格叠合，宿主统一处理 `fit / anchor`、物理像素 DPR 与逻辑指针逆变换。 |
| **3. 时钟与生命周期漂移** | 脚本私自开 `requestAnimationFrame` 与全局 `window.addEventListener`，宿主无法暂停、慢放、确定性截帧，卸载后内存泄漏。 | **宿主掌控心跳与确定性步进**：脚本只提供纯 `update(frame)` / `trigger()` / `reset()` / `destroy()` 回调，由宿主统一驱动、支持固定步确定性采样并在卸载时彻底回收。 |
| **4. 交互入口硬编码** | 展示台不知道这个角色支持哪些表情、心情或点击事件，只能为每个角色单独写测试页。 | **轻量自描述 `meta`**：演出脚本可选声明 `states`（状态）与 `triggers`（事件），Koma Live 自动生成交互测试按钮；作品业务层按同一名称调用。 |

---

## 2. 三份核心契约规范

整套架构只增加三个薄而稳定的边界，均不向 `rig-studio` 引入参数表或 FFD 面板，也不向 `rig-core` 引入渲染或动画库依赖。

### 2.1 演出模块契约：`koma-rig.performance.v1`

AI 或前端开发者交付的每一份角色实时动画，都是一个 **单文件自包含的纯 ES Module**（零框架依赖，不自行拉取资产、不自行启动主循环）：

```ts
export interface PerformanceMeta {
  format: 'koma-rig.performance.v1'
  title?: string
  author?: string
  /** 可选：可供作品与 Koma Live 切换的高层演出状态（如 ['idle', 'happy', 'sleepy']） */
  states?: string[]
  /** 可选：可供作品与 Koma Live 触发的瞬时互动事件（如 ['tap', 'poke', 'gust']） */
  triggers?: string[]
  /** 可选：声明需要宿主准备的前后景同轴 2D 画布槽，默认均不创建以省开销 */
  layers?: {
    back?: '2d' | false
    front?: '2d' | false
  }
}

export interface LogicalPointer {
  /** 是否在角色逻辑画布范围内 */
  inside: boolean
  /** 指针是否按下 */
  down: boolean
  /** 角色逻辑画布坐标（0..width, 0..height），左上为原点 */
  x: number
  y: number
  /** 以画布中心为原点、半宽高归一化的坐标（[-1, 1] 范围内，移出画布可超界） */
  nx: number
  ny: number
}

export interface PerformanceFrame {
  /** 宿主维护的逻辑时钟（ms，暂停时冻结，慢放时按倍率步进） */
  timeMs: number
  /** 距离上一帧的逻辑增量（ms，宿主自动钳制切后台后的超大跳变） */
  dtMs: number
  /** 已经换算到 manifest.canvas 逻辑空间的指针状态 */
  pointer: LogicalPointer
  /** 当前所处演出状态名（来自 meta.states 或宿主 setState） */
  state: string
}

export interface PerformanceLayerSlot {
  canvas: HTMLCanvasElement
  /** 2D 槽上下文：宿主已预置物理像素 DPR 变换，脚本直接按 ctx.size 逻辑像素绘制 */
  ctx2d?: CanvasRenderingContext2D | null
  /** 当前 2D 槽物理像素对逻辑像素的缩放倍率（只读信息，供高级效果参考） */
  pixelScale: number
}

export interface PerformanceContext {
  /** 已就绪的 Koma Rig 实时人偶驱动实例 */
  puppet: LiveRigPlayer
  /** 永远等于 manifest.canvas 的 1:1 逻辑像素尺寸 */
  size: { width: number; height: number }
  /** 与人偶画布严格 1:1 对齐的背景绘制槽（按 meta.layers.back 按需创建） */
  back?: PerformanceLayerSlot
  /** 与人偶画布严格 1:1 对齐的前景绘制槽（按 meta.layers.front 按需创建） */
  front?: PerformanceLayerSlot
}

export interface PerformanceInstance {
  /** 每帧由宿主调用：计算骨骼 TRS / slots，调用 ctx.puppet.setPose(...)，并可绘制 back/front */
  update(frame: PerformanceFrame): void
  /** 可选：响应宿主发来的交互触发器（如 tap、poke、weather-change） */
  trigger?(name: string, payload?: unknown): void
  /** 可选：响应宿主切换高层演出状态 */
  setState?(state: string): void
  /** 可选：宿主请求复位演出内部状态（弹簧、粒子、PRNG 种子归零），供 reset() 与 stepTo() 使用 */
  reset?(): void
  /** 可选：释放脚本自行分配的临时资源（离屏缓存、WebGL 程序等） */
  destroy?(): void
}

export type PerformanceFactory = (
  ctx: PerformanceContext,
) => PerformanceInstance | Promise<PerformanceInstance>

// 模块导出约定：
export declare const meta: PerformanceMeta
export default function createPerformance(ctx: PerformanceContext): PerformanceInstance | Promise<PerformanceInstance>
```

#### 契约护栏（必须严格遵守的硬约束）

1. **护栏 ① — 单文件自包含 ES Module（保证本地目录 Blob URL 热重载可靠）**：
   - 交付的演出脚本**必须为单文件自包含纯 ES Module**，**禁止**任何外部相对路径 `import`（如 `import { spring } from './utils.js'`）、裸包名 `import` 或运行时动态 `import()` 外部模块。
   - 原因：在 Koma Live 中打开本地文件夹（`FileSystemDirectoryHandle` / `<input webkitdirectory>`）并一键热重载时，浏览器通过 `Blob URL` 动态载入脚本，无法解析相对路径依赖；若上游作品使用 TypeScript 或多文件工程开发，须打包成单文件 ES Module 后再接入。
2. **护栏 ② — 确定性采样配合（支持 `stepTo(timeMs)` 精确复现）**：
   - 演出脚本**禁止**读取墙钟（`Date.now()`、`performance.now()`）或调用不可复现的 `Math.random()` 推进状态；若需随机粒子或自然眨眼间隔，应使用内置确定性伪随机生成器（PRNG）并在 `reset()` 中复位种子。
   - `reset()` 必须将内部弹簧位移/速度、粒子列表、计时器与随机种子彻底归零，确保宿主从 `t = 0` 快进至任意 `timeMs` 得到逐帧一致的画面。
3. **护栏 ③ — `back` / `front` 2D 逻辑绘制与变换栈保护**：
   - 宿主已为 2D 槽完成物理像素 DPR 适配，脚本一律在 `0..ctx.size.width × 0..ctx.size.height` 逻辑像素空间中绘图与清屏（`ctx2d.clearRect(0, 0, size.width, size.height)`）。
   - 脚本内若使用旋转/缩放，须成对使用 `ctx2d.save()` / `ctx2d.restore()`，**禁止**调用 `ctx2d.resetTransform()` 或 `ctx2d.setTransform(1, 0, 0, 1, 0, 0)` 破坏宿主预置的 DPR 缩放矩阵；且禁止读取外层 DOM 的 `clientWidth` / `getBoundingClientRect` / `window.innerWidth`。
4. **护栏 ④ — 禁止私自开循环与静默吞错**：
   - 禁止调用 `requestAnimationFrame`、`setInterval` 或向 `window` / `document` 挂载未清理的全局监听。
   - 调用 `ctx.puppet.setPose(...)` 若触发 `GeometryError` 或数值异常，禁止在脚本内 `try/catch` 吞错硬画；异常必须上抛给宿主统一处理。

---

### 2.2 作品清单契约：`koma-rig.work.v1`（`koma-work.json`）

为了做到**“无论目录结构怎么摆，都能被 Koma Live 与独立页面零配置加载”**，提供一份极薄的声明式入口清单 `koma-work.json`。它只做路径映射与视口基线声明，不复制 `rig.json` 或 `manifest.json` 的任何内容：

```json
{
  "format": "koma-rig.work.v1",
  "id": "lutie-human",
  "title": "露缇 · 人形态",
  "rig": "./assets/slices/",
  "performance": "./motion/lutie-live.js",
  "poster": "./assets/slices/reference.png",
  "viewport": {
    "fit": "contain",
    "anchor": [0.5, 1.0],
    "paddingPx": 0
  },
  "defaultState": "idle"
}
```

**关键设计原则**：
- **相对路径自由映射**：`rig` 可以是 `"./"`（与清单同目录）、`"./slices/"` 或 `"../shared/char-a/"`；`performance` 指向单文件自包含 ES Module（任意相对路径），也可省略（省略时 Koma Live 仍可按静止态展示该人偶）。
- **静态兜底图（`poster`）**：可选指向 `reference.png` 或精修立绘；在 WebGL 不可用、上下文丢失或脚本致命异常时，宿主自动无缝退回同一套 `fit / anchor` 规则展示 `poster`，确保版面不跳动。
- **视口贴合基准（`viewport.fit` + `anchor`）**：
  - `fit`：`contain`（完整入框，默认）或 `cover`（填满裁切）。
  - `anchor`：`[ax, ay] ∈ [0, 1]²`，定义画布锚点与容器锚点的对齐点（如 `[0.5, 0.5]` 居中，`[0.5, 1.0]` 脚底贴齐容器底边——立绘卡片和桌面宠物最常用，窗口高度变化时角色脚底绝不上下飘移）。
- **非强制清单**：在 Vite / 现代前端游戏工程里，可以直接跳过 `koma-work.json`，把已导入的模块对象与资产路径传给 `mountPerformance`。

---

### 2.3 统一宿主承载运行时：`mountPerformance`

`mountPerformance` 作为独立渲染运行时（`packages/rig-renderer/dist/runtime/player.js`）的顶层导出，与底层 `mountLiveRig` 并存，**零 Vue / 编辑器依赖**。

**Koma Live 动帧工坊** 和 **任何真实作品页面** 调用的都是这**同一份代码**：

```ts
export interface MountPerformanceOptions {
  /** 1) 传 koma-work.json 的 URL；或 2) 显式指定 rig 与 performance，兼容任意打包方式 */
  work?: string | URL
  rig?: string | URL | LiveRigSource
  performance?: string | URL | { code: string; filename?: string } | PerformanceModule | PerformanceFactory
  poster?: string | URL | Blob
  viewport?: {
    fit?: 'contain' | 'cover'
    anchor?: [number, number]
    paddingPx?: number
  }
  /** 宿主初始状态，覆盖 work.defaultState */
  initialState?: string
  /** 是否自动启动时钟循环（默认 true；截帧回归或工坊步进调试可设为 false） */
  autoplay?: boolean
  /** 是否监听外框 DOM 指针事件并喂给脚本逻辑指针（默认 true；关闭后立即将 pointer 归零复位） */
  pointerTracking?: boolean
  /** 时钟倍速（默认 1，Koma Live 可切 0.25 / 0.5 / 1） */
  timeScale?: number
  /** stepTo(timeMs) / advanceBy(deltaMs) 固定微步步长（ms，默认 10 ms，用于确定性快进） */
  stepMs?: number
  /** back/front 2D 槽物理像素缩放倍率上限（默认 2，兼顾 Retina 清晰度与显存占用） */
  maxDpr?: number
  /**
   * 运行期异常（含 GeometryError）防护策略，默认 'pause'：
   * - 'pause'：保持上一有效帧，立即暂停时钟循环并触发一次 onError，防止 60fps 异常风暴；
   * - 'throttle'：保持上一有效帧继续运行，但按错误签名去重并在冷却窗口（默认 1000 ms）内限流回调 onError。
   */
  errorPolicy?: 'pause' | 'throttle'
  /** errorPolicy === 'throttle' 时的同签名节流冷却窗口（ms，默认 1000） */
  errorThrottleMs?: number
  /** 几何校验或脚本运行出错时的回调（宿主已按 errorPolicy 做暂停或去重节流） */
  onError?: (error: unknown) => void
  /** 每帧渲染后的状态快照回调（供 Koma Live 叠加层与时间读数同步） */
  onFrame?: (snapshot: PerformanceFrameSnapshot) => void
  /** 外框尺寸或视口变化后的布局快照回调 */
  onLayout?: (layout: PerformanceLayoutSnapshot) => void
}

export interface MountedPerformance {
  /** 宿主创建的同轴三层画箱根元素（可直接受外层容器布局控制） */
  element: HTMLElement
  /** 内部逻辑画布堆叠层（统一施加 translate/scale 变换） */
  stackElement: HTMLElement
  /** 底层实时人偶实例（只读访问 spec / pose / canvas，支持 puppet.render() 同步落帧） */
  puppet: LiveRigPlayer
  /** 解析后的演出元信息（states / triggers / title 等） */
  meta: PerformanceMeta
  readonly playing: boolean
  readonly pointerTracking: boolean
  readonly timeMs: number
  readonly state: string
  readonly pointer: LogicalPointer
  readonly lastError: unknown
  /** 播放控制、鼠标跟随开关与确定性步进 */
  play(): void
  pause(): void
  setPointerTracking(enabled: boolean): void
  setTimeScale(scale: number): void
  /** 从当前时刻保持状态，按 stepMs 固定微步确定性推进 deltaMs（供剧本分段回放） */
  advanceBy(deltaMs: number): void
  /** 确定性跳转至指定时刻：内部执行 reset() + advanceBy(timeMs) */
  stepTo(timeMs: number): void
  reset(): void
  /** 注入逻辑空间指针（用于无头回放与程序化测试） */
  setPointer(pointer: Partial<LogicalPointer>): void
  /** 业务交互控制 */
  setState(state: string): void
  trigger(name: string, payload?: unknown): void
  /** 动态调整适配方式（如作品切换全屏/卡片态） */
  setViewport(viewport?: MountPerformanceOptions['viewport']): void
  getLayout(): PerformanceLayoutSnapshot
  /** 卸载三层画箱、停止循环、释放 WebGL 与事件 */
  destroy(): void
}

export declare function mountPerformance(
  host: HTMLElement,
  options: MountPerformanceOptions,
): Promise<MountedPerformance>
```

#### 四项运行时核心机制（对应 4 条契约护栏）

1. **单文件模块加载与本地热重载（护栏 ①）**：
   - `performance` 为 URL 时按标准 ES Module 加载；本地文件目录加载时宿主把单文件文本封装为 `Blob URL`（`text/javascript`）动态导入，并在销毁或重载时立即 `URL.revokeObjectURL` 防内存泄漏。
2. **确定性采样 `stepTo(timeMs)`（护栏 ②）**：
   - 宿主调用 `stepTo(targetMs)`（要求 `targetMs >= 0`）时，固定按以下序列执行：
     1. 冻结实时循环并调用 `performance.reset?.()` 与 `puppet.reset()`，将逻辑时钟归零（`t = 0`）、重新下发当前 `state`；
     2. 以固定微步 `h = stepMs`（默认 `10 ms`）循环推进 `update({ timeMs: t, dtMs: h, pointer, state })` 直至剩余时间 `<= h`；
     3. 若 `targetMs === 0` 则执行一次 `dtMs = 0` 的初帧渲染，否则执行最后一步余数 `dtMs = targetMs - t`。
   - 这样即使演出脚本内部带有阻尼弹簧、惯性追随或粒子系统，重复调用 `stepTo(1250)` 或拖动时间轴回看也能得到**完全确定、可复现的画面**。
3. **同轴三层画箱 + `back / front` 物理像素 DPR 适配（护栏 ③）**：
   - 宿主在 `host` 内挂载 `.koma-box`，通过 `ResizeObserver` 监听外框尺寸 `(W, H)`，按 `manifest.canvas (cw, ch)` 与 `fit / anchor` 计算出唯一缩放系数 `s` 与平移偏移 `(ox, oy)`。
   - 内部 `.koma-canvas-stack` 逻辑尺寸固定为 `(cw, ch)`，统一施加 `transform: translate(ox, oy) scale(s)`（`transform-origin: 0 0`），里面 `back`、`puppet`、`front`（及兜底 `poster`）四层全部 `position: absolute; inset: 0; width: 100%; height: 100%` 严丝合缝叠合。
   - 对于 `back` / `front` 的 `2d` Canvas：宿主根据 `Math.min(maxDpr, Math.max(1, (window.devicePixelRatio || 1) * s))`（并约束单边物理像素不超显存安全上限）动态更新物理缓冲区 `canvas.width = Math.round(cw * pixelScale)`、`canvas.height = Math.round(ch * pixelScale)`，并在每帧调用 `update` 前为 `ctx2d` 同步设置 `ctx2d.setTransform(pixelScale, 0, 0, pixelScale, 0, 0)`。高清屏下线条与粒子保持锐利，而脚本侧逻辑坐标始终锁定在 `manifest.canvas`。
   - 指针事件经逆变换映射为逻辑坐标 `x = (clientX - stackRect.left) / stackRect.width * cw`、`y = (clientY - stackRect.top) / stackRect.height * ch` 及归一化坐标 `(nx, ny)`。
4. **异常防护与反风暴机制（护栏 ④）**：
   - 任意一帧在 `update()` / `puppet.setPose()` / `trigger()` 抛出 `GeometryError` 或运行时异常时，WebGL 画面自动维持上一有效帧不清空、不崩页；
   - 默认 `errorPolicy: 'pause'`：宿主立即停止 `rAF` 推进并只触发一次 `onError(error)`，直至用户/宿主调用 `play()`、`reset()` 或重载脚本后再恢复（清空错误状态），彻底避免 60fps 异常刷屏；
   - 若显式配置 `errorPolicy: 'throttle'`：按错误签名（错误类型 + 报错信息）去重，并在 `errorThrottleMs`（默认 `1000 ms`）窗口内仅上报一次，帧恢复正常后重置签名状态。

#### 真实作品接入示例（以露缇原型为例）
无论是单文件原型还是完整前端工程，接入方式完全一致且不依赖任何目录约定：

```js
import { mountPerformance } from './rig-runtime/player.js'
import * as lutiePerformance from './any/folder/lutie-live.js'

const live = await mountPerformance(containerEl, {
  rig: './any/assets/lutie-slices/',
  performance: lutiePerformance,
  poster: './any/assets/lutie-slices/reference.png',
  viewport: { fit: 'contain', anchor: [0.5, 1.0] },
  errorPolicy: 'pause',
  onError: (err) => console.warn('Koma Live:', err),
})

// 作品业务逻辑只需发送语义事件，不耦合内部骨骼名与动画细节
containerEl.addEventListener('click', () => live.trigger('tap'))
live.setState('happy')
```

---

## 3. Koma Live（动帧展示与作品工坊）设计方案

定位为与 **Koma Studio（绑骨工作台）** 并列、但视觉气质截然不同的 **纯净动帧展示与互动工坊**：

- **Koma Studio（绑骨工作台）** = 造骨帧底盘（暗灰严谨的 DCC 绑骨、网格、层序校准台）。
- **Koma Live（动帧工坊）** = 让画格活起来（画布主导、极低界面干扰、既像精致的实时动帧展台，又能给创作者与 AI 实时热载验货）。

### 3.1 页面结构与交互
1. **无干扰全幅动帧画布**：直接由 `mountPerformance` 渲染角色与前后景特效，画布占比 > 90%，默认不显示任何骨架、网格或属性表单。
2. **顶部轻量浮岛**：
   - 左：品牌标识（`Koma LIVE`）+ 作品切换器（当前 Studio 项目、内置样例动帧作品、打开本地目录——兼容 `koma-work.json`、含 `rig.json` 或仅含 `setup.json` 的源目录——以及单独载入单文件演出脚本 `.js`）；
   - 右：一键切回 **绑骨 Studio**（`?view=live` 双向同步）+ **热重载演出脚本**（利用 Blob URL 即刻重新加载本地单文件脚本，保留当前状态与视口）+ **鼠标跟随开关**（`pointerTracking`，关闭时立即将逻辑指针复位归零、屏蔽画布指针事件）+ 审查开关 + 视口实测切换（`居中适屏` / `底边贴齐` / `竖卡 360×540` / `横卡 640×360` 验证响应式零漂移）+ 深浅主题切换。
3. **底部悬浮交互条（完全由契约 `meta` 自动驱动，零硬编码）**：
   - 自动展示 `meta.states` 状态胶囊（单选切换）与 `meta.triggers` 事件触发按钮（点击即发 `live.trigger(name)`）；
   - 紧凑播放控件：播放 / 暂停、`0.25× / 0.5× / 1×` 慢放、时间步进/复位；
   - 环境底色快切：透明棋盘格 / 暗夜 / 柔浅色（检验半透明果冻边缘 `gelGroups` 有无脏边）。
4. **按需开启的审查覆盖层（默认关闭）**：
   - 勾选后在同轴画箱上叠加只读层：实时骨骼位置、图层轮廓网格、逻辑坐标标尺与指针十字读数；
   - 一旦触发 `GeometryError` 或演出脚本异常，宿主按 `errorPolicy: 'pause'` 自动定格在上一有效帧并弹出紧凑诊断条，列出出错图层、时间戳、错误原因并在画箱同轴位置高亮标红出错三角形，支持一键复制诊断回喂给 AI，点击重载或继续后恢复。

### 3.2 为什么能与“作品实际展示”保持 100% 一致？
- **零差异执行链**：Koma Live 里除了外层可关闭的透明审查叠加层，底层角色与特效渲染**完完全全跑在 `mountPerformance` 里**，不存在“预览一套渲染、作品另一套渲染”。
- **卡片框实测模式**：内置“模拟嵌入容器（如 360×540 竖卡 / 640×360 横卡）”预览，当场肉眼验证在真实网页卡片里无裁切、无锚点偏移、无指针失准、高清屏 DPR 不发糊。

---

## 4. 代码原生顶点变形口（Mesh Field）与演进边界

- **明确不做**：全局语义参数绑定面板、传统手捏 FFD 晶格编辑器。
- **已落地接口（M4）**：在 `rig-core`（[mesh-field.ts](../packages/rig-core/src/mesh-field.ts)、[pose.ts](../packages/rig-core/src/pose.ts)）与 `LivePoseInput`（[game.ts](../packages/rig-renderer/src/game.ts)）中开放无 UI 负担的 `deform?: Record<string, MeshFieldFn | { grid?: [cols, rows], field: MeshFieldFn, minRatio?: number }>`：
  - `(u, v) ∈ [0, 1]²` 为切片局部归一化坐标，`(x, y)` 为原画布静止像素坐标（`rect.x + u * rect.w, rect.y + v * rect.h`），`[dx, dy]` 统一在静止空间施加后，再执行单骨矩阵变换或骨链蒙皮；
  - 支持普通矩形与轮廓/骨链网格的按需缓存细化（`1..16`，默认 `6×6`）、X 轴扫描裁剪加速的 `checkGeometry` 安全校验、以及后续帧省略 `deform` 时渲染几何与 `gelGroups` 覆盖层的像素级干净回退。
- **已封板基础设施**：运行期 `validateGeometry` 开关（播放态默认关闭，审查/`inspect:live` 开启）、常规层 `rgba8unorm`、`LivePoseInput` 逐层 `opacity / tint / clipTo`（通用 Alpha 裁切蒙版）、同轴 2D 层 `layerResolutionScale`，以及零脚本改动的 `rig export-work --scale <0.25..1>`（`manifest.textureScale`）详见 [设计哲学与演进路线](design-philosophy.md#四koma-live-基础设施边界与极简克制原则)。

---

## 5. 实现与验证映射

| 模块 | 落地文件 |
|---|---|
| 契约校验与 4 条护栏纯数学/状态机 | [work.ts](../packages/rig-core/src/work.ts) · [work.test.ts](../packages/rig-core/test/work.test.ts) |
| 统一承载运行时 `mountPerformance` | [performance.ts](../packages/rig-renderer/src/performance.ts) · [runtime.ts](../packages/rig-renderer/src/runtime.ts) → `packages/rig-renderer/dist/runtime/player.js` |
| Koma Live 动帧工坊与顶栏一键切换 | [KomaLive.vue](../apps/rig-studio/src/KomaLive.vue) · [live-work.ts](../apps/rig-studio/src/live-work.ts) · [App.vue](../apps/rig-studio/src/App.vue) |
| 单文件自包含样板作品 | [koma-work.json](../examples/gbot/koma-work.json) · [gbot-live.js](../examples/gbot/motion/gbot-live.js) |
| 端到端浏览器回归（Retina 2× DPR） | [koma-live.browser.mjs](../tests/koma-live.browser.mjs)（`npm run test:live`） |
