# Booth setup: push-to-talk

The kiosk's start screen, its two QR codes and the return to start after each
visitor are in [booth-kiosk-setup.md](booth-kiosk-setup.md).

Use this for a loud hall. At the KSEA poster session (2026-10-24) the default
server VAD took hall noise, bystanders and the kiosk's own voice as visitor
turns: 30 of 102 turns were noise, and 40 of the agent's 128 sentences were cut
by a VAD barge-in. With push-to-talk the microphone is open **only while a key
is held**. The Realtime session is minted with no turn detection at all, so
nothing the room says can open a turn or cut the agent off.

Push-to-talk is a booth (demo-session) option. Study sessions keep server VAD
and cannot be switched: the backend answers `403 PUSH_TO_TALK_DEMO_ONLY` to any
non-demo session that asks for manual turns.

## 1. Hardware

- Kiosk: a MacBook driving the 27-inch portrait monitor, with Chrome in front
  and focused. A key press only reaches the page while the Chrome window has
  focus. If focus leaves (Cmd-Tab, a notification, Spotlight), the page treats
  that as a release, and the presenter has to press again.
- Presenter: a wired headset (mic and earphones) in the MacBook's 3.5 mm jack
  or a USB adapter.

## 2. macOS sound devices: input from the headset, output to the speakers

When a headset is plugged in, macOS moves **both** input and output to it.
Split them:

1. System Settings > Sound > **Input**: pick the headset mic (it shows as
   "External Microphone" on the combo jack, or by its own name over USB).
   Speak and check that the input level meter moves.
2. System Settings > Sound > **Output**: pick the monitor's speakers or the
   booth speakers, not the headset, so visitors hear the agent.
3. Re-check both after every re-plug. macOS switches them again each time.

Chrome uses the system default input. The app has no device picker, so step 1
is the only place the headset mic gets chosen. If Chrome was already open
before the headset went in, reload the page after changing the input.

## 3. Turn push-to-talk on

You can do this on the setup screen before a visitor starts, or during a
session:

1. **Settings** (설정) > **Push to talk** (누르는 동안만 말하기): turn the switch on.
   The setting is saved in this browser (localStorage), so it carries over to
   every session after it until you switch it off.
2. Choose the **Talk key** (말하기 키). See section 4.
3. Hold the key: the light next to "Press the key to test it" (키를 눌러 시험해
   보세요) turns on and reads **Key held** (키 눌림). In a live session, holding
   the key here also opens the mic, so what lights up is exactly what talks.

Switching push-to-talk on or off during a session reconnects the voice session,
because turn detection is fixed when the session is minted. That takes about a
second.

During a session the status line shows:

| State | Korean | English |
|---|---|---|
| Key not held | 키를 누르고 말하세요 | Hold the key and speak |
| Key held | 듣는 중... | Listening... |
| Released, waiting for the transcript | 받아쓰는 중... | Transcribing... |

## 4. Choosing the key

The key is stored as a `KeyboardEvent.code`, so it does not depend on the
keyboard layout or the input language (a Korean input source does not change
it).

- **Space** (default). This is the easiest key to find without looking. It
  types normally while a text field is focused: the rule is **if focus is in an
  editable text field, the PTT key types and does not talk**. While voice is
  live, the voice composer is read-only and refuses focus, so in practice this
  only applies to the settings sheet's own text box. Space never scrolls the
  page and never clicks a focused button while it is the PTT key.
- **F13** for a custom button (next section).
- **ControlLeft** or **ShiftLeft** if you want a modifier.
- **Other key code**: type any `KeyboardEvent.code` (for example `F14`,
  `IntlBackslash` or `ScrollLock`), or press **Press a key to choose** (키를 눌러
  선택) and then press the key itself. Its code is recorded and the field fills
  in.

Cmd+Space (Spotlight) and Ctrl+Space (input source) are left to macOS when the
key is Space.

## 5. A dedicated HID button (F13)

A foot pedal, a one-key USB macro pad or a programmable presenter button can be
set (in its vendor tool, or with Karabiner-Elements) to send **F13**. macOS
does not bind F13 to anything by default. On full-size Apple keyboards it is a
real key, and Chrome reports it as `code: "F13"`. Pick **F13** in the key list,
or press the button after **Press a key to choose**, and check the test light.
The button must send its key-down on press and its key-up on release. Some
macro pads send both on press by default ("tap" mode), and that reads as a
tap under 300 ms, which is discarded (see section 6).

## 6. How it behaves (and what it ignores)

- **Press**: the agent's current sentence stops at once, the same way a
  barge-in stops it (cancel the response, clear the output buffer, report
  `tts.playback.complete` interrupted). The input buffer is cleared, and the mic
  track is enabled.
- **Release**: the mic stays open for another 200 ms so the last syllable is
  not clipped. Then the track is disabled and the buffer is committed. The
  transcription that comes back becomes the visitor's turn, through the same
  noise gates as a VAD transcript.
- A **press shorter than 300 ms** is not sent: the buffer is cleared, not
  committed. The limit was 150 ms in the first draft. A 234 ms press over
  speech then came back as "그걸로 할게요." ("I'll take that one"), which was
  never in the audio, and it reached the agent as a turn. A press meant to
  carry words is longer than 300 ms anyway.
- **Empty, whitespace-only or punctuation-only transcripts** are dropped.
- If no transcript arrives within 4 s, the kiosk returns to idle.
- **Auto-repeat** while the key is held is ignored. A press starts only on a
  fresh key-down.
- **Window blur or a hidden tab** counts as a release, and so does a hold longer
  than 60 s (a stuck key or a taped-down pedal).
- **Pressing again before the last transcript lands** is fine. Each press is its
  own commit, and both transcripts are delivered.
- **Reconnect or the 50-minute renewal**: the new session starts with the mic
  shut. A key still held across the reconnect does nothing until it is released
  and pressed again.

## 7. Keys

| Key | Does |
|---|---|
| **Space** (hold) | Talk (push-to-talk, the key from section 4) |
| **Enter** or **→** | Next: presses the stage's Continue, or Confirm Booking on the confirm step, or Finish on the booking-complete screen |
| **←** | Back: presses the stage's Back |

Enter, → and ← press the stage's own button, so they do exactly what a click
does, and nothing when the button is disabled (for example Continue on the seat
map before a seat is picked) or the agent is working. They work in the kiosk
and desktop layouts of a demo session, not on a phone and not in study
sessions. In the kiosk the buttons show the key ("Enter ⏎", "←").

They are ignored while focus is in a text field (Enter there sends the
message), while a dialog is open (Settings, the phone-pairing panel), with Cmd,
Ctrl, Alt or Shift held, and while a key is held down (auto-repeat): one press
is one stage. A second press within 0.7 s of the last one is dropped too, so a
double tap does not skip a stage. If you reached a button with Tab, Enter
presses that button, as usual; after a click on a seat or an option, Enter is
Continue.

## 8. Turning it off

Switch **Push to talk** off in Settings. The next voice connection is the
default server VAD, which is exactly what the study ran. Server VAD settings
are described next to `OPENAI_REALTIME_VAD_*` in `.env.example`.

## Verification (headless, fake microphone)

Measured on 2026-10-24 against an isolated dev stack. The fake microphone was a
looping 16-bit, 48 kHz WAV of "오늘 밤에 클라라와 태양 보고 싶어요" (3.5 s of
speech every 12.5 s), driven over the Chrome DevTools Protocol with real
`Input.dispatchKeyEvent` key events. A second WAV looped three different lines
so that the agent had something new to answer. The offline checks are
`apps/frontend/src/hooks/usePushToTalk.check.ts` (part of `npm run check`).

| Check | Result |
|---|---|
| Session config | `session.created` reports `turn_detection: null` with PTT on, and `server_vad` (0.5 / 300 / 900) with PTT off |
| Key not held for 30 s while the WAV loops (7.1 s of speech reached the local mic) | 0 transcripts, 0 `user.message`, 0 commits, 0 VAD events; mic track `enabled=false` throughout |
| Hold for the utterance, then release (5 presses) | 5 correct transcripts, each sent once, and the agent answered. Key-up to transcript: 802, 936, 902, 796, 1117 ms (median 902, worst 1117). That includes the 200 ms release tail; the commit left 203 to 206 ms after key-up |
| Press while the agent is speaking (4 presses over 2 runs) | Output RMS silent 276, 286, 293 and 264 ms after key-down; `tts.playback.complete {interrupted: true}` sent 1 ms after key-down; the transcript landed 534 to 907 ms after release |
| Taps of 113 ms and 252 ms (in-page timing) | Buffer cleared, 0 commits, 0 transcripts, 0 `user.message` |
| Auto-repeat (10 repeats per hold) | 1 clear and 1 commit per press |
| Space with the mic button focused | Default prevented; voice stayed on |
| Data channel closed while the key was held | Reconnected with a new mic track, `enabled=false` with the key still down (auto-repeat sent), 0 commits; the status read 키를 누르고 말하세요; the next fresh press transcribed |
| PTT off: `scripts/simulate-cards.mjs A --voice` | Booked (Klara and the Sun, Cinema Detroit, 9:30 PM, C4) |
| Setup-screen settings sheet | Test light on while Space was held; Space did not close the sheet; F13 captured with "Press a key to choose"; free-text `ControlLeft` saved |

Not verified: a real headset, a real MacBook and the macOS device split, a
physical F13 button, and a real hall.
