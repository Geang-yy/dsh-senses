# -*- coding: utf-8 -*-
"""dsh-speak 的发声后端：把一段文字念出来

依赖（用插件自带的 venv 或系统 Python 都行）：
    pip install edge-tts soundfile sounddevice

用法：
    python say_worker.py --text "要念的话"
    python say_worker.py --text "要念的话" --voice zh-CN-XiaoyiNeural --rate +10%

设计取舍：
  · 只做一件事——出声。判断"该不该念"是宿主那边的事。
  · 播完才返回（下载/生成完 → 播放 → 等播完），这样调用方知道什么时候结束。
  · 播放期间会在同目录写 tts-playing.flag，避免别的进程把这段声音录回去
    （踩过：念出来的回复被麦克风录到，又被当成用户输入，形成自我对话）。
"""
import argparse
import asyncio
import os
import re
import sys
import tempfile
import time
from pathlib import Path


def 口语化(t):
    """把书面语洗成能念的：去 Markdown/路径/时间戳/代码块/符号"""
    t = str(t or "")
    t = re.sub(r"```[\s\S]*?```", "，代码就不念了。", t)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", t)
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[A-Za-z]:\\[^\s，。；]+", "那个文件", t)
    t = re.sub(r"\b\d{1,2}:\d{2}(:\d{2})?\b", "", t)
    t = re.sub(r"\d{4}\s*[-年/]\s*\d{1,2}\s*[-月/]\s*\d{1,2}\s*日?", "", t)
    t = re.sub(r"^\s{0,3}#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"^\s*[-*+]\s+", "", t, flags=re.M)
    t = re.sub(r"^\s*\|.*\|\s*$", "", t, flags=re.M)
    t = re.sub(r"[#*_>~|]", "", t)
    t = re.sub(r"[@#$%^&*_=+<>\[\]{}|~`\\/]+", " ", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{2,}", "\n", t)
    return t.strip()


def 挂牌子(路径):
    try:
        路径.write_text(str(int(time.time())), encoding="utf-8")
    except OSError:
        pass


def 摘牌子(路径):
    try:
        路径.unlink()
    except OSError:
        pass


def 说(text, voice="zh-CN-XiaoxiaoNeural", rate="+4%", pitch="+0Hz", volume="+0%"):
    import edge_tts
    import sounddevice as sd
    import soundfile as sf

    out = os.path.join(tempfile.gettempdir(), "dsh-speak.mp3")
    asyncio.run(
        edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume).save(out)
    )
    data, sr = sf.read(out)
    牌子 = Path(os.path.expanduser("~")) / ".dsh" / "tts-playing.flag"
    挂牌子(牌子)
    try:
        sd.play(data, sr)
        sd.wait()
    finally:
        摘牌子(牌子)
    try:
        os.remove(out)
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    ap.add_argument("--rate", default="+4%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--volume", default="+0%")
    ap.add_argument("--dry-run", action="store_true", help="只打印会念什么，不出声")
    a = ap.parse_args()

    text = 口语化(a.text)
    if not text:
        print("没东西可念", file=sys.stderr)
        return 1
    if a.dry_run:
        print(text[:200])
        return 0
    try:
        说(text, a.voice, a.rate, a.pitch, a.volume)
    except Exception as e:
        print("发声失败：" + str(e)[:200], file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
