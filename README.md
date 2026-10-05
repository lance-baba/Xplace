# Scene Engine v0.1 — 草坪切片

游戏+视频双用场景引擎骨架。第一个内容切片：一片风格化草坪。

## 目录

- `index.html` — 引擎本体（单文件，Three.js 0.182）
- `capture.mjs` — 视频模式：逐帧抓取 → ffmpeg 合成 MP4
- `vendor/three-stylized/` — 参考实现（MIT），草地风场方法来源
- `scene-engine-summer-5s.mp4` — 夏日版 5 秒视频
- `qc_summer.png` / `qc_night.png` — 双风格截图

## 架构（三层）

```
core    渲染器 / ACES / 雾 / 灯光 / 相机系统 / renderFrame(t)   ← 稳定，只做一次
style   JSON preset：天空、雾、灯光、草色、树色……              ← 换风格 = 换 preset + 资产
content 草地 / 树 / 地形 / 萤火虫……                            ← 可替换
```

## 两种输出

- **游戏模式**（默认）：`meadow-pond.html` — 单文件浏览器程序（three.js 已打包，无外部依赖），打开即玩，OrbitControls 视角
- **视频模式**：`?mode=cinema` — 脚本运镜（缓慢环绕+推近），`capture.mjs` 150 帧 → 5s MP4

## 风格切换

`?style=summer` 菊次郎夏日 / `?style=night` 夜（萤火虫）
后续加风格（怪谈/科技）：新增一个 preset 对象 + 对应资产包，引擎不动。

## 草地技术（学自 three-stylized）

- InstancedMesh 9000 刃，确定性种子播撒
- 顶点着色器风场：世界空间双正弦波，按刃高²遮罩
- 片段：底→梢渐变 + 逆光透射 + 根部假 AO

## 下一步

1. 小木屋/栅栏等建筑资产
2. Blender → glTF 资产替换程序化树
3. 怪谈、科技 preset
4. 游戏模式：角色 + 简单玩法

## v0.2（2026-10-05）：水池 + 程序云天空 + 浏览器单文件

- 草甸旁加了一小块水池（轻量风格化水 shader：波浪顶点位移、深浅渐变、菲涅尔天空反射、太阳闪光、边缘泡沫），作为海洋效果的轻量验证，不搬 NAGI 的 FFT（省性能）
- 天空换成程序 fbm 云穹顶（方法学自 NAGI），云量进风格 preset
- 地形改用 RingGeometry（CircleGeometry 内部无顶点，洼地形不成——踩坑记录）
- 默认改为游戏模式（时钟自驱）；`meadow-pond.html` 为 esbuild 打包的单文件（569KB，零外部依赖），浏览器直接运行
