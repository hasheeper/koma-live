# THA3 头部 Morph 烘焙

从全分辨率 Koma 切片、已保存的骨架和角色的 `head-bake.json` 生成两轴 Morph。播放端读取原始贴图和网格位移。神经网络、模型权重和推理缓存仅用于离线制作。

## 安装与运行

在仓库根目录安装 Node 工作区依赖，使用 Python 3.11 或 3.12 和 uv 创建独立环境。

```sh
npm ci
uv venv --python 3.11 tools/head-bake/.venv
uv pip install --python tools/head-bake/.venv/bin/python -r tools/head-bake/pyproject.toml
tools/head-bake/.venv/bin/python tools/head-bake/fetch_tha3.py
```

下载器读取固定提交并核对五份 `separable_float` 权重的 SHA-256。弱网连接可加 `--chunked` 分段下载。默认缓存目录为 `~/.cache/koma-rig/tha3`。可用 `--host` 指定 Hugging Face 镜像，用 `--weights-dir` 在下载和烘焙时指定相同的本地目录。离线机器可复制已校验的 `source/` 和 `separable_float/` 两个子目录。

```sh
work=examples/<character>
out=.tmp/<character>-head
npm run rig -- bake-head "$work" --out "$out"
npm run rig -- bake-head "$work" --out "$out" --apply
npm run inspect:live -- "$work" --times 0,250,500 --out "$out/live"
```

第一条烘焙命令生成候选编辑并验证。第二条复用相同输入的推理缓存，在作品草稿锁内校验、保存并保留撤销记录。执行时若发现切片清单、骨架版本或未保存的编辑发生冲突，会保留已有草稿。相同目标层和轴对的 Morph 会被替换，其他参数与 Morph 保留。作品目录与切片目录均可作为输入；`--config` 可指定配置文件。`KOMA_HEAD_BAKE_PYTHON` 可指定现有的 Python 解释器。

默认 `--device auto` 在 Apple Silicon 上用独立子进程运行 MPS，失败时重新以 CPU 求值。macOS 14 上使用 PyTorch 2.5.1，卷积网络运行于 MPS，THA3 的边缘延拓采样在 CPU 完成。可用 `--device mps` 强制验证 GPU，或用 `--device cpu` 重现 CPU 版本。不同后端有各自的缓存。

## 角色校准

配置的 `format` 为 `koma-rig.head-bake.v1`，`backend` 为 `tha3`，`model` 为 `separable_float`。新角色应使用自己的图层 ID、眼位与颈部坐标。[配置示例](../../docs/head-morph-bake-plan.md) · [Morph 数据格式](../../docs/rig-spec.md)

- `framing.faceLayer` 指向用于共享脸部拟合的切片。`headLayers` 的联合边界或显式 `faceBox: [x,y,w,h]` 决定构图。标准 512 像素输入将头放在上半部中央的 128 像素方框内。`neckAnchor` 与 `directionProbe` 均用原画画布像素，分别放在颈部支点和鼻部。`eyeAnchorLayers`、`scaleFactor` 与 `eyeTargetYRatio` 支持已有的自定义裁切。
- `passes.faceContextLayers` 按角色的绘制顺序合成脸、五官、耳与颈肩上下文。`hairContextAddLayers` 为第二次推理加入发冠、刘海和鬓发。大角等配件可由角色演出独立驱动。
- 两个通道各执行九次推理，包含各自的中立位。45 维参数中仅设置 `head_y`（40）和 `head_x`（39）。`tha3Amplitude` 控制左右幅度，`tha3Up` 和 `tha3Down` 分别控制仰、俯。`sign` 可选 ±1。烘焙器核验逻辑正向在原画坐标中确实向右、向下。
- `targets.sharedFaceGroup.layers` 指定共用脸部 TPS 的层及各自网格。可选 `affineFeatures` 为眼、口定义局部配准区。每个区域在 `fitRect` 内拟合仿射位移，在 `rect` 内应用同一映射，通过 `featherPx` 平滑衔接外围 TPS。两个矩形均为原画 `[x,y,w,h]`。配准区应覆盖可见区域周围一圈晶格顶点，区域间过渡可放在透明空隙。配准脸组的位移保留五位小数，其余层保留两位。
- `targets.independentLayers` 按图层的 Alpha 掩膜拟合耳、前发和鬓发。`fitLayer` 可共享另一个掩膜，`followPoint` 让整个配件使用一个根部位置的位移。运行时仍可通过脚本添加发梢风、眨眼或视线。

## 审片与故障定位

`targets.sharedFaceGroup` 支持四项防鱼眼与对称校准项（默认均保持原生教师场）：
- `yawCurvatureScale`（默认 `1`）：缩放左右转头时的横向非仿射曲度（`< 1` 可压低球面中心凸胀，`> 1` 增强曲度）；
- `yawHorizontalScale`（默认 `1`）：左右转头时施加轻度正交水平缩短（如 `0.988`），防止近眼放大发胀；
- `pitchCurvatureScale`（默认 `1`）：缩放俯仰时的纵向非仿射曲度（如 `0.25` 可抑制 3D 球面带来的眼眶 V 字斜歪）；
- `symmetrizePitch`（默认 `false`）：消除纯俯仰时的偶然偏滚转与左右眼高低差，并在 `framing.faceCenterX` 两侧对称化纯俯仰场；
- `symmetrizeYaw`（默认 `false`）：对左右对称的偏航姿态对（`(-1, y)` 与 `(+1, y)`）按 `framing.faceCenterX` 镜像平均，消除单侧偏转过猛或双眼间距不对称挤压；
- `independentLayers.<layerId>.parallaxScale`（可选）：将独立发片/耳饰的位移锚定在平滑后的脸底主场上，仅叠加缩放后的相对视差 `face_clean + parallaxScale * (hair_raw - face_raw)`，防止前发与鬓发相对脸颊滑出纸片感。

修改后重新执行烘焙即可复用已有推理样本。

| 输出 | 检查内容 |
| --- | --- |
| `framing_preview.png` | 核对两次推理的可见图层、头部标准框与颈肩上下文。 |
| `tha3_raw_9grid.png` | 检查教师模型的原始姿态与正负方向。 |
| `rotator_warp.png`、`editor_warp.png` | 比较仅用各自位移场采样的结果。默认选 256² 的 Rotator 低频场，`--field editor` 可试烘 512² 的 Editor 场。 |
| `warp_field_viz.png` | 脸部晶格、前向位移及局部面积比。橙色小于 0.8，青色为 0.8 至 1.2，紫色大于 1.2。标题给出全部烘焙层的最小值。 |
| `bake-report.json` | 每个角点的反解残差（原画像素）、最小雅可比、衰减系数、鼻部探针方向以及可见上下文的平均颜色修正权重。 |
| `edits.json` | 标准 `set-parameter` 与 `set-morphs` 编辑数组。 |

烘焙器用中立场校正输出到源图的反向采样，再按 Alpha 加权拟合前向位移并扣除颈部平移。若晶格面积比过低，则同步衰减该姿态的位移。保存前由 Node 在全部目标层可见时按 **5 × 5** 角度做最终三角面检查，纯头转的面积比要求为 **0.15**。角色演出的眨眼、配件与挂点另用 `inspect:live` 验证。

无权重的数学回归可运行 `(cd tools/head-bake && .venv/bin/python -m unittest discover -s tests -v)`。

## 署名与许可

Talking Head Anime 3 作者为 **Pramook Khungurn**。上游演示与推理代码使用 MIT 许可，预训练权重使用 CC BY 4.0。Koma 烘焙器从模型输出中提取位移、求逆并拟合角色网格。[上游项目与许可说明](https://github.com/pkhungurn/talking-head-anime-3-demo/tree/8946939ec7b417f443d7b0e3fcd97384313fcdb8) · [权重镜像](https://huggingface.co/ksuriuri/talking-head-anime-3-models/tree/a538612b602a019e8c59c8d08e89727a3c34525b) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
