# ACGN / Koma Live 实战经验与物理配方库

沉淀自真实分层立绘、多层薄纱长发与刚体角色实践，覆盖绑骨规范、防翻面网格、真实重力物理/IK 配方、原生运行期原语与高频画面排障。

---

## 1. 立绘绑骨与轮廓网格规范（Rigging Playbook）

### 1.1 标准解剖骨骼层级
按力的传导顺序建树，不把软物与附生细发直接散挂在根骨或胸骨上：

```text
root (画布底部重心或骨盆)
├── hip (骨盆，驱动下半身与微重心转移)
│   ├── thigh_l -> shin_l -> foot_l         # 双骨链腿部（侧向/动作姿态供 2-Bone IK；正面直立腿禁用 IK 下压）
│   ├── thigh_r -> shin_r -> foot_r
│   ├── skirt -> skirt_hem                  # 百褶裙/多层纱裙：腰带根骨锁 hip，下摆 2 节骨链摆动
│   ├── belt_1 -> belt_2                    # 长垂带/皮带：2 节骨链
│   └── torso -> chest                      # 上衣跨 2 节骨链，支持柔和呼吸与微侧倾
│       ├── neck -> head
│       │   ├── eye_lash / eye_white / pupil / brow  # 眼白独立成骨防眨眼露白；pupil 可 clipTo eye_white
│       │   ├── hair_back / twintail_l1..l3 / twintail_r1..r3  # 长发 2–3 节骨链
│       │   │   └── hair_wispy_l / hair_stray_l                # 附生外侧细发丝：必须挂在所属主发束父骨下！
│       │   ├── bang_c / bang_l1..l2 / bang_r1..r2             # 鬓发 2 节骨链
│       │   └── horns / mask / hair_ribbon_1..2                # 刚体石角严禁缩放；折纸丝带沿折痕建 2–3 节骨链
│       ├── jacket_l -> jacket_l_hem        # 垂挂外套前/后片：2 节骨链防半边发死
│       ├── jacket_r_collar / jacket_r_hem -> jacket_r_tip
│       ├── shoulder_l -> upper_arm_l -> forearm_l -> hand_l   # 持物手供 2-Bone IK 锁点
│       │   └── shackle_l -> chain_l1 -> chain_l2              # 金属铁铐/铁链：纯重力零风力、严格 scale === [1,1]
│       └── shoulder_r -> upper_arm_r -> forearm_r -> hand_r
│           └── sleeve_bow_front / sleeve_bow_back             # 袖口蝴蝶结前后分层独立
```

> **附生细发丝挂点铁律**：紧贴在主发束外缘生长的散丝（`hair_wispy_*`、`hair_stray_*`）**绝不能挂在 `chest` 或独立挂在 `head` 下**——必须直接作为对应主发骨（如 `hair_mid_l1`）的子骨，根骨坐标精准对齐两张切片的实际重合像素，才能在摆动与转头时保持 `0 px` 零脱节。

### 1.2 什么时候必须升级为骨链 + 轮廓网格
- **单骨足够**：刚性小件（耳环、戒指、石角、铁铐、靴子、面具、硬质短袖口、小幅微动的短刘海或领结）。
- **必须 2–3 节 `boneChain` + 轮廓网格**：大片悬垂外套、百褶裙/多层纱裙、双马尾/长主发、长鬓发、折纸丝带（按原画折痕设关节）、长垂带、连体长腿与上衣。只绑单骨时，整片布料只能刚性绕根部转动，画面会明显“整块发死”。
- **轮廓网格防翻面经验**：
  - `boneChain` 图层严禁高凹度描边（尖凹角在轻微折弯时就会触发 `GeometryError` 翻面）。统一使用低凹度预设 `detail: 28, concavity: 10, padding: 4`（Studio 选中骨链层点击「生成骨链轮廓网格」，或 CLI `npm run rig -- auto-mesh <dir>`）。
  - 单骨柔性层可用较高贴合度（`detail: 42, concavity: 32, padding: 3`）。
  - `jointSoftnessPx` 决定关节过渡带宽：窄长垂带/鬓发约 `45–70 px`，厚外套/百褶裙/双马尾约 `85–140 px`；改完立即跑 `npm run rig -- check-bend <dir>` 确认安全转角（目标至少覆盖待机最大摆幅的 1.5–2 倍）。

---

## 2. 活立绘核心物理与数学配方（可直接内联进单文件脚本）

### 2.1 二阶阻尼谐振弹簧（2nd-Order Spring）与材质梯度
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

**按材质物理梯度调参**（阻尼比 `ζ = c / (2√k)`，具体幅度受 `check-bend` 上限约束）：

| 材质类型 | 典型部件 | 刚度 `k` | 阻尼 `c` | 阻尼比 `ζ` | 常见待机摆幅 | 力学特征 |
|---|---|---:|---:|---:|---:|---|
| 轻薄飘带 / 折纸丝带尾 | 蝴蝶结尾、折纸丝带末节 | `16–30` | `2.8–4.5` | `0.35–0.45` | `4°–10°` | 响应灵敏、微过冲、尾梢滞后长 |
| **厚重长发（重力垂坠）** | 长主发束、长侧发、垂地马尾 | `18–32` | `6.5–9.2` | **`0.72–0.85`** | `1.5°–5.5°` | **沉重丝滑、几乎不回弹、强重力铅垂感** |
| 中重布料 / 多层纱裙 | 百褶裙下摆、多层薄纱、披肩袖 | `26–44` | `5.5–8.0` | `0.55–0.68` | `1.5°–4.5°` | 沉稳有坠感、前后层差滞后明显 |
| 厚重外套 / 皮革垂带 | 厚夹克下摆、硬皮带 | `36–58` | `7.5–10.8` | `0.65–0.75` | `1.0°–3.2°` | 惯性大、起止克制 |
| **金属铁链 / 硬质挂件** | 手铐链、金属坠饰 | `34–54` | `7.8–11.5` | `0.68–0.82` | `0.6°–2.2°` | **零风力**，仅响应重力铅垂与锚点惯性，`scale === [1, 1]` |

> **链式传导技巧**：多节骨链不要各节独立乱晃——第 `i` 节弹簧的目标角加入第 `i-1` 节的角速度项（如 `-parentSpring.vel * 0.14`）叠加风场，立刻出现真实的鞭梢滞后与自然停顿。

### 2.2 呼吸、环境场与长发真实重力垂坠（反“海草发”）

**模式 A · 陆地立绘解耦场（非对称呼吸 × 单向阵风波前）**：
适合地面站姿或偏写实/酷感立绘——把**核心呼吸**留在胸腔/锁骨/肩/微重心内，**外在风场**用跨画布 X 坐标传播的阵风（周期远离呼吸周期，避免拍频共振）：

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

// 飘带/轻纱用单向阵风波前：风从左向右 (+X) 掠过锚点 worldX
function sampleBreeze(tSec, worldX, originX = 460, speedPxPerSec = 760) {
  const localT = tSec - (worldX - originX) / speedPxPerSec
  const env = 0.58 + 0.30 * Math.sin(localT * 0.648 + 0.4) + 0.14 * Math.sin(localT * 0.411 + 2.2)
  const gust = 0.52 * Math.sin(localT * 1.16 + 0.2) + 0.34 * Math.sin(localT * 2.09 - 0.9) + 0.16 * Math.sin(localT * 3.67 + 1.5)
  return (0.26 + gust) * env
}

// 厚重长发专用：零均值间歇室内气团（有明确静风回归垂线的间歇，不常驻偏吹）
function sampleHairAir(tSec, worldX, originX = 720, speedPxPerSec = 900) {
  const localT = tSec - (worldX - originX) / speedPxPerSec
  const gate = Math.max(0, Math.sin(localT * 0.37 + 0.8) - 0.28) / 0.72
  const env = gate * gate * (3 - 2 * gate)
  const drift = 0.65 * Math.sin(localT * 0.79 + 0.3) + 0.35 * Math.sin(localT * 1.43 - 1.1)
  return drift * env
}
```

**长发真实重力垂坠四法则**（避免“水下海草/果冻发”）：
1. **高阻尼 + 零均值间歇风**：使用 `ζ ≈ 0.72–0.85` 配合 `sampleHairAir`，让长发大部分时间稳稳垂坠，只在气团掠过或转头后带出一道沉稳的顺滑摆尾。
2. **重力铅垂反补偿（Plumb-Line Counter-Rotation）**：头部歪斜 `headWorldRot` 时，下垂发根骨叠加 `-headWorldRot * 0.45..0.60`，使长发在重力下保持铅垂而非随头僵硬横挑。
3. **`s³` 单曲率 C 弧 + 严格弧长守恒（禁竖向拉伸）**：`deform` 中只施加单曲率弯弧（`dx = s * s * s * swayPx`，不要高波数正弦 S 波），并按圆弧几何严格保守垂向缩短 `dy = -(dx * dx) / (2 * Math.max(80, strandLenPx))`——**严禁**对长发写 `Math.cos(...)` 竖向拉扯。
4. **附生细发根部焊接**：挂在主发骨下的外侧细发丝，在 `deform` 中读取主发在该挂点 `sAttach` 处的横向位移 `weldDx` 并以 `(1 - s) * weldDx` 注入自身根部，实测根部滑移可压至 `< 0.001 px`。

**模式 B · 水母 / 悬浮协同脉动场（径向呼吸 × 流体延迟）**：
适合水母（胶质/海洋生物）、悬浮或梦幻漂浮类角色——以主脉动驱动整体轻度浮沉与径向张合（*Squash & Stretch*），触须、飘带与宽大衣摆保留明显相位滞后（`phase - i * 0.55..0.8`）与低频暗流微漂，使推进收缩与末端舒展错开半拍。

- **层次视差（Depth Parallax）**：无论选用哪种模式，同侧前后重叠部件（臂 → 披肩领 → 前景袖 → 外套前片 → 前后蝴蝶结，或外纱 → 前帘 → 内衬 → 裙底）都应给不同刚度与相位差，做出立体纵深。

### 2.3 2-Bone 解析 IK（锁脚/持物）与两条不可碰的红线
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

- **适用场景**：
  - **侧向/微屈膝脚底锁地**：当 `hip` 随微重心晃动时反解双腿锚定静止地面坐标，再把 `foot` 旋转抵消小腿转角，脚底滑移可压到 `< 0.1 px`。
  - **持物/扶面具锁点**：目标点取头骨世界变换后的抓握点，2-Bone IK 让手稳稳锁住随头晃动的物件（误差 `< 0.5 px`）。
- **红线 1 · 正面直立腿“香蕉膝盖”禁令**：正面朝前站立、双腿静止笔直的立绘，**严禁用 2-Bone IK 强压 `hip` 垂直下沉**——2D 平面中正对镜头的膝盖没有纵深可弯，一压就会往侧面鼓出违和的“香蕉膝盖”。正确做法：保持 `hipDy = 0, hipRot = 0, shin_l/r = 0°`，双腿以脚踝为铰链做极微直线重心摆动（足底滑移 `< 0.2 px`），把呼吸起伏完全留在腰、胸、肩、头。
- **红线 2 · 直臂奇点禁令**：放松/悬浮状态静止几乎伸直的手臂（`L1 + L2 - restDist < 15 px`）且无需死锁硬物时，**不要强行上 2-Bone IK**（极易撞 `acos` 奇点导致肘部反折弹跳）；改用带解剖限位的流体制导 FK 弹簧链。

### 2.4 ACGN 面部生命感、完整闭缝眨眼桥接与运行期原生原语
- **原生三原语配合面部表现**：
  - **`clipTo`（通用 Alpha 裁切）**：通过 `rig.json`（`set-layer`）或每帧 `setPose({ clipTo })` 把 `pupil` 裁切到 `eye_white`（大角度看边绝不飘出眼眶）、把腮红/汗滴裁切到 `face_base`；需要越界特效时在某帧传 `clipTo: { pupil: null }` 即可临时解除。
  - **`opacity`（运行期平滑显隐）**：驱动腮红淡入、漫符微呼吸、泪光/星眼高光脉动，比硬切 `slots` 自然得多。
  - **`tint`（远侧克制微受光）**：微转头时给背光/远侧鬓发或脸缘叠 `4%–6%` 极轻冷灰/暖灰（如 `0xf0f1f6`）制造体积纵深；绝不对全图乱套重阴影以免产生 3D 伪人感。
- **眉眼透发（`peekOpacity / peekAfter`）**：动漫立绘中外眼角与眉毛被鬓发/刘海压住时，在 `set-layer` 配置 `peekOpacity`（上睫毛 `0.50–0.65`、眉毛 `0.35–0.45`）与 `peekAfter`（前发顶层之后、前景手持物之前），共享几何体 1:1 像素同步透出。
- **零露眼白眨眼与原画像素保护**：
  - 绝不擅自改坏原画默认睁眼像素；给默认眼加**低频微扫视（Saccade）**、透明鼻梁区的反斗鸡眼辐辏偏移与高光微弹簧即可立刻有神。
  - 为 `eye_white` 建从**下眼睑根部朝上指（`restRotation ≈ -90°`）**的骨头，眨眼闭合度 `blink ∈ [0, 1]` 增大时同步收拢 `eye_white` 与 `pupil` 的纵向尺度（最低保持 `>= 0.055`，严禁 `<= 0`），让上睫毛完全盖住眼白。
  - 眨眼节奏由确定性 PRNG 生成非等间隔（`2.8–5.8 s`，偶发轻快双眨），闭眼快（`~65 ms`）、睁眼略慢带缓出（`~115 ms`），配合眉毛微沉 `0.5–1.5 px`。
- **完整闭缝眨眼桥接（Blink-Bridged Expression Swap）**：
  - 离散切换差分眼（如 `default ↔ sleepy / star_eyes / abyss`）时，绝不硬闪切，也不能只闭到 `scaleY ≈ 0.3` 就过早切图（肉眼会看到“突然闭眼少了一截”的断层）。
  - 正确做法：用分段单调下压把眼球内部一直压成约 `3 px` 细缝（`scaleY → 0.055`），并把 `eye_white / pupil / eye_lash` 的闭合收束锚点精准对齐到闭眼线 `Y` 坐标，直到 **`eyeClose >= 0.975`** 的最闭瞬间才切入目标差分贴图；推荐桥接时长 **`135 ms 闭合 + 75 ms 闭缝停顿 + 200 ms 舒缓睁开`**。切入差分眼后依然保持活体周期眨眼与局部视线微动。
- **原生分层眼优先于模糊放大差分（`clipTo: 'eye_white'` 半睁/瞪大）**：
  - 对半睁死鱼眼、好奇微睁等只需调整眼睑开合的表情，优先直接驱动高解析原生分层眼，并将 **`pupil` 与 `eye_highlight` 同时配置 `clipTo: 'eye_white'`**；压低 `eye_white_bone` 顶端缩放并同步下移/拉平 `eye_lash`，即可让正圆虹膜被上眼睑锐利切出半睁感，既免去 2× 放大差分的模糊感与闪烁切换，又能保持完整实时瞳孔追踪与上睑投影。
- **双层唇心弹性嘴型渐变（消除 1 帧硬切）**：
  - 若把所有嘴型塞进单个互斥 `mouth_expr` 槽，切换必是 1 帧硬切。改为保留默认嘴常显（由 `opacity` 控制），其余扩展嘴型各挂独立开关槽（`none | on`）；切嘴时执行 ~`175 ms` 双层唇心弹性过渡——旧嘴先向共享唇心 `(LIP_CX, LIP_CY)` 轻抿收合（`scaleY → 0.34`）淡出，新嘴从同一唇心平滑舒展并带轻微弹性过冲（`scaleY: 0.32 → 1.09 → 1.0`），兼得丝滑过渡与零双嘴重影。
- **克制触感互动与程序化渐进粒子**：
  - 摸头类互动切忌夸张大晃或把头部压成橡皮球：让发冠 `hair_crown` 随抚摸落点做 `≤ 7.5 px` 细腻轻压、呆毛根部贴合下沉并在 `evalSkullFollow` 同步内收后发帽沿防露馅；爱心/星光等反馈优先在同轴 `front` 2D 层用程序化手绘粒子按持续交互渐进递增并设上限阈值（如最多 9 颗）自然飘散，远比机械循环的 APNG 更鲜活。

### 2.5 代码原生顶点变形口（`deform`）、解析式 2.5D 头转与多层薄纱
当单靠骨骼或骨链难以表现**丝带尾梢飘动、水母伞盖波动、多层纱裙褶皱、三轴微视差转头**时，直接在 `setPose({ bones, deform })` 叠加位移场；对精致人型角色推荐用 `npm run rig -- auto-head` + `head-rig.json` 生成带 `faceRelief`（面部球面浮雕）、分层五官 `zRatio`、`eyePairCenters`（眼睑-虹膜水平视差）、`crownDome`（径向球面圆润发冠，确保任意仰俯外轮廓不发方）与刚体 3D `horn` 旋转的 2.5D 头部 Morph，再用 `ctx.physics.projectHeadAccessory(puppet.spec.headCalibration, headYaw, headPitch, x, y, z)` 同步脑后蝴蝶结/头饰。

- **三轴微视差安全红线与 6 层 Z 杠杆**：
  - 严格守住 **Yaw `±8°~12°`（简鼻二次元上限 `±15°`）、Pitch `+6°` ~ `-10°`、Roll `±8°~15°`**，以深度错位替代强行透视拉扯。
  - 按前后 Z 轴景深分配相对平移系数：`前发/角尖 (+1.2~1.4)` → `五官 (+1.0)` → `脸部底片 (+0.55)` → `鬓发 (+0.25)` → `耳饰/侧结 (-0.35)` → `后发 (-0.85~-1.1)`；脸部叠加极轻梯形场 `(u, v) => [(u - 0.5) * lookX * -3, (u - 0.5) * (v - 0.5) * lookX * 6]` 与同心空间相位呼吸。
- **折纸丝带 / 单条飘带 → 局部 `(u, v)` 根部钉死 + 远端才启波**：
  折纸感丝带不要整条正弦扭动——前半段保留折痕硬挺，只在远端半段（`s > 0.46`）随 `smoothstep` 柔和漂浮；狭长部件用非等比网格（如 `grid: [3, 10]`）：
  ```js
  deform: {
    ribbon_l: {
      grid: [3, 10],
      field: (_u, v) => {
        const tail = smoothstep((v - 0.46) / 0.54)
        return [Math.sin(v * 3.8 - t * 2.6) * tail * tail * 11, 0]
      },
    },
  }
  ```
- **跨多张切片的连续流体 / 多层半透明薄纱 → 用原画布静止 `(x, y)` 对齐或分层差驱动**：
  - 前后水母伞盖或同组连片布料直接用第 3、4 参数 `(x, y)` 统一波场相位，避免不同裁切框 `rect` 造成接缝错位：
    ```js
    const bellWave = (_u, v, x, y) => [
      Math.sin(x * 0.035 - t * 2.4) * 7 * v + (x - centerX) * pulse * 0.04,
      Math.cos(x * 0.03 - t * 2.1) * 5 * v + (y - bellTopY) * -pulse * 0.03,
    ]
    ```
  - 多层半透明衣裙（外纱 / 垂帘 / 内衬 / 裙底）则按层次分别赋不同相位延迟、边缘轻涟漪与手提悬链线张力，避免多层重叠时糊成一块刚板。
- **使用纪律**：所有绑定模式均先在静止空间施加 `[dx, dy]` 再走骨骼/骨链变换；网格密度按需选 `3..12`（上限 `16×16`），幅度受 `GeometryError` 校验保护；某状态不需要变形时直接省略该 `layerId` 即可干净回退。

### 2.6 低骨数部件增活、刚体纪律与同轴前后景
- **单骨蝴蝶结 / 短饰增活**：用二阶弹簧旋转 + 极轻微轴向呼吸弹性（如 `scaleX: 1 + wind * 0.015`）配合前后片错相即可出轻盈流动感，切忌强拉形变。
- **刚体 / 机甲 / 石角 / 铁铐**：严格保持 `scaleX = 1, scaleY = 1`；跳跃/冲击动作离地瞬间保持 **C1 速度连续**（避免脚底轨迹 Z 字尖角）；向下喷射/烟尘特效必须用 `groundY - soleY` 裁切不穿地。
- **同轴 `back / front` 2D 层**：优先做服务氛围的克制元素（脚底随重心微缩放的接触投影、极淡背景光斑、柔和漫符氛围粒子），绝不遮挡角色主线稿；若 2D 特效面积大或面向移动端，可在挂载配置传入 `layerResolutionScale: 0.5` 省 75% 填充率（脚本逻辑坐标零改动）。

---

## 3. 高频画面问题排障对照表

| 观察到的画面症状 | 常见根因 | 直接修法与验收点 |
|---|---|---|
| 正面站姿呼吸下沉时，膝盖往旁边鼓出“香蕉膝盖” | 对正面笔直双腿误用了 2-Bone IK 垂直压低 `hip` | 立刻停用正面直腿 IK 下压：保持 `hipDy = 0, hipRot = 0, shin = 0°`，用直线微倾踝铰链，把呼吸留在腰胸肩头。 |
| 厚重长发像海草一样飘在半空、上下拉长或歪头时硬翘 | 阻尼过低（`ζ < 0.45`）、常驻偏置风、对长发用了 S 波或 `cos` 竖向拉伸、缺重力反补偿 | 提阻尼至 `ζ ≈ 0.72–0.85` + 改用零均值 `sampleHairAir` + 叠 `-headWorldRot * 0.45..0.60` + `s³` 单曲率 C 弧与严格弧长守恒 `dy = -dx² / 2L`。 |
| 外侧细发丝与主发束接缝处撕裂、穿帮滑脱 | 细发丝误挂在 `chest` 或独立挂在 `head` 下，未共享主发根部形变 | 把细发丝改成所属主发骨（如 `hair_mid_l1`）的子骨并精准对齐重合像素，在 `deform` 继承主发根部 `weldDx`，验算根部滑移 `< 0.1 px`。 |
| 陆地角色头发/衣摆与胸腔同步左右张合（机械膨缩感） | 软物直接套了呼吸波形，或左右对称反相正弦驱动 | 将呼吸与风场解耦：软物改由**锚点加速度弹簧 + 阵风波前**驱动，周期错开呼吸周期。 |
| 某片裙子或外套整块僵硬、像纸板（“半边发死”） | 整片大布料只绑了 1 根刚性骨或未建轮廓网格 | 升级为 2 节 `boneChain` + 低凹度轮廓网格（`rig auto-mesh`），下摆节接阻尼弹簧滞后。 |
| 脚底发飘滑步，或扶面具/持物手与物体错位 | 根骨移动后仅用 FK 驱动腿/臂 | 侧向腿与持物手接入 2-Bone 解析 IK 锁定目标点；在 `inspect:live` 拉 `guides` + `telemetry.json` 验算滑移 `< 0.5 px`。 |
| 眨眼露白色月牙，或切换表情眼时觉得“突然少了一截” | `eye_white` 未随眼睑收拢，或切眼阈值过低（尚未闭成细缝就切图） | `eye_white` 独立成骨随眨眼收拢至 `scaleY >= 0.055`（对齐闭眼线 `Y`），表情切换采用完整闭缝眨眼桥接（`eyeClose >= 0.975` 才换图，`135/75/200 ms`）；`pupil` 配 `clipTo: eye_white`。 |
| 导入的 APNG / 漫符贴图在画布上显得极小或飞错方向 | 源 APNG 帧四周含 60%+ 透明留白未紧裁，或朝向未按角色左右镜像 | 按序列所有帧的**联合非透明包围盒（union bbox）**先紧裁再等比缩放到目标落位，并确认漂移方向朝向头外侧空白区。 |
| 某条发丝/鬓发顶端无故翘起，或切片体积异常庞大 | PSD 角落残余孤立低透明噪点拉大了 `rect`（扭曲了 `v` 权重），或整画布有 `alpha=2` 雾膜 | 用 `layer_rig_psd.slices --trim-stray --bake-reference` 清理（必要时手工清掉残留孤岛像素并重烘焙 float32 `reference.png`），检查 `hazeWarnings` 与 `mismatches === 0`。 |
| 新增差分表情/漫符图层后 `verify-slices` 报 `mismatches > 0` | 非默认差分图层在 `manifest.json` 中被设为 `visible: true` 叠进了默认静帧 | 把非默认差分图层在 `manifest.json` 设为 `visible: false`，仅通过 `rig.json` 的 `semantics.slots` 在运行期切出。 |
| 动作报错 `GeometryError` 三角形翻面/退化 | 骨链网格轮廓过凹、单节折弯过大或 `jointSoftnessPx` 过窄 | 先跑 `rig check-bend <dir>` 定位超限关节；重跑低凹度 `rig auto-mesh`（`concavity: 8–10`），调宽 `jointSoftnessPx`，将转角分摊到整条链。 |
| 子骨平移方向歪 90° 或与预期相反 | 直接把画布 `(dx, dy)` 传给了非根骨的 `x / y` | 使用 `canvasDeltaToParentLocal(dx, dy, parentWorldRestDeg)` 换算到父局部空间。 |
