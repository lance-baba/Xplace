# Scene Engine — 海洋场景（我们自己的实现）

## 文件

- `ocean.html` — **单文件版（3.6MB）**：浏览器直接打开，手机可用
- `ocean-dev.html` — 开发版（importmap + 本地模块）
- `ocean-dist/` — 打包中间文件
- `lib/spectral-ocean.js` / `lib/float-readback.js` — FFT 波形模块（MIT，noxellab）
- `assets-sky-base.jpg` — 天空照片（Poly Haven "Kloofendal 48d Partly Cloudy"，CC0-1.0）

## 做法（学方法，不套壳）

- **波形**：用 NAGI 的频谱 FFT 模块生成位移/法线纹理（三频带 256² 级联），**海面 shader 是我们自己写的**：风格化高度渐变、菲涅尔天空反射、太阳闪光、波峰泡沫
- **天空**：CC0 照片全景做天穹贴图（summer/storm）；night 用程序渐变
- **引擎规范**：style preset、确定性 `renderFrame(t)`、game/cinema 双模式，与草甸场景一致
- **手机降级**：无浮点渲染目标时自动切 Gerstner 解析波

## URL 参数

- `?style=summer|storm|night` — 风格（浪高、色调、天空联动）
- `?mode=cinema` — 视频模式（脚本运镜）

## 备注

之前走错过一次：曾把 NAGI 应用整体打包套壳（9MB，手机打不开），用户纠正后改为"学方法、做我们自己的效果"。套壳版已移入 trash。
