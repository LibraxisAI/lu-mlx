# Voice and computer control: third-party notices

What Voice and computer control add to LU, and under which terms. Each license below was read at its source: the license file or metadata of the installed package, the crate in the cargo registry, the package in node_modules, or the model page. Versions are the pinned ones (requirements.txt, Cargo.lock, package-lock.json, models.json, python.json).

Two kinds of things are listed here. The Rust crates and npm packages are built into the LU app. The Python runtime, the Python packages and the voice models are not part of the app download: the Voice setup fetches them onto the computer, unchanged, from their publishers, into a private folder of LU.

## Attribution

The speech output and most of its voices are licensed under Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/). The credit lines, as the Voice setup and the Voice settings show them for the chosen voice:

- Pocket TTS by Kyutai, licensed under CC BY 4.0.
- Voice "alba" from recordings by Alba MacKenna (kyutai/tts-voices, alba-mackenna/casual.wav), licensed under CC BY 4.0.
- Voice "anna" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p228 (kyutai/tts-voices, vctk/p228_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "azelma" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p303 (kyutai/tts-voices, vctk/p303_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "charles" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p254 (kyutai/tts-voices, vctk/p254_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "eponine" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p262 (kyutai/tts-voices, vctk/p262_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "eve" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p361 (kyutai/tts-voices, vctk/p361_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "fantine" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p244 (kyutai/tts-voices, vctk/p244_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "george" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p315 (kyutai/tts-voices, vctk/p315_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "jane" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p339 (kyutai/tts-voices, vctk/p339_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "mary" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p333 (kyutai/tts-voices, vctk/p333_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "michael" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p360 (kyutai/tts-voices, vctk/p360_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "paul" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p259 (kyutai/tts-voices, vctk/p259_023_enhanced.wav), licensed under CC BY 4.0.
- Voice "vera" from the CSTR VCTK Corpus (version 0.92) by Junichi Yamagishi, Christophe Veaux and Kirsten MacDonald, University of Edinburgh, speaker p229 (kyutai/tts-voices, vctk/p229_023_enhanced.wav), licensed under CC BY 4.0.

The voices from the Unmute Voice Donation Project were released by their speakers as CC0 (https://creativecommons.org/publicdomain/zero/1.0/). No credit is required for them; LU names them all the same:

- Voice "javert" from the Unmute Voice Donation Project (kyutai/tts-voices, voice-donations/Butter.wav), released as CC0.
- Voice "marius" from the Unmute Voice Donation Project (kyutai/tts-voices, voice-donations/Selfie.wav), released as CC0.

LU uses all of them unchanged. Each voice is a file of voice data that Kyutai computed from the named recording and publishes with Pocket TTS; which recording belongs to which voice is stated by the Pocket TTS package itself (pocket_tts/utils/utils.py, version 2.1.0) and by the model page. The license of each set of recordings is stated at https://huggingface.co/kyutai/tts-voices.

Pocket TTS ships more voices than LU offers. Left out on purpose: "cosette" (Expresso) and "jean" (EARS), whose recordings are licensed for non-commercial use only; the four voices taken from LibriVox readers through Voice-Zero, which carry the names of real people; and the voices for other languages.

## Models

| Model | License | Source | Fetched |
| --- | --- | --- | --- |
| Whisper base.en (CTranslate2) | MIT | https://huggingface.co/Systran/faster-whisper-base.en | by the Voice setup, revision 3d3d5dee2648 |
| Kyutai Pocket TTS, English | CC-BY-4.0 | https://huggingface.co/kyutai/pocket-tts-without-voice-cloning | by the Voice setup, revision d29db7978e46 |
| alba | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/alba-mackenna/casual.wav | by the Voice setup, revision e041936c7547 |
| anna | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p228_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| azelma | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p303_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| charles | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p254_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| eponine | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p262_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| eve | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p361_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| fantine | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p244_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| george | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p315_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| jane | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p339_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| javert | CC0-1.0 | https://huggingface.co/kyutai/tts-voices/blob/main/voice-donations/Butter.wav | when the user picks this voice, revision e041936c7547 |
| marius | CC0-1.0 | https://huggingface.co/kyutai/tts-voices/blob/main/voice-donations/Selfie.wav | when the user picks this voice, revision e041936c7547 |
| mary | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p333_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| michael | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p360_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| paul | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p259_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| vera | CC-BY-4.0 | https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p229_023_enhanced.wav | when the user picks this voice, revision e041936c7547 |
| Silero VAD (ONNX) | MIT | https://github.com/snakers4/silero-vad | inside the pipecat-ai package |
| Smart Turn v3.2 (CPU, ONNX) | BSD-2-Clause | https://huggingface.co/pipecat-ai/smart-turn-v3 | inside the pipecat-ai package |
| Holo 3.1 9B (GGUF, Q4_K_M, with projector) | Apache-2.0 | https://huggingface.co/Hcompany/Holo-3.1-9B, conversion from https://huggingface.co/mradermacher/Holo-3.1-9B-GGUF | only when the user downloads it from the model catalog |

The dictation in the chat uses the Whisper "base" model (MIT, https://huggingface.co/Systran/faster-whisper-base), which faster-whisper fetches on first use.

## Python runtime

CPython 3.12.15, license PSF-2.0, from the standalone builds at https://github.com/astral-sh/python-build-standalone (release 20261003). The archive is fetched by the Voice setup and checked against its SHA-256. It carries the license texts of the libraries that are built into it.

## Python packages

Installed by pip from pypi.org (torch for Windows and Linux from download.pytorch.org) into the private Python above. Each package brings its own license text in its `dist-info` folder.

| Package | Version | License | Note |
| --- | --- | --- | --- |
| aiofiles | 25.1.0 | Apache-2.0 |  |
| aiohappyeyeballs | 2.7.1 | PSF-2.0 |  |
| aiohttp | 3.14.4 | Apache-2.0 AND MIT |  |
| aiosignal | 1.4.0 | Apache-2.0 |  |
| annotated-doc | 0.0.5 | MIT |  |
| annotated-types | 0.8.0 | MIT |  |
| anyio | 4.15.1 | MIT |  |
| attrs | 26.1.0 | MIT |  |
| audioop-lts | 0.2.2 | PSF-2.0 | not installed (Python 3.13 and later only) |
| av | 18.1.0 | BSD-3-Clause | not installed (Python below 3.12 only) |
| av | 19.0.1 | BSD-3-Clause |  |
| beartype | 0.22.9 | MIT |  |
| certifi | 2026.7.22 | MPL-2.0 |  |
| cffi | 2.1.1 | MIT-0 |  |
| charset-normalizer | 3.5.2 | MIT |  |
| click | 8.5.0 | BSD-3-Clause |  |
| colorama | 0.4.6 | BSD-3-Clause | Windows only |
| ctranslate2 | 4.8.2 | MIT |  |
| docopt | 0.6.2 | MIT |  |
| docstring-parser | 0.18.0 | MIT |  |
| einops | 0.8.2 | MIT |  |
| fastapi | 0.142.2 | MIT |  |
| faster-whisper | 1.2.1 | MIT |  |
| filelock | 4.0.12 | MIT |  |
| flatbuffers | 25.12.19 | Apache-2.0 |  |
| frozenlist | 1.8.0 | Apache-2.0 |  |
| fsspec | 2026.9.0 | BSD-3-Clause |  |
| h11 | 0.16.0 | MIT |  |
| hf-xet | 1.6.0 | Apache-2.0 |  |
| httpcore | 1.0.9 | BSD-3-Clause |  |
| httpcore2 | 2.13.1 | BSD-3-Clause |  |
| httpx | 0.28.1 | BSD-3-Clause |  |
| httpx2 | 2.13.1 | BSD-3-Clause |  |
| httpx2-jsfetch | 1.0 | BSD-3-Clause | not installed (browser Python only) |
| huggingface-hub | 1.33.0 | Apache-2.0 |  |
| idna | 3.20 | BSD-3-Clause |  |
| jinja2 | 3.1.6 | BSD-3-Clause |  |
| jiter | 0.17.0 | MIT |  |
| llvmlite | 0.50.0 | BSD-2-Clause AND Apache-2.0 WITH LLVM-exception |  |
| loguru | 0.7.3 | MIT |  |
| loudness | 0.2.0 | MIT |  |
| markdown | 3.11 | BSD-3-Clause |  |
| markdown-it-py | 4.2.0 | MIT |  |
| markupsafe | 3.0.4 | BSD-3-Clause |  |
| mdurl | 0.1.2 | MIT |  |
| mpmath | 1.3.0 | BSD-3-Clause |  |
| multidict | 6.9.1 | Apache-2.0 |  |
| networkx | 3.6.1 | BSD-3-Clause | not installed (Python below 3.12 only) |
| networkx | 3.7 | BSD-3-Clause |  |
| num2words | 0.5.14 | LGPL-2.1 |  |
| numba | 0.68.0 | BSD-2-Clause |  |
| numpy | 2.4.6 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | not installed (Python below 3.12 only) |
| numpy | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |  |
| onnxruntime | 1.24.4 | MIT |  |
| openai | 3.24.0 | Apache-2.0 |  |
| opentelemetry-api | 1.45.0 | Apache-2.0 |  |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |  |
| pillow | 12.3.0 | MIT-CMU |  |
| pipecat-ai | 1.12.0 | BSD-2-Clause |  |
| pocket-tts | 2.1.0 | MIT |  |
| propcache | 0.5.4 | Apache-2.0 |  |
| protobuf | 6.33.6 | BSD-3-Clause |  |
| pycparser | 3.0 | BSD-3-Clause |  |
| pydantic | 2.13.5 | MIT |  |
| pydantic-core | 2.46.5 | MIT |  |
| pygments | 2.21.0 | BSD-2-Clause |  |
| python-dotenv | 1.2.4 | BSD-3-Clause |  |
| python-multipart | 0.0.32 | Apache-2.0 |  |
| pyyaml | 6.0.3 | MIT |  |
| requests | 2.34.2 | Apache-2.0 |  |
| resampy | 0.4.3 | ISC |  |
| rich | 15.0.0 | MIT |  |
| safetensors | 0.8.0 | Apache-2.0 |  |
| scipy | 1.17.1 | BSD-3-Clause | not installed (Python below 3.12 only) |
| scipy | 1.18.1 | BSD-3-Clause |  |
| sentencepiece | 0.2.2 | Apache-2.0 |  |
| sentencex | 1.0.31 | MIT |  |
| setuptools | 84.0.0 | MIT |  |
| shellingham | 1.5.4 | ISC |  |
| sniffio | 1.3.1 | MIT OR Apache-2.0 |  |
| soundfile | 0.13.1 | BSD-3-Clause |  |
| soxr | 1.0.0 | LGPL-2.1-or-later |  |
| starlette | 1.7.0 | BSD-3-Clause |  |
| sympy | 1.14.0 | BSD-3-Clause |  |
| tokenizers | 0.23.2 | Apache-2.0 |  |
| torch | 2.14.1 | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT | macOS |
| torch | 2.14.1+cpu | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT | Windows and Linux, CPU build |
| tqdm | 4.70.1 | MPL-2.0 AND MIT |  |
| truststore | 0.10.4 | MIT |  |
| typer | 0.27.2 | MIT |  |
| typing-extensions | 4.16.0 | PSF-2.0 |  |
| typing-inspection | 0.4.4 | MIT |  |
| urllib3 | 2.8.0 | MIT |  |
| uvicorn | 0.54.0 | BSD-3-Clause |  |
| wait-for2 | 0.4.1 | Apache-2.0 | not installed (Python below 3.12 only) |
| websockets | 17.2 | BSD-3-Clause |  |
| win32-setctime | 1.2.0 | MIT | Windows only |
| yarl | 1.25.1 | Apache-2.0 |  |

### LGPL and GPL parts

These packages are, or contain, libraries under the GNU Lesser General Public License, and one of them, av, contains libraries under the GNU General Public License. LU does not change them and does not link them into its own program. They are installed as separate files that the user can replace with another build, and the voice engine reaches them only through their public Python interfaces.

- num2words 0.5.14: LGPL-2.1, pure Python.
- soxr 1.0.0: LGPL-2.1-or-later. Contains libsoxr (LGPL-2.1-or-later) and PFFFT (BSD-like).
- soundfile 0.13.1: the package itself is BSD-3-Clause. Its wheel contains libsndfile 1.2.2 (LGPL-2.1-or-later), built with mpg123 and LAME (both LGPL).
- av 19.0.1 (PyAV): the package itself is BSD-3-Clause. Its wheel contains FFmpeg libraries. In the macOS arm64 wheel, which is the one that was opened for this list, FFmpeg is configured with `--enable-version3`, `--enable-libx264` and `--enable-libx265` and reports "LGPL version 3 or later". Its libavcodec links the libx264 and libx265 that lie next to it (both GPL-2.0-or-later), together with dav1d, libvpx, libwebp, SVT-AV1, Opus and libvmaf. A build of FFmpeg that links x264 and x265 falls under the GPL as a whole, so this list treats the FFmpeg libraries of the wheel as GPL version 3 or later, whatever the build reports about itself. The GPL version 3 and the AGPL-3.0 of LU allow being combined (section 13 of both licenses). LU does not ship the wheel: the Voice setup has pip fetch it from PyPI onto the computer, unchanged, and the older speech-to-text install does the same. The sources are published by the PyAV project at https://github.com/PyAV-Org/PyAV, and the FFmpeg build of the wheels at https://github.com/PyAV-Org/pyav-ffmpeg. LU only decodes audio with it. The Windows and Linux wheels were not opened. This is our reading of the licenses and not legal advice.

Other wheels with built-in native libraries (numpy, scipy, torch, onnxruntime, ctranslate2, pillow, tokenizers, sentencepiece and more) list those libraries and their licenses in their own license files.

## Rust crates

Built into the app. The crates that are new in Cargo.lock since LU 3.0.5:

| Crate | Version | License | Used for |
| --- | --- | --- | --- |
| annotate-snippets | 0.11.5 | MIT OR Apache-2.0 |  |
| anstyle | 1.0.14 | MIT OR Apache-2.0 |  |
| bindgen | 0.72.1 | BSD-3-Clause |  |
| bytemuck_derive | 1.12.1 | Zlib OR Apache-2.0 OR MIT |  |
| cexpr | 0.6.0 | Apache-2.0/MIT |  |
| chacha20 | 0.10.2 | MIT OR Apache-2.0 |  |
| clang-sys | 1.9.1 | Apache-2.0 |  |
| cookie-factory | 0.3.3 | MIT |  |
| drm | 0.14.1 | MIT |  |
| drm | 0.15.0 | MIT |  |
| drm-ffi | 0.9.1 | MIT |  |
| drm-fourcc | 2.2.0 | MIT |  |
| drm-sys | 0.8.1 | MIT |  |
| enigo | 0.6.1 | MIT | simulated mouse and keyboard |
| gbm | 0.18.0 | MIT |  |
| gbm-sys | 0.4.0 | MIT |  |
| gethostname | 1.1.0 | Apache-2.0 |  |
| gl | 0.14.0 | Apache-2.0 |  |
| gl_generator | 0.14.0 | Apache-2.0 |  |
| global-hotkey | 0.8.0 | Apache-2.0 OR MIT | the global stop shortcut |
| itertools | 0.13.0 | MIT OR Apache-2.0 |  |
| khronos-egl | 6.0.0 | MIT/Apache-2.0 |  |
| khronos_api | 3.1.0 | Apache-2.0 |  |
| libspa | 0.10.1 | MIT |  |
| libspa-sys | 0.10.1 | MIT |  |
| libwayshot-xcap | 0.3.3 | BSD-2-Clause |  |
| memmap2 | 0.9.11 | MIT OR Apache-2.0 |  |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 |  |
| nom | 7.1.3 | MIT |  |
| nom | 8.0.0 | MIT |  |
| objc2-av-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-avf-audio | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-cloud-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-core-audio | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-core-audio-types | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-core-data | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-core-image | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-core-media | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-core-text | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-core-video | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-image-io | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-media-toolbox | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| objc2-metal | 0.3.2 | Zlib OR Apache-2.0 OR MIT |  |
| pipewire | 0.10.1 | MIT |  |
| pipewire-sys | 0.10.1 | MIT |  |
| tauri-plugin-global-shortcut | 2.3.2 | Apache-2.0 OR MIT | the global stop shortcut |
| uiautomation | 0.25.1 | Apache-2.0 | the interface tree (Windows) |
| uiautomation_derive | 0.7.9 | Apache-2.0 |  |
| unicode-width | 0.2.2 | MIT OR Apache-2.0 |  |
| wayland-protocols-wlr | 0.3.12 | MIT |  |
| wayland-server | 0.31.14 | MIT |  |
| widestring | 1.2.1 | MIT OR Apache-2.0 |  |
| x11rb | 0.13.2 | MIT OR Apache-2.0 | monitors, screenshots and windows on Linux (X11) |
| x11rb-protocol | 0.13.2 | MIT OR Apache-2.0 |  |
| xcap | 0.9.8 | Apache-2.0 | screenshots and the window list (Windows, macOS) |
| xcb | 1.7.1 | MIT |  |
| xkbcommon | 0.9.0 | MIT |  |
| xkeysym | 0.2.1 | MIT OR Apache-2.0 OR Zlib |  |
| xml-rs | 0.8.29 | MIT |  |
| zcheapstr | 1.1.0 | MIT |  |
| zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib |  |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib | JPEG screenshots |

Cargo.lock names crates for every system. Not every one is compiled into every build: the Wayland, PipeWire, DRM and GBM crates belong to xcap on Linux, and LU does not build xcap there.

### enigo 0.6.1 (MIT)

MIT License

Copyright (c) 2017 pythoneer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### tauri-plugin-global-shortcut 2.3.2 and global-hotkey 0.8.0 (MIT option)

MIT License

Copyright (c) 2017 - Present Tauri Apps Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

MIT License

Copyright (c) 2022-2022 Tauri Programme within The Commons Conservancy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### x11rb 0.13.2 (MIT option)

Copyright 2019 x11rb Contributers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

### xcap 0.9.8 and uiautomation 0.25.1 (Apache-2.0)

Copyright of xcap: the xcap authors (https://github.com/nashaofu/xcap). Copyright of uiautomation: the uiautomation-rs authors (https://github.com/leexgone/uiautomation-rs). Both are used unchanged under the Apache License 2.0:

Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2024 nashaofu

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

## npm packages

The packages that are new in package-lock.json since LU 3.0.5. The notices of the voice client itself (@pipecat-ai/client-js and what it needs) are in ASTRA-CLIENT-NOTICES.md next to this file.

Not built into the app: @daily-co/daily-js and the six Sentry packages it depends on. @pipecat-ai/websocket-transport names @daily-co/daily-js as a dependency, so npm installs them for a build, but the build replaces the package with a small file of LU (src/api/voice-no-daily.ts) and none of their code is in what LU ships. They are listed because they are in package-lock.json.

| Package | Version | License |
| --- | --- | --- |
| @bufbuild/protobuf | 2.16.0 | (Apache-2.0 AND BSD-3-Clause) |
| @bufbuild/protoplugin | 2.16.0 | Apache-2.0 |
| @bufbuild/protoplugin > typescript | 5.4.5 | Apache-2.0 |
| @daily-co/daily-js | 0.90.0 | BSD-2-Clause |
| @pipecat-ai/websocket-transport | 1.7.2 | BSD-2-Clause |
| @protobuf-ts/plugin | 2.11.1 | Apache-2.0 |
| @protobuf-ts/plugin > typescript | 3.9.10 | Apache-2.0 |
| @protobuf-ts/protoc | 2.11.1 | Apache-2.0 |
| @protobuf-ts/runtime | 2.11.1 | (Apache-2.0 AND BSD-3-Clause) |
| @protobuf-ts/runtime-rpc | 2.11.1 | Apache-2.0 |
| @sentry-internal/browser-utils | 8.55.2 | MIT |
| @sentry-internal/feedback | 8.55.2 | MIT |
| @sentry-internal/replay | 8.55.2 | MIT |
| @sentry-internal/replay-canvas | 8.55.2 | MIT |
| @sentry/browser | 8.55.2 | MIT |
| @sentry/core | 8.55.2 | MIT |
| @typescript/vfs | 1.6.5 | MIT |
| x-law | 0.3.1 | MIT |

### @bufbuild/protobuf 2.16.0 ((Apache-2.0 AND BSD-3-Clause))

The package carries no license file. Its package.json names the license above.

### @bufbuild/protoplugin 2.16.0 (Apache-2.0)

The package carries no license file. Its package.json names the license above.

### @bufbuild/protoplugin > typescript 5.4.5 (Apache-2.0)

Apache License 2.0, the full text is printed above under xcap.

### @daily-co/daily-js 0.90.0 (BSD-2-Clause)

BSD 2-Clause License

Copyright (c) 2019, daily-co
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### @pipecat-ai/websocket-transport 1.7.2 (BSD-2-Clause)

BSD 2-Clause License

Copyright (c) 2024, Daily

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### @protobuf-ts/plugin 2.11.1 (Apache-2.0)

Apache License 2.0, the full text is printed above under xcap.

### @protobuf-ts/plugin > typescript 3.9.10 (Apache-2.0)

Apache License 2.0, the full text is printed above under xcap.

### @protobuf-ts/protoc 2.11.1 (Apache-2.0)

The package carries no license file. Its package.json names the license above.

### @protobuf-ts/runtime 2.11.1 ((Apache-2.0 AND BSD-3-Clause))

Apache License 2.0, the full text is printed above under xcap.

### @protobuf-ts/runtime-rpc 2.11.1 (Apache-2.0)

Apache License 2.0, the full text is printed above under xcap.

### @sentry-internal/browser-utils 8.55.2 (MIT)

MIT License

Copyright (c) 2020-2024 Functional Software, Inc. dba Sentry

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### @sentry-internal/feedback 8.55.2 (MIT)

MIT License

Copyright (c) 2023-2024 Functional Software, Inc. dba Sentry

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### @sentry-internal/replay 8.55.2 (MIT)

MIT License

Copyright (c) 2022-2024 Functional Software, Inc. dba Sentry

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### @sentry-internal/replay-canvas 8.55.2 (MIT)

MIT License

Copyright (c) 2024 Functional Software, Inc. dba Sentry

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### @sentry/browser 8.55.2 (MIT)

MIT License

Copyright (c) 2019-2024 Functional Software, Inc. dba Sentry

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### @sentry/core 8.55.2 (MIT)

Same text as the package before it in this list with the same publisher.

### @typescript/vfs 1.6.5 (MIT)

The MIT License (MIT)
Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and 
associated documentation files (the "Software"), to deal in the Software without restriction, 
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, 
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, 
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial 
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT 
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. 
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, 
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE 
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### x-law 0.3.1 (MIT)

Copyright (c) 2018-2025 Rafael da Silva Rocha.
Copyright (c) 2025 Nico Möhn.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


### Cua Driver, trycua/cua (MIT), patterns only

Copyright (c) 2025 Cua AI, Inc.

No file of this project ships with LU. Two ways of doing things on Windows
follow its Rust driver (`libs/cua-driver/rust/crates/platform-windows`), and
the places in LU's code say so:

- bringing a window to the front by joining the input of the thread that has
  the foreground (`AttachThreadInput`), with a tap of the key `VK_NONAME` as
  the fallback instead of Alt (`src-tauri/src/commands/computer/desk/platform/windows.rs`),
- naming each element of a window by a short token and acting on the token
  instead of on coordinates.

The MIT licence text above (x-law) applies to it word for word, with the
copyright line of this section.
