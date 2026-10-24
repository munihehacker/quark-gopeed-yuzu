# Quark → Gopeed 直链加速 🐾

浏览器扩展（Chrome / Edge，Manifest V3）：在夸克网盘网页里勾选文件（或打开别人的分享链接），一键调用夸克官方接口拿**真实直链**，推送到本机 **Gopeed** 多线程下载——"浏览器里选，Gopeed 里下"的配合流。

> **size limit 修复**：拿直链的请求由 `declarativeNetRequest` 规则自动改写成**夸克官方客户端 UA**（浏览器原生禁止改 UA，所以走 DNR 网络层改写），规避网页端的"download file size limit"会员墙；Gopeed 下载时也带同一 UA。
>
> 另有姊妹方案 `gopeed-quark-yuzu`（Gopeed 原生扩展，粘链接即解析），两者可并存。

> 接口封装参考开源项目 [Cp0204/quark-auto-save](https://github.com/Cp0204/quark-auto-save)（仅封装官方 API，使用你自己的登录态，无任何破解）。仅供下载你有权访问的文件，请勿用于盗版传播。

## 前置条件

1. **Gopeed**（[gopeed.com](https://gopeed.com)）已安装，并开启 API：
   - 设置 → 高级 → **通讯协议** 选 `TCP`，IP `127.0.0.1`，端口 `16801`（你当前使用的）
   - 如配置了 **接口令牌**，把令牌填进本扩展的设置里
   - 改完需要重启 Gopeed
2. 已在浏览器登录 **pan.quark.cn**

## 安装扩展

1. `chrome://extensions`（Edge 用 `edge://extensions`）→ 开启 **开发者模式**
2. **加载已解压的扩展程序** → 选择本文件夹
3. 点扩展图标打开设置 → 填 Gopeed 地址（默认 `http://127.0.0.1:16801`）和令牌 → **测试连接** 应显示"连接成功喵！"

## 使用

### 我的网盘文件
1. 打开 `pan.quark.cn` 任意页面，右下角点 **🐾 悬浮球**
2. 面板里浏览目录（点文件夹进入），勾选文件
3. 点 **🚀 推送到 Gopeed** —— 自动取直链（带 `__puus` 下载 cookie + 专用 UA）建任务

### 分享链接（/s/xxx）
1. 在浏览器打开分享页，点 🐾 打开面板（需要提取码的先填）
2. 勾选文件 → 推送：自动 **转存到「Gopeed推送」目录**（没有会自动创建，可在设置里改名）→ 拿直链 → 推送
3. 转存的文件会留在你的网盘里，不想要记得删

## 常见问题

| 症状 | 处理 |
|---|---|
| 推送报 `unauthorized` / 连接失败 | Gopeed 接口令牌没填对，或 API 没开（设置→高级→通讯协议 TCP） |
| 列表空 / 报"登录态失效" | 刷新 pan.quark.cn 确认已登录 |
| Gopeed 任务速度为 0 | 直链绑定了 UA/Cookie，本扩展已自动带上；若仍失败说明直链过期，重新推送 |
| 分享需要提取码 | 面板顶部输入框填码后点"进入" |
| 夸克接口改版 | 夸克非官方对外开放接口，可能随版本变化，届时更新 `content.js` 里的 `api` 对象 |

## 目录结构

```
quark2gopeed/
├── manifest.json     MV3 清单
├── background.js     Gopeed REST 客户端 + 夸克请求兜底 + set-cookie(__puus) 捕获
├── content.js        浮动面板 UI + 夸克接口封装 + 转存/直链/推送流程
├── popup.html/js     设置页（Gopeed 地址 / 令牌 / 转存目录名）+ 测试连接
└── icons/            🐾 图标
```

## 原理

```
pan.quark.cn 页面（已登录，扩展带 cookie）
   └─ 夸克官方接口（参考 quark-auto-save 的封装）：
      我的网盘: GET  /1/clouddrive/file/sort      → 文件列表(fid)
               POST /1/clouddrive/file/download   → 直链 + Set-Cookie(__puus)
      分享页:   POST /share/sharepage/token       → stoken
               GET  /share/sharepage/detail       → fid + share_fid_token
               POST /share/sharepage/save         → 转存到自己网盘(轮询 task)
   └─ Gopeed REST API：
      POST /api/v1/tasks  {req:{url, extra:{headers:{UA, Cookie, Referer}}}}
          （多线程分段下载 → 加速）
```
