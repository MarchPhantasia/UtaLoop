# UtaLoop 开发指南

## 工作区

- 从项目根目录执行开发、测试和构建命令。调用工具时设置 `workdir` 并直接运行程序或脚本。避免额外套用 `cmd /c`、`pwsh -Command` 或其他 shell 包装。
- 查看工作区状态，保留已有修改。发布时使用经过测试的源码快照，逐项确认暂存文件和安装包内容。
- 用合成音频、歌词及账号记录做测试。登录凭证、API 密钥、用户备份、媒体文件和缓存只保存在本机。

## 代码入口

| 路径 | 职责 |
| --- | --- |
| [web](web) | 原生 HTML、CSS 和 ES modules。`music.html` 是选歌页，`player.html` 是练唱页，`web/js/song-stream.js` 负责音源恢复。 |
| [pipeline](pipeline) | 同源网页服务、字幕分析、日语词典与 AI 请求转发。 |
| [services/netease](services/netease) | 仅在本地回环地址使用的网易云音乐服务，负责登录、曲库、歌词、音源和歌曲缓存。 |
| [windows](windows) | .NET Framework 4.8 WinForms 启动器、WebView2、随包服务和 NSIS 安装程序。 |
| [mobile](mobile) | Capacitor 移动端入口与 Web 资源打包。Windows 版本号独立维护。 |

## 运行和测试

使用 [package.json](package.json) 指定的 Node.js 版本。第一次运行先安装项目和音乐服务的依赖。在一个终端启动音乐服务。

```powershell
npm ci
npm ci --prefix services/netease
npm start --prefix services/netease
```

在另一终端启动网页及分析服务，打开 [本地页面](http://127.0.0.1:13876/)。

```powershell
uv run --no-project --python 3.12 --with fugashi==1.5.2 --with unidic-lite==1.0.8 python -m pipeline serve --host 127.0.0.1 --port 13876
```

运行前端与音乐服务测试，以及 Python 测试。改动 Web 资源后用现有脚本同步本地开发缓存清单。

```powershell
node --test tests/test_*.mjs
uv run --no-project --python 3.12 --with fugashi==1.5.2 --with unidic-lite==1.0.8 python -m unittest discover -s tests
node mobile/scripts/development-cache.mjs
```

播放和曲库有两条浏览器回归用例，见 [导航与网络恢复](tests/check_navigation_recovery.cjs) 和 [练唱与升降调](tests/check_music_practice.cjs)。Web 服务启动后，可把本地 Playwright 模块路径和服务地址依次传给脚本。

## Windows 数据与发行

- 桌面版固定使用 `http://127.0.0.1:38596/`。IndexedDB、设置和浏览器 Cookie 按源隔离。修改端口、WebView2 profile 位置或产品标识前，先验证旧数据的迁移。
- 学习记录与设置位于系统「文档」下的 `UtaLoop/profile`，记住的网易云凭证位于 `UtaLoop/private/sessions`，音频缓存位于安装目录的 `cache/audio`。安装包替换的是安装目录下的 `app`。使用 `UTALOOP_DESKTOP_DATA_DIRECTORY` 可将测试 profile 与账号存储放在隔离目录，该目录须在测试安装目录之外。
- Windows 版本号写在 [windows/version.txt](windows/version.txt)。`.\windows\build.ps1` 构建 `dist/windows/UtaLoop-<版本>-Setup-x64.exe`。`.\windows\build.ps1 -UpdateFrom '<来源版本>'` 构建只适用该版本的小更新包。`windows/runtime-lock.json` 与音乐服务依赖锁定文件决定运行组件是否可复用。
- 发行前在独立安装目录和注册表项验证全新安装及覆盖升级，检查 profile、登录凭证和缓存，核对打包文件及 SHA-256。将审核后的提交和 `utaloop-v<版本>` 标签推送到 `origin`，在 GitHub Release 上传验证过的安装包并核对资产。安装包文件通过 Release 分发。

## OBS 应用程序音频采集

Windows 发布版从 0.1.10 起由标准 `UtaLoop.exe` 入口默认启用兼容输出。曾遇到 WebView2 把音频交给独立的音频服务进程，正常播放时，针对 UtaLoop 窗口的进程回环仍测到静音。

[Program.cs](windows/Program.cs) 在创建 WebView2 环境时传入 Chromium 功能开关，让音频服务保留在 WebView2 的浏览器进程，从而使 Windows 进程回环能在 UtaLoop 的进程树中采到声音。创建窗口和环境的顺序要保留，普通启动、开始菜单和覆盖更新都走这个入口。

```csharp
var options = new CoreWebView2EnvironmentOptions("--disable-features=AudioServiceOutOfProcess");
var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile, options: options);
await browser.EnsureCoreWebView2Async(environment);
```

[install.nsi](windows/install.nsi) 创建 `UtaLoop.lnk`，升级时移除历史版本的独立兼容快捷方式。普通 `<audio>` 和使用 Web Audio 的练唱变调由同一 WebView2 实例输出。源码中的 PCM 桥仅通过宿主显式启用，当前启动器的 `IsWebMessageEnabled` 为 `false`。

### 回归检查

1. 安装待发行版，从普通 UtaLoop 快捷方式启动。在 OBS 添加「应用程序音频采集」，选择 `[UtaLoop.exe] UtaLoop`。单独测试时静音桌面音频源，方便确认电平来自应用捕获。
2. 用本地合成音频验证原调播放和启用 Web Audio 的升降调。确认 OBS 电平及短录音有声，暂停后电平归零，从练唱退回曲库后仍可采集。
3. 自动验证可用 Windows WASAPI 进程回环，在 `VAD\Process_Loopback` 上以 `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` 捕获测试启动器的 PID。此前用 48 kHz 合成音验证普通 HTML audio 和 Web Audio 都能被采集。
4. WebView2 的 Chromium 功能开关可能随 Runtime 更新变动。更改 WebView2、启动器或音频链路后，用实际安装包复测并记录 Windows、WebView2 和 OBS 版本。[OBS 采集指南](https://obsproject.com/kb/application-audio-capture-guide) · [WebView2 功能开关](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags) · [WASAPI 进程回环](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode)
