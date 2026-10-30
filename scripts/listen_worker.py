# -*- coding: utf-8 -*-
"""dsh-listen 的耳朵：常驻听，听到唤醒词就把那句话写进收件箱

依赖：
    pip install sherpa-onnx faster-whisper sounddevice soundfile opencc-python-reimplemented

模型放哪（二选一，看 --models 参数）：
    <models>/kws/{tokens.txt,encoder.int8.onnx,decoder.int8.onnx,joiner.int8.onnx,keywords.txt}
    whisper 的 small 模型第一次跑会自动下载

用法：
    python listen_worker.py --inbox C:\\Users\\你\\.dsh\\dsh-listen\\inbox.jsonl
    python listen_worker.py --device 3 --wake 小鱼

设计：
  · 听到唤醒词 → 录一句（静音 1.6 秒结束）→ whisper 转写 → 追加一行 JSON 到 inbox
  · 说话时（tts-playing.flag 在）不录，避免把自己的声音当成主人
"""
import argparse
import json
import os
import queue
import sys
import time
from collections import deque
from pathlib import Path

import numpy as np

采样率 = 16000
静音秒数 = 1.6
最长秒数 = 15
最短秒数 = 0.4


def 记(日志, msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + " " + msg
    print(line, flush=True)
    try:
        日志.parent.mkdir(parents=True, exist_ok=True)
        with open(日志, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


class 耳朵:
    def __init__(self, models: Path, keywords: Path, device: int, 日志: Path, flag: Path):
        import sherpa_onnx
        from faster_whisper import WhisperModel

        self.日志 = 日志
        self.flag = flag
        self.q = queue.Queue()
        self.环形 = deque(maxlen=int(采样率 * 3))
        self.device = device

        记(日志, "加载唤醒模型…")
        self.kws = sherpa_onnx.KeywordSpotter(
            tokens=str(models / "tokens.txt"),
            encoder=str(models / "encoder.int8.onnx"),
            decoder=str(models / "decoder.int8.onnx"),
            joiner=str(models / "joiner.int8.onnx"),
            keywords_file=str(keywords),
            num_threads=2,
            max_active_paths=4,
            keywords_score=1.0,
            keywords_threshold=0.25,
            provider="cpu",
        )
        记(日志, "加载转写模型…")
        self.model = WhisperModel("small", device="cpu", compute_type="int8")
        记(日志, "就绪")

    def 有人在说话(self):
        try:
            if not self.flag.exists():
                return False
            ts = float(self.flag.read_text(encoding="utf-8").strip() or 0)
            if time.time() - ts > 60:
                self.flag.unlink(missing_ok=True)
                return False
            return True
        except Exception:
            return False

    def 回调(self, indata, frames, t, status):
        if self.有人在说话():
            return
        块 = np.squeeze(indata.copy()).astype(np.float32)
        self.q.put(块)
        self.环形.extend(块.tolist())

    def 等唤醒(self):
        stream = self.kws.create_stream()
        while True:
            try:
                块 = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            stream.accept_waveform(采样率, 块)
            while self.kws.is_ready(stream):
                self.kws.decode_stream(stream)
                r = self.kws.get_result(stream)
                if r:
                    self.kws.reset_stream(stream)
                    记(self.日志, f"唤醒命中：「{r}」")
                    return True
                break

    def 听一句(self):
        缓冲 = []
        if self.环形:
            缓冲.append(np.array(self.环形, dtype=np.float32))
        开始 = None
        静音 = 0.0
        while True:
            try:
                块 = self.q.get(timeout=0.5)
            except queue.Empty:
                if 开始 is not None:
                    静音 += 0.5
                    if 静音 >= 静音秒数 and 缓冲:
                        break
                continue
            音频 = np.squeeze(块).astype(np.float32)
            rms = float(np.sqrt(np.mean(np.square(音频)))) if 音频.size else 0.0
            if 开始 is None:
                if rms > 0.03:
                    开始 = time.time()
                    缓冲.append(音频)
            else:
                缓冲.append(音频)
                if rms > 0.015:
                    静音 = 0.0
                else:
                    静音 += 音频.size / 采样率
                if 静音 >= 静音秒数:
                    break
                if time.time() - 开始 >= 最长秒数:
                    break
        if not 缓冲:
            return None, 0.0
        全 = np.concatenate(缓冲)
        时长 = 全.size / 采样率
        if 时长 < 最短秒数:
            return None, 时长
        return 全, 时长

    def 转写(self, 音频):
        seg, _info = self.model.transcribe(
            音频.astype(np.float32), language="zh", beam_size=5, vad_filter=False
        )
        t = "".join(s.text for s in seg).strip()
        try:
            from opencc import OpenCC

            t = OpenCC("t2s").convert(t)
        except Exception:
            pass
        return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", required=True)
    ap.add_argument("--wake", default="小鱼")
    ap.add_argument("--device", type=int, default=0)
    ap.add_argument("--models", default=str(Path(__file__).resolve().parent.parent / "models"))
    ap.add_argument("--keywords", default="")
    ap.add_argument("--flag", default="")
    a = ap.parse_args()

    收件箱 = Path(a.inbox)
    收件箱.parent.mkdir(parents=True, exist_ok=True)

    # 单实例保护：不管上面拉起几份，真正干活的只能有一份。
    # 用排他创建抢锁；抢不到就退出，并把自己 pid 写进去供后人探活。
    import os
    import atexit

    锁 = 收件箱.parent / "worker.pid"

    def _锁还活着() -> bool:
        try:
            pid = int(锁.read_text(encoding="utf-8").strip() or 0)
            if pid <= 0:
                return False
            os.kill(pid, 0)
            return True
        except Exception:
            return False

    # 单实例：锁里 pid 活着就退。外层（Node）每次拉起前会先把旧的清干净，
    # 所以这里只做兜底，不指望它当唯一保障（竞态吃够亏了）。
    def _抢锁() -> bool:
        try:
            if _锁还活着():
                return False
        except Exception:
            pass
        try:
            锁.write_text(str(os.getpid()), encoding="utf-8")
            return True
        except OSError:
            return False

    if not _抢锁():
        print("已经有一份在听了，这份退出", flush=True)
        return 0

    def _清锁():
        try:
            if 锁.exists() and 锁.read_text(encoding="utf-8").strip() == str(os.getpid()):
                锁.unlink()
        except OSError:
            pass

    atexit.register(_清锁)

    收件箱.parent.mkdir(parents=True, exist_ok=True)
    日志 = 收件箱.parent / "listen.log"
    模型目录 = Path(a.models)
    关键词 = Path(a.keywords) if a.keywords else 模型目录 / "keywords.txt"
    flag = Path(a.flag) if a.flag else Path(os.path.expanduser("~")) / ".dsh" / "tts-playing.flag"

    import sounddevice as sd

    耳朵实例 = 耳朵(模型目录, 关键词, a.device, 日志, flag)
    with sd.InputStream(
        samplerate=采样率,
        channels=1,
        dtype="float32",
        blocksize=int(采样率 * 0.1),
        device=a.device,
        callback=耳朵实例.回调,
    ):
        记(日志, f"开始监听（设备 {a.device}，唤醒词「{a.wake}」）")
        while True:
            if not 耳朵实例.等唤醒():
                continue
            音频, 时长 = 耳朵实例.听一句()
            if 音频 is None:
                continue
            文本 = 耳朵实例.转写(音频)
            if not 文本:
                continue
            记(日志, f"听到 {时长:.1f}s：「{文本}」")
            with open(收件箱, "a", encoding="utf-8") as f:
                f.write(json.dumps({"text": 文本, "at": int(time.time() * 1000)}, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    sys.exit(main())
