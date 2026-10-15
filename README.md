# Goldfish

A free, open-source teleprompter for **Windows and macOS** that follows your voice.
Your script sits in a small bar right under your webcam, highlights each word as you say it,
and stays hidden from screen sharing and recordings. Inspired by [Textream](https://textream.net) (Mac only).

- **Follow my voice**: offline speech recognition (whisper.cpp) highlights where you are. Works in ~100 languages, including mixed-in English words.
- **Scroll while I talk**: scrolls at your speed while you speak and pauses when you stop. No speech model needed.
- **Bar under the webcam**, always on top (even over fullscreen slides), **invisible to Zoom / Teams / Meet / OBS screen capture**.
- **Script library**: paste text or import `.docx`, `.txt`, `.md`. The language is detected from the text.
- **Controls**: global shortcuts, mouse/trackpad scroll on the bar, and a **phone remote** (scan a QR code, same Wi-Fi).
- Private: audio never leaves your computer. No account, no analytics.

## Install

Download the latest installer from [Releases](../../releases): `.exe` for Windows, `.dmg` for Apple Silicon Macs.

The builds are not code-signed yet, so the first launch needs one extra step:
- **Windows**: SmartScreen → *More info* → *Run anyway*.
- **macOS**: open the app once, then *System Settings → Privacy & Security → Open Anyway*.

On first use of *Follow my voice* Goldfish downloads a speech model (574 MB for the best one, once).

## Use

1. Pick or paste a script, check its language (top right).
2. Choose *Follow my voice* or *Scroll while I talk*, press **Start**, and start talking.

| Shortcut (while presenting) | Windows | macOS |
| --- | --- | --- |
| Pause / resume | Ctrl+Shift+Space | Cmd+Shift+Space |
| Back / forward one line | Ctrl+Shift+Up / Down | Cmd+Shift+Up / Down |
| Slower / faster (scroll mode) | Ctrl+Shift+Left / Right | Cmd+Shift+Left / Right |
| Hide / show the bar | Ctrl+Shift+H | Cmd+Shift+H |

All shortcuts can be changed in Settings. Use headphones in calls if you use *Scroll while I talk*,
otherwise other people's voices from your speakers also scroll the bar.

## Develop

Requires Node.js 22+.

```sh
npm install
npm start          # run the app
npm test           # tracker / text tests
npm run dist       # build an installer for the current OS into dist/
```

`GOLDFISH_TEST_AUDIO=path/to/speech.wav npm start` feeds a recording to the bar instead of the microphone.

How it fits together:

| File | Role |
| --- | --- |
| `main.js` | Windows, library/settings storage, shortcuts, model download, phone remote server |
| `whisper.js` | Speech engine ([whisper.node](https://github.com/mybigday/whisper.node)) in a separate process: Vulkan on Windows, Metal on Mac, CPU fallback |
| `src/script.js` | Tokenizing, voice position tracking (alignment of what was heard against the script), language guess |
| `src/bar.*` | The bar: mic capture, voice activity, transcription loop, highlighting |
| `src/index.html`, `app.js`, `style.css` | Library, editor and settings |
| `src/remote.html` | Phone remote page |

## Release

Push a version tag; GitHub Actions builds Windows and macOS installers into a draft release, which you then publish.
Published releases are picked up by the app's auto-updater.

```sh
npm version patch && git push --follow-tags
```

### Code signing

Optional, but removes the first-launch warnings (and macOS auto-update needs it):
- **macOS**: Apple Developer Program ($99/year). Add repository secrets `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and remove `"identity": "-"` from `package.json`.
- **Windows**: any code signing certificate via `CSC_LINK` / `CSC_KEY_PASSWORD`, or Azure Trusted Signing.

Then uncomment the matching `env` lines in `.github/workflows/release.yml`.

## License

MIT
