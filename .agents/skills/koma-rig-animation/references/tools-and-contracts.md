# Koma Rig 工具与运行时契约手册

面向命令速查、坐标系换算、`rig-spec.json` / `koma-work.json` / `koma-rig.performance.v1` 契约与 `npm run inspect:live` 审片配置。

---

## 1. 全链路 CLI 与本地开发工作流

### 1.1 PSD 离线切片与去噪烘焙（`tools/psd`）

```sh
# 方式 A：单命令去孤立噪点/整画布雾噪、跳过隐藏参考层、自动去抠图白边 + 按 sRGB PMA 烘焙干净 reference.png 并内置 0 误差复验（推荐）
uv run --locked --project tools/psd python -m layer_rig_psd.slices \
  character.psd examples/char/slices --source-id char --skip-hidden --trim-stray --defringe white --bake-reference

# 方式 B：提供美术导出的独立参考 PNG
uv run --locked --project tools/psd python -m layer_rig_psd.slices \
  character.psd reference.png examples/char/slices --source-id char --skip-hidden --trim-stray
```

- 前置要求：8-bit RGB PSD，普通栅格图层（蒙版/剪贴/特效/组混合须在美术侧先烘焙）。
- `--trim-stray` 采用滞后连通域清理（`strong >= 40, weak >= 6, halo = 3px`），保留连通柔边、清掉孤立角落脏点与低透明雾膜，输出 JSON 含 `trimmedLayers` 与 `hazeWarnings`（自动标记大面积低透明雾噪层）。
- `--defringe white|black|#RRGGBB`（及对已有切片包直接执行的 `npm run rig -- defringe <作品或切片目录> [--matte white] [--strength 1.0] [--layers a,b] [--exclude c,d] [--dry-run]`）采用颜色空间逆混合（按局部干净内色 $F \to M$ 投影反解杂色比例 $t$ 并同步还原 $\alpha_{\text{new}}=\alpha(1-t)$），清除半透明白边与 1–2 px 实心抠图杂边，同时保留纯白蕾丝/白发与彩色自发光，不改 `rect` 与 `rig.json` 并自动重烘复验 `reference.png`。
- 切片清单 Schema 纪律：`manifest.json` 的 `texture` 路径必须平铺在 `textures/` 根目录（匹配 `/^textures\/[A-Za-z0-9_-]+\.png$/`，不可建子目录）；新增表情/漫符等非默认差分图层时，在 `manifest.json` 置 `visible: false` 即可同时保持 `verify-slices` `mismatches === 0` 且运行期由 `slots` 正常切换。
- 复验已有切片包：`npm run rig -- verify-slices <切片目录> [差异热图.png]`（8-bit PMA 逐像素比对，`mismatches === 0` 通过）。

### 1.2 骨架编辑、自动轮廓网格与安全角体检（`npm run rig`）

`spec`、`auto-mesh`、`check-bend` 均同时兼容 `koma-work.json` 作品根目录与切片目录，且在无 `rig.json` 时自动从 `setup.json` 内存合成：

```sh
# 导出或打印 rig-spec.json（骨骼树、静止坐标、图层绑定、差分槽）
npm run rig -- spec <作品或切片目录> [rig-spec.json]

# 为缺网格的 boneChain 图层批量生成低凹度防翻面轮廓网格（支持 --dry-run / --all / --layers a,b / --overwrite）
npm run rig -- auto-mesh <作品或切片目录> --dry-run
npm run rig -- auto-mesh <作品或切片目录>

# 扫描全部 boneChain 逐节与联动的最大无翻面转角，低于 warn-below 自动标 warn
npm run rig -- check-bend <作品或切片目录> --max-angle 75 --warn-below 18

# 批量应用 RigEdit JSON 操作数组并保存
npm run rig -- edit <切片目录> edits.json
npm run rig -- save <切片目录>

# 导出只读展示包（可选 --scale 0.5 预乘防黑边降采贴图，写入 manifest.textureScale，rig.json 与脚本零改动、省 4× 显存）
npm run rig -- export-work <作品目录> <输出目录> [--scale 0.5] [--runtime <运行时目录>] [--no-poster]
```

- `auto-mesh` 默认预设：
  - `boneChain` 图层：`detail: 28, concavity: 10, refinement: 50, padding: 4`（低凹度防翻面）
  - 单骨图层（`--all`）：`detail: 42, concavity: 32, refinement: 50, padding: 3`（高贴合）
  - 可用 `--detail` / `--concavity` / `--padding` / `--refinement` / `--alpha-threshold` 覆盖。
- `rig.json` 差分槽（`semantics.slots`）纪律：每个非默认状态都必须在 `transitions` 中存在回到 `default` 的有向边（每条边须含 `minHoldMs: 0, exitWindowMs: [0, 0]`），否则 `rig spec` 会报无法回到默认态。
- `set-layer` 图层设置支持 `visible`、`locked`、`peekOpacity`、`peekAfter`（ACGN 透发）以及 `clipTo`（通用图层 Alpha 裁切蒙版，目标不可为自身）。

### 1.3 Studio 与 Koma Live 零摩擦联调

- 启动开发服务：`npm run dev -- --host 127.0.0.1 --port 5186`
- 开发态直达 URL（免 Finder 选目录，刷新自动记忆）：
  - Studio 绑骨：`http://127.0.0.1:5186/?work=examples/<name>`
  - Koma Live 动帧：`http://127.0.0.1:5186/?view=live&work=examples/<name>`
- **全量热重载与同步**：
  - Koma Live 默认开启**自动热重载**（工具栏可暂停），同时监听 `koma-work.json`、`manifest.json`、`rig.json`、`performance.js` 改动并保持当前 `state`，未变化贴图命中缓存。
  - Studio 打开同一作品目录后，外部 CLI/AI 更新 `rig.json` 时：无未保存编辑自动同步，有未保存编辑顶部提示选择覆盖或忽略；菜单也支持手动「从目录重新载入 rig.json」。
  - 静态部署版通过 IndexedDB 记住最近目录句柄（刷新自动/一键恢复），且支持直接向画布拖入目录或 `.js` / `rig.json`。

---

## 2. `rig-spec.json` 与坐标系精确规则

```ts
interface RigSpec {
  format: 'koma-rig.spec.v1'
  rigId: string
  rigVersion: number
  canvas: { width: number; height: number }
  coordinates: {
    origin: 'top-left'
    yAxis: 'down'
    rotation: 'clockwise-degrees'
    translateSpace: 'parent-local'
    scaleDefault: 1
  }
  bones: Array<{
    boneId: string
    name: string
    parentBoneId: string | null
    length: number
    restRotation: number        // 父空间静止角（度）
    restStart: [number, number] // 世界静止起点（画布 px）
    restEnd: [number, number]   // 世界静止终点（画布 px）
  }>
  layers: Array<{
    layerId: string
    name: string
    visible: boolean
    boundTo?: { boneId?: string; boneChain?: string[] }
    deformerKind?: 'ffd' | 'ribbon'
    hasMesh: boolean
  }>
  slots: Array<{ slot: string; states: string[]; default: string }>
}
```

### 陷阱 1：子骨 `x / y` 平移在父骨局部空间
- **根骨（`parentBoneId === null`）**：`x / y` 直接沿画布 `+X`（右）、`+Y`（下）移动。
- **子骨（`parentBoneId !== null`）**：`x / y` 沿**父骨静止朝向**为 `+x`、顺时针 90° 为 `+y`。例如 `head` 朝上（`restRotation ≈ -90°`），给子骨 `eye_l` 传 `{ x: +6 }` 会向上移而非向右移。
- **换算公式**（`rotation` 无此陷阱，永远顺时针为正）：

```js
function buildWorldRestAngles(bones) {
  const byId = new Map(bones.map((b) => [b.boneId, b]))
  const worldDeg = new Map()
  const resolve = (id) => {
    if (worldDeg.has(id)) return worldDeg.get(id)
    const b = byId.get(id)
    const deg = (b?.parentBoneId ? resolve(b.parentBoneId) : 0) + (b?.restRotation ?? 0)
    worldDeg.set(id, deg)
    return deg
  }
  for (const b of bones) resolve(b.boneId)
  return worldDeg
}

function canvasDeltaToParentLocal(dx, dy, parentWorldRestDeg) {
  const rad = (-parentWorldRestDeg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: dx * c - dy * s, y: dx * s + dy * c }
}
```

### 陷阱 2：父级 `scale` 继承与 `GeometryError`
- 矩阵复合顺序：`W_parent · T(b.x + tx, b.y + ty) · R(b.rotation + rot) · S(sx, sy)`。
- 缩放 `torso` 会连带拉扯 `head`、五官和头发：若只需局部呼吸，优先用轻微 `y` 位移 + `rotation` + 肩部联动，或在轴向微缩放时对 `head` 做反向缩放（`1 / torsoSx, 1 / torsoSy`，且仅在接近 1 时使用避免旋转剪切）。
- `scaleX / scaleY` 严禁 `<= 0`、`NaN`、`Infinity`；骨链骨骼一般控制在 `0.85–1.15`。
- `setPose` 每次都会校验三角形翻面/退化/自交，**禁止静默 `catch` 吞掉 `GeometryError`**；由宿主保留上一合法帧并触发 `errorPolicy`（默认 `pause`），在 Koma Live 中直接标红翻面三角形。

---

## 3. 运行时接口与单文件演出模板

`packages/rig-renderer/dist/runtime/player.js` 同时导出 `mountLiveRig`（底层单帧直驱）与 `mountPerformance`（完整同轴演出承载，驱动 Koma Live）。

### 3.1 `mountLiveRig` 与 Mesh Field（`deform`）关键签名
```ts
interface BoneTransform {
  x?: number        // 父局部平移增量（px）；根骨为画布空间
  y?: number
  rotation?: number // 顺时针旋转增量（度）
  scaleX?: number   // > 0，沿骨轴
  scaleY?: number   // > 0，垂直骨轴
}
// u, v ∈ [0, 1] 为切片局部归一化坐标；x, y 为原画布静止像素坐标 (rect.x + u*rect.w, rect.y + v*rect.h)
// 返回值 [dx, dy] 为静止空间像素位移，在单骨变换与骨链蒙皮之前叠加
type MeshFieldFn = (u: number, v: number, x: number, y: number) => readonly [number, number]
interface MeshFieldSpec {
  field: MeshFieldFn
  grid?: readonly [number, number] // 细分密度 [cols, rows]，整数 1..16，默认 [6, 6]
  minRatio?: number                // 可选最小面积比护栏，默认 0.01
}
type MeshFields = Record<string, MeshFieldFn | MeshFieldSpec>

interface LivePoseInput {
  bones?: Record<string, BoneTransform>
  rotations?: Record<string, number>
  parameters?: Record<string, number>
  slots?: Record<string, string>
  deform?: MeshFields
  /** 逐层运行期透明度倍率 [0, 1]（与驱动透明度相乘；下一帧省略即恢复 1） */
  opacity?: Record<string, number>
  /** 逐层运行期 RGB 染色整数 0x000000..0xffffff（透发层自动继承；下一帧省略即恢复 0xffffff） */
  tint?: Record<string, number>
  /** 逐层运行期 Alpha 裁切目标 layerId（传 null 可临时清除静态 layerSettings.clipTo） */
  clipTo?: Record<string, string | null>
  /** 实时自动裁剪投影（不传沿用 rig.json 的 castShadows，传 [] 清除）：多投射层合并剪影先柔化再按受影层 Alpha 裁切 + multiply 混合，零叠黑零溢出 */
  shadows?: Array<{
    casters: string[]
    receivers: string[]
    offset: [number, number]
    color?: number      // 默认 0x6b5870（肤色推荐按原画阴影采样暖粉灰如 0xd0b0b6，白发推荐冷银灰如 0xbcb8c4）
    opacity?: number    // 默认 0.2
    blur?: number       // 默认 0（锐利 2D 赛璐璐硬影，零高斯模糊开销；>0 可选柔影）
    blendMode?: 'multiply' | 'normal'
  }>
  timeMs?: number
}

interface MountPerformanceOptions {
  // ...work / rig / performance / poster / viewport / initialState / autoplay / pointerTracking / timeScale / stepMs / maxDpr
  /** 同轴 2D back/front 画布缓冲分辨率倍率 (0, 1]（如 0.5 省 75% 像素填充率，逻辑坐标保持 1× 不变） */
  layerResolutionScale?: number
  /** 是否每帧执行全量 checkGeometry 体检（播放态默认 false 提速 ~20×；inspect:live 与 Koma Live 审查态开启 true） */
  validateGeometry?: boolean
}
```
- **Mesh Field 与运行期新原语要点**：
  - 所有绑定模式（未绑骨、单骨 `boneId`、骨链 `boneChain`）统一顺序：**先在静止空间叠加 `[dx, dy]`，再执行单骨矩阵变换或骨链蒙皮**，波浪方向自动跟随部件旋转与弯曲。
  - 普通切片自动生成并缓存 `[cols, rows]` 规则网格；带轮廓网格（`mesh`）或骨链的切片沿静止切线平面细分且严格保留原轮廓边界；同密度复用 `indices` 引用，WebGL 走零重分配快路径且同步作用 `gelGroups` 覆盖层。
  - 动态启停干净回退：后续帧不再传 `deform` / `opacity` / `tint` / `clipTo`（或传 `clipTo: { id: null }`）时自动干净恢复，0 残留。
  - **显存与几何自检**：WebGL 渲染器仅对 `gelGroups` 成员保留 `rgba16float`，其余常规切片默认 `rgba8unorm`（省 50% 显存）；导出包若含 `manifest.textureScale`（如 `0.5`），逻辑画布与坐标仍为 1×，演出脚本零改动。`mountLiveRig` / `mountPerformance` 默认 `validateGeometry: false`（可通过 `setValidateGeometry(true)` 随时开启），而 `inspect:live`、`rig check-bend`、Studio 试动与 Koma Live「审查」模式始终开启全量 `checkGeometry`。

`const pose = puppet.setPose(...)` 返回实时世界坐标 `pose.bones`（`start`, `end`, `matrix`）与 `pose.parts`（`pivot`, `matrix`, `visible`）——前后景特效直接锚定 `pose`，不手算二次矩阵。

**参数化头转。** 在 `semantics.parameters` 声明 `headYaw` 和 `headPitch` 后，演出可用 `puppet.setPose({ parameters: {headYaw, headPitch}, bones, deform, slots })` 驱动烘焙在 `rig.json.morphs` 的位移。单文件脚本管理眨眼与惯性。每次 `setPose` 后，`puppet.projectRestPoint(layerId, [原画布X, 原画布Y])` 可定位实际变形后的眼部高光等附着点。接口读取与 WebGL 相同的三角面。[数据契约](../../../../docs/rig-spec.md) · [烘焙命令](../../../../tools/head-bake/README.md)

### 3.2 `mountPerformance` 四条运行护栏

1. **单文件自包含 ES Module**：零外部相对或包 `import`（兼容 Koma Live `Blob URL` 热重载）。
2. **确定性采样与洁净 `reset()`**：禁用 `Date.now()` / `performance.now()` / `Math.random()`；仅以 `timeMs / dtMs` 与确定性 PRNG 推进，并在 `reset()` 中完全归零内部状态（`stepTo(t)` 通过 `reset()` + 固定 `stepMs` 步进实现）。
3. **2D DPR 逻辑绘制**：宿主已按 `maxDpr`（默认 `2`）设置物理缓冲并预置 `ctx2d.setTransform(pixelScale, 0, 0, pixelScale, 0, 0)`；脚本严格按 `ctx.size` 逻辑像素绘制和清屏，自定义变换用 `save()/restore()`，**禁止调用 `resetTransform()`**。
4. **零环境耦合**：不 `fetch()`、不读 DOM/窗口尺寸、不启 `requestAnimationFrame / setInterval`，在 `destroy()` 清理残留。

### 3.3 `koma-work.json`（`koma-rig.work.v1`）

```json
{
  "format": "koma-rig.work.v1",
  "id": "character-demo",
  "title": "角色待机演出",
  "rig": "./slices/",
  "performance": "./motion/character-live.js",
  "poster": "./slices/reference.png",
  "viewport": { "fit": "contain", "anchor": [0.5, 1.0], "paddingPx": 16 },
  "defaultState": "idle"
}
```

### 3.4 最小可抄单文件演出模板（`koma-rig.performance.v1`）

```js
// Single-file self-contained ES Module (no external imports)
export const meta = {
  format: 'koma-rig.performance.v1',
  title: 'Example Living Idle',
  states: ['idle', 'happy'],
  triggers: ['tap'],
  layers: { back: false, front: '2d' },
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export default function createPerformance(ctx) {
  const { puppet, size, front } = ctx
  let state = 'idle'
  let bounce = 0, bounceVel = 0
  let lookX = 0, lookY = 0
  let rand = mulberry32(42)

  const clearFront = () => front?.ctx2d?.clearRect(0, 0, size.width, size.height)

  return {
    setState(next) { state = next },
    trigger(name) { if (name === 'tap') bounceVel += 18 + rand() * 4 },
    reset() {
      bounce = bounceVel = lookX = lookY = 0
      rand = mulberry32(42)
      puppet.reset()
      clearFront()
    },
    update({ timeMs, dtMs, pointer }) {
      const t = timeMs / 1000
      const dt = Math.min(dtMs, 50) / 1000
      bounceVel += (-120 * bounce - 14 * bounceVel) * dt
      bounce += bounceVel * dt

      const tx = pointer.inside ? Math.max(-1, Math.min(1, pointer.nx)) : 0
      const ty = pointer.inside ? Math.max(-1, Math.min(1, pointer.ny)) : 0
      const follow = 1 - Math.exp(-6 * dt)
      lookX += (tx - lookX) * follow
      lookY += (ty - lookY) * follow

      const pose = puppet.setPose({
        timeMs,
        bones: {
          // 替换为 puppet.spec.bones 中的真实 boneId
          root: { y: Math.sin(t * 1.45) * 4 - bounce * 4 },
          head: { rotation: Math.sin(t * 0.92) * 3 + lookX * 7 },
        },
      })

      if (front?.ctx2d) {
        const g = front.ctx2d
        g.clearRect(0, 0, size.width, size.height)
        const head = pose.bones?.find((b) => b.boneId === 'head')
        if (head) {
          g.save()
          g.fillStyle = 'rgba(180, 235, 255, 0.25)'
          g.beginPath()
          g.arc(head.end[0] + lookX * 8, head.end[1] - 12, 6, 0, Math.PI * 2)
          g.fill()
          g.restore()
        }
      }
    },
    destroy() { clearFront() },
  }
}
```

---

## 4. 无头视觉审片与遥测（`npm run inspect:live`）

支持直接传 `koma-work.json`、目录路径（自动识别 `koma-work.json` 或 `manifest.json + performance.js`，缺 `rig.json` 时内存合成 `setup.json`），或 `--rig <dir> --script <file.js>`：

```sh
# 快捷单板审片
npm run inspect:live -- ./examples/gbot/koma-work.json \
  --state happy --trigger wave@120 \
  --times 0,120,260,420 --onion 120..420:6 --arcs forearm_r.end \
  --out .tmp/inspect

# 自由多分栏审片板（stdin 传入 koma-rig.inspect.v1 JSON）
cat <<'EOF' | npm run inspect:live -- --plan -
{
  "format": "koma-rig.inspect.v1",
  "source": { "work": "./examples/gbot/koma-work.json" },
  "outDir": ".tmp/inspect-gbot",
  "exportTelemetry": true,
  "timeline": [
    { "at": 0, "state": "idle" },
    { "at": 1500, "pointer": { "nx": 0.45, "ny": -0.2, "inside": true } }
  ],
  "boards": [
    {
      "file": "review.png",
      "title": "Idle Physics & Contact Review",
      "width": 1440,
      "sections": [
        {
          "columns": 1,
          "panels": [
            { "kind": "strip", "columns": 5, "frames": [0, 900, 1800, 2700, 3600] }
          ]
        },
        {
          "columns": [1.1, 1, 1],
          "panels": [
            {
              "kind": "onion",
              "range": { "from": 800, "to": 2600, "count": 6 },
              "focus": 1800,
              "tint": "spine",
              "overlays": {
                "arcs": [{ "target": "twintail_l3", "point": "end", "dots": true }],
                "guides": [{ "y": 1480, "label": "floor" }]
              }
            },
            { "kind": "frame", "t": 1800, "channel": "alpha", "crop": [650, 120, 320, 320], "background": "checker" },
            {
              "kind": "compare",
              "mode": "overlay",
              "crop": [500, 1180, 620, 360],
              "entries": [{ "t": 0, "label": "rest" }, { "t": 1800, "label": "peak" }],
              "overlays": { "guides": [{ "y": 1480, "label": "floor" }] }
            }
          ]
        }
      ]
    }
  ]
}
EOF
```

- **Panel 类型**：`strip` / `grid`、`onion`（`tint: "spine" | "mono" | "none" | { past, future }`）、`frame`、`compare`（`side-by-side` 支持不同 `container / viewport` 实测无漂移；`overlay` 支持透明叠影 + 色块图例 + `overlays`）。
- **通用选项**：`channel: "rgba" | "alpha"`、`crop: [x, y, w, h]`、`background: "dark" | "light" | "checker" | "#hex"`、`overlays: { bones, mesh, arcs, guides, bounds, errors }`（`arcs` 默认高对比琥珀色带起止点标记与图例；横/纵 `guides` 自动裁切至 `crop` 内）。
- **遥测文件 `telemetry.json`**：逐样本记录 `bones[id]: { start, end, rotationDeg, effectiveScale }`、`parts[id]`、`pointer`、`errors`，可用于程序化验算脚底滑移、持物锁点误差与刚体缩放零漂移。
