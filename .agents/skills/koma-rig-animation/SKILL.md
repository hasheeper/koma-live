---
name: koma-rig-animation
description: >-
  Slice PSD assets, plan 2D skeletal rigs and contour meshes, author real-time
  procedural animations and coaxial 2D effects, and visually inspect Koma Rig
  characters. Use when working with PSD slicing, rig-spec.json, rig auto-mesh /
  check-bend, mountLiveRig, mountPerformance, Koma Live, or inspect:live.
---

# Koma Rig 2D 绑骨与实时动画指南

面向「精绘分层立绘 + 程序化实时驱动」工作流。先建立画面直觉与项目能力边界，再按需查阅详细工具手册与实战经验库。

---

## 1. 动画直觉与 ACGN / Spine / Live2D 审美基线

写代码或规划骨骼前，先看原画（`reference.png`），把角色当作受重力、惯性与材质约束的整体，而不是互不相关的正弦滑条：

- **重心与解剖层级**：骨盆/腰椎稳住重心，胸腔主导呼吸，锁骨、肩臂与头部按层级传递并带轻微相位滞后；地面站姿的脚底、撑地或持物接触点（如手扶面具、握武器）需锚定防滑步，悬浮/水下角色则用柔和浮力与水流惯性替代硬落地。
- **按题材选择物理场（解耦风场 vs 协同脉动）**：先明确驱动动力的来源，不偷懒拿同一条正弦波糊全图：
  - **常规陆地立绘**：把内在生物节律（呼吸、眨眼、微重心）与外在环境场（单向阵风波前、重力回复）解耦，头发与衣摆靠锚点惯性和单向风场流动，避免意外出现左右对称膨缩感。
  - **水母 / 水下 / 悬浮 / 梦幻漂浮题材**：可有意采用协同脉动与径向起伏（如伞盖/躯体收缩推进 → 触须、裙摆与飘带顺相位延迟舒展），通过相位差与流体阻尼做出饱满的浮力呼吸感。
- **材质与质量梯度**：
  - **刚体 / 机甲 / 硬质配饰**：保持 `scaleX = 1, scaleY = 1`，靠节奏、阻尼、IK 接触与微滞后表达重量，不捏扁拉长。
  - **重布料（厚外套、百褶裙）**：频率低、振幅克制、回弹沉稳；大片悬垂衣摆需 2 节骨链驱动，单骨容易“半边发死”。
  - **轻软物（长发、双马尾、丝带、领结）**：阻尼更低、滞后更明显，运动沿链条向末端逐节放大（*Follow-Through & Overlapping Action*）。
- **节奏、弧线与克制**：呼吸用非对称曲线（吸气舒展 → 顶点微停 → 呼气松沉，*Slow In / Slow Out*），避免机械正弦；末端走弧线（*Arcs*）；所有幅度服务于原画线稿与剪影，宁可克制传神，不破坏结构。

---

## 2. Koma Rig 项目基础能力与机制边界

| 阶段 | 核心工具 | 能力范围 |
|---|---|---|
| **离线切片** | `tools/psd` (`layer_rig_psd.slices`) | 8-bit RGB PSD 导 v2 sRGB PMA 切片包；`--trim-stray` 去孤立噪点/雾噪，`--bake-reference` 自动烘焙并 0 误差复验 `reference.png`。 |
| **绑骨与网格** | **Koma Studio** / `npm run rig` | 骨骼树、单骨与连续骨链（`boneChain`）自动权重蒙皮、关节柔化（`jointSoftnessPx`）、轮廓网格（Studio 一键生成或 `rig auto-mesh`）、骨链极限安全角扫描（`rig check-bend`）、导出 `rig-spec.json`（`rig spec`）。 |
| **实时演出** | **Koma Live** / `mountPerformance` / `mountLiveRig` | PixiJS WebGL 角色渲染 + 代码原生顶点变形口（`deform` Mesh Field）+ 同轴 1:1 DPR 对齐的 `back / front` 2D 前后景层；统一兼容 `koma-work.json` 与切片目录，开发态支持 `?work=` 直达与自动热重载。 |
| **视觉验收** | `npm run inspect:live` | 无头 Chromium 确定性采样，自由拼装关键帧条、Spine 风格洋葱皮（含轨迹弧 `arcs`、基准线 `guides`）、局部裁剪、Alpha 通道与跨视口对比板，输出 `telemetry.json`。 |

**与 Spine / Live2D 的机制差异**：
- Koma Rig 以**骨骼 TRS + 骨链自动蒙皮 + 轮廓网格 + 代码原生顶点变形口（`deform` Mesh Field）**为核心，不在 Studio 堆砌手工 FFD 晶格面板；丝带 S 波、水母伞盖波动、百褶裙微翻、轻度伪 2.5D 转头可直接通过 `deform` 在代码中以 `(u, v, x, y) => [dx, dy]` 实时驱动，并与骨骼、骨链、解析 IK、二阶弹簧和同轴 2D 前后景自由组合。
- 每次 `setPose` 都执行实时三角形翻面/退化/自交校验，超限即抛 `GeometryError`——这是安全护栏，设计前应先用 `rig check-bend` 摸清安全转角边界。

---

## 3. 标准作业闭环与 5 条底线

1. **先看图读数据，绝不盲猜**：先读 `reference.png`、`npm run rig -- spec <dir>`（拿骨骼树、静止朝向、绑定与差分槽），有骨链时跑 `npm run rig -- check-bend <dir>` 拿每节安全转角。
2. **注意坐标与缩放规则**：画布原点在左上，`+X` 右、`+Y` 下，顺时针为正角度；**子骨 `x/y` 平移在父骨局部空间**（需按父骨世界静止角旋转换算），父级 `scale` 会继承给全部子孙。
3. **遵守 4 条零漂移运行护栏**：单文件自包含 ES Module（零外部 `import`，确保 `Blob URL` 热重载）；仅由 `timeMs / dtMs` 与可复位 PRNG 驱动并在 `reset()` 清零全部内部状态；2D 前后景严格使用 `ctx.size` 逻辑像素且用 `save()/restore()`（禁 `resetTransform()`）；不读 DOM、不启私循环、不吞 `GeometryError`。
4. **必须视觉验收再交付**：跑 `npm run inspect:live` 产出审片板并直接看图检查剪影、接触锁定、透明边缘与运动弧线，同时核对 `telemetry.json`（`errors: []`、刚体 `effectiveScale: [1, 1]`）。
5. **本地联调免手选**：开发态直接在浏览器打开 `?view=live&work=examples/<name>` 或 `?work=examples/<name>`，保持自动热重载开启即可实时看改。

---

## 4. 按需查阅详细手册

- **查 CLI 参数、坐标系公式、接口签名、单文件模板、`inspect:live` 审片板配置** → 读 [references/tools-and-contracts.md](./references/tools-and-contracts.md)
- **做立绘绑骨规划、选轮廓网格参数、写物理弹簧 / 单向风场 / 2-Bone IK / 零露眼白眨眼、排查死板与穿帮** → 读 [references/craft-and-playbooks.md](./references/craft-and-playbooks.md)
