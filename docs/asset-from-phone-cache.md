# 从手机缓存取游戏资源（替代抓包）

## 结论先行

**在未 root 的 Android 手机上用 Fiddler/Charles 抓微信小游戏的资源 URL，抓不到，别浪费时间。**

正确做法：微信小游戏的原生资源会落盘到用户存储，用 adb 直接取，资源是明文的（manifest 是 JSON，贴图是 ASTC）。

## 为什么抓包抓不到

Android 7（API 24）起，App 默认只信任**系统 CA**，不信任用户手动安装的证书。微信小游戏的资源下载走微信原生网络栈，所以：

- `CONNECT cdn-resource.nqf.qq.com:443` 能抓到（隧道建立成功）
- 但隧道里面的 HTTP 请求一个都解不出来
- 只有 H5 页面（XWEB / Chromium 渲染层）的请求能解，比如 `mp.weixin.qq.com`、`badjs.weixinbridge.com`

判断方法：看 HAR 里同一台手机的请求，如果 `mp.weixin.qq.com` 解开了、`cdn-resource.nqf.qq.com` 没解开，就是这个问题，不是配置问题。

例外：iOS 上手动开启「证书信任设置 → 完全信任」后，App 会信任用户 CA，可以抓。有 iPhone 就用 iPhone。

## 正确路径：手机缓存

### 1. 定位小游戏缓存目录

```bash
ADB="C:/Users/Administrator/AppData/Local/Android/Sdk/platform-tools/adb.exe"
"$ADB" shell "grep -rl 'Crop_' /sdcard/Android/data/com.tencent.mm/MicroMsg/ 2>/dev/null | head"
```

命中类似：

```
/sdcard/Android/data/com.tencent.mm/MicroMsg/wxanewfiles/<账号hash>/gamecaches/plant/<时间戳>.json
```

`gamecaches/<bundle名>/` 就是 Cocos 的 bundle 缓存，bundle 名与 CDN 上一致（`plant`、`mainscene`、`extraRes` 等）。

### 2. 整目录拉下来

```bash
G=/sdcard/Android/data/com.tencent.mm/MicroMsg/wxanewfiles/<账号hash>/gamecaches
"$ADB" pull "$G/plant/" .capture/phone/plant
```

一个 bundle 通常几百个文件、几 MB，很快。

### 3. 认文件

| 文件 | 内容 |
|---|---|
| `*.json`（最大，几百 KB） | bundle manifest，含 `paths` / `uuids` / `versions` |
| `*.json`（小，几十 KB） | `cc.Texture2D` 打包元数据 |
| `*.json`（几 KB，`[1,[...]]` 开头） | `cc.SpriteFrame`，**含资源名**，如 `"name":"Crop_307_Seed"` |
| `*.astc` | 贴图本体（移动端压缩纹理） |
| `*.png` | 少数不压缩的贴图 |

**关键：文件名是时间戳，和 uuid 无关，不能靠名字反查。** 但 `cc.SpriteFrame` 的 json 里有 `_textureSource`，能拿到 texture uuid；manifest 里能用 uuid 查到 `versions.native`（hash），只是 CDN 有防盗链、资源下不下来。

### 4. 把 astc 认领到资源名

**文件名全是时间戳，`rect` 和时间邻近都不够可靠 —— 实测两次都错位了，别再走这两条路。**

- `rect` 不是内容的包围盒，只是 sprite 的声明区。红薯 `Crop_307_Seed` 的 `rect` 是 `0,0,100,99`，
  但解码图里内容只占 `(6,1)-(96,96)`，每张图的 padding 还不一样，没法当唯一键。
- 时间戳配对（`SpriteFrame.json → ImageAsset.json → astc` 相邻）只在「一次性全量下载」时成立。
  手机缓存里同一批 astc 是集中下载的，时间戳密集到毫秒，按「最近」配对会把胡萝卜认成红薯。

**可行的方法：拿项目里的旧图当锚点，做一对一内容匹配。**

1. 资源名 → itemId 的规则是确定的（`Crop_<n>_Seed` → `20000+n`，`Crop_<n>_<phase>` → `1020000+n`），
   `EventPlants.json` / `ItemInfo.json` 里还有官方的 `asset_name` 可以直接查
2. 项目里已经有大部分旧版官方图，同一作物的新旧两版差异远小于跨作物差异
3. 把「旧图 × 解码图」算成代价矩阵，贪心全局最小分配，保证一对一
4. 按距离分档判定：

| 距离 | 含义 | 处理 |
|---|---|---|
| `<= 3` | 同一张图（ASTC 有损压缩差异） | 不覆盖，项目里的无损 PNG 更好 |
| `3 ~ 10` | 图案一致，构图/色差毫厘 | 不覆盖 |
| `> 10` | 美术改版 | 覆盖，但先肉眼核对 |

> 距离用 48×48 缩放的 RGBA 平均绝对差（0-255）。跨作物的距离通常在 100 以上，
> 同作物新旧版在 15~25，压缩噪声在 5 以下 —— 分档很清楚。

`> 10` 的一批务必拼成对比图看一遍：左右并排（旧 / 新），确认是同一作物的不同版本再落盘。
本项目 16 组全部核对通过（例如 `20527 森野甜橙` 旧版切开、新版整颗 + 金色版）。

### 5. 解码 ASTC

```bash
# 下载解码器（需要代理，GitHub 直连常超时）
curl -x http://127.0.0.1:10808 -sSL -o astcenc.zip \
  https://github.com/ARM-software/astc-encoder/releases/download/5.7.1/astcenc-5.7.1-windows-x64.zip
tar -xf astcenc.zip

# 解码（注意：5.x 用 -dl/-ds，没有 -d）
astcenc-avx2.exe -dl input.astc output.png -silent
```

ASTC 文件头（前 16 字节）自带格式信息，可用来读尺寸：

```
0-3   magic  13 ab a1 5c
4-6   block  x / y / z
7-9   dim    width
10-12 dim    height
13-15 dim    depth
```

## 本项目实测数据（2026-11-26 / 27）

- 小游戏资源 CDN：`https://cdn-resource.nqf.qq.com/release/`
  - `remote/<bundle>/config.<hash>.json` 可公开下载（实测 `extraRes/config.c384c.json` 200）
  - `remote/<bundle>/native/...` 全部 404，有防盗链
- bundle 落盘目录：`gamecaches/` 下有 `plant`、`mainscene`、`extraRes`、`animal`、`delayRes`、`mcRes`、`commonRes`、`audio`、`petdog` 九个子目录
- `plant` bundle：272 个 json（manifest / SpriteFrame / ImageAsset）+ 131 个 astc
  - 100×100 有 87 张（种子图），150×150 有 42 张（作物阶段图）
  - 实测尺寸池：`100x100`、`101x102`（两个 527/528 系列）、`150x150` 三种
- 红薯 `Crop_307_Seed`：100×100，缓存文件 `1795661844979146.astc`
- 红枣之外的活动作物（522~530、9003/9005、1435、416、21、129、121、109）都是**美术改版**，
  项目里的旧图与官方新图距离 15~23，已更新 16 组

## 配置 TextAsset 是加密的，别硬解

`mainscene` 里的 `Plant` / `ItemInfo` 是 `cc.TextAsset`，`text` 字段 base64 解码后熵 6.925、
与项目旧版做 XOR 找不到 ≤64 的周期 —— 加密或压缩过，没有密钥解不开。

**要新配置直接对齐上游仓库**，`muyuewang/main` 的 `core/src/gameConfig/` 已经是新版，
`EventPlants.json` 更是仓库里一直缺的活动作物表。

## 注意

- `wxafiles/<appid>/` 是另一套缓存（网页/接口层），`wxanewfiles/<hash>/gamecaches/` 才是 Cocos 资源
- 微信数据在 `/data/data/com.tencent.mm/`（私有目录）时需要 root；能在外置存储找到就不用 root
- 拉下来的资源不要提交进仓库，放 `.capture/`
- 解码器 `astcenc-avx2.exe` 放在 `.capture/tools/bin/`，不随仓库走
