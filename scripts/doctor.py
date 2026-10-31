# -*- coding: utf-8 -*-
"""dsh-senses 体检：装完跑一下，看哪一步没成

用法：
    python scripts/doctor.py
    python scripts/doctor.py --device 3

它逐项检查，每项给"过 / 没过 / 提醒"，最后给一句结论。
不改任何东西，只看。
"""
import argparse
import os
import shutil
import sys
from pathlib import Path

这里 = Path(__file__).resolve().parent
插件根 = 这里.parent
模型目录 = 插件根 / "models"


class 结果:
    过 = 0
    没过 = 0
    提醒 = 0

    @staticmethod
    def 好(标题, 说明=""):
        结果.过 += 1
        print(f"  [✓] {标题}" + (f"　{说明}" if 说明 else ""))

    @staticmethod
    def 坏(标题, 怎么办):
        结果.没过 += 1
        print(f"  [✗] {标题}")
        print(f"        → {怎么办}")

    @staticmethod
    def 注意(标题, 说明):
        结果.提醒 += 1
        print(f"  [!] {标题}　{说明}")


def 查依赖():
    print("\n【Python 依赖】")
    需要 = {
        "sounddevice": "录音要它",
        "soundfile": "读写音频要它",
        "sherpa_onnx": "唤醒词和声纹要它",
        "faster_whisper": "转写要它",
        "edge_tts": "说话要它（不装嘴就用不上）",
    }
    缺 = []
    for 包, 用途 in 需要.items():
        try:
            __import__(包)
            结果.好(包)
        except ImportError:
            缺.append((包, 用途))
            结果.坏(f"{包} 没有（{用途}）", f"pip install {包}")
    return len(缺) == 0


def 查模型():
    print("\n【模型文件】")
    关键 = {
        "tokens.txt": "唤醒词词表",
        "encoder.int8.onnx": "唤醒模型",
        "decoder.int8.onnx": "唤醒模型",
        "joiner.int8.onnx": "唤醒模型",
        "speaker.onnx": "声纹模型（27MB，第一次跑 enroll 会自动下）",
    }
    缺 = []
    for f, 用途 in 关键.items():
        p = 模型目录 / f
        if p.exists():
            mb = p.stat().st_size / 1024 / 1024
            结果.好(f"{f}（{mb:.1f}MB）")
        else:
            缺.append(f)
            结果.坏(f"{f} 没有（{用途}）", "跑 python scripts/enroll.py 会自动下载；或者手动放到 models/")
    if (模型目录 / "keywords.txt").exists():
        行 = [l for l in (模型目录 / "keywords.txt").read_text(encoding="utf-8").splitlines() if l.strip()]
        结果.好(f"keywords.txt（{len(行)} 条唤醒词）")
    else:
        结果.坏("keywords.txt 没有", "这就是唤醒词表，必须有一个")
    return len(缺) == 0


def 查声纹():
    print("\n【声纹（谁说话才算数）】")
    p = 模型目录 / "owner.npy"
    if p.exists():
        mb = p.stat().st_size / 1024
        结果.好(f"owner.npy（{mb:.1f}KB）", "——已经登记过声音")
        return True
    结果.注意("还没登记声音", "现在跑 python scripts/enroll.py，否则耳朵谁都不认")
    return False


def 查麦克风(设备号):
    print("\n【麦克风】")
    try:
        import sounddevice as sd
    except ImportError:
        结果.坏("装不了 sounddevice，跳过这项", "pip install sounddevice")
        return

    有输入的 = [(i, d) for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]
    if not 有输入的:
        结果.坏("找不到任何麦克风", "检查设备管理器")
        return

    print(f"  有 {len(有输入的)} 个输入设备：")
    for i, d in 有输入的[:8]:
        标记 = " ← 你配的" if i == 设备号 else ""
        print(f"      {i}: {d['name'][:50]}{标记}")

    # 设备号对得上吗
    if not any(i == 设备号 for i, _ in 有输入的):
        结果.坏(f"配置里的设备号 {设备号} 不存在", f"改成上面列表里的一个数字")
        return

    名字 = dict(有输入的)[设备号]["name"]
    # 别选立体声混音
    if any(k in 名字.lower() for k in ["stereo mix", "立体声混音", "loopback", "monitor"]):
        结果.坏(f"设备 {设备号} 是「{名字}」", "别选这个——它录的是电脑播放的声音，不是你的声音")
    else:
        结果.好(f"设备 {设备号}：{名字[:40]}")

    # 试录一秒看有没有声音
    try:
        import numpy as np

        a = sd.rec(16000, samplerate=16000, channels=1, dtype="float32", device=设备号)
        sd.wait()
        rms = float(np.sqrt(np.mean(np.square(a))))
        if rms < 0.0005:
            结果.注意("录到的几乎是静音", "麦克风可能被静音了，或者选错了设备")
        else:
            结果.好(f"能录到声音（底噪 {rms:.4f}）")
    except Exception as e:
        结果.坏("录音试失败了", str(e)[:100])


def 查嘴():
    print("\n【嘴（说话）】")
    脚本 = 这里 / "say_worker.py"
    if not 脚本.exists():
        结果.坏("say_worker.py 不见了", "重新装一遍插件")
        return
    try:
        import edge_tts  # noqa: F401

        结果.好("edge-tts 可用")
    except ImportError:
        结果.坏("edge-tts 没装", "pip install edge-tts")
    if not shutil.which("ffmpeg"):
        结果.注意("系统里没有 ffmpeg 命令", "一般不影响（soundfile 自带解码）")


def 查python():
    print("【运行环境】")
    print(f"  Python {sys.version.split()[0]}")
    print(f"  解释器 {sys.executable}")
    print(f"  插件目录 {插件根}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", type=int, default=3, help="配置里那个麦克风设备号")
    ap.add_argument("--no-mic-test", action="store_true", help="不试录（不想出声的时候）")
    a = ap.parse_args()

    print("=" * 54)
    print("  dsh-senses 体检")
    print("=" * 54)

    查python()
    依赖好 = 查依赖()
    模型好 = 查模型()
    有声音 = 查声纹()
    if not a.no_mic_test:
        查麦克风(a.device)
    查嘴()

    print("\n" + "=" * 54)
    if 结果.没过 == 0:
        print(f"  全部通过（{结果.过} 项），提醒 {结果.提醒} 条。可以用了。")
        if not 有声音:
            print("  但还没登记声音——耳朵现在谁都不认。")
    else:
        print(f"  {结果.没过} 项没过，{结果.过} 项通过。按上面 [✗] 后面的提示改。")
    print("=" * 54)
    return 0 if 结果.没过 == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
