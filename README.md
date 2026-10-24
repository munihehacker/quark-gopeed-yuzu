# Quark → Gopeed 直链加速工具箱 🐾

夸克网盘文件**多线程加速下载**的一套工具：调用夸克官方接口获取文件真实直链，交给 [Gopeed](https://gopeed.com) 分段下载，突破网盘单线程限速。

两个组件，按喜好选用（也可同时安装）：

| 组件 | 交互方式 | 适合 |
|---|---|---|
| **Gopeed 扩展**（本仓库根目录） | 把夸克分享链接粘进 Gopeed → 自动展开全部文件 → 勾选下载 | 整个分享打包下载 |
| **浏览器扩展**（`browser-extension/`） | 在夸克网页里勾选文件/文件夹 → 一键推送到 Gopeed | 网盘里挑着下、逛网页顺手下 |

> [!NOTE]
> 仅封装夸克官方 API + 使用者自己的登录 Cookie，无任何破解或 DRM 绕过。
> 仅供下载你有权访问的内容（自有文件、授权分享等），请遵守夸克用户协议与当地法律。
> 接口为非官方对外开放接口，可能随夸克版本变化而失效。

## 一、Gopeed 扩展安装（推荐）

1. Gopeed → 扩展 → 安装扩展 → 填入本仓库地址：`https://github.com/munihehacker/quark-gopeed-yuzu`
   （或下载本仓库 zip 解压后，选"从文件夹安装"）
2. 扩展设置 → **夸克 Cookie**：
   浏览器登录 `pan.quark.cn` → F12 → Network → 任选一个请求 → 复制 Request Headers 里完整的 `Cookie` 值粘贴进来
3. Gopeed 设置 → 连接数 调到 **256**（加速关键）

使用：复制分享链接（需要提取码的在链接后加 `?pw=提取码`；只要子目录就复制带 `#/list/share/xxx` 的完整链接）→ Gopeed 新建 → 粘贴 → 确认 → 勾选文件下载。

特性：递归扫描整个分享、按网盘剩余空间**分批转存+边转边删**（空间小也能下大分享）、批量提取直链、直链过期自动刷新、夸克官方客户端 UA。

## 二、浏览器扩展安装

1. `chrome://extensions`（Edge：`edge://extensions`）→ 开启开发者模式 → 加载已解压的扩展程序 → 选 `browser-extension` 文件夹
2. 点扩展图标 → 设置 Gopeed API 地址（默认 `http://127.0.0.1:16801`）和接口令牌 → **测试连接**

使用：打开 `pan.quark.cn` → 右下角 🐾 → 浏览/进入文件夹 → 勾选 → 「🚀 推送到 Gopeed」。分享页同样支持（自动转存到「Gopeed推送」目录再取直链）。

> 拿直链的请求会由 `declarativeNetRequest` 规则自动改写为夸克官方客户端 UA，规避网页端的 "download file size limit" 单文件大小限制。

## 常见问题

| 症状 | 处理 |
|---|---|
| Cookie 已失效 | 重新登录网页复制 Cookie（几天到几周会过期） |
| `23018` 风控 | 转存/直链太频繁，歇几分钟再试 |
| 推送报 unauthorized | Gopeed 接口令牌没填对，或未开启 TCP 通讯（设置→高级） |
| 直链下载 0 速 | 任务里直链过期，删任务重推（Gopeed 扩展会自动刷新） |
| 非会员超大文件仍被拒 | 夸克服务端会员墙，扩展已用客户端 UA 尽量兼容，个别情况无解 |

## 致谢

- [muyan556/gopeed-extension-quark](https://github.com/muyan556/gopeed-extension-quark)（MIT）— Gopeed 扩展的参考实现
- [Cp0204/quark-auto-save](https://github.com/Cp0204/quark-auto-save) — 夸克 API 封装参考

## License

MIT
