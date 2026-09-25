# ipadown 通信协议分析 (逆向自 `ipadown_20260123.exe`)

> 本文记录旧版通信格式。Apple 后续要求登录请求使用 SAP 签名；当前应用的登录实现见 `authbridge/main.go` 与 `src/auth-bridge.js`，调用 ipatool v2.6.0。下文的未签名 `authenticate` 字典请求已停用，会收到 HTTP 403。

> 工具用 **易语言** 编写，本质是 Apple App Store / iTunes Store 私有
> "Configurator / StoreKit" 协议的客户端（与开源 `ipatool` 同源）。
> 下面是用 IDA Pro 逆向得到的全部通信细节，Go 版按此 1:1 复刻。

## 1. 设备标识 GUID

- 调用 `GetAdaptersInfo` 取本机网卡 **MAC 地址**，去掉分隔符、转大写得到 `GUID`
  （例：`A1B2C3D4E5F6`）。
- 早期版本写死 GUID 导致大量用户同 GUID 被苹果风控，现改为读取本机网卡。
- GUID 同时用于鉴权、下载、购买三个接口的 `?guid=` 查询参数。

## 2. 公共请求头 (Configurator 伪装)

```
User-Agent: Configurator/2.18 (Macintosh; OS X 15.4.1; 24E263) AppleWebKit/0621.1.15.11.10
Content-Type: application/x-www-form-urlencoded
X-Dsid: <dsPersonId>
iCloud-Dsid: <dsPersonId>
X-Apple-Store-Front: <storefront>     # 例 JP=143462, US=143441, CN=143465
X-Token: <passwordToken>
```

登录成功后服务器返回的 `Set-Cookie` 全部保存，后续下载/购买请求需带上。

## 3. 鉴权 authenticate

```
POST https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=<GUID>
```
另一可选的预热端点：
```
GET  https://auth.itunes.apple.com/auth/v1/native/fast?guid=<GUID>
```

请求体（字符串模板，`attempt` 第一次为 `4`，二次验证为 `2`）：
```
{'appleId':'<user>','attempt':'<4|2>','createSession':'true','guid':'<GUID>','password':'<pass>','rmp':'0','why':'signIn'}
```

> 注：二次验证(2FA)时 `password` = 原密码 + 6 位验证码，`attempt` 用 `2`。

> ⚠️ **实测/Frida 抓包修正（2026-06）**：请求体格式因端点而异（Content-Type 始终为
> `application/x-www-form-urlencoded`，但 body 内容不同）：
> - **authenticate**：用单引号字典字面量 `{'k':'v',...}`。从 Node 发标准 XML plist 会被
>   WAF 403（原版用 libcurl 发 plist 可过——疑似 TLS 指纹差异）。
> - **volumeStoreDownloadProduct / buyProduct**：用**标准 XML plist** body
>   （Frida 抓原版确认，键 `guid`/`salableAdamId`/`externalVersionId`）。
>   之前用字典字面量发 download 会得 `failureType 5002`，换成 plist 即成功。
> - **guid 对 download 无影响**（任意 MAC 都能下，实测三种网卡均成功）；
>   X-Token/Cookie 才是关键。响应体始终为 XML plist。

响应为 **XML plist**，关键字段：
| 字段 | 含义 |
|------|------|
| `dsPersonId` | 账号数字 ID，写入 `X-Dsid` |
| `passwordToken` | 会话令牌，写入 `X-Token` |
| `accountInfo.appleId` | 规范化后的 Apple ID |
| `accountInfo.address.firstName/lastName` | 姓名（写入 iTunesMetadata） |
| `x-set-apple-store-front` (响应头) | 实际归属商店 storefront |
| `customerMessage` / `failureType` | 失败原因（账号密码错/需 2FA/被锁等） |

常见错误：`MZFinance.BadLogin.Configurator_message`（账密错或需 2FA）、
`Your account is disabled.`（账号被封）。

## 4. 下载 volumeStoreDownloadProduct

```
POST https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=<GUID>
```
请求体（plist 或 form 形式）参数：
| 参数 | 含义 |
|------|------|
| `salableAdamId` | App 的 appid（如 337248563） |
| `externalVersionId` / `appExtVrsId` | 指定历史版本的 version-id（0 = 最新） |
| `productType` | `C` |
| `pricingParameters` | `STDQ`(购买) 或 `SWUPD`(更新，降低登录频率) |

响应 plist：`songList[0]` 内含：
- `URL` —— IPA 真实下载直链（走 `iosapps.itunes.apple.com`）
- `sinfs[]` —— DRM 签名，每项含 `id` 与 `sinf`(data)
- `metadata` —— 写入 `iTunesMetadata.plist` 的字典
- 顶层 `customerMessage` / `failureType` —— 失败提示

下载头额外带：
```
Apple-Download-Type: buy
Host: iosapps.itunes.apple.com
```
原程序用 `aria2c.exe` 做多线程/断点续传下载，Go 版用原生分片下载替代。

## 5. 购买 buyProduct (首次获取授权)

```
POST https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct
```
form 参数：
| 参数 | 值 |
|------|----|
| `salableAdamId` | appid |
| `appExtVrsId` | version-id |
| `buyWithoutAuthorization` | `true` |
| `hasAskedToFulfillPreorder` | `true` |
| `hasDoneAgeCheck` | `true` |
| `price` | `0` |
| `pricingParameters` | `STDQ`(购买) / `SWUPD`(标记已购免更新) |
| `productType` | `C` |

> 仅当账号"未拥有"该 App 时需要先 buyProduct，再 volumeStoreDownloadProduct。
> 免费 App 价格为 0 即可"购买"。错误码 `2034`=CK 过期需更新凭证，`9610`=未购买。

## 6. IPA 后处理（关键：让 IPA 可被侧载安装）

下载得到的原始 zip 缺少 DRM 信息，需注入：
1. 在压缩包根目录写入 `iTunesMetadata.plist`（来自响应 `metadata`，
   并把 `softwareVersionExternalIdentifier` 设为版本 id、写入 `appleId`）。
   "免更新"模式会把 `softwareVersionExternalIdentifier` 改成 `999888777`。
2. 把每个 `sinf` 写入 `Payload/<App>.app/SC_Info/<App>.sinf`
   （`id` 对应 `Info.plist` 中的可执行项顺序）。
3. 解析 `Payload/<App>.app/Info.plist` 读取
   `CFBundleShortVersionString`、`CFBundleIdentifier` 等用于展示。

## 7. 查询/搜索接口（公开 iTunes API）

| 用途 | URL |
|------|-----|
| 按 id 查 App 信息 | `https://itunes.apple.com/lookup?id=<appid>&country=<cc>` |
| 关键词搜索 | `https://itunes.apple.com/search?term=<kw>&country=<cc>&entity=software&limit=20` |
| 历史版本 id（第三方） | `https://api.timbrd.com/apple/app-version/index.php?id=<appid>` |
| 网页详情 | `https://apps.apple.com/<cc>/app/id<appid>` |

`softwareVersionExternalIdentifiers` 字段（lookup 返回）= 该 App 全部历史版本 id。

## 8. Storefront（国家→商店）映射

二进制内置 `<storefrontId>\0<CC>` 表，例：
`US=143441 CN=143465 JP=143462 GB=143444 DE=143443 FR=143442 KR=143466
TW=143470 HK=143463 IN=143467 AU=143460 CA=143455 …`（Go 版 `storefront.go` 内置完整表）。
