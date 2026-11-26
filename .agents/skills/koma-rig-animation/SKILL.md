---
name: koma-rig-animation
description: >-
  Slice PSD assets, plan 2D skeletal rigs and contour meshes, author real-time
  procedural animations and coaxial 2D effects, and visually inspect Koma Rig
  characters. Use when working with PSD slicing, rig-spec.json, rig auto-mesh /
  check-bend, mountLiveRig, mountPerformance, Koma Live, or inspect:live.
---

# Koma Live 2D 绑骨与实时动画指南

面向 **Koma Live**（内置 **Koma Rig** 绑骨底盘）「精绘分层立绘 + 程序化实时驱动」工作流。先建立画面直觉与项目能力边界，再按需查阅详细工具手册与实战经验库。

---

## 1. 设计哲学与审美基线（Koma 赛博皮影戏）

写代码或规划骨骼前，先看原画（`reference.png`），遵循 **「像素只管美，代码只管真；八分画格定力，二分末梢呼吸；按物种写物理，零成本导演权」**（详见 [docs/design-philosophy.md](../../../docs/design-philosophy.md)）：

- **重心与解剖层级**：骨盆/腰椎稳住重心，胸腔主导呼吸，锁骨、肩臂与头部按层级传递并带相位滞后；正面直立腿严禁用 2-Bone IK 垂直压低造成“香蕉膝盖”（保持 `hipDy = 0, shin = 0°` 直线踝铰链），侧向/机甲腿脚与持物手才用 2-Bone IK 锁点；悬浮/水下角色用柔和浮力与流体阻尼替代硬落地。
- **反暴力伪 3D，守住三轴微视差安全红线**：靠 5~6 个深度层的相对错位（前发/角尖 → 五官 → 脸颊/发冠 → 鬓发 → 耳饰/蝴蝶结 → 后发）和远侧 `4%~6%` 极轻 `tint` 受光建立立体感，绝不硬捏大角度破坏原画五官：
  - **Yaw 左右转头 `±8°~12°`**（简鼻二次元上限 `±15°`）、**Pitch 仰 `+6°` ~ 俯 `-10°`**（低头比抬头安全）、**Roll 歪头 `±8°~15°`**（平面无畸变，配合重力回垂头发最出情绪）。
- **按物种与材质建立真实力学梯度**（拒绝千人一面弹簧模板）：
  - **刚体 / 机甲 / 石角 / 铁铐铁链**：严格 `scale === [1, 1]`；金属铁链**零风力**，仅受纯重力与上段惯性。
  - **厚重长发**：高阻尼（`ζ ≈ 0.72~0.85`）、零均值间歇轻风、`s³` 单曲率 C 弧与**严格弧长守恒**（`dy = -dx² / 2L`，禁上下拉伸“水草波”），头歪时做强重力铅垂反补偿；外侧附生细发丝必须挂在主发束父骨下共享根部变形。
  - **折纸丝带与多层薄纱**：折纸丝带沿原画折痕建 2~3 节骨链弯折；多层半透明衣物按前后层差做相位滞后、手提悬链线张力与边缘涟漪。
  - **水母 / 悬浮 / 异质流体**：用协同脉动、高粘滞缓流与相位延迟表达物种真实性。
- **连续状态场 + 阴影克制**：不硬切动作片段、不打断呼吸与弹簧动量；离散表情/换件用连续物理包裹（如完整闭缝的**眨眼桥接**）；**100% 尊重 AI/画师原画自带光影**，不强加全图算法投影以免产生 3D 伪人感。

---

## 2. Koma Live 项目基础能力与机制边界

| 阶段 | 核心工具 | 能力范围 |
|---|---|---|
| **离线切片** | `tools/psd` (`layer_rig_psd.slices`) | 8-bit RGB PSD 导 v2 sRGB PMA 切片包；`--trim-stray --skip-hidden --bake-reference` 去孤立噪点/雾噪、烘焙并 0 误差复验 `reference.png`。 |
| **绑骨与网格** | **Koma Studio** / `npm run rig` | 骨骼树、单骨与连续骨链（`boneChain`）自动权重蒙皮、关节柔化（`jointSoftnessPx`）、轮廓网格（`rig auto-mesh`）、骨链安全转角体检（`rig check-bend`）、3D 头部网格（`rig auto-head`，自动持久化 `headCalibration`）、结构巡检与切片工具（`rig doctor / repivot / pad-slice / reorder / bake-reference`）、透发（`peekOpacity/peekAfter`）、通用 Alpha 裁切（`clipTo`）、导出 `rig-spec.json`（`rig spec`）与无痛降采发布包（`rig export-work --scale 0.5`）。 |
| **实时演出** | **Koma Live** / `mountPerformance` / `mountLiveRig` | PixiJS WebGL 角色渲染（常规层 `rgba8unorm`、`gelGroups` `rgba16float`）、代码原生顶点变形口（`deform`）、内置画布坐标物理原语（`ctx.physics`：`softClamp / createLowPass / createDampedSpring / createHairStrand / createWeldedMeshField / projectHeadAccessory`）、逐层运行期 `opacity / tint / clipTo`、播放态高性能开关（`validateGeometry` 默认 `false`）、同轴 2D 前后景（支持 `layerResolutionScale` 半分辨率）、贴图/清单/脚本全量自动热重载与零改脚本 `manifest.textureScale`。 |
| **视觉验收** | `rig audit-motion` / `npm run inspect:live` | `rig audit-motion` 纯 Node 秒级无头体检（自动查 `GeometryError`、帧间突变、骨骼卡墙跳变与反惯性钢板感）；`inspect:live` 无头 Chromium 确定性采样（支持 `--dpr 1 --step 33.33` 重型角色提速），自由拼装关键帧条、Spine 洋葱皮、局部裁剪、Alpha 通道与跨视口对比板，输出 `telemetry.json`。 |

**与 Spine / Live2D 的机制差异**：
- Koma 以 **骨骼 TRS + 骨链自动蒙皮 + 轮廓网格 + `deform` 网格场 + 逐层 `opacity / tint / clipTo`** 为核心，不在 Studio 堆砌全局参数表单与手工时间轴；连续动力学状态场让呼吸、微风与弹簧动量在任意状态切换和触发时自然延续。
- **几何自检分工**：底层 `rig.pose()`、Studio 试动、`rig check-bend`、`inspect:live` 及 Koma Live 开启「审查」叠层时执行全量 `checkGeometry`（超限抛 `GeometryError` 标红翻面三角形）；生产播放态 `mountPerformance` / `mountLiveRig` 默认 `validateGeometry: false`（重度角色 CPU 提速 ~20×），设计期务必以 `check-bend` 与 `inspect:live` 守住安全边界。

---

## 3. 标准作业闭环与 5 条底线

1. **先看图读数据，绝不盲猜**：先读 `reference.png`、`npm run rig -- spec <dir>`，有骨链时先跑 `npm run rig -- check-bend <dir>`；不擅自篡改原画默认静止像素（用动态视线/形变激活而非硬改原图）。
2. **注意坐标与缩放规则**：画布原点在左上，`+X` 右、`+Y` 下，顺时针为正角度；**子骨 `x/y` 平移在父骨局部空间**（需按父骨世界静止角旋转换算），父级 `scale` 会继承给全部子孙。
3. **遵守 4 条零漂移运行护栏**：单文件自包含 ES Module（零外部 `import`）；仅由 `timeMs / dtMs` 与确定性 PRNG 驱动并在 `reset()` 彻底清零；2D 前后景严格按 `ctx.size` 逻辑像素绘制并用 `save()/restore()`（禁 `resetTransform()`）；不读 DOM、不启私循环、不吞 `GeometryError`。
4. **必须视觉验收再交付**：跑 `npm run inspect:live` 产出审片板并直接看图检查剪影、接触锁定、透明边缘、漫符落位与眨眼过渡，同时核对 `telemetry.json`（`errors: []`、刚体 `effectiveScale: [1, 1]`）。
5. **本地联调免手选**：开发态直达 `?view=live&work=examples/<name>` 或 `?work=examples/<name>`，保持自动热重载；发布移动端包可直接 `npm run rig -- export-work <dir> <out> --scale 0.5`（零改脚本省 4× 显存）。

---

## 4. 按需查阅详细手册

- **查 CLI 参数、坐标系公式、接口签名、单文件模板、`inspect:live` 审片板配置** → 读 [references/tools-and-contracts.md](./references/tools-and-contracts.md)
- **做立绘绑骨规划、选轮廓网格参数、写物理弹簧 / 单向风场 / 2-Bone IK / 零露眼白眨眼、排查死板与穿帮** → 读 [references/craft-and-playbooks.md](./references/craft-and-playbooks.md)
