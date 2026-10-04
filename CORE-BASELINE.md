# Core dependency provenance

The standalone DSH adapter consumes the host-neutral Python distribution `thaliris==0.4.3` from the Thaliris Core repository at current main commit [`7f4d9acf2e642e7b3c987d4ee45ebc6589d7cc15`](https://github.com/Iris0fTheValley/Thaliris/tree/7f4d9acf2e642e7b3c987d4ee45ebc6589d7cc15). The DSH native API baseline is source revision [`639ed015397290b3745d163aafe02ffee4aa3f84`](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84). The adapter keeps the authority and task ledger in Core; this repository ships no Core or Codex adapter source.

For the extracted-repository validation, a fresh `thaliris-0.4.3-py3-none-any.whl` was built from current Core main, inspected, and installed into an isolated Python 3.11 environment. Its payload contains only the `thaliris` package (`__init__`, `authority`, `cli`, `core`, `markdown`, and `models`) plus distribution metadata; it contains no Codex-specific modules. The tested wheel SHA-256 was `c916e219c99bc52021c8d91d71ec93a5c1a1950eaa4ed71dec90be73658dec16`.

The bridge suite passed all 13 tests against the `src` tree from current Core main at commit `7f4d9acf2e642e7b3c987d4ee45ebc6589d7cc15`, and passed again against the installed wheel. The packed activation smoke was not rerun for this dependency refresh.

The original source repository's live Web integration was verified separately against Core source revision `256f760`, including a real active task, a fifth child, denial of native root tools to that child, and an explicit `DONE` close. That observation is separate from the extracted-repository native and packed-install checks; a Desktop binary was not launched.
