# Echoic 本地使用说明（Windows，无 Docker）

本说明适用于 Windows 上的源码安装，不需要 Docker。示例项目目录为 `C:\Projects\Echoic`，请替换为实际克隆位置。安装完成后的访问地址：[http://127.0.0.1:18765](http://127.0.0.1:18765)。

本地模式使用独立 Python 环境、SQLite、FFmpeg、eSpeak 和英语语音模型。英语识别默认使用 CPU / int8，跟读对齐和音素评分也在本机运行。盲听、跟读录音、原音对比和本地发音评分不需要 API key。

源码不包含用户数据库、导入的音频、个人录音、已下载的模型、AI 密钥或已导入的专辑。首次使用需要安装依赖并下载模型；数据库和学习数据会在运行时创建。

## 首次安装、重装依赖与前端构建

先安装 Python 3.12、uv 和 Node.js 20+（含 npm）。以下命令创建后端虚拟环境、构建前端，并准备本地英语模型和词库。首次下载需要联网，模型准备可能耗时较长。日常启动无需重复执行；重装时保留 `.runtime` 可以保留学习数据与模型。

在 PowerShell 中执行：

```powershell
Set-Location -LiteralPath 'C:\Projects\Echoic'
$env:UV_CACHE_DIR = Join-Path (Get-Location).Path '.runtime\uv-cache'

Set-Location -LiteralPath '.\backend'
uv sync --python 3.12 --extra dev

Set-Location -LiteralPath '..\frontend'
npm install
npm run build

Set-Location -LiteralPath '..\backend'
.\.venv\Scripts\python.exe prepare_models.py
.\.venv\Scripts\python.exe prepare_dictionary.py

Set-Location -LiteralPath '..'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\Start-Echoic.ps1'
```

依赖和模型准备完成后，导入本地音频、盲听及跟读评分可在本机运行。FFmpeg 和 eSpeak 由 Python 依赖提供，无需单独配置系统安装。前端构建输出到 `backend\static`，由同一个本地服务提供。

启动失败时，先查看 `.runtime\server.err.log`。如果端口 18765 被其他程序使用，日志会显示端口占用；不要为此停止不明进程。

## 启动与停止

1. 双击项目根目录的 **启动Echoic.cmd**，等待浏览器打开。
2. 如果浏览器未自动打开，访问上面的本地地址。
3. 使用完毕，先确认标记显示“已保存到本地服务”，再双击 **停止Echoic.cmd**。

关闭浏览器不会停止后台服务。重复启动会打开已运行的 Echoic。

也可以在 PowerShell 中执行：

```powershell
Set-Location -LiteralPath 'C:\Projects\Echoic'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\Start-Echoic.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\Stop-Echoic.ps1'
```

启动脚本记录进程的实际启动时间。停止脚本同时核对 Python 路径与启动时间，避免 PID 被其他进程复用后误停程序。

## 手机网页

网页在窄屏下使用底部导航。跟读页面点击顶部的句子栏展开列表，选中后返回练习；原音、录音与播放按钮保持在下方。盲听时点击“标记此刻”不会暂停播放。

手机远程录音需要有效的 HTTPS 网址，并允许浏览器访问麦克风。`127.0.0.1` 指手机自身；需要使用手机能访问的 Echoic 服务器网址。本机桌面上的 localhost / 127.0.0.1 录音继续可用。通过普通局域网 HTTP 查看页面时，录音入口会说明 HTTPS 要求。

录音会自动选择浏览器支持的 WebM、MP4 或 Ogg，上传及下载保留实际格式。切换到后台或麦克风连接中断时，网页会结束录音，保留已录到的部分并提示回放检查。跟读上传失败可以点击“重试保存”；口语练习提交失败后可以再次提交。未保存录音仅保留在当前页面内存中，重试成功前请保持页面打开。

手机回归复用 `scripts/qa_mobile.cjs`，保留原有 40 组页面布局和录音操作检查。首次在项目根目录安装固定版本的 QA 依赖：

```powershell
npm ci
npm ci --prefix frontend
npx playwright install chromium
npm run build --prefix frontend
npm run test:mobile
```

`test:mobile` 自动启动并关闭 `127.0.0.1:18767` 的构建预览；端口占用会报错。也可用 `ECHOIC_QA_BASE_URL` 指向自己已经启动的预览。原来的 `node scripts/qa_mobile.cjs` 仍可直接调用，默认使用 Chromium/Edge；`ECHOIC_PLAYWRIGHT_MODULE` 和 `ECHOIC_BROWSER_PATH` 仍适用于 Chromium。

### WebKit / Safari 风格的 MP4 回归

在 **macOS** 上安装 WebKit 后运行同一套场景：

```sh
npx playwright install webkit
npm run test:mobile:webkit
```

这个模式使用真实 Playwright WebKit 引擎、原生 `MediaRecorder` 和原生音频播放。测试将 `getUserMedia` 输入替换为 Web Audio 合成音，并限制格式探测为 MP4，让新版 WebKit 即使支持 WebM 也必须走 MP4 分支；不会替换录音器或用 WAV 冒充 MP4。不支持原生 MP4 时测试失败，不跳过、不降级为 WebM。WebKit 模式拒绝 Chromium 启动参数及自定义 Edge 路径。

Playwright WebKit 不是发行版 Safari，编解码能力也依赖操作系统。因此 CI 使用 macOS WebKit；Linux WebKit 不能作为 Safari 编解码兼容性的充分证据。参见 [Playwright 浏览器说明](https://playwright.dev/docs/browsers#webkit) 和 [Safari 18.4 新增 WebM 录制支持](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)。

| 自动化层 | 验证内容 | 替代或未覆盖的部分 |
| --- | --- | --- |
| 现有前端单元测试 + MP4 事件边界 | 格式选择、资源释放；新增空事件过滤、带 codec 的 MIME、分片顺序和无类型分片回退 | 模拟录音器，不证明真实媒体可解码 |
| Chromium / macOS WebKit 浏览器 | 原生 WebM / MP4 编码，真实容器头、MIME/扩展名；上传及口语重试字节完全一致；同时播放、A/B；评分失败重试不重复上传；刷新后从历史录音字节回放；原有中断和权限提示 | API 响应和评分结果模拟；输入为测试音；后台、断麦和拒权事件模拟 |
| 真实后端媒体测试 | 普通及 fragmented MP4/AAC，`.m4a` / `.mp4`，multipart 上传、真实本地存储、Content-Type、HTTP 206 / Content-Range、FFmpeg 解码；失败不写入分数，重试复用同一记录；口语朗读接口 | 对齐和评分模型使用替身；在评分入口使用实际解码验证文件，未运行语音模型 |
| WebKit → 后端文件衔接 | 浏览器保存的普通、后台中断、断麦、口语 4 个原生 MP4 文件再次进入上述真实后端测试 | 分层验证，不是浏览器连接生产后端的一次完整联调 |

运行轻量后端媒体测试（不下载语音模型、不需要 API key）：

```sh
python -m pip install -r scripts/requirements-media-qa.txt
# PATH 中需要 ffmpeg 和 ffprobe；Windows 可在 PowerShell 设置相同环境变量。
DATABASE_URL=sqlite:///:memory: python -m pytest backend/tests/api/test_practice.py -q
# macOS 上完成 WebKit 场景后，强制验证它产出的四个文件；缺任何文件会报错。
DATABASE_URL=sqlite:///:memory: ECHOIC_QA_CAPTURE_DIR="$PWD/.runtime/qa/webkit" \
  python -m pytest backend/tests/api/test_practice.py -m media -q
```

轻量依赖版本取自 `backend/uv.lock`；更新后端锁文件时同步 `scripts/requirements-media-qa.txt`。已有完整后端环境可直接运行 pytest。测试使用临时 SQLite 和临时存储，不操作个人数据库，也不调用收费 AI 服务。

`.github/workflows/mobile-recording.yml` 在 PR、main 推送及手动触发时执行前端单元测试、真实后端媒体测试，以及 Chromium/Linux 和 WebKit/macOS 两个浏览器任务。失败时保留截图和 Playwright trace；每次成功录音也保存测试音文件，供后端衔接验证。产物在 `.runtime/qa/<browser>/`，CI 保留 7 天；可用 `npx playwright show-trace <trace.zip>` 查看。原有其他专项 QA 脚本保留，未宣称全部纳入这个工作流。

### 发布前的真实手机验收（仍需人工完成）

记录设备、iOS/iPadOS、Safari 版本、实际 MIME/扩展名、HTTPS 地址和结果；自动化通过不能代替以下检查：

- 在 iPhone Safari 和 iPad Safari 的有效 HTTPS 页面，首次允许麦克风，拒绝后恢复权限；确认系统麦克风指示在结束、取消、导航后熄灭。
- 录短句及较长句，暂停/继续后完成；试听首尾、无静音或截断，再保存、刷新载入历史，拖动播放，做 A/B 和同时播放。
- 录制时切到后台、锁屏、来电、切换蓝牙耳机或拔掉耳机，返回后检查中断提示及残留音频是否实际可听，必要时重新录音。操作系统可能冻结页面，不能保证所有中断都有完整尾帧。
- 在上传时断网，页面保持打开，恢复网络后重试，确认录音内容一致。区分服务器明确失败与“服务端已保存但响应丢失”：后者目前没有录音上传幂等键，仍可能产生重复记录；自动化的 503 重试不证明这一情形已解决。
- 使用真实人声分别完成跟读评分和口语朗读评分；确认部署机的 FFmpeg、模型和所选服务可处理实际文件。合成测试音的固定分数不能证明发音评分质量。

真机验收状态应单独记录为待测/通过/失败，不将 Playwright 移动视口或合成输入记为真机通过。

## 第一遍连续盲听

在音频库上传本地音频。导入时会进行英语转写，CPU 处理较长音频需要一些时间。然后点击音频旁的 **盲听** 或 **连续盲听**。

盲听页面默认隐藏原文。开始播放后，遇到没听清或需要复习的位置直接打标记：

| 按键 | 作用 |
| --- | --- |
| 空格 / M / 分号 `;` | 记录当前时间，播放继续 |
| P | 播放 / 暂停 |
| Enter | 操作当前聚焦的按钮 |

按住标记键只记录一次。输入备注、操作进度或速度控件时，快捷键不会抢占输入；这些键仅在盲听页面生效。也可以点击“标记此刻”。

每次按键会立即出现在标记列表，同时保存到本地服务。服务暂时不可用时，未保存标记保留在当前浏览器的待保存队列中，并提供“重试”。使用同一浏览器和同一地址返回页面，可继续处理队列；响应丢失后重试不会生成重复标记。若页面提示浏览器暂存失败，请先重试保存并确认成功，再关闭页面。

第一遍听完后：

- 点击 **听完查看标记词**，显示对应单词和所在句子的高亮上下文；已有标记也会按原时间自动定位到词。落在静音间隙附近时显示“附近单词”，没有足够接近的词时继续保留时间标记。
- 点击 **从该词回听**，从词开始前约 0.1 秒播放，之后继续播放。
- 展开原文后，可直接点击单词为该词新增标记，播放不会暂停或跳动。按键稍慢时可用它重新标记目标词，旧标记仍保留，可自行删除。
- 点击标记时间，从该位置前 **2 秒**开始回听。
- 输入备注后点击 **保存备注**；不需要的标记可以删除。
- 点击 **听完查看原文**核对内容。
- 点击标记旁的 **跟读对应句子 →**，进入相应句子的跟读页面。

已保存的标记及备注存入 SQLite，刷新页面或重启服务后仍会保留。删除音频时，其时间标记也会删除。

## 跟读、录音对比与评分

在跟读页选择一句，先听原音，再录下自己的跟读。首次使用麦克风时，允许浏览器访问麦克风。录音保存后，可以播放自己的录音，也可以使用 **A/B 对比**，依次听原音和自己的录音。

点击 **原音与录音同时播放**，两段会从各自开头一起播放，使用同一倍速。可以点按钮或按空格一起暂停、继续；较短的一段结束后，较长的一段会继续，暂停恢复不会重新播放已经结束的一段。历史录音载入后也能使用。

拖动任一波形、切换句子、重新录音或改用 A/B 对比会退出同时播放。此功能按两段音频的起点播放，录音开头有静音时，可重新录制以便更贴近原音的节奏。

在 **翻译与分析** 中点击任意单词，会单独播放该词，并展开英文释义、词性、例句和同义词。优先使用素材中该词的原音；缺少可靠词时间戳时，使用本地英文语音朗读。点击 **听单词** 可以重听，换词或换句会停止上一段发音。录音期间可以查看释义，单词发音会暂时禁用。

英文释义来自已安装的 Princeton WordNet 本地词库，并补充常见功能词的英文用法说明；支持常见复数和时态查找，无需 API key。少数专名、缩写或未收录词会显示提示，发音仍可使用。词库位于 `.runtime\nltk_data\corpora\wordnet.zip`，备份离线词库时可一并复制该目录。

提交评分后，会显示准确度、流利度、完整度，以及单词和音素的颜色反馈。评分用于定位练习重点，仍应结合原音和自己的录音判断。

跟读页面沿用原有快捷键，和盲听页不同：

| 按键 | 作用 |
| --- | --- |
| 空格 | 原音播放 / 暂停；同时播放时一起暂停 / 继续 |
| R | 开始 / 结束录音 |
| Enter | 提交已保存的录音评分 |
| ← / → | 上一句 / 下一句 |
| Esc | 取消录音 |

## AI 发音评测与连读反馈

在 **设置 → AI 分析** 中可以分别配置并保存以下服务。密钥请直接在设置页面填写；留空保留已保存值，也可以点“清除”后保存。

| 服务 | 需要填写 |
| --- | --- |
| 腾讯云口语评测新版 | AppID、Secret ID、Secret Key |
| Azure 发音评估 | Speech API Key、服务区域或接口地址，默认 en-US |
| 讯飞语音评测 | App ID、API Key、API Secret |
| OpenAI 音频模型 | API Key、支持音频输入的模型、Chat Completions 基础地址 |
| Google Gemini | API Key、音频模型、Interactions 基础地址 |
| 通义千问 Qwen Omni | API Key、音频模型、对应地区的兼容接口基础地址 |
| 本地音频模型 / 兼容接口 | 已启动的音频模型服务地址、模型名；密钥可选 |

默认地址和模型名称已填入，可按账号权限修改。选择一个“默认分析服务”，开启 AI 分析并保存。七种服务均可作为默认服务，后端按服务类型自动选择专用评测或音频模型反馈。“检查配置”只检查字段完整性，不发送录音，也不验证付费账号权限。

录音保存后，在跟读页 **我的练习** 中选择一条录音，点击 **AI 分析**，使用设置中保存的默认服务。分析入口与结果直接放在这条录音的练习区域内。单次最长 60 秒，录音和参考句文字会发送到所选服务；不会自动分析或上传，也不会自动重试失败请求。

专用评测展示服务实际返回的单词、音素及整体指标，未提供的指标不补造。通用音频大模型提供纠音、连读、弱读、失爆、同化等建议，若返回分数则标为参考分；这些分数与专用评测、本地分数并不直接通用，也不能换算雅思分数。参考读法与对录音的判断分别标记；不确定内容需要结合回听确认。

在 AI 结果中点击单词或连读短语，展开 **对比回听**，分别点击 **原音** 和 **我的录音** 播放对应片段。重复词会要求选择句中的具体位置；连读按连续短语回听。首次播放个人录音片段时，会在本机定位单词并保存位置，不需要先提交本地评分。片段使用当前倍速，点击停止、切换录音或开始其他播放会停止旧片段。缺少可用位置或无法匹配的提示，可使用明确标注的 **整句原音 / 整句录音**；自动定位在漏读、含混读音处可能不准确，需结合整句确认。

AI 分析结果与对应录音关联保存到 SQLite，保留服务来源及历史；刷新页面、重新选择该录音或重启后仍可查看，删除录音时一并删除结果。不覆盖原有本地评分。本地模型选项仅连接现有音频模型接口，不会自动下载或部署 30B 模型。

配置文件为 `.runtime\ai-settings.json`。Windows 下密钥使用当前 Windows 用户的 DPAPI 加密保存，API 只返回密钥是否存在。备份配置后换电脑或换 Windows 用户，需重新填写密钥。

## 数据与备份

重要数据位于：

- `.runtime\echoic.db`：音频信息、时间标记、备注、练习记录、本地评分及 AI 分析结果。
- `.runtime\storage\`：导入的音频和自己的录音。
- `.runtime\models\`：已下载的模型缓存。
- `.runtime\server.out.log`、`.runtime\server.err.log`：运行日志。

Windows 的 eSpeak 字典另有一份可再生缓存，位于系统临时目录的 `Echoic-native\espeak-0.2.4\espeak-ng-data`，其完整路径可从环境变量 `%TEMP%` 对应的目录找到。这样可以避开中文项目路径对其底层文件接口的影响；临时缓存被清理后，下次启动会自动重建。模型、数据库和录音仍保存在项目的 `.runtime` 内。

备份前先停止 Echoic，复制 `echoic.db` 和整个 `storage` 文件夹，并保留目录对应关系。需要同时保留离线模型时，再复制 `models`。尚未保存的浏览器队列不在数据库备份中，应先点重试并确认保存成功。

## 批量下载与导入公开音频系列

也可以直接在音频库上传本地文件。对于可公开访问、未加密的 Bilibili 多分 P 视频，仓库提供通用下载和导入脚本。先完成上面的依赖与模型准备，然后在项目根目录运行以下命令；将 `BVxxxxxxxxxx` 替换为目标视频的 BV 号，并按需修改输出目录和专辑名称。

```powershell
.\backend\.venv\Scripts\python.exe .\scripts\download_bilibili_series.py --bvid 'BVxxxxxxxxxx' --output '.\.runtime\downloads\my-series'
.\backend\.venv\Scripts\python.exe .\scripts\import_local_series.py --manifest '.\.runtime\downloads\my-series\manifest.json' --collection '我的听力专辑'
```

下载脚本生成音频文件和 `manifest.json`；导入脚本将文件加入本地音频库并逐集转写。CPU 转写长音频可能需要较长时间，可以在单独的 PowerShell 窗口运行。下载脚本的 `--pages` 参数可选择分 P 编号，`--workers` 可调整下载并发数。

导入进度保存在 `.runtime\imports\<BV号>.json`。中断后可重新运行相同的导入命令，脚本会依据进度和数据库继续处理。保留下载目录中的清单与对应音频；这些文件属于本地学习数据，不随源码分发。导入后刷新音频库，并点击专辑名称筛选内容。
