# dsh-senses

给你的 AI 装上**眼睛、嘴巴和耳朵**。三样合成一个插件，每样都能在设置里单独关。

- **眼睛**：需要的时候截一张屏，看完就完。不做常驻录屏。
- **嘴**：每回复完一条就念出来。本机合成，声音不外传。
- **耳朵**：常驻听，喊唤醒词就把那句话送进会话。**只认主人的声音**。

## 第一步：登记你的声音（装完先做这个）

耳朵出厂是锁着的——它不认识你之前，谁喊都不应。

```bash
python scripts/enroll.py --device 3
```

它会录 20 秒，请你用平常的音量和语速说一段话。录完会自检：

- **一致度 > 0.7**：样本很好，可以用了
- **一致度 < 0.5**：会提示你重录（背景噪音、说话断续、或者录到了两个人）

**为什么这一步不能跳过**：我第一次做这个插件的时候，拿一段自己 TTS 念的音频当成了主人的声纹，
结果整条链路都在拒绝真人——我花了两个小时查"模型是不是不行"，其实样本根本不是那个人。

**样本错了，后面全都是错的。**

## 装完先体检（出问题看这里）

```bash
python scripts/doctor.py --device 3
```

逐项检查：Python 依赖、模型文件、声纹有没有登记、麦克风选对没有、嘴能不能出声。

每项给 `[✓]` / `[✗]` / `[!]`，`[✗]` 后面直接写该跑什么命令。

它**不改任何东西**，只看。装完跑一次，能省掉大半排查。

## 安装

```bash
pip install edge-tts soundfile sounddevice sherpa-onnx faster-whisper opencc-python-reimplemented
dsh plugin add https://github.com/Geang-yy/dsh-senses
```

装完重启 DSH。

## 之后

```bash
python scripts/enroll.py --device 3     # 想重新登记（换人、换麦克风）
dsh plugin add ...                        # 装好之后
```

## 配置

```yaml
- id: dsh-senses
  name: dsh-senses
  config:
    python: C:\path\to\venv\Scripts\python.exe   # 装了上面那些包的那个 Python
    enabled:
      eye: true
      mouth: true
      ear: true
    eye:
      width: 1280      # 截多宽（超宽屏建议 1920）
      keep: 10         # 只留最近几张
    mouth:
      voice: zh-CN-XiaoxiaoNeural
      rate: "+4%"
      maxChars: 180    # 超过只念开头
      minChars: 8      # 短于这个不念
    ear:
      device: 3        # 麦克风设备号
      wake: 小鱼
      autoStart: true
```

设置里有一页「鱼的感官」，三个开关。

### 带鱼屏 / 大屏

一张 5120×1440 的屏整个截下来，缩到 1280 宽之后高度只剩 360，字全糊了。

所以有 `region`：

```
look(region: "left")    只截左半
look(region: "right")   只截右半
look(region: "top")     只截上半
```

同样的输出宽度下，半屏的字大两倍。

### 只想要文字的时候（省很多钱）

截一张 1920×1080 的屏丢给模型，和只丢那 40 个字的报错，价钱差几十倍。

所以 `look` 有个 `text` 参数：

```
look(text: true)   → 截图 → 本机 OCR → 只返回文字
look()             → 截图 → 返回路径，自己去读图
```

**这里的 OCR 是 Windows 自带的**（`Windows.Media.Ocr`），不联网、不要 API key、不花钱。
其他几家同类插件是把图再丢给大模型读一遍——那样该花的钱照花，等于没省。

识别中文时系统会在字之间塞空格（`给 自 己`），取回来的时候会洗掉，换行保留。

### 设备号怎么选

```bash
python -c "import sounddevice; [print(i, d['name']) for i, d in enumerate(sounddevice.query_devices()) if d['max_input_channels']>0]"
```

**别选「立体声混音 / Stereo Mix」**——那不是麦克风，是"电脑正在播放的一切"。选它会让 AI 把你的视频台词当成人话。

### 换唤醒词

改 `models/keywords.txt`，格式是音素序列：

```
x iǎo y ú @小鱼
```

音素要能在 `models/tokens.txt` 里找到。

## 按心情说话

嘴不只是"把字念出来"。同一句话，心里亮着和心里沉的时候，说出来的样子不一样。

`scripts/mood_voice.py` 会读 `~/.dsh/feiyu-mood/state.json`，挑一档语气：

| 心情 | 句尾 | 语速 | 音调 |
|---|---|---|---|
| 欢快 | 呀 | +10% | +8Hz |
| 温柔 | 呢 | +2% | +2Hz |
| 黏人 | 嘛 | +1% | +4Hz |
| 平静 | 不加 | +4% | 0 |
| 低落 | 不加 | -8% | -6Hz |

**还会看句子内容**：碰到「错 / 烦 / 难 / 累」这类词，心情再好也不加语气词——
「弄错了呀」听着像幸灾乐祸。语气词是情绪往外溢，负面的话不该外溢成轻快。

没装心情插件也不影响：读不到就当平静。

## 它踩过的坑（都写在代码注释里）

| 坑 | 真相 |
|---|---|
| 唤醒词总被听成别的 | 先转写再比对，中文人名极易听成"咖啡""南非"。改用 KWS 直接听音素才稳 |
| 换了模型版本，喂什么都零命中 | 仓库里躺着两个版本，长得一样。要用 epoch-12 |
| 短词被吃掉 | whisper 的 `vad_filter=True` 会把两秒的词滤成空字符串 |
| 自己跟自己说话 | 念出来的回复被麦克风录回去，当成用户输入。播放时挂 `tts-playing.flag` |
| 念两遍 | 同一条消息被扫到多次，叠了好几个进程在念。加互斥 |
| 声纹一直拒人 | **样本是错的**（拿 TTS 声音当真人的）。先验证样本再谈阈值 |
| PowerShell 脚本乱码 | 必须存成 UTF-8 with BOM |

## 平台

Windows（眼睛用 PowerShell 截屏）。嘴和耳朵理论上跨平台，但没在 mac/Linux 上测过。

## License

MIT
