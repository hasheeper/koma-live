# Koma Live 离线制作与验收（Koma Rig CLI / PSD）

在仓库根目录使用 Node 26。TypeScript 内核与 CLI 负责骨架、绑定、姿势求值与清单导出；离线 PNG 像素比对与出图使用 Python、NumPy 和 Pillow 环境（可用 `uv sync --locked --project tools/psd` 安装，或用 `KOMA_RIG_PYTHON` 指向已有解释器）。

> **与实时驱动运行时的分工**：离线 CLI 适合批量建骨、像素级原稿复原、换图重导（`reimport`）与静态归档（`publish`）；若需要将角色接入前端程序化代码美术，请在完成绑骨后通过工作台或 `npm run rig -- spec <目录> [rig-spec.json]`（支持直接从含 `rig.json` 或仅含 `setup.json` 的源目录零落盘打印或导出）获取 `rig-spec.json`，并在宿主页面直接使用 `packages/rig-renderer/dist/runtime/player.js` 的 `mountPerformance` / `mountLiveRig` 进行实时骨骼 **TRS** 驱动。[功能规格](implementation-plan.md) · [演出契约与 Koma Live](performance-contract.md)

## 用两张纸条走完离线流程

两根骨各长 `56 px`，蓝纸条与黄纸条在画布点 `(76, 40)` 铰接。先导入临时企划，切片合成与独立参考图的像素对照通过后才创建目录。[测试夹具](../tests/fixtures/hinge/manifest.json) · [建骨与绑层操作](../tests/fixtures/hinge/setup.json) · [可选晶格操作](../tests/fixtures/hinge/grid.json)

```sh
work=$(mktemp -d)
npm run rig -- import tests/fixtures/hinge "$work/hinge"
npm run rig -- edit "$work/hinge" tests/fixtures/hinge/setup.json
npm run rig -- inspect "$work/hinge"
npm run rig -- save "$work/hinge"
npm run rig -- verify-slices "$work/hinge"

echo '{"bones":{"base-joint":{"y":-6,"rotation":5,"scaleX":1.04},"tip-joint":{"rotation":8}}}' > "$work/trs.json"
npm run rig -- render "$work/hinge" "$work/posed.png" "$work/trs.json"
npm run rig -- render "$work/hinge" "$work/rest.png"
```

第一次 `edit` 即可从只有切片的目录建立空 Rig；一次操作数组构成一次撤销单位。省略试动文件即回到静止姿势。

## 同一张纸带跨两根骨

```sh
work=$(mktemp -d)
npm run rig -- import tests/fixtures/chain-strip "$work/strip"
npm run rig -- edit "$work/strip" tests/fixtures/chain-strip/setup.json
npm run rig -- render "$work/strip" "$work/rest.png"
npm run rig -- render "$work/strip" "$work/bent.png" tests/fixtures/chain-strip/bend.json
npm run rig -- save "$work/strip"
npm run rig -- sample "$work/strip/rig.json" tests/fixtures/chain-strip/motions/bend.json 800
```

`sample` 与 `render` 在姿势求值后自动执行三角形翻面、退化与自交体检，报错直接定位部件、毫秒与三角形索引。

## 骨链轮廓网格批量生成与安全角体检

完成 `boneChain` 绑定后，可用零额外依赖的 CLI 工具批量生成防翻面轮廓网格，并在编写实时演出脚本前扫描每条骨链的正负极限无翻面安全转角（均同时支持 `koma-work.json` 作品根目录或切片目录）：

```sh
# 默认仅为缺网格的 boneChain 图层生成低凹度防翻面轮廓网格（detail:28, concavity:10, padding:4）
npm run rig -- auto-mesh <你的作品或切片目录> --dry-run
npm run rig -- auto-mesh <你的作品或切片目录>

# 扫描所有 boneChain 逐节与联动最大无翻面转角，低于阈值自动标记 warn
npm run rig -- check-bend <你的作品或切片目录> --max-angle 75 --warn-below 18
```

若源 PSD 存在角落孤立脏点或整画布低透明雾噪，可直接单命令去噪并烘焙干净 `reference.png`（内置 0 误差复验并输出逐层清理 JSON 报告）：

```sh
uv run --locked --project tools/psd python -m layer_rig_psd.slices character.psd out/slices --source-id character --trim-stray --bake-reference
```

## 作者可写的编辑操作（`RigEdit`）

| 操作 | 输入与效果 |
|---|---|
| `add-bone` | 输入 `boneId` 和画布终点 `end`。根骨另给 `start`；选定 `parentBoneId` 时默认从其尖端创建，`snap: false` 配合 `start` 可建有偏移的子骨。起终点一致得到点关节。 |
| `place-bone` | 用画布坐标 `start/end` 移动骨身或调整尖端，自动重算附着图层的静止偏移。 |
| `edit-bone`、`reparent`、`remove-bone` | `edit-bone` 编辑名称、父空间起点、静止角度、长度及可选驱动系数；`reparent` 重算局部坐标以保留骨骼静止世界位置（父级填 `null` 设为根骨）；`remove-bone` 删除无引用的骨骼，若仍被子骨或图层引用则原子报错。 |
| `bind`、`bind-chain`、`unbind` | 分别绑定单骨（`boneId`）、连续母子骨链（`boneChain` 与可选 `jointSoftnessPx`）或解绑；均在静止姿势按世界矩阵重算偏移，保留原有轮廓网格与设置。 |
| `set-layer` | 设置图层 `locked` 或 `visible`。锁定保护绑定与网格编辑，骨架仍可带动它运动；隐藏层从最终姿势隐藏。 |
| `draw-order` | `layers` 给出由后至前的完整图层 ID 列表；同深度组（`gelGroups`）成员须保持连续且维持校准覆盖优先级。 |
| `set-mesh` | 指定 `layerId` 与切片局部像素坐标 `mesh: { points, indices }`；填 `null` 清除自定义轮廓网格还原为矩形图像。 |
| `set-parameter`、`remove-parameter` | 可选的离线语义参数增改删（删除仍被引用的参数会原子报错）；仅在需要静态动作或局部变形器时使用。 |
| `create-ffd`、`ffd-point`、`set-deformer` | 可选的局部变形器（`3×3` / `4×4` FFD 晶格或 Ribbon 条带）创建、调点与移除（填 `null`）。[变形器求值](../packages/rig-core/src/geometry.ts) |

`preview` 接受临时的 `bones`（完整 TRS：`{ x?, y?, rotation?, scaleX?, scaleY? }`）、`rotations` 与 `parameters`，返回骨骼实时起终点、矩阵与部件几何。[编辑操作 Schema](../packages/rig-core/src/authoring.ts)

## 保存、撤销与换图

- `edit`、`undo`、`redo` 更新本地 `.rig-draft.json`，用 `save` 原子写回 `rig.json`；写入加系统文件锁并比对摘要，发现外部修改冲突时可用 `rig recover <目录> <新文件>` 另存草稿。
- `rig reimport <已保存企划> <新切片目录>` 对比新增、缺失、位置、层序与轮廓变化；同 `sourceId` 且保留 PSD 原生 `lyid` 的改名层自动认回；重建或拆并层用 `--map mapping.json` 显式映射并用 `--out 新目录` 复验像素后输出。

## 像素复原与静态归档发布

- `verify-slices` 按清单复原切片并与独立 `reference.png` 逐像素比对 8 位预乘 RGBA（默认每通道容差 1），可输出热图 PNG。
- 如需离线审计静态 `motions/*.json` 并打包带 SHA-256 校验的静态发布 ZIP（供 `mountPublished` 使用），依次执行：

```sh
npm run rig -- review tests/fixtures/layered-parts idle.json activate.json
# 人工看片确认后写入 acceptance.json（含 reviewId、reviewer、approved: true）
npm run rig -- publish <目录> <待机.json> <响应.json> <新包.zip> <看片记录.json>
```
