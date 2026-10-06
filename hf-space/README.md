---
title: DZD Voice
emoji: 🎙️
colorFrom: green
colorTo: gray
sdk: gradio
sdk_version: 6.29.1
app_file: app.py
pinned: false
license: mit
short_description: DZD Learn AI voice (Kyutai Pocket TTS on CPU)
---

# DZD Voice

The DZD Learn AI voice, made with [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts)
(code MIT, weights CC BY 4.0). It runs on the CPU only.

Setup:
1. Accept the terms at https://huggingface.co/kyutai/pocket-tts (needed for voice cloning).
2. Add a **read** token as the Space secret `HF_TOKEN`.
3. Upload `voice.mp3` (the voice recording) next to `app.py`.
