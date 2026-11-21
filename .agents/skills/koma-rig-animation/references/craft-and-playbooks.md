# ACGN / Spine / Live2D 实战经验与物理配方库

沉淀自真实分层立绘与刚体角色实践，覆盖绑骨规范、防翻面网格、可内联物理/IK 配方与高频画面排障。

---

## 1. 立绘绑骨与轮廓网格规范（Rigging Playbook）

### 1.1 标准解剖骨骼层级
按力的传导顺序建树，不把软物直接散挂在根骨上：

```text
root (画布底部重心或骨盆)
├── hip (骨盆，驱动下半身与微重心转移)
│   ├── thigh_l -> shin_l -> foot_l         # 双骨链腿部，供站姿 2-Bone IK 锁地
│   ├── thigh_r -> shin_r -> foot_r
│   ├── skirt -> skirt_hem                  # 百褶裙：腰带根骨锁 hip，下摆 2 节骨链摆动
│   ├── belt_1 -> belt_2                    # 长垂带/皮带：2 节骨链
│   └── torso -> chest                      # 上衣跨 2 节骨链，支持柔和呼吸与微侧倾
│       ├── neck -> head
│       │   ├── eye_lash / eye_white / pupil / brow  # 眼白独立成骨防眨眼露白
│       │   ├── hair_back / twintail_l1..l3 / twintail_r1..r3  # 长发 2–3 节骨链
│       │   ├── bang_c / bang_l1..l2 / bang_r1..r2             # 鬓发 2 节骨链
│       │   └── mask / hair_ribbon_*                           # 头部配饰与发结
│       ├── jacket_l -> jacket_l_hem        # 垂挂外套前/后片：2 节骨链防半边发死
│       ├── jacket_r_collar / jacket_r_hem -> jacket_r_tip
│       ├── shoulder_l -> upper_arm_l -> forearm_l -> hand_l   # 持物手供 2-Bone IK 锁点
│       └── shoulder_r -> upper_arm_r -> forearm_r -> hand_r
│           └── sleeve_bow_front / sleeve_bow_back             # 袖口蝴蝶结前后分层独立
```

### 1.2 什么时候必须升级为骨链 + 轮廓网格
- **单骨足够**：刚性小件（耳环、戒指、靴子、面具、硬质短袖口、小幅微动的短刘海或领结）。
- **必须 2–3 节 `boneChain` + 轮廓网格**：大片悬垂外套、百褶裙、双马尾、长鬓发、长垂带、连体长腿与上衣。只绑单骨时，整片布料只能刚性绕根部转动，画面会明显“整块发死”。
- **轮廓网格防翻面经验**：
  - `boneChain` 图层严禁高凹度描边（尖凹角在轻微折弯时就会触发 `GeometryError` 翻面）。统一使用低凹度预设 `detail: 28, concavity: 10, padding: 4`（Studio 选中骨链层点击「生成骨链轮廓网格」，或 CLI `npm run rig -- auto-mesh <dir>`）。
  - 单骨柔性层可用较高贴合度（`detail: 42, concavity: 32, padding: 3`）。
  - `jointSoftnessPx` 决定关节过渡带宽：窄长垂带/鬓发约 `45–70 px`，厚外套/百褶裙/双马尾约 `85–140 px`；改完立即跑 `npm run rig -- check-bend <dir>` 确认安全转角（目标至少覆盖待机最大摆幅的 1.5–2 倍）。

---

## 2. 活立绘核心物理与数学配方（可直接内联进单文件脚本）

### 2.1 二阶阻尼谐振弹簧（2nd-Order Spring）
用锚点运动加速度与外风作为驱动，内部固定子步积分（`h <= 10 ms`），保证 60Hz / 120Hz / `inspect:live` 10ms 采样结果完全一致：

```js
function createSpring(stiffness, damping, maxAngleDeg = 18) {
  return {
    k: stiffness, c: damping, max: maxAngleDeg,
    pos: 0, vel: 0, acc: 0,
    reset() { this.pos = this.vel = this.acc = 0 },
    step(targetDeg, dtSec) {
      if (dtSec <= 0) return this.pos
      const steps = Math.max(1, Math.ceil(dtSec / 0.01))
      const h = dtSec / steps
      for (let i = 0; i < steps; i++) {
        const a = this.k * (targetDeg - this.pos) - this.c * this.vel
        this.vel += a * h
        this.pos += this.vel * h
        this.acc = a
      }
      if (this.pos > this.max) { this.pos = this.max; if (this.vel > 0) this.vel *= 0.25 }
      else if (this.pos < -this.max) { this.pos = -this.max; if (this.vel < 0) this.vel *= 0.25 }
      return this.pos
    },
  }
}
```

**材质手感参考区间**（具体幅度受 `check-bend` 上限约束）：

| 材质类型 | 典型部件 | 刚度 `k` | 阻尼 `c` | 常见待机摆幅 | 惯性特征 |
|---|---|---:|---:|---:|---|
| 轻薄飘带 / 细发梢 | 蝴蝶结尾、双马尾末节、刘海尖 | `18–34` | `2.6–4.2` | `4°–11°` | 响应灵敏、微过冲、滞后长 |
| 中长主发束 | 双马尾根/中节、侧鬓发 | `22–38` | `3.8–5.6` | `2.5°–7°` | 柔顺连贯、链节逐级传递 |
| 中重布料 | 百褶裙下摆、垂带、披肩袖口 | `28–48` | `5.0–7.5` | `1.8°–5°` | 沉稳有坠感、几乎不过冲 |
| 厚重外套 / 挂件 | 厚夹克下摆、硬皮革带 | `38–60` | `7.0–10.5` | `1.2°–3.5°` | 惯性大、起止克制 |

> **链式传导技巧**：多节骨链不要各节独立乱晃——第 `i` 节弹簧的目标角加入第 `i-1` 节的角速度/加速度项（如 `-parentSpring.vel * 0.14`）叠加风场，立刻出现真实的鞭梢滞后与回弹。

### 2.2 两种常见呼吸与环境场模式（按角色气质选用）

**模式 A · 陆地立绘解耦场（非对称呼吸 × 单向阵风波前）**：
适合地面站姿或偏写实/酷感立绘——把**核心呼吸**留在胸腔/锁骨/肩/微重心内，**外在风场**用跨画布 X 坐标传播的单向阵风（周期远离呼吸周期，避免拍频共振）：

```js
const smoothstep = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u) }
const smootherstep = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * u * (u * (u * 6 - 15) + 10) }

// 非对称呼吸 [0, 1]：缓吸 (0..0.41) -> 顶点微停 (0.41..0.49) -> 松沉呼气 (0.49..1.0)
function asymmetricBreath(tSec, periodSec = 4.35) {
  const u = ((tSec / periodSec) % 1 + 1) % 1
  if (u < 0.41) return smootherstep(u / 0.41)
  if (u < 0.49) return 1 - 0.02 * smoothstep((u - 0.41) / 0.08)
  return 0.98 * (1 - smootherstep(Math.pow((u - 0.49) / 0.51, 0.88)))
}

// 单向阵风波前：风从左向右 (+X) 以 ~760 px/s 掠过不同锚点 worldX，带非周期慢包络
function sampleBreeze(tSec, worldX, originX = 460, speedPxPerSec = 760) {
  const localT = tSec - (worldX - originX) / speedPxPerSec
  const env = 0.58 + 0.30 * Math.sin(localT * 0.648 + 0.4) + 0.14 * Math.sin(localT * 0.411 + 2.2)
  const gust = 0.52 * Math.sin(localT * 1.16 + 0.2) + 0.34 * Math.sin(localT * 2.09 - 0.9) + 0.16 * Math.sin(localT * 3.67 + 1.5)
  return (0.26 + gust) * env
}
```

**模式 B · 水母 / 悬浮协同脉动场（径向呼吸 × 流体延迟）**：
适合水母（如胶质/海洋生物）、悬浮、失重或梦幻漂浮类角色——以主脉动驱动整体轻度浮沉与径向张合（*Squash & Stretch*），触须、飘带与宽大衣摆保留明显相位滞后（`phase - i * 0.55..0.8`）与低频暗流微漂，使推进收缩与末端舒展错开半拍，呈现柔韧的流体呼吸感。

- **层次视差（Depth Parallax）**：无论选用哪种模式，同侧前后重叠部件（如臂 → 披肩领 → 前景袖 → 外套前片 → 前后蝴蝶结，或水母伞盖 → 内层口腕 → 外层长触须）都应给不同刚度与相位差，做出立体纵深。

### 2.3 2-Bone 解析 IK（锁脚防滑步 / 锁持物接触）
根据 `puppet.spec.bones` 读取静止腿长或臂长 `L1, L2` 与静止屈膝/屈肘方向 `bendSign`（`+1` 或 `-1`），每帧直接解出上/下节世界角度，再减去父骨世界角与自身 `restRotation` 得到增量 `rotation`：

```js
function solveTwoBoneIK(rootX, rootY, targetX, targetY, L1, L2, bendSign) {
  const dx = targetX - rootX, dy = targetY - rootY
  const rawDist = Math.hypot(dx, dy)
  const dist = Math.max(Math.abs(L1 - L2) + 0.5, Math.min(L1 + L2 - 0.12, rawDist))
  const base = Math.atan2(dy, dx)
  const cosA = Math.max(-1, Math.min(1, (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist)))
  const a1 = base - bendSign * Math.acos(cosA)
  const midX = rootX + Math.cos(a1) * L1, midY = rootY + Math.sin(a1) * L1
  const s = rawDist > 1e-6 ? dist / rawDist : 1
  const a2 = Math.atan2(rootY + dy * s - midY, rootX + dx * s - midX)
  return { upperWorldDeg: (a1 * 180) / Math.PI, lowerWorldDeg: (a2 * 180) / Math.PI }
}
```

- **脚底锁地**：当 `hip` 随呼吸与微重心晃动时，反解左右腿让 `foot_l / foot_r` 锚定在静止地面坐标，再把 `foot` 旋转抵消小腿转角，可将脚底滑移压到 `< 0.05 px`。
- **持物/扶面具锁点**：把目标点设为头骨世界变换后的面具抓握点，2-Bone IK 解算手臂即可让手稳稳扶住随头晃动的面具（误差 `< 0.5 px`）。

### 2.4 ACGN 面部生命感：零露眼白眨眼与视线
- **零露眼白眨眼**：若 `eye_white` 直接静态挂在 `head` 上，闭眼压低上睫毛（`eye_lash`）时，睫毛上方常会露出一条白色眼白月牙。正确做法：为 `eye_white` 建一根从**下眼睑根部朝上指（`restRotation ≈ -90°`）**的骨头，眨眼闭合度 `blink ∈ [0, 1]` 增大时同步收拢 `eye_white.scaleX`（最低保持 `>= 0.08`，严禁 `<= 0`）并微降 `eye_lash`，让上睫毛完全压住眼白。
- **眨眼节奏**：非等间隔随机（由确定性 PRNG 预生成或步进生成，常见间隔 `2.8–5.8 s`，偶发一次轻快双眨）；闭眼快（`~65 ms`）、睁眼略慢带缓出（`~115 ms`），配合眉毛微沉 `0.5–1.5 px`。
- **视线与微扫视**：用低频确定性偏移叠加极细微瞳孔扫视（`1–2 px`），接入 `pointer` 时对目标做指数平滑，且把权重分层分配给瞳孔（主）、头部（次）、胸腔（微），宿主关闭 `pointerTracking` 时平滑回中。

### 2.5 代码原生顶点变形口（`deform` Mesh Field）实战配方
当单靠骨骼或骨链难以表现**丝带 S 波、水母伞盖波动、百褶裙局部褶皱、轻度伪 2.5D 转头**时，直接在 `setPose({ bones, deform })` 叠加位移场：

- **单条丝带 / 发带 / 飘带 → 用切片局部 `(u, v)` 锚死根部**：
  用 `v * v` 或 `smoothstep(v)` 让根部（`v = 0`）位移严格为 `0`，末端自然舒展，狭长部件用非等比细分（如 `grid: [3, 10]`）：
  ```js
  deform: {
    ribbon_l: {
      grid: [3, 10],
      field: (_u, v) => [Math.sin(v * 5.5 - t * 3.8) * v * v * 14, 0],
    },
  }
  ```
- **跨多张切片的整体连续波动（如前后水母伞盖呼吸、多层裙摆波纹）→ 用原画布静止 `(x, y)` 对齐相位**：
  前后伞盖或内外裙层的切片裁切框 `rect` 往往尺寸不同，若用各自 `(u, v)` 会相位错位；直接基于回调第 3、4 参数 `(x, y)` 计算波场，即可让多张切片像一整块连续流体同步呼吸：
  ```js
  const bellWave = (_u, v, x, y) => [
    Math.sin(x * 0.035 - t * 2.4) * 7 * v + (x - centerX) * pulse * 0.04,
    Math.cos(x * 0.03 - t * 2.1) * 5 * v + (y - bellTopY) * -pulse * 0.03,
  ]
  deform: {
    bell_back: { grid: [8, 6], field: bellWave },
    bell_front: { grid: [8, 6], field: bellWave },
  }
  ```
- **轻度伪 2.5D 转头透视**：视线水平偏移 `lookX ∈ [-1, 1]` 时，对脸部或刘海施加极轻梯形场 `(u, v) => [(u - 0.5) * lookX * -3, (u - 0.5) * (v - 0.5) * lookX * 6]`，与五官景深视差平移配合即可出现柔和立体感。
- **使用纪律**：所有绑定模式均先在静止空间施加 `[dx, dy]` 再走骨骼/骨链变换；网格密度按需选 `3..12`（上限 `16×16`），幅度受 `GeometryError` 校验保护；某状态下不需要变形时直接省略该 `layerId` 即可干净回退。

### 2.6 低骨数部件增活、刚体纪律与同轴前后景
- **单骨丝带 / 蝴蝶结增活**：即使只有单根骨头，也可以用**二阶弹簧旋转 + 极轻微轴向呼吸弹性**（如 `scaleX: 1 + wind * 0.018`）配合前后片错相做出轻盈流动感，避免把单骨强拉变形。
- **刚体 / 机甲角色**：所有机械部件保持 `scaleX = 1, scaleY = 1`；跳跃/冲击动作在离地瞬间保持 **C1 速度连续**（避免脚底轨迹出现折返 Z 字尖角）；向下的喷射/烟尘特效必须用 `groundY - soleY` 裁切，绝不穿透地面。
- **同轴 `back / front` 2D 层**：优先做服务氛围的克制元素（脚底随重心微缩放的柔和接触投影、极淡背景光斑或环境微尘），绝不遮挡角色主线稿。

---

## 3. 高频画面问题排障对照表

| 观察到的画面症状 | 常见根因 | 直接修法与验收点 |
|---|---|---|
| 陆地角色头发/衣摆无意中与胸腔同步左右张合（机械膨缩感） | 软物直接套了呼吸波形，或左右对称反相正弦驱动 | 若目标不是漂浮/水母脉动风格，将呼吸与风场解耦：软物改由**锚点加速度弹簧 + 单向阵风波前 `sampleBreeze(t, worldX)`** 驱动。 |
| 某片裙子或外套整块僵硬、像纸板（“半边发死”） | 整片大布料只绑了 1 根刚性骨或未建轮廓网格 | 升级为 2 节 `boneChain` + 低凹度轮廓网格（`rig auto-mesh`），下摆节接阻尼弹簧滞后。 |
| 脚底在地面发飘滑步，或扶面具/持物手与物体错位 | 根骨移动后仅用 FK 驱动腿/臂 | 接入 2-Bone 解析 IK 锁定目标点；在 `inspect:live` 中拉地面/坐标 `guides` + `telemetry.json` 验算滑移 `< 0.5 px`。 |
| 眨眼时上睫毛上方露出白色月牙 | `eye_white` 静态挂在 `head` 上未随眼睑收拢 | 拆分 `eye_white` 独立骨（根在下眼睑朝上指），闭眼同步压缩 `scaleX`（`>= 0.08`）。 |
| 动作报错 `GeometryError` 三角形翻面/退化 | 骨链网格轮廓过凹、单节折弯过大或 `jointSoftnessPx` 过窄 | 先跑 `rig check-bend <dir>` 定位超限关节；重跑低凹度 `rig auto-mesh`（`concavity: 8–10`），调宽 `jointSoftnessPx`，将转角分摊到整条链。 |
| 子骨平移方向歪 90° 或与预期相反 | 直接把画布 `(dx, dy)` 传给了非根骨的 `x / y` | 使用 `canvasDeltaToParentLocal(dx, dy, parentWorldRestDeg)` 换算到父局部空间。 |
| 切片包体积异常庞大、描边贴合失败或透明边发灰 | PSD 图层角落残余孤立低透明噪点或整画布 `alpha=2` 雾膜 | 用 `layer_rig_psd.slices --trim-stray --bake-reference` 重导并检查 `hazeWarnings` 与 `proof.mismatches === 0`。 |
