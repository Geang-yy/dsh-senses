# -*- coding: utf-8 -*-
"""dsh-senses 的「登记声音」：让耳朵只认主人的声音

用法（装完插件后第一件事就跑这个）：
    python scripts/enroll.py
    python scripts/enroll.py --device 3 --seconds 20

它做四件事：
  1. 录一段你正常说话的声音
  2. 切段、自检「这段里是不是同一个人的声音」（防录到噪音或别人的声音）
  3. 算出声纹，存到 models/owner.npy
  4. 打印一个自检结果，告诉你这个样本靠不靠谱

为什么这么麻烦：我第一次做的时候，拿自己的 TTS 声音当成了主人的声纹，
结果整条链路都在拒绝真人。**样本错了，后面全都是错的。**
"""
import argparse
import time
from pathlib import Path

import numpy as np


模型地址 = "https://github.com/Geang-yy/dsh-senses/releases/latest/download/speaker.onnx"


def 找模型(自动下载=True) -> Path:
    """声纹模型不放在仓库里（27MB），从 Release 拿。

    为什么要分开：模型是死的，代码是活的。每次改代码都要背 27MB 的历史，
    用户 clone 也慢。所以代码进仓库，模型走 Release。
    """
    目标 = Path(__file__).resolve().parent.parent / "models" / "speaker.onnx"
    if 目标.exists():
        return 目标

    候选 = [Path(__file__).resolve().parent.parent.parent / "models" / "speaker" / "campplus.onnx"]
    for p in 候选:
        if p.exists():
            import shutil

            目标.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, 目标)
            return 目标

    if not 自动下载:
        raise SystemExit(f"找不到 {目标}")

    print("没有声纹模型，正在下载（约 27MB，只有第一次）…", flush=True)
    目标.parent.mkdir(parents=True, exist_ok=True)
    临时 = 目标.with_suffix(".part")
    try:
        import urllib.request

        def 进度(块, 块大小, 总大小):
            if 总大小 > 0:
                done = min(100, int(块 * 块大小 * 100 / 总大小))
                print(f"\r  下载中 {done}%", end="", flush=True)

        urllib.request.urlretrieve(模型地址, 临时, 进度)
        print("\r  下载完成      ")
        临时.replace(目标)
    except Exception as e:
        临时.unlink(missing_ok=True)
        raise SystemExit(
            f"下载失败：{e}\n"
            f"请手动下载后放到 {目标}：\n  {模型地址}\n"
        )
    return 目标


def 主函数():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", type=int, default=3, help="麦克风设备号（用 python -m sounddevice 查）")
    ap.add_argument("--seconds", type=int, default=20, help="录多久（建议 20 秒）")
    ap.add_argument("--out", default="", help="存到哪，默认 models/owner.npy")
    a = ap.parse_args()

    import soundfile as sf
    import sounddevice as sd
    import sherpa_onnx

    模型 = 找模型()
    出 = Path(a.out) if a.out else Path(__file__).resolve().parent.parent / "models" / "owner.npy"

    print("=" * 52)
    print("  登记你的声音（只认你说话）")
    print("=" * 52)
    print(f"  麦克风设备 {a.device}")
    print("")
    print("  接下来会录 {0} 秒。请用**平常的语速和音量**说话，".format(a.seconds))
    print("  念下面这段，或者说你此刻在想什么都行：")
    print("")
    print("      今天弄了很久，一直把方向弄错了。")
    print("      后来才发现，是我一直对着自己的回声在较劲。")
    print("")
    print("  ⚠ 录音期间不要放音乐，不要让别的程序发声。")
    print("=" * 52)
    for i in range(3, 0, -1):
        print(f"  {i}...", flush=True)
        time.sleep(1)

    print("【录音中】", flush=True)
    音频 = sd.rec(int(a.seconds * 16000), samplerate=16000, channels=1, dtype="float32", device=a.device)
    sd.wait()
    音频 = np.squeeze(音频)

    # 找有声音的部分（前面可能有静音）
    块 = 16000 // 10
    有声 = []
    for i in range(0, len(音频) - 块 + 1, 块):
        rms = float(np.sqrt(np.mean(音频[i : i + 块] ** 2)))
        if rms > 0.01:
            有声.append(i)
    if not 有声:
        raise SystemExit("没听到声音。检查麦克风设备号，或者离麦克风近一点。")
    起 = max(0, 有声[0] - 1600)
    终 = min(len(音频), 有声[-1] + 块 + 1600)
    有效 = 音频[起:终]
    print(f"\n有效声音 {len(有效)/16000:.1f} 秒")

    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(模型), num_threads=2)
    ext = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)

    def 嵌入(x):
        if len(x) < 8000:
            return None
        s = ext.create_stream()
        s.accept_waveform(16000, x.astype(np.float32))
        s.input_finished()
        if not ext.is_ready(s):
            return None
        v = np.array(ext.compute(s), dtype=np.float32)
        return v / (np.linalg.norm(v) + 1e-9)

    # 自检：把有效部分切三段，看它们像不像同一个人的声音
    段 = len(有效) // 3
    段们 = [嵌入(有效[i * 段 : (i + 1) * 段]) for i in range(3)]
    段们 = [e for e in 段们 if e is not None]
    if len(段们) >= 2:
        cos = lambda x, y: float(x @ y)
        相似 = [cos(段们[i], 段们[j]) for i in range(len(段们)) for j in range(i + 1, len(段们))]
        平均 = float(np.mean(相似))
        print(f"自检：同一个人内部一致度 {平均:.2f}（越高越稳，< 0.5 说明录音质量差）")
        if 平均 < 0.5:
            print("  ⚠ 这个数字偏低，可能是：背景有噪音 / 说话断断续续 / 录到了两个人")
            print("    建议重录一次，找个安静的地方，连续说话。")
    else:
        print("自检跳过（有效声音太短）")

    全 = 嵌入(有效)
    if 全 is None:
        raise SystemExit("算不出声纹，录音太短。")

    出.parent.mkdir(parents=True, exist_ok=True)
    np.save(出, 全)
    print(f"\n声纹已保存：{出}")
    print("现在起，耳朵只认你的声音了。别人喊也听不见。")


if __name__ == "__main__":
    主函数()
