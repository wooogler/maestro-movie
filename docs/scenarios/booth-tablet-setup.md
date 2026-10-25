# Booth setup: unattended tablets

Use this for the visitor tablets (Galaxy Tab A7 Lite, one wired headset each)
that run beside the presenter's 27-inch portrait kiosk. A visitor walks up,
puts on the headset, taps **one** button and talks. There is no QR to scan, no
code to type and no setup screen. When they walk away, the tablet cleans up
after them.

The tablet is the ordinary app with a **tablet profile** stored on the device
(localStorage), not a separate build. The profile only changes demo sessions;
a study condition opened on the same device runs exactly as it always did.

## 1. The profile URL

Open this once on each tablet, in the browser you will install the app from:

```
https://<booth host>/?profile=tablet&code=ABC123&lang=en&idle=180
```

| Parameter | Values | Default | What it does |
| --- | --- | --- | --- |
| `profile` | `tablet`, `clear` | (required) | `tablet` stores (or overwrites) the profile; `clear` removes it |
| `code` | a demo access code | none | The code every session on this tablet starts with |
| `lang` | `en`, `ko`, `ja`, `zh-Hans`, `zh-Hant`, `de`, `fr`, `es` (or a tag like `zh-TW`) | `en` | The language each new visitor starts in. Use `ko` for KSEA, `en` for UIST |
| `idle` | seconds, 20 to 3600 | `180` | No input, no agent activity and no touch for this long starts over |
| `consent` | `on`, `off` | `on` | Where the research-recording box starts. The box is always visible |
| `motion` | `on`, `off` | `on` | `off` turns on the app's reduced-motion path (section 7) |

Voice is always on, push-to-talk is always off, and the phone pairing is always
hidden on a tablet; those are not parameters.

After the page loads, the profile parameters (the code with them) are removed
from the address bar. `lang` is read and removed by the language switch, as a
`?lang=` link always was.

**The code in this URL is a bearer credential**, the same as the code inside a
quick-card QR: anyone holding the URL can start sessions on the operator key
until the code expires or is revoked. Do not post it, print it or leave it in a
chat. Mint a batch for the tablets (`npm run codes:generate -- --batch
uist-tablets --count 1 --valid-until ...`) so it can be revoked on its own
(`npm run codes:revoke`).

KSEA (Korean):

```
https://<booth host>/?profile=tablet&code=ABC123&lang=ko&idle=180
```

## 2. What the visitor sees

**The start screen.** One line in the profile's language ("Say what you'd like
to see and when" / "보고 싶은 영화와 조건을 말씀해 보세요"), a short headset
hint, the language dropdown, one large **Start** (**시작하기**) button, the
research-recording box (pre-ticked unless `consent=off`), and a small **Test
sound** (**소리 확인**) link that plays a short sample through the headset. No
code dialog, no key, no preset picker, no push-to-talk switch.

**Start** creates a demo session with the stored code, opens the booking page
with voice on, and is also the tap that unlocks audio, so the agent's first
sentence is audible. The first time, Chrome asks for the microphone (section 4
makes that a one-time question).

**During the session.** The phone-pairing card, the devices card and "use my
phone as the mic" are gone. The toolbar is **Memory**, **Settings** (language
and how much the agent says; the planner model, push-to-talk and layout are not
offered) and **Start over** (**처음부터**). Start over finishes the session
and returns to the start screen; if a booking is under way it asks once
("Start over? This booking will be cleared." with **Keep going** / **Start
over**). In portrait the toolbar is a strip at the top; in landscape it sits in
the empty gutter left of the booking card, so the card keeps that height.

**When the visitor walks away.** After `idle - 15` seconds with no input, no
agent activity and no touch, a **Still there?** card counts down 15 seconds.
Any touch cancels it. At `idle` seconds the session is finished and the tablet
is back on the start screen, in the profile's language, with the box ticked
again. "Agent activity" includes the agent planning, the agent speaking and the
visitor mid-utterance, so a long answer never triggers it.

**When the booking is done.** The confirmation stays up for 20 seconds after
the agent stops talking, with "All done! Starting over for the next visitor in
N s." beside Start over; then the tablet starts over.

Every reset (idle, booking done, Start over, the Finish Task button) sends
`POST /study/sessions/finish` for that session, closes the Realtime voice
session and the relay socket, and clears the chat, so the next visitor never
sees the previous visitor's booking. The finish waits up to 2 seconds for the
booking page's last log line, then goes out with `keepalive`.

**Relaunch.** An installed app that is closed and reopened mid-session resumes
the booking, as on the kiosk, but only if the tablet was touched within the
idle window; otherwise the stored session is finished and the start screen
opens.

**The server's own reaper still applies.** The backend ends a demo session
after `DEMO_SESSION_IDLE_TIMEOUT_MS` (900000, 15 minutes) without activity and
caps demo sessions at `DEMO_MAX_CONCURRENT_SESSIONS` (10). The tablet's idle
reset is the normal path; the reaper is the backstop for a tablet that lost
power or network mid-session. For a booth with several tablets,
`DEMO_SESSION_IDLE_TIMEOUT_MS=300000` (5 minutes) is a reasonable value: it
frees a dead tablet's slot sooner without ever beating a 180-second tablet
reset. It is an `.env` change on the server, not part of the profile.

## 3. Orientation: portrait

Use the A7 Lite in **portrait** (Auto rotate off, held portrait before pinning).
Measured at 533x893 CSS px every stage fits at scale 0.94 to 1.0: list rows
58px, Continue 48px, seats 29px. In landscape (893x533) the stage is fitted to
533px of height and drawn at 0.55 to 0.78 (list rows about 40px, seats 15px);
it works, especially by voice, but it is cramped. An installed app in landscape
also loses the status and navigation bars from those 533px.

## 4. Android setup (once per tablet)

1. **Wi-Fi** on the booth network. Settings > Software update: postpone, so
   the tablet does not restart mid-day.
2. **Keep the screen on while charging.** Settings > About tablet > Software
   information, tap Build number seven times; then Settings > Developer
   options > **Stay awake** on. Keep the tablet on its charger. (The app also
   holds a screen wake lock while it is open, which is best effort only.)
3. **Notifications off.** Swipe down, turn on **Do not disturb** (allow
   nothing), and turn off notifications for Chrome in Settings > Notifications.
4. **Chrome: microphone allowed for the site.** Open the booth URL in Chrome,
   tap the lock icon > Permissions > Microphone > **Allow**. Also Chrome >
   Settings > Site settings > Sound: allowed.
5. **Apply the profile.** Open the profile URL from section 1. The start screen
   appears.
6. **Install as an app.** Chrome menu > **Add to home screen** > Install. Open
   it from the home screen icon; it runs full screen at the same address, and
   the profile is already there (same site, same storage).
7. **Headset in, volume.** Plug the wired headset into the 3.5 mm jack. Media
   volume to about 60 percent, then tap **Test sound** on the start screen and
   adjust. Check that the sound is in the earphones and not the speaker.
8. **Pin the screen.** Settings > Security and privacy > More security
   settings (Other security settings on older One UI) > **Pin windows** on
   (with "Ask for PIN before unpinning"). Open
   Recents, tap the app's icon above its card, **Pin this app**. A visitor can
   no longer leave the app; to unpin, hold Back and Recents and enter the PIN.
9. **Try it.** Start, say one sentence, walk away for `idle` seconds, and check
   the tablet comes back to the start screen on its own.

## 5. Clearing or changing the profile

- **Change** the code, language or idle time: open a new profile URL; it
  overwrites the old profile.
- **Remove** the profile: open `/?profile=clear`. The full demo setup page is
  back, and the reduced-motion flag is cleared with it.
- A pinned tablet must be unpinned first (section 4.8) to reach the address
  bar. In the installed app, open the URL in Chrome; both share the storage.

## 6. If something goes wrong

- **Start does nothing / "This tablet has no access code".** The profile URL had
  no `code=`. Open it again with one.
- **Start shows an error.** The code expired, was revoked, or the demo is at its
  ten-session cap. Check `npm run codes:stats` on the server.
- **The agent does not hear the visitor.** Chrome's microphone permission was
  denied for the site (section 4.4), or the headset is not fully seated.
- **Sound comes out of the tablet speaker.** Re-seat the headset plug and
  re-check with Test sound.

## 7. Reduced motion (`motion=off`)

`motion=off` (or Settings > Reduce motion on the full demo) applies the same
CSS path `prefers-reduced-motion` does: no stage slide, no highlight rings, no
list enter/exit animation. Off by default. Measured in headless Chromium at
`Emulation.setCPUThrottlingRate 6`, portrait 533x893, main-thread task time in
the 25 seconds after one typed line:

| Step | Motion on | Motion off |
| --- | --- | --- |
| Showtimes filter ("Something after 7 PM") | 4539, 4372 ms | 3773, 6153 ms |
| Seat highlight ("Two seats together near the middle") | 4282, 4648 ms | 4562, 4540 ms |

About 80 percent of it is script (React rendering the agent's steps), which
reduced motion does not touch; style recalculation drops by a fifth to a third
(150-180 ms to 120-135 ms). The spread between runs comes from the agent taking
a different number of steps. Headless has no GPU, so compositor smoothness is
not measured: turn `motion=off` on if the real tablet visibly stutters during a
stage change, and leave it on (the default) otherwise.
