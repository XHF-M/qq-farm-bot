# 工具脚本

`tools/` 收录游戏配置、图片下载和协议抓包分析脚本。下载脚本只使用 Node.js 内置模块；协议分析脚本还会复用 `core` 的依赖、协议定义和已编译模块。

## 脚本索引

| 脚本 | 用途 |
| --- | --- |
| `download-game-config.js` | 从微信小程序 CDN 定位、下载并校验游戏 JSON 配置 |
| `sniff-asset-urls.js` | 自带 MITM 代理，记录客户端真实请求的资源 URL（免第三方抓包工具） |
| `extract-cdn-from-capture.js` | 从抓包导出（HAR / URL 文本）提取 CDN 基址与 bundle 版本，免反编译 |
| `download-game-images.js` | 根据游戏配置和 Cocos manifest 下载准确的 PNG 资源 |
| `decode-latest-protocols.js` | 解码选定的 WebSocket 抓包并保留未知 protobuf 字段 |
| `analyze-keepalive-capture.js` | 只输出非敏感的版本、心跳和 Gateway Token 形态统计 |
| `decode-shop-protocols.js` | 解码神秘商人、商城列表、购买响应及相关通知 |
| `audit-qingmei-flow.js` | 按时间顺序输出青梅活动抓包的精简审计记录 |

所有命令均在仓库根目录执行。

## 用自带代理嗅探资源 URL（不装第三方抓包工具）

官方贴图按 bundle 版本 hash 组织：

```text
<server>/remote/plant/config.<版本>.json            ← 版本号只能从真实请求里拿
<server>/remote/plant/native/<xx>/<uuid>.<hash>.astc ← 贴图本体
```

`remote/plant/config.json`、`version.manifest`、`project.manifest` 全部 404，CDN 也不开目录列举，
所以**必须有一次性客户端流量**才能拿到版本号。`sniff-asset-urls.js` 就是为这一步准备的极简代理：

- 只解密 `*.qq.com` / `*.gtimg.com` / `*.qpic.cn`，其他域名走原始 TCP 隧道
- **只记录请求 URL，不落盘请求/响应正文**
- 自动用本机 openssl 生成根 CA 和多 SAN 通配证书，放在 `.capture/certs/`（已在 `.gitignore`）
- 顺带提供证书下载页和手机配置说明

### 用法

```bash
node tools/sniff-asset-urls.js                 # 默认端口 18000
node tools/sniff-asset-urls.js --port 18001    # 换端口
node tools/sniff-asset-urls.js --reset         # 重新生成 CA 与证书
```

启动后终端会打印内网地址，例如：

```text
监听端口   : 18000
内网地址   : 192.168.1.107:18000
CA 证书    : http://192.168.1.107:18000/ca.crt
```

### 手机侧

1. 手机连**与本机相同的 WiFi**
2. WiFi 高级设置 → 手动代理 → 服务器填上面 IP，端口 `18000`
3. 浏览器打开 `http://<IP>:18000/`，Android 下 `ca.der`、iOS 下 `ca.crt`，下载并安装、信任
4. 打开 QQ → 农场，玩到能看到目标作物（如红薯）地块，停留 30 秒
5. 回到终端 `Ctrl+C`，日志在 `.capture/asset-urls.log`

### 输出

```text
2026-11-26T08:26:27.432Z ASSET https://cdn-resource.nqf.qq.com/release/remote/extraRes/config.c384c.json
2026-11-26T08:26:30.118Z ASSET https://cdn-resource.nqf.qq.com/release/remote/plant/native/ab/ab12....astc
```

`ASSET` 行即静态资源。日志可直接喂给下一步：

```bash
node tools/extract-cdn-from-capture.js --text .capture/asset-urls.log
```

### 注意

- 抓完**务必关掉手机代理**，否则手机会一直走本机网络
- Android 上部分 App 不信任用户安装的 CA，表现为开了代理就断网；遇到就把代理关掉，改用「手机截图 + 抠图」的兜底
- 证书只在本机 `.capture/certs/` 生成，绝不要提交或外发

## 从抓包提取 CDN 参数（免反编译）

`download-game-config.js` / `download-game-images.js` 原本要读小程序反编译源码里
`src/settings.*.json` 的 `assets.server` 与 `assets.bundleVers`。这两个值在**静态资源请求 URL** 里就有，
所以不反编译也能拿到：

```text
<server>/remote/<bundle>/config.<version>.json                 ← manifest，版本号来源
<server>/remote/<bundle>/<nativeBase>/<xx>/<uuid>.<hash>.png   ← 贴图
```

### 抓包要求

只需要抓到**静态资源请求**，不需要解协议、不需要登录态：

1. 用 Reqable / Charles / mitmproxy 给手机装 CA 证书，开 HTTPS 解密
2. 微信里清掉小游戏缓存，重新进入游戏（否则资源命中本地缓存，不发请求）
3. 导出 HAR，或者把请求 URL 列表复制成文本

### 提取

```bash
# HAR
node tools/extract-cdn-from-capture.js --har capture.har

# 纯文本 URL 列表
node tools/extract-cdn-from-capture.js --text urls.txt

# 直接给一条 URL
node tools/extract-cdn-from-capture.js --url "https://xxx/remote/mainscene/config.abc123.json"
```

输出可直接复制的两条命令：

```text
[CDN]    https://xxx.example.com/res/
[bundle] mainscene = abc123   (来自 config.<版本>.json)
```

### 后续

```bash
# 配置表（含 allconfig/<其他配置名>.json，活动临时作物通常在这里）
node tools/download-game-config.js --cdn-server "<CDN>" --bundle-version <版本>

# 贴图
node tools/download-game-images.js --cdn-server "<CDN>" --bundle-version mainscene=<版本>
```

`--bundle-version` 支持 `mainscene=abc,native=def` 多个 bundle。
不传 `--source` 时不会碰反编译目录。

### 局限

- 抓包里没有 `config.<版本>.json`（资源全命中缓存）→ 拿不到版本号，需清缓存重抓
- 部分资源走独立 CDN 域名，脚本会列出候选域名但只采用 `/remote/` 前缀最可靠的那个

## 游戏配置下载

`download-game-config.js` 用于从微信小程序当前 CDN 中定位、下载并解析以下资源：

- `ItemInfo.json`
- `Plant.json`
- `RoleLevel.json`
- `Land.json`
- `MutantEffect.json`
- `BuffCfg.json`
- `Illustrated.json`

工具完全独立于 `core` 和 `web`，只使用 Node.js 内置模块，不参与 bot 的构建或运行。

### 使用方法

在仓库根目录运行：

```bash
node tools/download-game-config.js
```

脚本内置默认参数如下，其中反编译源码路径仅适用于原开发环境，其他环境建议显式传入：

- 反编译源码：脚本内置的原开发环境路径，建议通过 `--source` 覆盖
- 输出目录：`tools/json`

也可以显式指定路径：

```bash
node tools/download-game-config.js \
  --source "D:\path\to\wx-mini-program-source" \
  --output "D:\path\to\game-config-output"
```

查看参数说明：

```bash
node tools/download-game-config.js --help
```

### 输出边界

工具默认只写入：

```text
tools/json/ItemInfo.json
tools/json/Plant.json
tools/json/RoleLevel.json
tools/json/Land.json
tools/json/MutantEffect.json
tools/json/BuffCfg.json
tools/json/Illustrated.json
tools/json/allconfig/<其他配置名>.json
```

它不会自动覆盖 `core/src/gameConfig`，也不会修改任何 `package.json` 或运行中的账号配置。需要正式更新 bot 配置时，应先人工检查新旧数据差异，再决定是否复制。

### 解析流程

1. 在反编译源码的 `src/settings.*.json` 中读取 CDN 地址和 `mainscene` bundle 版本。
2. 下载 `mainscene` 的 Cocos bundle manifest。
3. 扫描 manifest 中全部 `config/*` 资源，解析压缩 UUID 和 import hash。代码指定的 7 项写入 `tools/json` 根目录，其余配置写入 `tools/json/allconfig`。
4. 并发下载对应的 `cc.TextAsset`。
5. 对 `text` 先进行 Base64 解码，再使用小程序当前的配置密钥循环 XOR，得到原始 UTF-8 JSON。
6. 校验指定配置的 ID、变异 `effect_name`、Plant 引用、等级连续性以及土地网格坐标唯一性。
7. 全部资源成功后才替换输出文件；失败时保留上一次成功结果。

### 常见错误

- **找不到 settings 文件**：确认 `--source` 指向反编译源码根目录，并且其下存在 `src/settings.*.json`。
- **manifest 中找不到资源**：小程序可能调整了 bundle 或资源路径，需要重新核对反编译源码。
- **Base64、UTF-8 或 JSON 解码失败**：上游可能更换了配置保护方式或密钥。
- **Plant 引用不存在**：CDN 配置可能版本不一致，工具会拒绝写出半成品。
- **Land 坐标无效或重复**：土地网格配置不完整，工具会拒绝替换旧文件。
- **请求超时或 HTTP 错误**：检查网络和 CDN 可访问性后重试。

工具成功时会输出每个资源的 URL、UUID、hash、条目数及最终目录，方便核对 CDN 版本。

## 游戏图片下载

`download-game-images.js` 读取 `ItemInfo.json` 和 `Plant.json`，从小程序当前 CDN 精确定位图片，并按配置 ID 保存为 `<id>.png`。

### 使用方法

```bash
node tools/download-game-images.js
```

脚本内置默认参数如下，其中反编译源码路径仅适用于原开发环境，其他环境建议显式传入：

- JSON 输入目录：`tools/json`
- 图片输出目录：`tools/img`
- 反编译源码：脚本内置的原开发环境路径，建议通过 `--source` 覆盖
- 下载并发：8
- 可重试次数：3

完整参数示例：

```bash
node tools/download-game-images.js \
  --input "D:\path\to\game-json" \
  --output "D:\path\to\game-images" \
  --source "D:\path\to\wx-mini-program-source" \
  --concurrency 8 \
  --retries 3
```

查看帮助：

```bash
node tools/download-game-images.js --help
```

### 图片映射规则

- `ItemInfo.icon_res` 非空时，严格使用它指向的 `cc.SpriteFrame`，再解析同组 `cc.ImageAsset`。
- `icon_res` 为空时，使用 `asset_name` 构造图片路径：有 `bundle_name` 的物品使用该 bundle 中的 `texture/<asset_name>`，例如动物资源；其余使用 `model/v4/<asset_name>_Seed`。
- 配置指定 `bundle_name` 时仅在该 bundle 内匹配，避免同名资源混用。
- `Plant.seed_id` 非空时，通过对应 Item 的 `asset_name` 获取种子图。
- `Plant.seed_id` 为空时，通过 `Plant.fruit.id` 对应 Item 的 `asset_name` 获取种子图。
- Item 与 Plant 都使用各自的 ID 作为输出文件名，例如 `20002.png`、`40002.png`、`1020002.png`。

工具会解析 Cocos bundle 的 `redirect`、`deps`、UUID 和 `versions.native`，不会根据 ID 猜 URL，不会模糊匹配，也不会用相似图片或占位图兜底。

### 准确性与部分完成

部分 Item 配置指向的资源可能已不在当前 remote bundle manifest 中。对于这类 ID：

- 不生成错误图片；
- 继续下载其他能够唯一、准确映射的图片；
- 在 `download-images-report.json` 中记录失败原因和 ID；
- 进程以非零状态结束，并显示“部分完成”。

报告会记录每个 ID 的 JSON 字段来源、manifest path、声明 bundle、redirect 链、最终 owner bundle、UUID、hash、CDN URL、PNG 尺寸、SHA-256 和输出状态。

### 文件安全

下载内容必须通过 PNG 签名、IHDR、chunk CRC、IDAT、IEND 和解压校验。非 PNG 资源不会被伪装成 `.png`。

如果输出文件已经存在：

- 与当前 CDN 内容完全相同：跳过；
- 内容不同或已有文件损坏：通过临时文件和备份安全替换；
- 下载或替换失败：保留原文件。

工具不会删除输出目录中已有的额外图片。

## 协议抓包分析

这些脚本需要先安装工作区依赖并编译后端，因为它们会加载 `protobufjs` 和 TSDK 运行时：

```bash
pnpm install
pnpm build:core
```

### 通用协议解码

```bash
pnpm -C core exec node ../tools/decode-latest-protocols.js "D:\path\to\captures"
```

脚本会读取目录中的 `.bin` WebSocket 帧，解码背包、物品使用、任务、赛季和活动操作等已选协议，同时输出无法匹配到类型的原始 protobuf 字段。

### 保活协议安全审计

```bash
pnpm -C core exec tsx ../tools/analyze-keepalive-capture.js "D:\path\to\captures"
```

脚本会严格比较完整握手中的非敏感参数、Login/Heartbeat 版本、Heartbeat wire 字段、25 秒间隔和 Token 形态。报告不会包含 Code、完整 URL、原始 Token、GID 或业务消息正文，适合直接用于版本与保活回归核对。

### 商城协议解码

```bash
pnpm -C core exec node ../tools/decode-shop-protocols.js "D:\path\to\captures"
```

用于核对神秘商人、商城列表、商品购买、背包变更和商城刷新通知。输出中的 `roundtrip: true` 表示消息解码后重新编码的字节与原业务 body 一致。字段说明见[商城协议文档](shop-protocols.md)。

### 青梅活动流程审计

```bash
pnpm -C core exec node ../tools/audit-qingmei-flow.js "D:\path\to\captures" "ws_202608121522"
```

脚本按文件顺序输出青梅酿酒和分享流程的关键请求、响应、错误码、活动轮次及未知字段，适合对照一次完整操作链路。

> 抓包可能包含账号凭据、网关 Token 和游戏数据。分析前应保存副本，输出或提交日志前应先清理敏感信息。
