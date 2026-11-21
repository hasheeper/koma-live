# Koma Live 动帧视觉验收与自由排版工具规划

> **状态**：第一步（`npm run inspect:live` 自由排版验收工具 + `setup.json` 自动合成）与第二步（GBot 纯刚体机器人动画重做与逐帧验收）均已落地并通过回归（`npm run test:live`）；第三步（Koma Live 页面轻量洋葱皮开关）待按需启动。  
> **关联文档**：[演出契约与 Koma Live](performance-contract.md) · [功能规格](implementation-plan.md) · [AI 演出技能](../.agents/skills/koma-rig-animation/SKILL.md)

## 1. 设计动机：为什么不是“录视频”，也不是“写死模板”？

多模态大模型看视频本质是低帧率（常约 1 fps）、压缩分辨率的抽帧，既抓不住 `0.18s` 蓄力、`0.27s` 蹬地、`0.72s` 砸地这类关键力学瞬间，也无法在 GPT / Claude 等不支持视频输入的编码 Agent 间通用。

另一方面，如果把验收工具做成“只能输出固定 3×3 拼图 + 固定蓝绿洋葱皮”的死板工具，又会限制 Agent 的审查判断——不同角色、不同动作需要检查的焦点截然不同：
- **刚体机器人跳跃**：最需要看“蓄力→离地→顶点→砸地”的 6 格胶片带 + 重心抛物线洋葱皮 + **脚底局部 2× 放大特写与地面参考线**（抓滑步/穿地）；
- **软体长发 / 触手摆动**：最需要看高密连续洋葱皮弧线 + 网格三角线（抓折角/自交趋势）；
- **半透明边缘 / `gelGroups` 核验**：最需要切到 **`alpha` 黑白通道视图** 直接揪出半透明边缘脏点与接缝漏底；
- **响应式不漂移验收**：最需要把全屏容器与 `360×540` 竖卡的**同一时刻**截图并排对比。

因此，本工具的核心设计原则是 **“只提供高自由度、正交的采样与排版原语，不写死审片模板与业务规则”**：由理解 `rig-spec.json` 和角色气质的 LLM / Agent 自主决定 **演什么剧本、采哪些时刻、怎么分栏排版、裁哪块特写、看 RGBA 还是 Alpha 通道、叠哪些影子帧与标尺线**。

---

## 2. 总体架构与包边界死线

- **包边界死线**：
  - `packages/rig-core` 保持纯粹（仅管骨架/绑定/几何/工作清单求值），**不放入** `inspectPlan` 校验或任何审片排版定义；
  - `inspectPlan`（`koma-rig.inspect.v1`）校验与合成逻辑**仅在 `apps/rig-cli` 侧以零额外依赖方式维护**（严格遵守 `apps/rig-cli` 的依赖护栏）；
  - `packages/rig-renderer` 仅增加极薄的确定性步进/指针原语，**零膨胀**、零审片排版代码进入 `player.js`。
- **执行链路**：复用已打包的 `packages/rig-renderer/dist/runtime/player.js`（`mountPerformance`）与仓库已有的 `playwright-core`，零视频转码依赖。

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 调用入口：npm run inspect:live（apps/rig-cli/inspect-live.mjs）          │
│  A. 自由排版模式：--plan review.json 或 --plan -（stdin 管道）            │
│  B. 快捷 CLI 模式：--trigger / --times / --onion 等一键语法糖              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 1 层：确定性剧本回放与同步抓帧内核（Timeline Sampler）                  │
│  · 通过 mountPerformance 按固定微步（stepMs，默认 10ms）回放任意事件序列    │
│  · 同一帧同步微任务内将 back→puppet→front 绘入离屏 2D 帧缓存（防 WebGL    │
│    双缓冲清空或延迟一帧）                                                 │
│  · 支持跨容器/跨视口分组独立采样，确保同一时刻可在不同尺寸框下直接对比      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 2 层：声明式视觉审片排版器（Board Composer）                            │
│  · Agent 在一张或多张 PNG 画板上自由组合行/列分栏与 4 种画格原语：          │
│    strip / grid（胶片带）、onion（洋葱皮）、frame（特写）、compare         │
│  · 明确不做折线图；支持 channel: 'rgba' | 'alpha' 黑白通道检视模式         │
│  · 每个画格独立控制：crop 特写、底色、角标、叠加层（骨架/网格/运动弧线      │
│    点阵 arcs / 参考线 guides / GeometryError 标红）                       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 第 3 层：开放式运动学遥测（telemetry.json + 可选单帧 PNG）                  │
│  · 忠实输出每帧骨骼世界 start / end / rotationDeg / effectiveScale、       │
│    部件中心点与异常列表；不硬编码业务评判规则                               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 原语详细设计（协议 `koma-rig.inspect.v1`）

### 3.1 运行时极薄前置增量：`advanceBy(deltaMs)` 与 `setPointer(...)`

目前 [performance.ts](../packages/rig-renderer/src/performance.ts) 的 `stepTo(timeMs)` 语义是“从 `0` 重置并快进到 `timeMs`”。为了支持**带中途事件剧本**（例如 `t=100ms` 触发 `jump`、`t=220ms` 移动鼠标）的确定性逐段推进，在 `MountedPerformance` 补充两个极薄原语（零新依赖）：

- `advanceBy(deltaMs: number)`：保持暂停态与当前内部状态，从当前 `timeMs` 起按 `stepMs`（默认 `10 ms`）固定微步确定性推进 `deltaMs`；`stepTo(timeMs)` 内部复用 `reset()` + `advanceBy(timeMs)`。
- `setPointer(pointer: Partial<LogicalPointer>)`：供无头剧本注入精确逻辑指针位置与按压状态（与真实 DOM 指针事件共用同一逻辑坐标系，零漂移）。

---

### 3.2 输入源与自由剧本原语（`source` & `timeline`）

支持任意目录结构（`koma-work.json`、含 `koma-work.json` 或 `manifest.json` 的目录简写，或直接指定 `rig` 目录 + 单文件 `performance.js`），不绑定任何仓库路径约定：
- **源目录 `setup.json` 零落盘自动合成**：若目标切片目录尚无 `rig.json` 但含 `setup.json`（如 `apps/rig-studio/src/samples/gbot`、`examples/chain-strip` 等源目录），`inspect:live`、`rig spec` 以及 Koma Studio / Koma Live 本地目录载入均会在内存中自动执行 `editRig(manifest, emptyRig, setup.json)` 动态合成骨架（无 `setup.json` 则退回空骨架），不修改原目录；并在启动 Chromium 前提前校验 `manifest.json` / `setup.json` 以即时暴露清晰报错。
- **配套 CLI 骨架快查**：写脚本前可直接运行 `npm run rig -- spec <目录> [输出.json]` 零落盘打印或导出 `rig-spec.json`（同样兼容 `rig.json` 与 `setup.json` 源目录）。

```json
{
  "format": "koma-rig.inspect.v1",
  "source": {
    "work": "./examples/live-demo/koma-work.json",
    "viewport": { "fit": "contain", "anchor": [0.5, 1.0] }
  },
  "stepMs": 10,
  "timeline": [
    { "at": 0, "state": "idle" },
    { "at": 80, "pointer": { "nx": 0.6, "ny": -0.2 } },
    { "at": 100, "trigger": "jump" },
    { "at": 600, "pointer": { "nx": 0, "ny": 0 } }
  ]
}
```

支持的剧本事件原语（可按 `at` 时间戳任意数量、任意顺序编排）：
- `state`：切换高层演出状态（`live.setState`）
- `trigger` + 可选 `payload`：触发瞬时交互（`live.trigger`）
- `pointer`：设置逻辑画布坐标（支持 `x/y` 逻辑像素或 `nx/ny` 归一化坐标、`inside`、`down`），支持 `{ "at": 100, "to": 500, "pointerTrack": [...] }` 线性插值轨迹以测试鼠标跟随阻尼
- `reset: true`：中途复位（方便在同一趟剧本里串拍多个互不干扰的动作）
- `container` / `viewport`：中途切换模拟容器尺寸（如 `[360, 540]`）或 `fit / anchor`

---

### 3.3 自由排版画板原语（`boards[]`）

Agent 可以一次声明生成 **1 张或多张 PNG 审片板**；每张画板由自由的 **区块流（`sections`：纵向堆叠，每个区块可自由指定 `columns` 列宽比例或自动等分）** 组成。

#### 四种画格原语（明确拍板范围，不增加数值折线图）

| 画格原语 | 能力与自由度 | 典型用途 |
|---|---|---|
| **`strip` / `grid`** | 自由指定 `frames`（任意不等间隔时间点数组，或 `{ from, to, count \| every }`）、自由 `columns`（`6` 即横胶片带、`3` 即 3×2 网格）、每格支持独立 `label` 与 `crop` | 纵览 5 段跳跃结构、状态切换序列、眨眼/口型帧序列 |
| **`onion`**（Spine 式影子帧） | 自由指定任意一组叠加时刻、任意主帧 `focus`（支持单个或多个实色关键帧）、透明度曲线 `alpha: [min, max]`、着色策略 `tint: 'spine' \| 'mono' \| 'none' \| { past, future }`（默认 Spine 经典“过去偏蓝、未来偏青、主帧原色”）、`stepOrder: 'chronological' \| 'focus-on-top'` | 审脚底滑步重影、运动节奏间距（Spacing）、挥手弧线顺滑度、软体波动相位 |
| **`frame`** | 单张高清大图，支持自由 `crop: [x, y, w, h]` 局部放大特写与自定义标注 | 2× 放大审脚底着地、手腕关节接缝、半透明 `gelGroups` 边缘、下颌表情 |
| **`compare`** | 支持**同一时刻不同容器/视口配置**（如全屏 `[800, 600]` vs 竖卡 `[360, 540]` 同在 `t=280ms`）或**跨时刻同构画面**的并排 / 叠差对比（`mode: 'side-by-side' \| 'overlay'`） | 跨视口零漂移对比（含真实容器盒贴边验证）；静止参照帧 vs 落地帧叠差查偏移 |

#### 所有画格共享的自由视觉控制
- **`channel?: 'rgba' | 'alpha'`**（默认 `'rgba'`）：
  - `'alpha'` 模式将透明合图的 Alpha 通道映射为黑白灰度图（`alpha = 0` 纯黑、`alpha = 255` 纯白、半透明呈灰阶），专门用来揪出半透明边缘脏点、`gelGroups` 接缝漏底与裁切毛边。
- **`crop?: [x, y, w, h]`**：以 `manifest.canvas` 逻辑像素自由裁切放大任意局部区域。
- **`background?: 'dark' | 'light' | 'checker' | string`**：每格独立选底色（`alpha` 通道模式下默认黑底以凸显微弱漏底噪点）。
- **`caption?: string` / `showTime?: boolean`**：自由标题、区块说明文字与精确时间戳角标。
- **`overlays`**（全部默认关闭，按需任意组合，零强制）：
  - `bones?: boolean | string[]`：绘制全部或指定骨骼的连线与关节圆点（青色 `#3df2ff`）；
  - `mesh?: boolean | string[]`：绘制网格三角线；
  - `arcs?: Array<{ target: string, point?: 'start' | 'end' | 'pivot', color?: string, dots?: boolean }>`：沿着洋葱皮或时间段内的采样帧绘制指定骨骼/部件的 **运动弧线与时间点阵（Motion Arc）**——默认调色盘首选高对比琥珀金 `#fbbf24`（与青色骨架鲜明区分），起点为空心描边圈、过程为实心点阵、终点为白环实心大圆，画格较宽时自动在右下角叠加紧凑弧线图例胶囊；
  - `guides?: Array<{ y?: number, x?: number, label?: string, color?: string }>`：自定义水平/垂直参考线（如地面线 `y: 867`、中轴线 `x: 285`），水平与垂直标签均自带半透明深色底衬并按可见画格范围自动钳制（`crop` 局部放大特写时标签不飞出裁切框）；
  - `bounds?: boolean`：逻辑画布边框与刻度；
  - `errors?: boolean`（默认 `true`）：若某帧触发 `GeometryError`，自动在该格用警示红描出出错三角形并标注错误提示；
  - `compare` 的 `overlay` 叠差模式同样支持叠加 `overlays`，并在左上角徽章用色点标明各对比帧对应的叠色。

---

### 3.4 三项关键实现防坑设计

#### 防坑 1：WebGL 抓帧同步（杜绝空帧与延迟一帧）
- `packages/rig-renderer` 的 PixiJS WebGL 默认采用标准 `preserveDrawingBuffer: false`，浏览器合成器一旦过帧就会清掉 WebGL 绘图缓冲。
- **确定性同步抓帧规则**：在每一目标采样步 `advanceBy(...)` 完成 `instance.update(...)` → `puppet.setPose(...)` → `app.render()` 后的 **同一个同步 JS 执行栈（绝不跨 `requestAnimationFrame` 或 `setTimeout`）** 内，立即按同轴层序把 `back` → `puppet.canvas` → `front` 依次 `drawImage` 合成到该时刻专属的离屏 2D 帧缓存（保留完整逻辑分辨率与 Alpha 通道）。
- 抓帧同时记录画布非零 Alpha 像素存在性，彻底杜绝无头 SwiftShader 下抓到空白帧或上一帧残影。

#### 防坑 2：跨视口同帧对比（支持同 `t` 多容器尺寸分别采样）
- 在 `compare` 画格中，每个待对比条目都可独立声明 `container?: [width, height]` 与 `viewport?: WorkViewportInput`（例如对比 `t = 280ms` 在 `[800, 600]` 与 `[360, 540]` 下的实际落盒结果）：
  ```json
  {
    "kind": "compare",
    "caption": "t=280ms 跨视口零漂移验证",
    "mode": "side-by-side",
    "entries": [
      { "t": 280, "label": "全屏 800×600", "container": [800, 600], "viewport": { "fit": "contain", "anchor": [0.5, 1] } },
      { "t": 280, "label": "竖卡 360×540", "container": [360, 540], "viewport": { "fit": "contain", "anchor": [0.5, 1] } }
    ]
  }
  ```
- **采样分组机制**：采样器按 `(container, viewport)` 上下文键对所有面板的采样请求做分组——默认逻辑画布组只跑 1 趟回放采集透明逻辑合图；若 `compare` 中包含不同容器尺寸的对比项，则按对应容器上下文分别独立重放该段剧本并在同步帧内采集**带真实容器框缩放结果（含容器外框尺寸标尺与画箱贴边位置）**的对比图，确保同一 `t` 在多个视口下的对比互不覆盖、100% 真实反映实际嵌入排版。

#### 防坑 3：遥测补充世界旋转角 `rotationDeg`
- `telemetry.json` 中每帧每个骨骼采样统一包含 4 项几何事实：
  ```json
  {
    "format": "koma-rig.telemetry.v1",
    "canvas": { "width": 625, "height": 995 },
    "stepMs": 10,
    "samples": [
      {
        "timeMs": 280,
        "state": "idle",
        "bones": {
          "hip": {
            "start": [280.4, 710.0],
            "end": [280.4, 671.0],
            "rotationDeg": -90.0,
            "effectiveScale": [1.0, 1.0]
          },
          "foot_r": {
            "start": [207.0, 867.0],
            "end": [305.0, 895.0],
            "rotationDeg": 15.945,
            "effectiveScale": [1.0, 1.0]
          }
        },
        "parts": {
          "tex-foot_r": { "pivot": [256.0, 880.5], "visible": true }
        },
        "errors": []
      }
    ]
  }
  ```
- `rotationDeg` 由世界仿射矩阵 `bone.matrix = [a, b, c, d, tx, ty]` 精确导出：`Math.atan2(b, a) * 180 / Math.PI`（顺时针为正，与 `rig-spec.json` 坐标系完全一致），保留 3 位小数；`effectiveScale` 为 `[hypot(a, b), hypot(c, d)]`。Agent 无需自行反推即可直接核对关节绝对角度、角度变化曲线与刚体无形变缩放。

---

### 3.5 双入口调用方式（`npm run inspect:live`）

1. **自由排版模式（主力，给 LLM / Agent 完整排版自由）**：
   ```sh
   npm run inspect:live -- --plan review-plan.json
   # 或通过 stdin 管道动态传入 JSON，免落临时文件
   cat <<'EOF' | npm run inspect:live -- --plan -
   { ... }
   EOF
   ```
2. **快捷模式（内部自动翻译为标准 `koma-rig.inspect.v1` 清单）**：
   ```sh
   npm run inspect:live -- ./examples/live-demo/koma-work.json \
     --state gust --trigger flick@120 \
     --times 0,120,220,340,520,800 \
     --onion 120..620:8 --arcs tip.end \
     --channel rgba \
     --out .tmp/inspect
   ```
   同样支持直接传入目录路径（自动识别其中的 `koma-work.json` 或 `manifest.json` + `performance.js` + `setup.json`），或以 `--rig <dir> --script <file.js>` 运行任意本地开发目录。

---

## 4. 综合混排审片单示例（`rgba` + `onion` + `alpha` + 跨视口 `compare`）

```json
{
  "format": "koma-rig.inspect.v1",
  "source": { "work": "./my-bot/koma-work.json" },
  "timeline": [
    { "at": 0, "state": "idle" },
    { "at": 100, "trigger": "jump" }
  ],
  "outDir": ".tmp/inspect-jump",
  "exportTelemetry": true,
  "boards": [
    {
      "file": "jump-review.png",
      "title": "GBot Jump — 刚体跳跃与边缘综合审片板",
      "background": "#12141a",
      "width": 1680,
      "sections": [
        {
          "columns": 1,
          "panels": [
            {
              "kind": "strip",
              "caption": "5 段力学关键帧（t=100ms 触发 jump）",
              "columns": 6,
              "background": "dark",
              "frames": [
                { "t": 100, "label": "起始待机" },
                { "t": 280, "label": "蓄力最低" },
                { "t": 370, "label": "蹬地离地" },
                { "t": 600, "label": "滞空顶点" },
                { "t": 860, "label": "重金属砸地" },
                { "t": 1350, "label": "伺服站稳" }
              ],
              "overlays": { "guides": [{ "y": 867, "label": "ground" }] }
            }
          ]
        },
        {
          "columns": [1.3, 1, 0.9],
          "panels": [
            {
              "kind": "onion",
              "caption": "起跳→砸地洋葱皮 + 重心/右靴弧线",
              "range": { "from": 220, "to": 920, "count": 9 },
              "focus": [370, 600, 860],
              "tint": "spine",
              "alpha": [0.16, 0.55],
              "background": "checker",
              "overlays": {
                "arcs": [
                  { "target": "hip", "point": "start", "color": "#3df2ff", "dots": true },
                  { "target": "foot_r", "point": "start", "color": "#fbbf24", "dots": true }
                ],
                "guides": [{ "y": 867, "label": "ground", "color": "#ef4444" }]
              }
            },
            {
              "kind": "grid",
              "caption": "双靴接触 2× 特写（RGBA + Alpha 通道）",
              "columns": 1,
              "crop": [150, 740, 300, 210],
              "frames": [
                { "t": 280, "label": "蓄力深蹲 · RGBA", "background": "checker", "channel": "rgba" },
                { "t": 860, "label": "砸地瞬间 · Alpha 通道查毛边", "channel": "alpha" }
              ],
              "overlays": {
                "bones": ["shin_r", "foot_r", "shin_l", "foot_l"],
                "guides": [{ "y": 867, "color": "#ef4444" }]
              }
            },
            {
              "kind": "compare",
              "caption": "t=280ms 跨视口零漂移比对",
              "mode": "side-by-side",
              "entries": [
                { "t": 280, "label": "800×600", "container": [800, 600], "viewport": { "fit": "contain", "anchor": [0.5, 1] } },
                { "t": 280, "label": "360×540", "container": [360, 540], "viewport": { "fit": "contain", "anchor": [0.5, 1] } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 5. 分阶段实施路线与当前状态

### 第一步（已完成）：运行时微增 + `inspect:live` 自由排版验收引擎
1. **运行时微增**（[performance.ts](../packages/rig-renderer/src/performance.ts)）：
   - 已落地 `advanceBy(deltaMs)`（`stepTo(timeMs)` 复用 `reset()` + `advanceBy(timeMs)`）、`setPointer(pointer)` 与 `pointerTracking / setPointerTracking(enabled)`；
   - `npm run typecheck`、`npm run build:runtime` 与 `npm run test:live` 全绿。
2. **`apps/rig-cli` 侧独立契约校验与快捷翻译**（零新增依赖，不碰 `packages/rig-core`）：
   - 已落地 [inspect-plan.mjs](../apps/rig-cli/inspect-plan.mjs) 与 [inspect-plan.test.ts](../tests/inspect-plan.test.ts)（覆盖 `strip / grid / onion / frame / compare`、`channel: 'rgba' | 'alpha'`、跨视口 `compare.entries` 采样分组与快捷 CLI 翻译）。
3. **无头同步抓帧、自由排版合成与开发目录直通**（[inspect-live.mjs](../apps/rig-cli/inspect-live.mjs) · [inspect-composer.mjs](../apps/rig-cli/inspect-composer.mjs) · [rig.mjs](../apps/rig-cli/rig.mjs)）：
   - 本地临时静态服务按需映射目标作品文件，支持目录简写与 `setup.json` 内存动态合成（提前校验、不污染源目录），同步提供 `npm run rig -- spec <目录> [输出.json]` 零落盘查看 `rig-spec.json`；
   - 在 Playwright Chromium 中按固定微步推进剧本，每步同步将 `back → puppet → front` 绘入离屏 2D 缓存（确保 WebGL 非空且无滞后一帧），支持同 `t` 跨视口 `compare` 独立采样与 `overlay` 叠差对比；
   - 审片板叠加层采用高对比琥珀金弧线（带起止点区分与图例）、裁切安全带底衬的水平/垂直 `guides`、骨骼/网格与 `GeometryError` 标红，输出高清 `boards[]` PNG 与含 `rotationDeg` / `effectiveScale` 的 `telemetry.json`。
4. **端到端回归与 `SKILL.md` 闭环**：
   - [koma-live.browser.mjs](../tests/koma-live.browser.mjs) 全面验证同步 WebGL 抓帧、`alpha` 通道、Spine 洋葱皮、同 `t` 跨视口 `compare`、`overlay` 叠差、`setup.json` 自动合成、同刻 `state + pointer` 注入与 `telemetry.json`；
   - 已同步沉淀至 [SKILL.md](../.agents/skills/koma-rig-animation/SKILL.md)、[tools-and-contracts.md](../.agents/skills/koma-rig-animation/references/tools-and-contracts.md) 与 [craft-and-playbooks.md](../.agents/skills/koma-rig-animation/references/craft-and-playbooks.md)。

### 第二步（已完成）：重做 GBot 纯刚体机器人动画并用 `inspect:live` 逐帧验收
- 已按刚体规范（全骨 `scale = 1` + 2-Bone IK 双脚焊地 + 5 段重金属跳跃 + 干净招手 + 硬金属受击 + 地板钳制 2D 机械特效）重写 [gbot/performance.js](../apps/rig-studio/src/samples/gbot/performance.js)，通过两轮自由排版审片板迭代修复全部细节，并将全骨 `effectiveScale === [1, 1]` 与地面 0px 焊地不变量锁定在 `npm run test:live` 回归中。

### 第三步（按需）：Koma Live 网页端轻量洋葱皮开关
- 在 [KomaLive.vue](../apps/rig-studio/src/KomaLive.vue) 审查层增加暂停态影子帧开关（零实时播放开销）。
