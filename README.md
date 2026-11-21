# Lingua

UtaLoop 的网易云登录、选歌和日语歌词标注见[本地练唱启动说明](#utaloop-本地练唱)。

Lingua 是一个面向语言学习的播放器。它把音视频、字幕、逐词时间轴、注音、转写、词性、译文和讲解放在同一条学习流程。支持 Android、iOS 和 Web 平台。支持日语、英语、西班牙语、法语、德语和韩语。

## 功能概览

- 支持导入音视频：WAV、MP3、M4A、FLAC、OGG、OPUS，以及 MP4、WebM、MOV 等。
- 支持词级 JSON、带内联时间戳的 WebVTT、普通 SRT / VTT。
- 支持展示日语假名与罗马音、韩语发音与罗马字、英语/西班牙语/法语/德语音标与原形。
- 支持句子成分分解、词性着色、逐词高亮、音标显示、原形显示。
- 支持接入大模型自动生成翻译，以及按需生成单词和句子讲解。
- 支持逐句修改字幕原文与译文，并按需进行重新分析、重新翻译。
- 支持画中画播放、字幕悬浮窗、变速播放、单句重复、字幕自动跟随。
- 支持单词的原音频片段发音与标准发音、打开词卡自动发音。
- 支持收藏单词与句子，搜索筛选、学习笔记、自测、掌握标记。
- 本地保存音视频、分析结果、大模型产物与收藏，支持数据导入导出。
- 内置工作台支持本地音频提取、压制，以及在线转录、快捷导入。

## 界面预览

![界面预览](imgs/preview.jpg)

## 安装
  
项目分为前端和分析后端。前端可独立运行，但句子成分分解、词性分析、注音和词形还原等功能需要分析后端提供的 API。

### Android / iOS （纯前端）
在 [Releases](https://github.com/RzMY/Lingua/releases) 下载对应安装包。

### Docker 部署 （包括Web前端和分析后端）

首次部署先复制配置文件：

```bash
cp .env.docker.example .env.docker
```
编辑 `.env.docker`，设置 `LINGUA_API_TOKEN`。

#### 拉取远程镜像

拉取已发布的镜像并启动：

```bash
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d --no-build --wait
```

#### 本地构建

在 `.env.docker` 中设置 `LINGUA_IMAGE=lingua:local`，然后构建并启动：

```bash
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d --no-build --wait
```

#### 原生访问

- Android：在浏览器中打开页面，添加书签到主屏幕。
- IOS：在 [WebClip](https://webclip-vue-app.vercel.app) 添加 WebClip。

## 开始使用

- 在首页导入音频或视频，选择源语言，即可进行播放。
- 在播放页导入字幕，即可直接显示原文并按句定位播放。
- 句子成分分解、注音、原形和词性等分析功能，需要在「设置 → 分析后端」配置分析后端地址和访问令牌。
- 在「设置 → AI 助学」填写兼容接口地址和 API Key，获取模型列表或手动输入模型 ID。每个服务商可单独保存模型和思考程度。
- 点击单词可查看单词讲解，可收藏单词学习、聆听发音、查看释义、语境、讲解。
- 长按句子可查看句子讲解，可收藏句子学习、编辑字幕原文与译文、生成句子讲解。

## 设置说明

设置主要包括以下几类：

- **AI 助学**：保存和切换模型服务商，选择模型及思考程度。词典分析后端和访问令牌位于「系统」。
- **学习偏好**：译文语言、各源语言的默认显示层、字幕字号、发音设置、视频设置和主题色。
- **数据管理**：导入和导出配置、媒体记录、歌词注音、学习进度、收藏与模型缓存，也可补充缺失文件和查看存储明细。
- **更新管理**：原生应用支持检查更新、下载更新、安装更新；需要新版原生能力时，会提示更新安装包。

## 工作台（实验性功能）

在「设置 → 系统」开启「实验性功能」后，底部导航的首页与设置之间显示工作台。

### 提取聆听音频：
- 普通 MP4 的 AAC/ALAC 原音轨直接分离为 M4A。
- 已有无损 WAV 直接复用，其他支持的格式解码为浮点 WAV，保留原采样率与声道。
### 生成ASR音频：
- 下采样聆听音频生成 16 kHz MP3 用于转录。
### 转录：
- 点击「转录接口配置」，设置 OpenAI 兼容接口地址、API Key、模型与结果格式。
- 输入音频可直接引用第一步的聆听原音频，也可引用第二步的 ASR 音频。

## 字幕格式

### 词级 JSON

兼容 Whisper、WhisperX 和 faster-whisper 常见结构。示例：

```json
{
  "language": "ja",
  "segments": [
    {
      "start": 0.0,
      "end": 2.4,
      "text": "今日はいい天気ですね。",
      "words": [
        {"word": "今日", "start": 0.0, "end": 0.6},
        {"word": "は", "start": 0.6, "end": 0.8}
      ]
    }
  ]
}
```

### SRT / 普通 WebVTT

支持句级时间戳并按整句高亮。

### 带内联时间戳的 WebVTT

支持卡拉 OK 风格的 `<00:00:01.400>` 标记，后端会将其转换为词级时间片段。

## 支持的语言

| 代码 | 语言 | 分词引擎 | 上层文字 | 下层文字 |
| --- | --- | --- | --- | --- |
| `ja` | 日语 | MeCab + UniDic | 假名 | 罗马音 |
| `en` | 英语 | spaCy | 音标 | 原形 |
| `es` | 西班牙语 | spaCy | 音标 | 原形 |
| `fr` | 法语 | spaCy | 音标 | 原形 |
| `de` | 德语 | spaCy | 音标 | 原形 |
| `ko` | 韩语 | spaCy | 发音 | 罗马字 |

## HTTP API

### `GET /api/health`

返回版本、`schemaVersion`、支持的字幕格式和语言依赖状态。`?probe=1` 会实际检查语言分析器依赖。

### `POST /api/analyze`

请求体为字幕原文，参数包括：

- `lang`：源语言代码。
- `id`、`title`：音频标识和标题。
- `split`：是否按停顿拆分长句。
- `merge`：是否合并形态素。
- `estimate`：无词级时间戳时是否估算词时间。
- `duration`：音频时长。
- `name`：字幕文件名。

响应结构：

```json
{"ok": true, "log": ["..."], "track": {"schemaVersion": 2, "sentences": []}}
```
## 开源致谢

* **LinuxDo** [LinuxDo 官方网站](https://linux.do/)。
* **lamejs** [LAME 官方网站](http://lame.sourceforge.net)。
* **MeCab** [MeCab 官方网站](https://taku910.github.io/mecab/)。
* **UniDic** [UniDic 官方网站](https://clrd.ninjal.ac.jp/unidic/)。
* **spaCy** [spaCy 官方网站](https://spacy.io/)。
* **Capacitor** [Capacitor 官方网站](https://capacitorjs.com/)。
* **g2p-en** [g2p-en GitHub 仓库](https://github.com/Kyubyong/g2p)。
* **hangulpy** [hangulpy GitHub 仓库](https://github.com/gaon12/hangulpy)。
* **eSpeak NG** [eSpeak NG GitHub 仓库](https://github.com/espeak-ng/espeak-ng)。
* **Piper WASM** [Piper WASM GitHub 仓库](https://github.com/diffusion-studio/piper-wasm)。
* **ONNX Runtime** [ONNX Runtime GitHub 仓库](https://github.com/microsoft/onnxruntime)。
* **Supertonic** [Supertonic GitHub 仓库](https://github.com/supertone-oss-archive/supertonic)。

## 许可

本项目使用 MIT License，详见 [LICENSE](LICENSE)。

第三方运行文件与语音模型遵循各自许可，详见 [Piper 说明](web/js/vendor/piper/NOTICE.md) 和 [Supertonic 说明](web/js/vendor/supertonic/NOTICE.md)。Supertonic 模型采用含用途限制的 OpenRAIL-M 许可。
## UtaLoop 本地练唱

在项目根目录运行以下两条命令，分别启动音乐服务和网页。首次使用先运行 `npm ci --prefix services/netease` 安装音乐接口。网页及本地文件播放也可以单独启动。

```sh
npm start --prefix services/netease
```

```sh
uv run --no-project --python 3.12 --with fugashi==1.5.2 --with unidic-lite==1.0.8 python -m pipeline serve --host 127.0.0.1 --port 13876
```

打开 [本地曲库](http://127.0.0.1:13876/)，从「从网易云选歌」搜索歌曲或扫码查看喜欢的音乐和自建歌单。播放器按需读取可完整播放的音源，遇到试听限制时可用工具栏的文件按钮关联自己的音频。练唱页的「设置 → 日语歌词标注」支持用词典为整首分词和注音，也支持用已配置的大模型校准整首或当前一句。来源逐字时间码支持逐词跟随，普通 LRC 按行跟随。

在「从网易云选歌 → 本机登录设置」可以选择仅本次使用、记住 30 天（默认），或长期记住。已登录时修改会立即生效。仅本次使用将凭证保存在音乐服务内存中；另外两档加密保存在当前用户的应用数据目录（Windows 为 `%LOCALAPPDATA%\UtaLoop\sessions`）。长期模式的本地期限约为一年，在使用期间按周顺延。旧版已保存的登录沿用原有的 30 天期限，可直接改为长期。

普通升级保留应用数据和浏览器 Cookie 时，同一浏览器及主机名可以恢复登录。音乐服务仅监听本机，账号凭证只随网易云请求使用，与歌词 AI 调用分开。网易云在正常响应中下发的新 Cookie 会按所选方式更新。上游[刷新登录说明](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/public/docs/home.md#刷新登录)注明扫码凭证不支持主动刷新。退出会清除本机凭证，网络故障会保留记录供重试。网易云撤销授权、本地期限届满或清除浏览器 Cookie 后需要重新扫码。

### 升级、备份与迁移

- 网页升级时沿用同一个浏览器配置和访问地址。曲库、歌词和学习记录保存在该地址的浏览器数据库里，模型服务商和偏好保存在同一地址的浏览器设置里。更换地址、端口、浏览器或安装形态时，使用「设置 → 数据管理」导出并导入数据。
- 当前导出格式为 v3，可导入 v1 和 v2。备份包含原词、翻译、音译、人工注音、在学／已学／最近练唱、学习进度和播放器偏好。原始音视频和字幕文件需单独保存，导入后可按文件名重新关联。网易云登录按本机的保存方式管理，API Key 和访问令牌可在导出时单独勾选。
- 将数据库版本、歌词对齐版本和备份格式版本独立维护。数据库的结构升级在 IndexedDB 升级事务里完成。保持旧版本的曲目 ID、存储键和备份字段的含义，为已有字段优先增加兼容读取。回滚时如果遇到更高版本的数据库，提示打开新版。
- 发布存储变更前，用旧版数据库与备份验证升级、导入和回滚保护。检查歌词原文、人工确认的读音、学习进度和相同服务商的配置。验证已有加密登录可读取，且旧服务能保留它无法读取的新格式凭证。桌面端或移动端更换存储位置时，先验证导出文件可在新版本完整导入。

### Windows 桌面存储

- 桌面启动程序应给音乐服务提供两个绝对路径。`UTALOOP_DESKTOP_ROOT` 是用户选择的安装目录。`UTALOOP_DESKTOP_PRIVATE` 取 Windows 系统「文档」目录下的 `UtaLoop\private`。凭证目录独立于安装目录，仍按用户选定的期限保存加密凭证。仅在显式设置桌面路径时启用歌曲缓存，普通网页启动方式照旧。
- 歌曲缓存位于 `<安装目录>\cache\audio`。选歌页「设置 → 歌曲缓存」可以查看占用、调整上限和清理。默认 2048 MB，0 MB 表示只在线播放。超限时按最近使用情况淘汰，正在读取的缓存释放后删除。只有符合权限的完整音轨才落盘，未完成或仅请求局部的音轨可直接播放。封面缓存可使用独立的 `cache\covers`，歌曲清理只处理 `cache\audio` 自己管理的文件。
- Windows x64 安装包使用系统 WebView2 和 .NET Framework 4.8 或更新版本，随应用提供本机音乐服务和日语分析词典。安装时选择当前用户可写的目录，之后可从开始菜单打开 UtaLoop。关闭桌面窗口后，两个本机服务会随之结束。
- 学习进度、校订后的歌词、词义和本机设置保存在系统「文档」的 `UtaLoop\profile`，记住的网易云凭证在 `UtaLoop\private\sessions`。从网页切换到桌面版时，用「设置 → 数据管理」导出网页备份并在桌面版导入。单独保留需要重新关联的原始音视频与字幕。浏览器与桌面窗口分别登录。
- 升级时关闭 UtaLoop 后运行新版安装包。安装器复用原路径，在新程序文件完整写入后启用新版。学习数据、网易云会话、歌曲缓存和容量设置沿用原目录。旧版本安装包会拒绝覆盖较新的版本。
- 已安装更新包所指版本时，可以用小更新包复用现有的音乐服务运行文件、Python 和离线词典。首次安装、跨版本升级或更新运行组件时使用完整安装包。
- 构建时修改 `windows/version.txt` 并运行 `./windows/build.ps1`，默认输出到 `dist/windows`。运行组件相同时可用 `-UpdateFrom <已发布版本>` 生成指定来源版本的更新包。发布前验证可在同一目录升级，并检查注音、学习进度和会话可继续读取。
