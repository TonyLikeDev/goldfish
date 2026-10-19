# Goldfish test report (v0.1.0, October 2026)

**61 problems: 1 critical, 3 high, 21 medium, 36 low.**

Status after the first fix batch: 36 fixed, 5 partly fixed, 3 fixed in code but unconfirmed (Mac), 17 open.

How it was tested: the dev build ran on a Windows 11 PC (i5-13400F, RTX 3070). Every test used its own throwaway data folder. Speech came from recordings instead of a microphone, using the base speech model only. A second tester re-checked every finding and tried to disprove it. Nothing was run on a Mac: the Mac items come from reading the code and the Apple and Electron docs.

Tags:
- `confirmed`: reproduced.
- `plausible`: clear from the code, not reproduced.
- `needs Mac` / `needs device`: can't be checked without one.

File and line references point to the v0.1.0 code.

---

## Critical

**C1: Mac (macOS 15+): screen recordings and some meeting apps may still show the bar** (main.js:95)
- Status: **Fixed in code; needs a Mac to confirm.** The README, a Mac-only hint in Settings and a one-time notice on Start (macOS 15+) now say to share a single window instead of the whole screen.
- Impact: Hiding relies only on `setContentProtection`. Electron's docs say apps built on Apple's ScreenCaptureKit capture the window anyway, and that includes macOS's own screen recording. Your audience or your video could show the script.
- Repro: On a Mac with macOS 15 or later, start a session. Record with QuickTime or Cmd+Shift+5, then share the whole screen in Zoom, Teams, Meet (Chrome) and OBS. Evidence: Electron's `setContentProtection` docs; Electron issue #48258 (closed as a macOS change); Apple developer support: "no public APIs for preventing screen capture".
- Fix: No code can block it. Test each app on a Mac. Until they pass, change README.md:9 and the Settings label for Mac, and on Start (macOS 15+) show "Share a single window, not your whole screen".
- `needs Mac`

---

## High

**H1: Voice mode: scroll back to re-read and the highlight jumps forward again, then freezes** (src/bar.js:158)
- Status: **Fixed.** After a move by hand, voice follow listens only to audio from after the move and drops results from before it, so the bar follows the re-read instead of snapping back.
- Impact: You stumble and go back (wheel, Ctrl/Cmd+Shift+Up or phone Back). Usually within half a second the bar snaps back to where you were. The lines you're re-reading scroll out of view, and the bar stays stuck until you catch up. Re-reading only works if you stay silent for about 6 s first.
- Repro: Seen 4 times in the app. Example: highlight at word 34, scrolled back to word 8, back at 34 after 250 ms, then stuck for 10.6 s during the re-read.
- Fix: There are two causes. The 6 s audio window still holds speech from before the move, and a transcription already in flight lands after the move. On every manual move (wheel, back, forward), save `heardFrom = total` and bump a move counter. In listen(), start the window at `Math.max(total - WINDOW, heardFrom)`, wait for about 0.5 s of new audio, and drop any result whose request was sent before the last manual move.
- `confirmed`

**H2: Edits typed in the last 0.4 s before you switch script, press New or close the window are lost, and a just-deleted script comes back** (src/app.js:93)
- Status: **Fixed.** Every edit now goes to the main process at once and reaches disk within 0.4 s and on quit, and a deleted script stays deleted.
- Impact: The save timer saves whichever script is open when it fires, and nothing saves on switch or close. The editor still shows your text, so it looks saved, but it's gone after a restart. A paste followed by a quick click loses the whole paste.
- Repro: Paste into script A, click script B within 0.4 s, then restart: A is missing the paste. Or type and press Alt+F4 right away. Or type, press Delete, confirm and restart: the script is back.
- Fix: Save the script that was edited, not whatever is open. Save any pending edit before switching, New and import. Clear the timer before deleting. Save when the window closes.
- `confirmed`

**H3: Phone remote: one malformed request from any device on the network freezes Goldfish mid-talk** (main.js:223)
- Status: **Fixed.** A malformed request now gets a 400, and uncaught errors are logged instead of opening a blocking error box.
- Impact: The request address is parsed before the token check and the error isn't caught, so Electron shows its own error box. Until someone clicks OK, the bar, voice follow, shortcuts and the remote all stop, and the box shows in screen shares. No token is needed. This only happens when the phone remote is on (it's off by default).
- Repro: Turn on the phone remote and send one request whose target the URL parser rejects. An "Error" window appears and the app stops responding.
- Fix: Parse with `URL.parse(req.url, 'http://local')` (it returns null instead of throwing) and answer 400 when it fails, before anything else. Log uncaught exceptions instead of letting Electron show a blocking box during a talk.
- `confirmed`

---

## Medium

### Voice follow

**M1: Changing Model or GPU in Settings during a voice session freezes voice follow until Stop/Start** (main.js:202)
- Status: **Fixed.** Changing Model, GPU or mode mid-session now ends waiting calls with "Switching speech model…" and starts a new engine, so tracking resumes by itself.
- Impact: stopEngine() forgets the engine before killing it, so calls still waiting are never answered. The bar waits forever: green dot, no highlight, no error. If this happens during start-up, the bar stays on "Preparing speech engine…".
- Repro: Start a voice session, open Settings and turn GPU off (or change the model) while talking. Highlighting stops for good.
- Fix: In stopEngine(), reject and clear `pending` before `kill()`. Optionally give engine calls a timeout, so a hung engine shows an error and restarts.
- `confirmed`

**M2: Speech-engine start-up and errors are nearly invisible, and the main window says "Hearing you"** (src/bar.js:187)
- Status: **Fixed.** The bar's status now reaches the main window (amber while loading, red on errors), the bar's status line is larger and brighter, and the engine stays loaded for 10 minutes after Stop.
- Impact: The first voice session shows "Preparing speech engine…" for 10–18 s, probably longer with the default 574 MB model, in 11 px grey text at the bottom of the bar. Errors ("Microphone unavailable", "keeps crashing", "Failed to initialize") also show only there. Meanwhile the main window shows a green "Hearing you · 0%".
- Repro: Fresh profile, voice mode, press Start. Watch the bar's status line and the main window's status pill.
- Fix: Send the status with bar:state. In the main window, show start-up in amber and errors in red. Make the bar's status easier to read. Keep the engine loaded across Stop/Start.
- `confirmed`

**M3: The script's speech language is often wrong, and the app doesn't say so** (src/app.js:91)
- Status: **Fixed.** New scripts re-guess their language on every edit until you pick one, 12 common Latin-script languages are told apart, and the picker has a visible "Speech language" label.
- Impact: The language is guessed only on the first keystroke, so typing "X" gives English. Spanish, French, German or Indonesian always get the fallback: English, or the last language you picked by hand. Whisper is then forced to the wrong language. English speech under a wrong label started tracking about 10 s late, then recovered. The effect on non-English speech wasn't measured.
- Repro: In a new script, type a Vietnamese sentence key by key: it stays English. Paste Spanish: English. Set one script to Vietnamese, then paste English into a new one: Vietnamese.
- Fix: Keep guessing on each edit until the user picks a language for that script. Tell common Latin-script languages apart. Give the picker a visible label.
- `confirmed`

**M4: Ukrainian, Bulgarian, Serbian and Kazakh scripts become Russian even when you chose them (also Persian/Urdu → Arabic, Marathi/Nepali → Hindi, Cantonese → Chinese)** (src/script.js:77)
- Status: **Fixed.** If your language uses the same writing system as the guess, your language is kept, so Ukrainian stays Ukrainian.
- Impact: The writing-system guess wins before your own language is looked at. These scripts are saved and transcribed in the wrong language on every paste and import, including with "Detect automatically".
- Repro: Set the language to Ukrainian and paste a Ukrainian script: it's labelled Russian.
- Fix: If your language uses the same writing system as the guess, keep yours (compare `new Intl.Locale(x).maximize().script`). Skip that check for "auto", because `Intl.Locale('auto')` throws.
- `confirmed`

**M5: Voice detection can't adapt to a new steady noise, so "Scroll while I talk" keeps scrolling with nobody talking** (src/bar.js:116)
- Impact: The noise level is only learned while the input is quiet. A fan, AC, music or TV that starts after a quiet start counts as speech for as long as it lasts. Lowering the sensitivity doesn't help.
- Repro: In talk mode, start quiet, then add steady noise: the bar scrolled 25 of 105 words with no speech. The test fed audio directly and skipped Chrome's noise suppression, which removes some steady noise on a real mic but not music.
- Fix: Track the floor as the lowest chunk level over the last 3–5 s (speech always has gaps), and seed it from the first 0.5 s instead of a fixed 0.003.
- `confirmed`

**M6: Windows: if the GPU engine crashes while loading, the CPU engine starts twice and one copy runs until you quit** (main.js:183)
- Status: **Fixed.** Any older engine is stopped before a new one starts, so a GPU crash during loading leaves exactly one CPU engine.
- Impact: The leftover engine keeps the whole model in memory: 364 MB with the smallest model, much more with the default one. Tracking also starts about 5 s later. On PCs whose graphics driver crashes at load, this happens every run.
- Repro: Kill the "Goldfish Speech" process while it loads, run a session, then press Stop: one "Goldfish Speech" process stays alive.
- Fix: Don't clear engineReady in the exit handler while that process is still starting, and kill any previous engine before starting a new one.
- `confirmed`

### Bar under the webcam, hidden from capture

**M7: While you present, the main window with the full script is not hidden from screen sharing** (main.js:66)
- Status: **Fixed.** The main window now follows the same "Hide Goldfish from screen sharing and recordings" setting as the bar.
- Impact: Only the bar is protected. Share your whole screen with the Goldfish window on it and the audience sees the whole script, the Stop button and "Hearing you". Zoom and Teams hide only their own window when you share.
- Repro: Start a session and check both windows: the bar is protected; the main window is not protected, is visible and is not minimized.
- Fix: Call `setContentProtection(settings.hideFromCapture)` on the main window too.
- `confirmed`

**M8: Mac: the bar probably sits one menu-bar height too low, or behind the notch when the menu bar auto-hides** (main.js:79)
- Impact: macOS normally keeps such windows below the menu bar and the bar doesn't opt out. On a notched MacBook the text would start about 74 pt down instead of about 37. With "auto-hide menu bar", the padding drops to 8 px and the first line sits behind the camera notch.
- Repro: Needs a Mac. Start a session and compare the bar's top with the screen's top. Then turn on menu-bar auto-hide and look at the first line.
- Fix: Add `enableLargerThanScreen: true` to the bar window. Work out the padding from where the window really is, and never go below the notch strip on built-in screens (about `height - width / 1.6`, which is 37 pt).
- `needs Mac`

**M9: Mac: Keynote's full-screen slideshow may hide the bar** (README.md:9)
- Status: **Fixed in code; needs a Mac to confirm.** The README now tells Keynote users to turn on "Allow Mission Control, Dashboard and others to use screen".
- Impact: Keynote keeps other apps off the slideshow screen unless its "Allow Mission Control, Dashboard and others to use screen" option is on. The README promises "even over fullscreen slides".
- Repro: Needs a Mac with Keynote. Start a session and play a slideshow full screen on the webcam screen.
- Fix: Test Keynote, PowerPoint and Zoom in full screen on a Mac. Add a tip about the Keynote option, or soften the README claim.
- `needs Mac`

**M10: With Lines set to 1, the line you're reading is faded out** (src/bar.html:13)
- Status: **Fixed.** With Lines set to 1 the fade is off, and otherwise the fade is sized from the text size.
- Impact: The "more below" fade is a fixed 19 px, sized from the 16 px parent rather than your text size. With one line, the only line sits inside it: dim at 24 px, very dim at 16 px.
- Repro: In Settings, set Lines to 1 and the text size to 16 or 24, then start a session.
- Fix: Turn the mask off when Lines is 1, and size the fade from the text size.
- `confirmed`

**M11: Mac: after the first Start, Goldfish loses its Dock icon, Cmd+Tab entry and menu bar until restart** (main.js:94)
- Status: **Fixed in code; needs a Mac to confirm.** Stopping a session now brings the Dock icon back.
- Impact: `setVisibleOnAllWorkspaces` with `visibleOnFullScreen` hides the Dock icon, and nothing brings it back. The only Stop button is in the main window, and getting back to it takes Mission Control.
- Repro: Needs a Mac. Press Start, then look at the Dock and Cmd+Tab.
- Fix: Call `app.dock.show()` when the session stops. Try `skipTransformProcessType: true` on a Mac.
- `needs Mac`

### Install and update

**M12: Mac: auto-update can never install on the ad-hoc signed build, but says it will on every launch** (main.js:363)
- Status: **Partly fixed.** On a Mac, Goldfish no longer downloads updates it can't install and shows "Goldfish X is available." with a Download button for the Releases page instead; still open: telling 0.1.x Mac users, in the release notes, to reinstall once, and a test on a Mac.
- Impact: The updater downloads the update and shows "will be automatically installed on exit" before macOS checks the signature, and ad-hoc builds always fail that check. Mac users stay on 0.1.0 and see the notice on every launch, maybe during a screen share. Even a later, properly signed build can't update these installs.
- Repro: Ran electron-updater's real code with a stand-in for the Mac installer. A real check needs a Mac and two releases.
- Fix: Until the Mac build is signed, set `autoDownload = false` on macOS, call `checkForUpdates()`, and on 'update-available' show a notice in the main window with a link to the Releases page. Tell 0.1.x Mac users they'll need to reinstall once.
- `needs Mac`

**M13: Windows: installing into a folder whose path contains "Goldfish" makes the next update or uninstall delete that whole folder** (package.json:53)
- Status: **Fixed.** The installer's folder page now refuses a non-empty folder without Goldfish.exe (tested with a harness build of the check; the real installer wasn't run). The page explains this in English in every installer language, like the desktop-shortcut tick box.
- Impact: The installer adds a \Goldfish subfolder only when the path doesn't already contain "goldfish" (any case). Update and uninstall then delete the install folder and everything in it, such as the user's own files in D:\Goldfish.
- Repro: From electron-builder's installer templates; the installer wasn't run. To check on a VM: install into an existing "C:\Test\Goldfish notes" folder that holds a .txt, then uninstall: the .txt is gone.
- Fix: In build/installer.nsh, refuse a non-empty folder that has no Goldfish.exe, or turn off `allowToChangeInstallationDirectory`.
- `plausible`

### Your scripts

**M14: A failed save is silent, and then Start does nothing** (src/app.js:181)
- Status: **Fixed.** Saves now retry a locked file, a failed save shows a red "Couldn't save your scripts…" banner and is retried on the next edit and on quit, and Start no longer waits for the save.
- Impact: If library.json can't be replaced (an antivirus or sync tool holds it, it's read-only, or the disk is full), nobody catches the error. Edits reach disk only if a later save works. Start stops at `await flush()`: no bar, no message.
- Repro: Make library.json read-only, type something and press Start: no bar, no banner.
- Fix: Retry the rename a few times on EPERM/EBUSY/EACCES. Return the error and show "Couldn't save your script". Don't let a failed save block Start, because the script is already in memory.
- `confirmed`

**M15: A damaged library.json is silently replaced by the Welcome script, and saves aren't forced to disk** (main.js:26)
- Status: **Fixed.** Saves are flushed to disk and the previous file is kept as library.json.bak, so a damaged library is restored from it, with a banner saying where the damaged file was moved.
- Impact: On a read error the file is moved to library.json.broken-(time) and the app opens with one script and no message, so people think everything is gone. Saves aren't flushed before the rename, so a power cut right after typing can leave an empty file and lose the whole library.
- Repro: Cut library.json to 60% of its size and start the app: only "Welcome to Goldfish" shows, with no banner.
- Fix: `writeFileSync(tmp, data, { flush: true })`. Keep a library.json.bak and fall back to it. Show a banner saying which file was moved aside and where.
- `confirmed`

**M16: Markdown import deletes everything between a "<" and the next ">", even across paragraphs** (src/script.js:93)
- Status: **Fixed.** Only real HTML tags and comments are stripped, so "< 200 ms", "->" and the text of `<https://…>` and `<name@mail>` links stay.
- Impact: "If latency is < 200 ms and errors are > 1%" becomes "If latency is  1%". A 4-paragraph file went from 67 words to 9. Arrows like "->", "<3", web links in angle brackets and e-mail addresses also vanish. There's no warning; the original file is safe.
- Repro: Import a .md containing "If latency is < 200 ms and errors are > 1%, we roll back."
- Fix: Strip only real tags, and keep the text of `<https://…>` and `<name@mail>` links.
- `confirmed`

**M17: .txt files saved as UTF-16 or in older encodings import as garbage** (main.js:299)
- Status: **Fixed.** Imported .txt and .md files are decoded by their byte-order mark, then as UTF-8, then in the system's code page, with a warning if unreadable characters remain.
- Impact: Every .txt is read as UTF-8. These fill the script with blanks and "�", with a wrong language guess and no warning:
  - Notepad "Unicode" and Word "Plain Text" files
  - files written by PowerShell 5.1
  - older ANSI, Shift-JIS, GBK or Vietnamese files
- Repro: Import a .txt saved by Notepad as "UTF-16 LE", or a Windows-1252 file with "café".
- Fix: Read the file as a Buffer.
  - FF FE or FE FF at the start: decode as UTF-16. EF BB BF: decode as UTF-8.
  - Otherwise try strict UTF-8, and fall back to the system code page.
  - Warn if "�" remains.
- `confirmed`

**M18: Word line breaks (Shift+Enter) are dropped and glue words together** (main.js:297)
- Status: **Fixed.** Word import now goes through HTML, so Shift+Enter breaks become line breaks.
- Impact: The raw-text import ignores soft breaks, so "Line one" + break + "Line two" becomes "Line oneLine two" in the editor and on the bar.
- Repro: Import a .docx whose lines end with Shift+Enter.
- Fix: Use `mammoth.convertToHtml`, turn `<br>` into "\n" and `</p>` into "\n\n", then strip the tags.
- `confirmed`

### Everything else

**M19: The Start/Stop button slides off-screen when the window is narrower than about 855 px** (src/style.css:51)
- Status: **Fixed.** The layout now shrinks to fit, so Start/Stop stays on screen at the 760 px minimum width.
- Impact: Snapping Goldfish to half a laptop screen next to Zoom hides Start/Stop, half of Settings and Delete behind a sideways scrollbar. Below about 771 px Start is fully hidden; the minimum window width is 760.
- Repro: Resize the main window to 760×480: the page is 839 px wide and Start sits outside it.
- Fix: `main { grid-template-columns: 260px minmax(0, 1fr) }`.
- `confirmed`

**M20: Phone remote: the QR code can point to a VPN or virtual-machine address** (main.js:252)
- Status: **Fixed.** Virtual, VPN and container adapters now rank last, 172.16–31.x counts as a local address, and the remote dialog lists the other addresses under "Not loading? Try:".
- Impact: Any 192.168.x address wins, including VirtualBox and VMware adapters (192.168.56.1). On 172.16–31.x office networks, the address falls back to whichever adapter is listed first. The phone can't reach it, and there's no way to pick another address.
- Repro: The same code fed with sample adapter lists: VirtualBox plus Wi-Fi 10.0.0.23 gives 192.168.56.1.
- Fix: Skip known virtual adapters, include 172.16/12, and show the other addresses.
- `plausible`

**M21: The script list can't be used with the keyboard or a screen reader** (src/app.js:61)
- Status: **Fixed.** Each script in the list is now a button that Tab reaches and Enter or Space opens, and the open one is marked with `aria-current`.
- Impact: List items are plain `<li>` elements with a click handler. Tab skips them, so keyboard-only users can't switch scripts at all.
- Repro: Tab through the main window: focus jumps from "New script" to "Import file…".
- Fix: Put a `<button>` inside each `<li>` and mark the open one with `aria-current`.
- `confirmed`

---

## Low

### Voice follow

**L1: Skipping ahead more than about 70 English words (41 Korean) while talking loses you until you scroll** (src/script.js:33)
- Impact: The search looks only 240 characters back and 360 ahead, and that reach differs 3–4× between languages.
- Repro: Read a paragraph 150 words ahead: the tracker doesn't move.
- Fix: After about 3 s of misses while you talk, search the rest of the script once with a double score. Measure the window in words.
- `confirmed`

**L2: Whisper's stock "thanks for watching" phrases can jump the tracker to the end** (src/script.js:33)
- Impact: The Japanese "ご視聴ありがとうございました" matches a typical closing line from about 30 words away; "Thank you for watching." matches from about 14 words away in English. The last lines then scroll away.
- Repro: Seen in locate() with those phrases. Whisper producing them wasn't proven here; they're typical of the default turbo model, which wasn't used.
- Fix: Drop known hallucination phrases before locate().
- `plausible`

**L3: Vietnamese typed with separate accent marks is detected as English** (src/script.js:72)
- Status: **Fixed.** The language guess normalizes text to NFC first, so Vietnamese with separate accent marks is detected.
- Impact: Text from Unikey's combining charset, or copied in that form, scores under the 3% threshold, so Whisper is forced to English.
- Repro: `guessLang(vietnamese.normalize('NFD'), 'en')` returns 'en'.
- Fix: Make the first line of guessLang `text = text.normalize('NFC')`.
- `confirmed`

**L4: Recovery after an engine failure is clumsy** (main.js:188)
- Impact:
  - One GPU crash or any load error, even from a damaged model, keeps the engine on the slow CPU build for the rest of the run with no hint (5–10 s behind).
  - A damaged model can't be re-downloaded (Settings says "Downloaded."), and the app starts a new engine every 2 s.
  - After 3 crashes, "turn off GPU in Settings" does nothing until Stop/Start.
- Repro: Kill the engine mid-session: later sessions run on CPU. Truncate the model file: the bar says "Failed to initialize whisper context".
- Fix:
  - Reset gpuFailed and engineFailures per session and on Model/GPU change, and set gpuFailed only for GPU crashes.
  - Treat load errors as "model damaged, download again".
  - Show "Running without GPU (slow)".
- `confirmed`

**L5: The first session after a driver update still stalls 1–4 s on some windows mid-talk** (whisper.js:11)
- Impact: The warm-up (1 s of silence, no prompt) doesn't prepare everything the GPU needs. The first prompted window took 3.2 s extra.
- Repro: Run the same windows with a cold and a warm shader cache: about 6 s of extra work after the warm-up.
- Fix: Warm up with about 2 s of speech-like audio, a prompt and one retry-style run, or warm up in the background after the app starts.
- `confirmed`

**L6: Cantonese with the Fast or Balanced model sends Whisper the "translate" signal** (src/app.js:14)
- Status: **Fixed.** Cantonese is sent to Whisper as "zh" unless the model is large-v3.
- Impact: "yue" maps to language number 99, which on the smaller models lands on the translate token, so tracking likely won't move.
- Repro: Found by reading the whisper.cpp code; no Cantonese voice was available to test.
- Fix: Send "zh" for "yue" unless the model is large-v3, or hide Cantonese for the smaller models.
- `plausible`

**L7: The voice sensitivity slider does nothing in a quiet room** (src/bar.js:113)
- Impact: The threshold is clamped at 0.004, so every slider position acts the same, and quiet keyboard clicks can't be tuned out in talk mode.
- Repro: The same talk session at sensitivity 0 and 1 gives identical positions.
- Fix: Scale the minimum with sensitivity, e.g. `Math.max(floor * k, 0.002 + 0.008 * (1 - sensitivity))`.
- `confirmed`

**L8: Voice mode transcribes about 3 times a second while you talk** (src/bar.js:157)
- Impact: The engine runs back to back while you speak: 40% busy on an RTX 3070 with the smallest model. It might compete with Zoom or OBS; no harm was measured.
- Repro: 601 transcriptions in 225 s of speech.
- Fix: Only if a slowdown shows up: skip windows with less than about 0.5 s of new audio.
- `plausible`

### The bar

**L9: The bar doesn't move when a monitor is plugged in, unplugged or changes resolution mid-session** (main.js:85)
- Status: **Fixed.** The bar moves back into place when a monitor is plugged in, unplugged or changes resolution.
- Impact: The bar stays off-centre or partly off-screen until a setting changes or you restart the session.
- Repro: No screen-change listeners exist (checked in a live session).
- Fix: On display-added, display-removed and display-metrics-changed, call `bar.setBounds(barBounds())` and resend 'settings'.
- `confirmed`

**L10: A crashed bar isn't noticed: the dead bar stays on top and the main window freezes on its last state** (main.js:98)
- Status: **Fixed.** A crashed bar now reloads at its last position, and a second crash within 10 s stops the session with a banner.
- Impact: Rare, but the prompter freezes with no message. Stop then Start fixes it, but starts from the top.
- Repro: Crash the bar's page from the main process: the window stays, and the main window keeps showing "Hearing you · 30%".
- Fix: On 'render-process-gone', reload the bar at its last position, or stop the session and show a banner.
- `confirmed`

**L11: Trackpad swipes may jump several lines** (src/bar.js:92)
- Impact: The bar moves one line per 50 px of scrolling with no grouping, so momentum can overshoot and leftovers carry into the next swipe.
- Repro: Tested only with synthetic events (30 × 4 px moved 2 lines); needs a real trackpad.
- Fix: Reset the scroll total after about 200 ms without events, and consider one line per gesture.
- `needs device`

**L12: At the end of the script, one "back" skips the last line** (src/bar.js:61)
- Status: **Fixed.** Back from the end of the script now lands on the start of the last line.
- Impact: You need an extra press to re-read the last line.
- Repro: Go to the end and press back once: you land on the line before the last.
- Fix: In lineStart(-1), when `pos >= spans.length`, return the start of the last line.
- `confirmed`

**L13: Japanese scripts show Chinese-style characters on non-Japanese Windows** (src/bar.html:2)
- Status: **Fixed.** The bar and the phone page now take their page language from the script.
- Impact: The page has no language set, so kanji use Microsoft YaHei while kana use Yu Gothic: two fonts in one line.
- Repro: Show a Japanese script on English Windows and check the fonts used.
- Fix: Set `document.documentElement.lang = script.lang` (unless "auto") in the bar and the phone page.
- `confirmed`

**L14: The bar can cover the Zoom/Teams share toolbar at the top centre** (main.js:82)
- Impact: The bar is always on top and catches clicks across 640 px, right where "Stop share" docks.
- Repro: Not run; it would need Zoom or Teams.
- Fix: Show the hide shortcut in the main window during a session, and consider a small nudge setting.
- `needs device`

### Presenting

**L15: Closing the main window mid-talk quits Goldfish without asking, and Electron's default menu ships** (main.js:72)
- Status: **Fixed.** Closing the main window mid-talk now asks "Stop presenting and quit Goldfish?", Windows gets no default menu, and a Mac gets a small menu and a Dock click that restores the window (not tried on a Mac).
- Impact:
  - X, Alt+F4 or Ctrl/Cmd+W ends the session at once.
  - Ctrl+R reloads, dropping unsaved typing, and the hidden menu offers Toggle Developer Tools.
  - On Mac, clicking the Dock icon doesn't bring back a minimized window.
- Repro: Close the main window during a session: the app exits.
- Fix:
  - While presenting, ask "Stop presenting and quit?".
  - Set a small menu: Edit only on Windows; About, Edit and Quit on Mac.
  - Handle 'activate' on Mac.
- `confirmed`

**L16: The default shortcuts take over normal text-selection keys in every app while you present** (main.js:43)
- Impact: Ctrl+Shift+arrows (Cmd+Shift+arrows on Mac) stop selecting words and lines in chat or notes, and move the bar or change speed instead. On Mac, Cmd+Shift+H (Finder home, Zoom chat) and Cmd+Shift+Space (Siri on macOS 27) are taken too.
- Repro: From the code and Apple's shortcut list; not pressed during testing.
- Fix: Before the next release, pick defaults nobody uses for editing. Saved keys stay as they are for existing users.
- `confirmed`

**L17: The shortcut recorder accepts single keys and duplicates, and misreports conflicts** (src/app.js:246)
- Impact:
  - Space, a letter or PageDown on its own is grabbed system-wide during the session.
  - Two actions can share a key, and the warning blames "another app" in raw "CommandOrControl+…" text.
  - On AZERTY/QWERTZ keyboards it records the key position (pressing A saves Q).
- Repro: In Settings, press Space in the Pause box: it's saved as "Space".
- Fix:
  - Require Ctrl, Alt or Cmd unless the key is F13–F24 or a clicker key.
  - Reject keys another action already uses.
  - Write warnings with keyLabel().
  - Use `e.key` for letters on Windows.
- `confirmed`

**L18: While presenting, the main window offers only Stop** (src/index.html:19)
- Impact: There's no Pause, Back or Forward, and no reminder of the shortcuts or the wheel. Someone who forgets the keys can only Stop (and lose their place) or use the phone.
- Repro: Start a session and look at the main window's header.
- Fix: Show a small row with Pause, Back and Forward, each with its shortcut.
- `plausible`

**L19: Faster/Slower give no feedback, and Settings shows the old speed** (src/bar.js:84)
- Impact: Nothing shows the new speed in the bar, on the phone or in the main window, and Settings keeps the value from app start. In voice mode, the +/− buttons do nothing.
- Repro: Press Faster twice, then open Settings: it shows 2.5 while the real speed is 3.
- Fix: Flash "Speed 3.0 words/s" in the bar's status line, push settings changes to the main window, and hide +/− in voice mode.
- `confirmed`

**L20: Edits made during a session don't reach the bar or the phone** (main.js:112)
- Impact: You fix a typo mid-rehearsal and the bar keeps the old text, with no hint to restart.
- Repro: Start, edit the script, then look at the bar.
- Fix: Send the edited script to the bar and phone, keeping the position, or show "Changes apply next time you press Start".
- `confirmed`

**L21: Microphone and screen settings quirks** (src/app.js:226)
- Status: **Partly fixed.** Settings now opens the mic only when device names are hidden, and a saved mic or screen that isn't connected shows as "(not connected)"; still open: a mic chosen mid-session still applies only from the next session.
- Impact:
  - Opening Settings turns the mic on every time: the mic icon shows on Windows, and on Mac a permission prompt appears before any session.
  - A saved mic or screen that's unplugged shows as a blank choice.
  - A new mic chosen mid-session applies only from the next session.
- Repro: Open Settings 3 times: the mic is opened 3 times.
- Fix: Call enumerateDevices() first and ask for the mic only if names are missing. Show "(unplugged, using default)". Restart audio when the mic changes.
- `confirmed`

### Library and import

**L22: Odd data files can crash start-up or lock Settings** (main.js:48)
- Status: **Fixed.** Settings and library files are checked after loading: bad values fall back to defaults, a damaged file is moved aside with a notice, and a file locked at launch gets a plain error message instead of a crash.
- Impact:
  - A settings.json containing `null` crashes every launch.
  - A library.json of `[]` makes saves and Start fail silently.
  - An unknown model or mode (after a downgrade or hand edit) stops Settings opening or empties the list.
  - A settings or library file locked by another program at launch crashes start-up.
- Repro: Put `null` in settings.json and start the app: an error window appears and no main window.
- Fix: Check the shape after loading (plain object, known model and mode, scripts array) and use defaults otherwise. Move a file aside only when JSON parsing fails.
- `confirmed`

**L23: One unreadable file cancels a whole multi-file import, with a cryptic error** (main.js:294)
- Status: **Fixed.** Each file is imported on its own, so the good ones still import, and each failure is named in plain words.
- Impact: One protected or renamed .doc file in a batch means nothing is imported. The banner shows a zip-library message with a developer link and no file name.
- Repro: Import a good .txt, a broken .docx and a good .md together: 0 added.
- Fix: Catch errors per file, import the good ones, and name the failures in plain words.
- `confirmed`

**L24: Markdown import leaves markup on the bar** (src/script.js:82)
- Status: **Fixed.** Markdown import now handles Windows line endings, front matter (also keys with spaces, dots or quotes, such as Obsidian's "date created:", and TOML `[tables]`), "====" lines, task boxes, footnotes, tables and entities, and keeps list numbers.
- Impact:
  - These show up on the bar: front matter (title:, tags:), "=====" lines, `&amp;`, task boxes, tables, backslashes and extra blank lines (from Windows line endings).
  - Numbered lines lose their number: "2024. What a year" becomes "What a year".
  - Front matter longer than about 350 characters stops voice follow at word 0.
- Repro: Import an Obsidian or Jekyll .md that starts with front matter.
- Fix: Normalize line endings first. Strip leading front matter, "====" lines, task boxes, and reference and footnote lines. Decode common entities. Keep the numbers.
- `confirmed`

**L25: Import quirks: upper-case extensions stay in the title, unsupported dropped files are skipped silently, empty files become empty scripts** (main.js:303)
- Status: **Fixed.** Titles drop the extension in any case, unsupported dropped files are named, and empty files are reported instead of added.
- Impact: Small surprises on import. "This script is empty." only shows on Start.
- Repro: Import SPEECH.TXT: the title is "SPEECH.TXT".
- Fix: Use `path.parse(file).name`, say which dropped files were skipped, and report "X has no text" instead of adding it.
- `confirmed`

### Speech model download

**L26: Asking for a second model while one downloads says "ready" without downloading it** (main.js:315)
- Status: **Fixed.** Downloads are tracked per model, progress shows only under its own model, and only the selected model is called "ready".
- Impact: One shared download ignores the model name. Progress shows under the wrong model, and Start asks for the model again.
- Repro: Start one download, pick another model and press Download: only the first is fetched, and the banner says "ready".
- Fix: Track downloads per model name, and show only progress events whose name matches.
- `confirmed`

**L27: The model download is hard to follow and recover from** (src/app.js:144)
- Status: **Partly fixed.** Downloads now use Electron's `net.fetch`, which follows the system proxy, and a failed download deletes its .part file; still open: a % and Cancel in the banner, plain error messages, resume, a stall timeout, and Start during a download still asks for the model.
- Impact:
  - The banner shows no percent, size or Cancel, and ✕ hides the progress.
  - Start during a download says the model is missing.
  - Errors are raw ("TypeError: fetch failed") and hidden behind the Settings dialog.
  - There's no resume and no timeout for a stalled download (frozen up to 5 min), and partial .part files stay.
  - Behind a company proxy the download may fail outright, because Node's fetch probably ignores the Windows proxy setting (not tested).
- Repro: Fake a download in the main process (no network) that drops halfway: "Download failed: TypeError: terminated", and Try again starts from 0.
- Fix:
  - Show one download state in both the banner and Settings, with % and Cancel.
  - Use plain error messages.
  - Resume with a Range request, and give up after about 30 s without data.
  - Use Electron's `net.fetch`, which follows the system proxy.
- `confirmed`

### Phone remote

**L28: After Goldfish restarts, an open phone page says "Reconnecting…" forever** (src/remote.html:91)
- Status: **Fixed.** When a restarted Goldfish refuses the old link, the phone page now says to scan the QR code again.
- Impact: The token changes on every launch, so the phone gets refused and stops retrying, and taps silently do nothing.
- Repro: Open the phone page, restart Goldfish and wait.
- Fix: On error, check `events.readyState === EventSource.CLOSED` and say "Scan the QR code in Goldfish again". Optionally keep the token across restarts.
- `confirmed`

**L29: A port number with decimals silently kills the phone remote** (src/app.js:238)
- Status: **Fixed.** The port is rounded and clamped to 1024–65535 in the field, a port that can't be used shows a plain error, and the update check no longer depends on the remote.
- Impact: 7391.5 is saved, the server can't start, and the QR code still shows ":7391.5". On every later launch the same error also skips the update check (main.js:362-363).
- Repro: In Settings, set Port to 7391.5.
- Fix: Round the value and write the clamped value back to the field. Catch listen errors into remoteError, and run the update check on its own.
- `confirmed`

**L30: The phone page re-splits the script with the phone's own text engine** (src/remote.html:60)
- Status: **Partly fixed.** The Markdown code moved out of the shared script.js, which no longer uses regex lookbehind, so iOS 15.4–16.3 can load the phone page again (not tried on a phone); still open: the phone still splits the script into words itself instead of using the bar's word list.
- Impact: The phone's highlight can run ahead of the bar on words like "Node.js", "e.g.", web addresses, Khmer or Lao. iPhones on iOS 15.4–16.3 can't load the page at all, because of a regex feature in the shared script.js.
- Repro: The same text splits into 82 words in Electron and 71 with standard ICU; no phone was available.
- Fix: Send the bar's word list from main with the script, and stop loading script.js on the phone (move mdToText into main).
- `needs device`

**L31: Phone remote usability** (src/remote.html:33)
- Impact:
  - The phone auto-locks mid-talk, because a plain http page can't keep the screen awake.
  - Buttons are icons only, and "−" and "+" read as zoom.
  - Buttons look active with no session, and the speed buttons show in voice mode.
- Repro: Open the phone page at 390×844, idle and during a session.
- Fix:
  - On the first tap, start a muted, looping inline video to keep the screen on, or show an auto-lock tip.
  - Add small text labels.
  - Disable the buttons with no session, and hide +/− in voice mode.
- `needs device`

### Accessibility, security and release

**L32: Accessibility gaps in the main window** (src/style.css:4)
- Status: **Fixed.** Light-theme status, error and focus colours now pass AA, the title, script text and Port box show focus, the banner is announced, and the fields have names.
- Impact:
  - Several colours fail WCAG AA: light-theme status text (2.7–2.9:1), red error text, the focus ring (2.35:1) and the open script's highlight (1.18:1).
  - The title, the script text and the Port box show no focus.
  - Banner messages aren't announced, and fields are named only by placeholders.
- Repro: Contrast check over the CSS colours, a Tab walk, and the accessibility tree.
- Fix:
  - Use darker light-theme green, orange and error colours, and a stronger focus ring.
  - Add focus styles to the title, the script text and the Port box.
  - Add `role="status"` to the banner, and aria-labels to the fields.
- `confirmed`

**L33: Security hardening is off** (package.json:25)
- Status: **Partly fixed.** Packaged builds now turn off run-as-node, NODE_OPTIONS and inspect, pages can't navigate or open windows, and library:import reads only .txt, .md and .docx; still open: the preload still opens every channel to every window, and asar integrity checking is off.
- Impact: Electron's safety switches ("fuses") are left at their defaults. On a Mac, another program already on the computer could start Goldfish in a mode that runs its own code with Goldfish's microphone permission. Also:
  - The preload opens every channel to every window.
  - library:import reads any path.
  - Nothing blocks navigation.

  No way in from outside was found.
- Repro: Fuse settings read from the packaged Goldfish.exe, plus reading the code.
- Fix:
  - Add `build.electronFuses`: turn off runAsNode, NODE_OPTIONS and inspect.
  - Accept only .txt/.md/.docx in library:import.
  - Block navigation and window.open.
- `plausible`

**L34: The release workflow can go green without uploading the right files** (.github/workflows/release.yml:25)
- Status: **Fixed.** One release build runs per tag, a tag that doesn't match package.json fails the run, Windows signing has its own WIN_CSC_LINK, and the actions are on v5.
- Impact:
  - Re-tagging reuses old drafts: the v0.1.0 release mixes Mac files from a failed run with Windows files from a later one.
  - A tag that doesn't match package.json uploads nothing and still passes.
  - The README's signing setup gives one CSC_LINK to both jobs, which would sign Windows with the Apple certificate.
  - Node 20 action warnings show on every run.
- Repro: Asset timestamps of the v0.1.0 release, plus electron-publish code.
- Fix:
  - Run one build per tag (concurrency).
  - Fail if the tag isn't v + the package version.
  - Use WIN_CSC_LINK for Windows.
  - Bump checkout and setup-node to v5.
- `confirmed`

**L35: Uninstalling leaves a 118 MB installer copy (and the speech models) behind** (build/installer.nsh:29)
- Status: **Fixed.** A real uninstall (not an update) now deletes %LOCALAPPDATA%\goldfish-updater, while the speech models are kept on purpose (checked in the built uninstaller, which wasn't run).
- Impact: %LOCALAPPDATA%\goldfish-updater\installer.exe stays forever, and models of up to 574 MB stay in %APPDATA%\Goldfish.
- Repro: Seen on the test PC after an uninstall.
- Fix: In customUnInstall (not on update), delete $LOCALAPPDATA\goldfish-updater.
- `confirmed`

**L36: Mac: the microphone permission is asked again after every update, right when you press Start** (main.js:109)
- Impact: macOS doesn't see a new ad-hoc build as the same app, so the prompt can appear just as you go live.
- Repro: Needs a Mac (Apple technote TN3127).
- Fix: Use proper Developer ID signing. Until then, ask for the mic when the app opens if the status is "not-determined".
- `needs Mac`

---

## Not tested yet

- **Anything on a Mac:**
  - bar position under the notch
  - capture by ScreenCaptureKit apps
  - Keynote, PowerPoint and Zoom in full screen
  - Dock and Cmd+Tab
  - Metal speed
  - mic prompts
  - Gatekeeper on first launch
  - Mac auto-update
  - trackpads
  - Mac shortcuts
- **Real phones** (iPhone Safari, Android Chrome): QR scanning, reconnecting, word splitting, auto-lock, old iOS versions.
- **Non-English speech:** only English voices were available, so Chinese, Japanese, Korean, Thai, Vietnamese and European speech was never transcribed for real.
- **The default large-v3-turbo model and the small model:** turbo speed and its typical hallucinations are unmeasured.
- **A real microphone:**
  - Chrome's noise suppression and auto-gain with voice detection
  - unplugging, or a Bluetooth drop mid-session
  - switching mics
  - permission-denied states
- **Real model downloads:** proxies, captive portals, resume, a full disk, quitting mid-download.
- **The packaged app and installer:**
  - a fresh install and uninstall
  - Windows auto-update end to end
  - update notifications
  - Windows on ARM
  - PCs without Vulkan
  - laptops with two graphics chips
- **A real GPU driver crash or hang:** only simulated by killing the engine.
- **Monitors:** mixed scaling, and unplugging or changing resolution mid-session.
- **Real meeting and recording apps on Windows:** Zoom, Teams, Meet and OBS toolbars, and PowerPoint slideshow stacking.
- **Real keyboard input:** Ctrl+W and Ctrl+R menu keys, IME typing, single-key global shortcuts, AZERTY at runtime.
- **Accessibility settings:** screen readers, Windows High Contrast, 200% zoom, and the light theme during a live session.
- **Power loss or a Windows crash** right after a save.
- **Very large or malicious .docx files.**
- **Other networks for the phone remote:** 172.16.x-only or VPN-only setups, and the Windows Firewall prompt on first run.
