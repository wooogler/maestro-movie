# Booth setup: the kiosk start screen

Use this for the presenter-run kiosk (a MacBook and the 27-inch portrait
monitor, with a headset) and for any desktop running the full demo from `/`.
For the headset key see [booth-ptt-setup.md](booth-ptt-setup.md). For the
unattended tablets see [booth-tablet-setup.md](booth-tablet-setup.md).

The flow is one screen and then the booking. Start goes straight to `/booking`
with voice on. There is no "ready to start" pairing page any more. The
study conditions C1–C4 are unchanged: their setup still goes through the
scenario review page.

## 1. Setting up the kiosk once

1. Open `/?lang=ko` (or `?lang=en`). The language the page is **loaded in**
   is the kiosk's default. Every visitor reset puts the language back to it.
   To change the default, reload with a different `lang`.
2. With no code stored, the code dialog opens by itself. Enter the booth
   access code. From then on the header only shows the small
   **Code ready · Change** chip.
3. Optional, in **Settings**, under *Between visitors*:
   - **After a booking**: how long the complete screen stays up after its
     spoken line. The default is 12 s.
   - **When nobody is using it**: the idle reset. The default is 10 min; it
     can also be set to *Never*.

   Both values are stored on the device and survive every reset.

## 2. What the start screen shows, top to bottom

1. **Title row.** "Demo Setup", one line of invitation, and *What is this
   demo?*. On the right are the presenter's quiet controls: Demo Mode, Settings,
   and Code ready · Change.
2. **Language dropdown** and one large **Start Demo** button. A small *Mic
   Check* link sits under it.
3. **Preference memory.** *Start empty* is the default, then Family matinee,
   Date night and Big screen. *More presets (3)* opens Late show, Budget and
   Easy trip. If the chosen preset is one of those three, the list starts
   open, so a visitor's choice is never hidden.
4. **Research recording.** One line with a pre-ticked checkbox and a
   *Details* link that unfolds the full consent text.
5. **Start Demo, again.** This only appears when the page is taller than the
   screen (at 1920×1080, not at 1440×2560 portrait).
6. **Two QR codes side by side**, each with a one-line caption, and the
   device roster under them:
   - **(a) Use your phone as the mic for this kiosk.** This is the phone
     pairing.
   - **(b) Try the demo on your own phone.** This is the full demo on the
     visitor's phone, with nothing to type and nothing to pair.

## 3. The two QR codes

### (a) Phone as the mic

A pairing token can only be minted against a session that exists. While the
start screen is up with a code stored, it therefore holds one **standby demo
session** (`study/demoStandbySession.ts`), and App mints the pairing token for
it. Pressing Start promotes that same session, so the token is never minted
again (minting revokes the previous pairing). A phone that scanned on the start
screen is still paired on the booking page, and the memory rail's "Use my phone
as the mic" card shows the same code.

How the standby session behaves:

- **Consent changes.** The research-recording answer is fixed when a session
  is created. Ticking or unticking the box therefore replaces the standby
  (after a 0.5 s debounce) and finishes the old one. A phone that had already
  scanned (a) has to scan the new code. The replaced session never had a
  visitor; a consented one holds only its session-start line.
- **Heartbeat.** It runs every 4 min, because the backend reaps an idle demo
  session after 15 min.
- **Expiry.** A standby with less than 25 min of its 60-min lifetime left is
  replaced, but only after a minute with no touch on the screen.
- **Leaving.** Leaving the start screen without Start (the About page, Demo
  Mode off, closing the tab) finishes the standby.
- **Capacity.** A kiosk on its start screen therefore always holds one of the
  demo's concurrent sessions (`DEMO_MAX_CONCURRENT_SESSIONS`, 10 by default).
- **Capped codes.** Each standby is a code redemption. Use an uncapped booth
  code; a code with a redemption cap is used up by consent toggles.

### (b) Try on your own phone

The QR carries the movie quick card's link with the booth code and the current
language in the URL fragment:

```
/demo/card#c=movie&k=<code>&lang=<language>
```

The fragment never reaches the server or its logs. The QR is rebuilt when the
language dropdown changes.

On the phone, the card face is a one-tap start ("Start and talk" or "Start and
type"), in the carried language, with no code field. It then opens a normal
full booking from the movie stage. It is a quick-card session:

- It is never recorded, because the card route does not ask for consent.
- The phone does **not** get the tablet profile.
- It has no booth reset; it ends on the end page like any card.

QR (b) only appears when the kiosk runs on an access code. A pasted OpenAI key
is never put in a QR.

### Both are bearer links

- **(a)** attaches a phone to this session's voice until the session ends.
- **(b)** carries the access code, which starts sessions on the operator key
  until the code is revoked. This is exactly what a printed quick card does.

Neither link is printed as text on screen. Revoke the batch after the event
(`npm run codes:revoke -- --batch <name>`).

## 4. After the booking: back to the start screen

The booking-complete screen plays its spoken line (`useBookingCompleteAnnouncement`).
The return-to-start countdown is counted from when that line **settles**:

- it played out (plus a 0.5 s tail), or
- it was interrupted, or
- it hit the 6 s cap, or
- with voice off, the chime played.

After that comes the *After a booking* delay (12 s by default). A pill at the
bottom says "All done! Starting over for the next visitor in N s." Anything the
agent does in the meantime pushes the return out, so the countdown never runs
under speech.

Tapping **Done / 완료** on the complete screen returns at once.

Either way, the booth reset (`handleBoothReset` in `App.tsx`, shared with the
tablet) does the following:

1. Cuts the audio.
2. Writes `study.control.booth_reset`.
3. Clears the shared chat store.
4. Drops the session. ChatPage unmounts and tears down Realtime and the relay.
5. Calls `POST /study/sessions/finish` with the captured token, after the last
   log line (or 2 s).
6. Puts the start screen back to the next visitor's defaults: the kiosk's
   language, Start empty, the box ticked, and voice on the kiosk.

The start screen then creates a fresh standby, so a new pairing QR appears.

## 5. Idle reset

If nothing happens for the idle window (10 min by default), the session resets
the same way as after a booking. Nothing happening means no touch, key or
scroll, no message, no stage change, and no agent speech. A *Still there?*
dialog counts down for 15 s first; any touch cancels it.

"Busy" (the agent planning or speaking, the visitor mid-utterance) holds the
clock, but for at most 90 s. A stuck flag cannot keep the kiosk from its next
visitor.

The start screen has the same rule for leftover choices. If a visitor changed
the language, a preset or the box and walked away, those choices go back to
the defaults after the same idle window.

The rules are `decideBoothIdle` in `study/boothReset.ts`, which the tablet's
`decideTabletIdle` now is. The kiosk only passes different numbers.

## 6. Verification (headless)

The checks were run on this server's Chromium with `scripts/drive.mjs`, against
a worktree Vite on :5286 and the shared backend on :3000:

| Check | Result |
|---|---|
| Start screen, en and ko, at 1440×2560 and 1920×1080 | Matches section 2 |
| Start | `/booking` directly; the mic button reads "Turn off voice mode" (voice on); the rail's pairing card has the same companion URL the start screen's QR (a) showed |
| QR (b) | `/demo/card#c=movie&k=…&lang=ko\|en`; at 390×844 the phone shows the one-tap card face in that language, no code field, no tablet profile; "Start and type" lands on `/booking` |
| Return timer set to 3 s, silent fake mic | Complete screen at 0.3 s, line released by the 6 s cap at 6.3 s, countdown 3 → 0, back on `/` at 9.5 s. The old token then answers 401, the box is ticked, the preset is Start empty, and a new QR (a) is up |
| Done tap | Immediate return, same reset |
| Idle set to 1 min, after a switch to English and Family matinee | *Still there?* at about 55 s, then `/` with the language back to ko, Start empty, the box ticked, and the old session finished |
| Study flow | Demo Mode off → C1 → Start Task → `/task-review` (Scenario Review) |

Offline checks, part of `npm run check`:

- `study/boothReset.check.ts`: the return timer, the idle reset and the
  settings parsing.
- `study/presetGrouping.dom.check.ts`: the three presets up front and three
  behind the expander.

Not verified here:

- a real phone scanning either code;
- a real headset hearing the completion line play out (headless, the
  playback-done event never arrived, so the 6 s cap ended it).
