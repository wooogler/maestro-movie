# KSEA 2026: Korean simulation of the demo cards

What happens when a Korean visitor reads the printed MAESTRO cards aloud to the current system? I ran each card end to end on 24 Oct 2026 against the dev stack (`realtime-voice` @ `13529c6`, agent dist rebuilt from it). The full cards ran 3–4 times each and the quick cards twice each, all in Korean. Every session is mine; there is no participant data here.

## The short answer

| Card | Does it go the way the card promises? |
|---|---|
| **A 오늘 밤** | **Mostly.** All 3 stage-paced runs land on a valid showing: Cinema Detroit 9:30 PM, ends 11:28 PM, the only one that fits at the nearest cinema. "자정" was read correctly as an end time every time, and 15 miles was never violated. 2 of 3 reached a confirmed booking. The weak spot is the seat line: in 1 of 3 runs the agent marked nothing and asked "어느 좌석을 말씀하신 건가요?" four times in a row. |
| **B IMAX 밤** | **No (0 of 3).** The agent never tells the visitor that IMAX exists only 20.4 miles out. It filters to ≤15 mi without checking IMAX, books its way to a non-IMAX cinema, finds the dead end only at the showtime screen, and then offers **"날짜를 바꿔볼까요?"** That fallback contradicts the visitor's own "목요일" and cannot fix anything, because the cinema has no IMAX on any day. It never offers to drop IMAX or relax the distance. |
| **C 가족 낮 상영** | **Yes, with friction.** 3 of 4 runs reached a correct booking or confirm read-back (Wildwood, Thu 1:15 PM, ends 3:01 PM, three adjacent seats); C4v confirmed it. The runtime re-sort happened 4/4. The PG filter happened 2/4; the other 2 runs only highlighted. One run went **silent for 90 s** after "첫 번째 걸로 할게요". |
| **Quick 1 영화** | ✅ 5 → 2 films, ratings shown. The settle took 19.7 s of narration. |
| **Quick 2 영화관** | ⚠️ 5 → 3 cinemas with miles shown, but **no reorder by distance** (2 of 2 runs), and 23 s of narration. |
| **Quick 3 날짜** | ⚠️ The two weekend days are **highlighted, not left standing alone**: all 6 stay on the calendar (2 of 2 runs). |
| **Quick 4 상영 시간** | ✅ 16 → 3 with end times shown, but it took **41 s** with five spoken sentences. Two of the three survivors read identically: "8:10 PM · 종료 10:14 PM" (one is IMAX, one is 3D). |
| **Quick 5 좌석** | ❌ **Nothing lights up** (2 of 2). The agent asks "E열인가요, F열인가요?" instead. The planner's Highlight-economy ceiling (≤3 choices) forbids marking the 7 pairs the card counts on. |

Three findings go beyond the cards:

- **Typing does not work.** Switching voice off leaves the composer read-only ("마이크를 눌러 말하세요"), so the quick card's own line "주변이 시끄러우면 타이핑으로 하셔도 됩니다" is false.
- **Every full card gets an extra date-confirmation turn.** At the date stage the agent asks to confirm a day the visitor already said ("오늘 날짜로 할까요?", "Nov 5 (Thu)로 할까요?"). This happened in 10 of 10 runs that reached the date stage.
- **Delegating does not work.** "첫 번째 걸로 할게요" and "추천해 주세요" are handled inconsistently: sometimes the agent selects, sometimes it asks to confirm, sometimes it refuses three times, and once it went silent.

## How these runs were made

- **Stack:** the dev stack already running from the main checkout (backend :3000, Vite :5173, branch `realtime-voice` at `13529c6`). I rebuilt `apps/tuning-agent/dist` there with `npm run build:agent` before the first run, so the sessions ran the committed agent. Planner model: `gpt-5.6-terra`, which the GUI reports on every reply.
- **Session:** I minted a demo access code in batch `ksea-sim` (`npm run codes:generate -- --batch ksea-sim --max-uses 40 --ttl-hours 48`; it expires 26 Oct). The full cards start at `/` in Korean with **빈 상태로 시작** (no preset memory) and the consent box left ticked, so each full-card run has an LLM trace. The quick cards start at `/demo/card#c=<id>&k=<code>&lang=ko`, which never records (DemoCardPage sends `researchConsent:false`), so for those the evidence is the captured relay frames only.
- **How the visitor "speaks":** in the demo the composer is read-only whenever voice is available (`ChatInput`'s `isVoiceComposer`), so there is no box to type into. The driver calls ChatInput's own `onSubmit` prop through the React fiber. That reaches the same `submitChatInput` a voice transcript reaches, and the `source` tag never reaches the agent, so every line arrives as a **perfect transcript of the card's words**. STT errors are out of scope here.
- **Voice on vs. voice off are different planners.** This matters more than anything else about the method. With voice on, ChatPage sends `spokenBrevity` (`plannerWritesForTheEar`), and the planner writes for the ear. With voice off it narrates every step, and a step it leaves unnarrated falls back to the English sentence `I will run <tool> next. Reason: …` (`apps/tuning-agent/src/index.ts:1628`). The booth runs with voice on, so the **`v` runs (`--voice`) are the ones that predict KSEA.** They keep the Realtime voice session up on a fake mic fed from a silent WAV, so the kiosk really speaks each reply and the driver waits for every playback to finish. The `t` runs are the briefed text mode with voice off. I kept them as a control, but they do not match the booth.
- **When each line is said:** a full card's line is sent once the GUI reaches the stage the line belongs to (A and B: movie, theater, time, seat; C: movie, movie, time, seat). Until then the simulated visitor answers what the agent asks, as a cooperative visitor would: **첫 번째 걸로 할게요.** to a which-one question, **추천해 주시는 자리로 할게요.** to a which-seat question, and **네, 좋아요.** to anything else. Those follow-up turns are marked *(follow-up)*. They are the driver's words, not the card's, and two of the failures below are partly caused by them; I say so where that applies. Run A1 instead read all four lines in a row (`--eager`, the behaviour before I added stage gating).
- **Reproduce one run:**

  ```bash
  DEMO_TRACE_DIR=/home/sangwonlee/tuning-movie/logs/demo/trace \
    node scripts/simulate-cards.mjs A --voice --code=<code> --json=/tmp/a.json
  ```

## Ground truth (dataset `demo_uist2026_detroit.json`)

| Card | What the data allows |
|---|---|
| A | Klara and the Sun on Tue 3 Nov, ≤15 mi, starting ≥20:00 and ending before midnight: **Cinema Detroit 21:30 (ends 23:28)**, **Bel Air 22:00 (ends 23:58)**, **Emagine 22:00 (ends 23:58)**. Cinema Detroit has rows A–E with 8 seats per row, so row C is the middle. |
| B | Street Fighter on Thu 5 Nov in IMAX: only at **MJR Troy (20.4 mi)**, 20:15 (ends 22:19). Under 15 mi, Bel Air and Emagine show it in Standard or 3D only. Bel Air 18:50/18:55 and Emagine 18:55/19:15 fit the 18:30–23:00 window. This is a designed dead end. |
| C | PG films are Wildwood (1h 46m) and The Legend of Aang (1h 52m). On Thu 5 Nov, afternoon showings that end by 17:00 exist at Bel Air, Redford, Emagine and MJR Troy (for example Wildwood at Emagine 13:15, ending 15:01). |
| Q4 | Street Fighter at MJR Troy, Sat 7 Nov: 16 showtimes. "Not before 8, out by 11" leaves 20:10 IMAX, 20:10 3D and 20:45, so 16 → 3 as printed. |

## Card A: 오늘 밤

**Expected:** Klara and the Sun tonight (3 Nov), within 15 miles, starting after 8 PM, ending before midnight, one middle seat, with the stated preferences shown in the side panel.

| Run | Mode | Trace | Outcome |
|---|---|---|---|
| A1 | text, all four lines read in a row (`--eager`) | `demo-st_7354c566…-20261024-102130` | Stuck at the theater stage for 4 turns, then reached the time stage after the driver said "첫 번째 걸로". The agent **invented a 9-mile limit** for "다운타운에서 가까운 곳" (filter ≤9, three cinemas hidden), then corrected it to ≤15 on the next line. Lines 3 and 4 (time, seat) were remembered but ignored at the theater screen ("apply only to later stages"), and the same question came back **4×**: "15마일 이내 조건 때문에 1곳이 숨겨져 있어요. 보이는 극장 중 어디로 할까요?" |
| A2v | voice | `demo-st_19d4408b…-20261024-102457` | ✅ **Booked:** Cinema Detroit, Tue 3 Nov 9:30 PM (ends 11:28 PM), seat C4 (row C of A–E, seat 4 of 8), $12.00. |
| A3v | voice | `demo-st_91731727…-20261024-102845` | Correct up to the seat stage, then **stuck in a loop**. The seat line got no highlight, only "가운데 쪽에서 어느 좌석으로 할까요?", and then "어느 좌석을 말씀하신 건가요?" ×2, "좌석 번호를 말씀해 주세요" ×2. |
| A4t | text | `demo-st_d99b8e39…-20261024-103327` | ✅ **Booked:** same booking as A2v (C4, 9:30 PM). |

- **Midnight end time:** handled correctly in every run that reached the time stage (A1, A2v, A3v, A4t). The agent augments end times ("9:30 PM · ends 11:28 PM"), keeps only the 9:30 showing, and in voice says "9:30 PM만 조건에 맞아서 선택했어요." A1 only filtered on start time, but it did say "보이는 상영 시간은 자정 전에 끝나요", which was true.
- **15 miles:** never violated. Cinema Detroit (2.5 mi) won every time.
- **Side panel:** all four stated preferences appear, but **in English** ("Wants to see it tonight.", "Needs a theater within 15 miles.", …) on a Korean screen. In card C runs the same panel came out in Korean, so the extractor's output language is not stable.
- **Seat:** dozens of single seats qualify as "middle, not the front row", which is over the Highlight-economy ceiling of 3. Whether a seat gets marked therefore depends on the planner ignoring its own rule: A2v and A4t "recommended" C4, while A3v obeyed the rule and asked for a seat number. In A2v the recommendation was spoken as **"C4 좌석을 선택했어요."** (it had only highlighted), followed by the contradictory "원하시는 좌석을 말씀해 주세요.". In A4t it said "C4를 추천해요" and then "앞줄을 제외한 좌석이 여러 개예요. 어느 좌석으로 할까요?".

### Representative transcript: A2v (voice on, booked)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 오늘 밤에 클라라와 태양 보고 싶어요. 다운타운에서 가까운 곳으로요. | Cinema Detroit가 가장 가까워요. 여기로 할까요? | select m2 → next → augment (5 labels, e.g. “Cinema Detroit — 2.5 miles”) | 2.7 / 8.4 |
| 2 | 15마일 넘는 데는 안 돼요. | 15마일 이내 조건으로 4곳만 보여드려요. 어느 곳으로 할까요? / 15마일 이내 조건 때문에 1곳이 숨겨져 있어요. 어느 극장으로 할까요? | filter distanceMiles lte 15 | 3.7 / 9.1 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | 오늘 날짜가 맞나요? / 오늘 날짜로 할까요? | select t1 → next → highlight 2026-11-03 | 1.9 / 7.5 |
| 4 | 네, 좋아요. *(follow-up)* | 어느 상영 시간으로 할까요? | select 2026-11-03 → next | 2.3 / 5.9 |
| 5 | 8시 이후에 시작해야 하고, 자정 전에는 돌아와야 해요. | 9:30 PM만 조건에 맞아서 선택했어요. / 어느 좌석으로 할까요? | augment (3 labels, e.g. “4:00 PM · ends 5:58 PM”) → select s_m2_t1_20261103_2130_s1 → next | 3.5 / 11.1 |
| 6 | 한 자리만요. 가운데쯤으로, 앞줄은 말고요. | C4 좌석을 선택했어요. / 원하시는 좌석을 말씀해 주세요. | highlight C4 | 4.2 / 6.8 |
| 7 | 네, 좋아요. *(follow-up)* | Klara and the Sun, Cinema Detroit, 오늘 9:30 PM, C4 좌석으로 총 $12.00예요. 예약을 확정할까요? | select s_m2_t1_20261103_2130_s1-C4 → next | 2.8 / 6.7 |
| 8 | 네, 좋아요. *(follow-up)* | *(말 없음)* | next | 예매 확정 화면 (확정 뒤에는 말하지 않음) |

The visitor's lines are the card's. Rows 3, 4, 7 and 8 are the driver's follow-ups. Row 3 is an extra turn only because the agent asked "어느 극장으로 할까요?" instead of taking the nearest cinema it had just proposed. Row 4 answers a confirmation of 오늘, which the visitor had already said.

## Card B: IMAX 밤 (designed dead end)

**Expected:** the agent notices that the only IMAX (MJR Troy) is 20.4 mi away, more than the 15-mile limit. It says so and offers a fallback (drop IMAX, or widen the distance) rather than booking something that breaks a rule.

| Run | Mode | Trace | Outcome |
|---|---|---|---|
| B2t | text | `demo-st_6ef202cd…-20261024-102843` | Dead end found only at the **time** stage, at Emagine. The fallback offered was "IMAX 상영이 없어 선택할 수 없어요. **다른 날짜로 돌아가 볼까요?**" It went back, and the driver's "첫 번째 걸로" then picked Tue 3 Nov, abandoning Thursday. Same dead end again. |
| B3v | voice | `demo-st_5a33d8a9…-20261024-103107` | Same pattern: "IMAX 상영이 없어 날짜를 바꿔볼까요?" said 2×, then `prev`, "IMAX 상영이 가능한 다른 날짜를 골라 주세요." |
| B4v | voice | `demo-st_bd2644e3…-20261024-103532` | Same pattern. Before that it refused "첫 번째 걸로 할게요" **3×** at the theater stage with the identical question. At the end: "IMAX 상영이 가능한 다른 날짜를 골라 주세요." ×3. |
| B1v | voice | — | Did not start: the backend hit its demo-session cap (see the Concurrency observation below). |

Why it fails, from the traces:

1. **The IMAX preference is scoped to the time stage only.** The extractor wrote `"Requires an IMAX screening." relevantStages: ["time"]`. Theaters carry `IMAX` in `amenities`, so the conflict was visible at the theater stage, but the planner was never told to look there. It filtered on distance alone and left Bel Air and Emagine, neither of which has IMAX.
2. **The backtrack target ignores the Thursday preference.** At the time stage, `priorStageAlternativeCounts` was `[{date: 5}, {theater: 1}, {movie: 4}]`. The date count of 5 ignores the hard "목요일" preference, which has no filter binding at the date stage. The prompt says to go back to "the nearest earlier stage that has remaining alternatives" (`llmPlanner.ts:353`, `:368`), so the planner proposes the date. Going back there cannot help, because the cinema lacks IMAX, not the day, and it also breaks a stated rule.
3. The fallback the card needs, "IMAX는 20.4마일 떨어진 MJR Troy에만 있어요. 거리를 늘릴까요, IMAX를 빼고 볼까요?", never appears. The two hard rules are never named together.
4. Line 3 (6:30–11) arrives while the agent is already stuck on the dead end, so it only augments end times. Line 4 (seats) is never reached.

### Representative transcript: B3v (voice on)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 공저자랑 같이 목요일 밤에 스트리트 파이터를 IMAX로 보려고요. | 어느 극장으로 갈까요? | select m1 → next | 3.8 / 6.6 |
| 2 | 15마일 넘게는 운전 안 할 거예요. | 15마일 이내 조건으로 1곳을 숨겼어요. 어느 극장으로 할까요? / 15마일 이내 조건으로 1곳이 숨겨져 있어요. 어느 극장으로 할까요? | augment (3 labels, e.g. “Emagine Royal Oak — 14.2 miles”) → filter distanceMiles lte 15 | 3.6 / 11.1 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | Emagine Royal Oak을 말씀하신 건가요? | — | 3.1 / 3.1 |
| 4 | 네, 좋아요. *(follow-up)* | 목요일이 맞나요? / Nov 5 (Thu)로 할까요? | select t4 → next → highlight 2026-11-05 | 2.9 / 8.3 |
| 5 | 네, 좋아요. *(follow-up)* | IMAX 상영이 없어 날짜를 바꿔볼까요? | select 2026-11-05 → next → augment (8 labels, e.g. “12:50 PM — Standard”) | 2.6 / 9.0 |
| 6 | 6시 반 이후에 시작해서 11시까지는 끝나야 해요. | IMAX 상영이 없어 날짜를 바꿔볼까요? | augment (8 labels, e.g. “12:50 PM — Standard, ends 2:54 PM”) | 4.4 / 6.3 |
| 7 | 네, 좋아요. *(follow-up)* | IMAX 상영이 가능한 다른 날짜를 골라 주세요. | prev | 2.8 / 5.2 |
| 8 | 네, 좋아요. *(follow-up)* | 어느 날짜로 바꿀까요? | — | 3.0 / 3.0 |
| 9 | 첫 번째 걸로 할게요. *(follow-up)* | IMAX 상영이 없어 날짜를 바꿔야 해요. 다른 날짜로 돌아갈까요? | select 2026-11-03 → next → augment (8 labels, e.g. “1:00 PM · Standard · ends 3:04 PM”) | 2.2 / 8.6 |

Rows 7–9 are the driver's agreeable answers to the agent's own fallback. A presenter would step in here, but the fallback the agent offers is the problem.

### Card B after the fix (24 Oct 2026)

Fix 1 below is implemented on branch `worktree-agent-ab4a1cfee1f3bf5af` (commits `ad3d99b`, `21641a8`, `4c658f9`, `578bc84`, `28ede6b`, on top of `realtime-voice` @ `a340d1c`). Every change is behind the booth flag (`AGENT_STUDY_MODE=demo`). A study session's planner and extractor prompts are byte-identical to before, and `plannerPrompt.check.ts` pins that.

What changed, layer by layer:

- **Extractor.** The agent rewrites the two format notes in the field guides before it builds the extractor prompt (`boothStageFieldGuides` in `llmExtractor.ts`). The frontend still sends the study text. In the booth a format requirement belongs to both `theater` and `time`, because amenities list "IMAX". A booth line also tells the extractor how to read the answer to an either-or question: "첫 번째 걸로" means the first way out offered, and that way out drops the requirement it goes without.
- **Counts.** In the booth, each `priorStageAlternativeCounts` entry also lists `uncheckedHardPreferenceIds`: the hard preferences relevant to that stage that the count did not apply. That is how the planner can tell that "date: 5" includes four days the visitor ruled out. The count itself is unchanged, because a free-text preference ("Thursday night") cannot be evaluated there.
- **Planner.** A new booth-only section, `REQUIREMENT_CONFLICT_RULES` (`llmPlanner.ts`), applies when two hard requirements exclude each other. The agent augments both fields and filters as usual, then does not select. It says where the one requirement can be met and what breaks the other, and asks one either-or question. Once the visitor gives one up, the booking carries on under the other. At a later stage it never offers a way out that breaks a stated requirement.
- **Ordinals (fix 6, separable commit `4c658f9`).** In the first live run, the visitor gave up IMAX and was then refused "첫 번째 걸로 할게요." five times at the cinema question. A position in `visibleItems` now names an option in `DECISIVE_SELECTION_RULES` (1).
- **Driver.** Three changes to `simulate-cards.mjs`. An either-or question ("…, 아니면 …?") now gets a pick instead of "네, 좋아요". A booked run is recognised from the host's "Booking Complete" spec; two runs that booked had ended `done=false` after a 90 s wait. A line is now retried while the composer is briefly disabled.

**Replay (`apps/tuning-agent/src/llm/cardB.regress.ts`, real API calls, logged B2t/B3v/B4v turns, 3 runs each, final code):**

| Case | Before | After |
|---|---|---|
| Opener: IMAX scoped to the theater stage | 0/9 (time only) | 9/9 |
| "15마일…": IMAX and the limit both on theater | 0/9 | 9/9 |
| Theater stage after the limit: names IMAX + Troy/20.4 mi and asks, no pick | 0/9 (filters to ≤15 mi, asks which cinema) | 9/9 |
| Time-stage fallback at a cinema with no IMAX: no other day, names both and asks | 0/9 ("다른 날짜로 돌아갈까요?") | 9/9 |
| Answer "첫 번째 걸로 할게요." retracts IMAX only | 0/9 (retracts nothing) | 9/9 |
| The same, on the live requests from the runs below | — | 9/9 |
| Answer "트로이까지 갈게요." retracts the distance limit only | 6/9 | 9/9 |
| After giving up IMAX: carries on among the nearby two, distance filter kept | — | 8/9 (1 cleared the filter and left Troy on screen) |
| After giving up the limit: selects Troy | — | 9/9 |

**Live runs.** These ran on an isolated stack from the worktree (backend :3100 with `NODE_ENV=development`, so the agent ran from `src`; Vite :5273), with `--voice` and access code batch `cardb-fix`. Each row is one card-B run, oldest first. In every run, the visitor's opener led the agent to filter the cinemas to the one with IMAX and ask "MJR Troy로 할까요?". "15마일 넘게는 운전 안 할 거예요" then arrived at the theater stage.

| Run | Code | Conflict named at the theater stage | Right requirement relaxed | Booked |
|---|---|---|---|---|
| L1 `st_7511f754` | `ad3d99b` | ✅ | ✅ (after 3 "네" from the old driver) | ❌ "첫 번째" refused 5× at the cinema question (fix 6 not yet in) |
| L2 `st_c3997de5` | + ordinal | ✅ | ✅ | ✅ Emagine, Thu 7:15 PM, C9–C10 |
| L3 `st_fcec7537` | + ordinal | ✅ | ❌ the extractor retracted the 15-mile limit; the planner still filtered ≤15 mi | ✅ Emagine, Thu 6:55 PM, F7–F8 |
| L4 `st_4e74ebd6` | `4c658f9` | ✅ | ✅ | ✅ Emagine, Thu 6:55 PM, F7–F8 |
| L5 `st_76ab7ae5` | `4c658f9` | ✅ | ❌ the 15-mile limit was retracted, so the conflict was raised again at the time stage | ❌ seat-stage loop (issue 3) |
| L6 `st_36d456d6` | `4c658f9` | ✅ | ✅ | ✅ Emagine, Thu 6:55 PM, F8–F9 |
| L7 `st_7ad8a4b6` | `578bc84` | ✅ | ✅ | ❌ seat-stage loop: "추천해 주시는 자리로" answered with a question 4× (issue 3) |
| L8 `st_680888ad` | `578bc84` | ✅ | ✅ | ✅ Emagine, Thu 6:55 PM, B1–B2 |
| L9 `st_6cb5406b` | `578bc84` | ✅ | ✅ | ✅ Emagine, Thu 6:55 PM, F7–F8 |
| **F1** `st_8816f14b` | **`28ede6b`** | ✅ | ✅ | ✅ Emagine, Thu 6:55 PM, B1–B2 |
| **F2** `st_e89d2cce` | **`28ede6b`** | ✅ | ✅ | ✅ Emagine, Thu 6:55 PM, B1–B2 |
| **F3** `st_4d79136d` | **`28ede6b`** | ✅ | ✅ | ✅ Emagine, Thu 6:55 PM, B1–B2 |

- **The card now does what it promises: 12 of 12 runs named the conflict at the theater stage.** No run booked a non-IMAX cinema without saying so, and no run offered another day. The sentence varied little: "IMAX는 MJR Troy Grand Digital Cinema 16에서만 가능하지만 20.4마일 떨어져 있어요. 가까운 곳에서 Standard 또는 3D로 볼까요, 아니면 Troy까지 가서 IMAX로 볼까요?"
- The extractor misread "첫 번째" in 2 of the first 6 runs (L3, L5). Both logged requests are replay cases now, and the final wording reads them correctly 9/9. On the final code, 3 of 3 runs relaxed IMAX, kept "15 miles", and booked.
- The conflict memory names both preference ids (`conflictMemory.preferenceIds`), and the panel drops the relaxed one. No dead end is recorded, because no `prev` happens. That is what the machinery does for a conflict resolved at its own stage.
- What is still rough, all pre-existing: the date stage asks to confirm "목요일" (issue 5). The seat line gets a question before a recommendation (issue 3), and it looped in L5 and L7. "B1–B2" is the second row of six, which a visitor may not count as "앞줄 말고". The demo log's heuristic `conflict.detected` event also fires on the planner's new `[conflict]` reason tag, so demo logs count those turns.
- **Cards A and C did not regress.** A (`st_361fb0b5`, `578bc84`) booked Cinema Detroit, Tue 9:30 PM (ends 11:28 PM), C4. C booked twice: `st_3ea62f48` (`4c658f9`) F5–F7 and `st_ff5667d8` (`578bc84`) E1–E3, both Wildwood at Emagine, Thu 1:15 PM. `28ede6b` changed only the booth extractor's relaxation line, which A and C never trigger, and they were not re-run on it.

#### Transcript F1 (final code, voice on)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 공저자랑 같이 목요일 밤에 스트리트 파이터를 IMAX로 보려고요. | IMAX 상영관만 보이도록 했어요. / IMAX 조건 때문에 2곳이 숨겨져 있어요. MJR Troy Grand Digital Cinema 16로 할까요? | select m1 → next → augment (3 labels, e.g. “MJR Troy Grand Digital Cinema 16 — IMAX, 3D Screens”) → filter amenities contains IMAX → augment (3 labels, e.g. “MJR Troy Grand Digital Cinema 16 — 20.4 miles — IMAX, 3D Screens”) | 8.3 / 13.7 |
| 2 | 15마일 넘게는 운전 안 할 거예요. | IMAX는 MJR Troy Grand Digital Cinema 16에서만 가능하지만 20.4마일 떨어져 있어요. 가까운 곳에서 Standard 또는 3D로 볼까요, 아니면 Troy까지 가서 IMAX로 볼까요? | augment (3 labels, e.g. “MJR Troy Grand Digital Cinema 16 — 20.4 miles — IMAX, 3D Screens”) | 6.0 / 6.0 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | 15마일 이내 상영관만 보이도록 했어요. / 15마일 조건 때문에 1곳이 숨겨져 있어요. 어느 상영관으로 할까요? | clearModification filter → filter distanceMiles lte 15 | 4.9 / 8.2 |
| 4 | 첫 번째 걸로 할게요. *(follow-up)* | 목요일로 할까요? / 목요일로 할까요? | select t4 → next → highlight 05 | 7.0 / 9.1 |
| 5 | 네, 좋아요. *(follow-up)* | 저녁 시간대만 보고 있어요. / 저녁 시간대 조건으로 4개가 숨겨져 있어요. 어떤 시간으로 할까요? | select 2026-11-05 → next → augment (8 labels, e.g. “10:00 PM — 3D”) → filter time gte 18:00 | 9.8 / 12.7 |
| 6 | 6시 반 이후에 시작해서 11시까지는 끝나야 해요. | 4개가 저녁 시간대 조건으로 숨겨져 있고, 종료 시간 조건으로 맞지 않는 상영도 제외했어요. / 6개가 저녁 시간대 조건으로 숨겨져 있어요. 어떤 시간으로 할까요? | augment (4 labels, e.g. “10:00 PM–12:04 AM — 3D”) → augment (4 labels, e.g. “10:00 PM–12:04 AM — 3D”) → filter endTime lte 23:00 | 8.7 / 15.6 |
| 7 | 첫 번째 걸로 할게요. *(follow-up)* | 어느 붙어 있는 두 좌석으로 할까요? | select s_m1_t4_20261105_1855_s1 → next | 7.6 / 7.6 |
| 8 | 두 자리 붙어서요. 앞줄은 말고요. | 어느 두 좌석으로 할까요? / 어느 두 좌석으로 할까요? | highlight B1, B2, B3, B4 | 4.6 / 7.7 |
| 9 | 추천해 주시는 자리로 할게요. *(follow-up)* | 추천 좌석으로 B1, B2를 선택했어요. / Street Fighter를 Emagine Royal Oak에서 11월 5일 6:55 PM에 B1, B2 좌석으로 예매할까요? | selectMultiple B1, B2 → next | 2.9 / 10.0 |
| 10 | 네, 좋아요. *(follow-up)* | — | next → **booked** | — / 2.9 |

The other two final-code runs are in the appendix (F2, F3).

## Card C: 가족 낮 상영

**Expected:** nothing blocks. Films are filtered to PG or under and re-sorted by runtime, a showing on Thu 5 Nov ends by 5 PM, and the party gets three adjacent seats.

| Run | Mode | Trace | Outcome |
|---|---|---|---|
| C1v | voice | `demo-st_3a7e79b6…-20261024-102843` | ✅ PG filter (5 → 2) and duration sort. Then "첫 번째 걸로 할게요." got **nothing: 90 s of silence.** The planner chose `respond` with an empty message, and under spoken brevity that is no speech, no tool, and no retry. |
| C2v | voice | `demo-st_7c0018369…-20261024-103106` | Reached confirm: Wildwood, Emagine Royal Oak, Thu 1:15 PM (ends 3:01 PM), E1–E3, $63. At the movie stage it highlighted PG films instead of filtering. At the seat stage it **highlighted E1–E4 (four seats) for a party of three**, then selected E1–E3. Stopped one "네" short because the driver's follow-up cap was then 6. |
| C3t | text | `demo-st_43257afd…-20261024-103328` | Reached confirm: Wildwood, Emagine, Thu 1:15 PM, **B1–B3** (second row of six), $45. The time stage filtered `endTime ≤ 17:00`. It stopped at the confirm question for the same cap reason. |
| C4v | voice | `demo-st_ba3b0c5d…-20261024-104309` | ✅ **Booked:** Wildwood, Emagine Royal Oak, Thu 5 Nov 1:15 PM (ends 3:01 PM), E1–E3, $63. It filtered to PG *and* highlighted both survivors, sorted by runtime, and filtered `endTime ≤ 17:00` before selecting 1:15 PM itself ("1:15 PM 상영만 오후 5시 전에 끝나서 선택했어요."). Seats: "어느 줄이 좋으세요?" to the card line. After "추천해 주시는 자리로 할게요" it marked E1–E3 (right size) and then asked "어느 줄로 할까요?" in the same turn. This was the run made with the committed driver to check that it reproduces. |

- **Runtime sort:** 4/4. **PG filter:** 2/4; the other two highlighted Aang and Wildwood but left all five films on screen. Either way, the card's "PG 이하로 걸러진다" is only half true as shown.
- After "짧을수록 좋아요" the planner asks which film rather than selecting the shorter one. That is by design: a soft preference does not decide. Only C3t suggested Wildwood ("Wildwood가 더 짧은 상영 시간 선호에 맞아요. Wildwood로 할까요?").
- **5 PM end time:** correct whenever it was applied (C2v, C3t, C4v). Only 1:15 PM survives at Emagine.
- **Seats:** "세 자리 붙어서요. 앞줄은 말고요." never produced a highlight on its own (4/4), because there are too many qualifying blocks. A highlight came only after the driver said "추천해 주시는 자리로 할게요". Once it was the wrong size (4 seats), once it was row B of A–F (which a visitor may not count as "앞줄 말고"), and once it was right (E1–E3) but was followed straight away by "어느 줄로 할까요?".
- The memory panel was in **Korean** in all C runs ("목요일 오후에 영화를 보고 싶습니다." …) and in English in all A/B runs.

### Representative transcript: C2v (voice on)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 목요일 오후에 아이 둘 데리고 영화 보러 가려고요. | 아이들과 보기 좋은 영화 중 어느 쪽으로 할까요? / 어느 쪽을 보고 싶으세요? | augment (5 labels, e.g. “The Legend of Aang: The Last Airbender — Family, PG”) → highlight m4, m3 | 3.3 / 8.8 |
| 2 | PG 이하여야 하고, 짧을수록 좋아요. | 둘 다 조건에 맞아요. 어느 쪽으로 할까요? / 어느 쪽으로 할까요? | augment (5 labels, e.g. “The Legend of Aang: The Last Airbender — Family, PG, 1h 52m”) → sort duration asc | 3.6 / 8.9 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | 어느 극장으로 할까요? | select m3 → next | 2.8 / 5.9 |
| 4 | 첫 번째 걸로 할게요. *(follow-up)* | 목요일인 Nov 5 (Thu)로 할까요? / Nov 5 (Thu)로 할까요? | select t4 → next → highlight 2026-11-05 | 2.2 / 10.7 |
| 5 | 네, 좋아요. *(follow-up)* | 오후 상영이 모두 가능해요. 어느 시간으로 할까요? | select 2026-11-05 → next → augment (5 labels, e.g. “1:15 PM · 오후”) | 2.2 / 8.2 |
| 6 | 비행기 때문에 5시까지는 나와야 해요. | 1:15 PM 상영으로 할까요? | augment (5 labels, e.g. “1:15 PM · 오후 · 3:01 PM 종료”) → highlight s_m3_t4_20261105_1315_s3 | 4.1 / 7.9 |
| 7 | 네, 좋아요. *(follow-up)* | 어느 좌석으로 할까요? | select s_m3_t4_20261105_1315_s3 → next | 2.4 / 6.3 |
| 8 | 세 자리 붙어서요. 앞줄은 말고요. | 앞줄을 제외하고 붙어 있는 세 자리 중 어느 쪽이 좋으세요? | — | 4.1 / 4.1 |
| 9 | 추천해 주시는 자리로 할게요. *(follow-up)* | 추천 좌석을 표시했어요. / 표시된 추천 좌석으로 할까요? | highlight E1, E2, E3, E4 | 4.8 / 7.0 |
| 10 | 네, 좋아요. *(follow-up)* | Wildwood, Emagine Royal Oak, 2026-11-05 1:15 PM, E1~E3 좌석으로 총 $63예요. 예약을 확정할까요? | selectMultiple E1, E2, E3 → next | 2.7 / 6.3 |

## Quick cards 1–5

All quick-card runs were voice on, from `/demo/card#c=<id>&k=<code>&lang=ko`. At the time a quick card never sent `spokenBrevity` (`plannerWritesForTheEar` excluded `quickStartCard`; changed in Round 2 below), so it narrated every step. That is why these settle times are long.

| Card | Visitor line (ko) | Printed "watch" | Observed (run 1 / run 2) | First action / settle |
|---|---|---|---|---|
| 1 영화 | 여덟 살 조카랑 같이 왔어요. 무서운 건 안 돼요. | 영화 다섯 편이 두 편으로 줄고, 남은 영화에 연령 등급이 붙습니다. | ✅ The agent augments genre and rating on all 5, then filters `ageRating eq PG`, leaving Aang and Wildwood. It speaks 3 sentences ("…다섯 작품 모두에 장르와 관람등급을 추가했어요." / "…세 작품을 숨겼어요." / "…어느 작품으로 할까요?"). A voice-off control run did the same plus a redundant highlight of both survivors. | 4.6 s / 19.7 s |
| 2 영화관 | 15마일 넘게는 운전 안 할 거고, 주차비도 내기 싫어요. | 영화관 두 곳이 빠지고, 남은 곳은 거리순으로 재정렬되며 거리가 표시됩니다. | ⚠️ Augments "— 13.8 miles, Free Parking", filters `distanceMiles ≤ 15`, then `amenities contains Free Parking`, leaving Redford, Emagine and Bel Air. **No sort in either run**: the list reads 13.8, 14.2, 9 miles. 4 sentences. | 3.6 s / 23.1 s · 3.7 s / 18.3 s |
| 3 날짜 | 주말이어야 해요. | 달력의 여섯 날 중 두 날만 남습니다. | ⚠️ `highlight` on 7 and 8 Nov, "주말 조건에 맞는 날짜 2개를 강조했어요. 어느 날로 할까요?". **All six days stay visible** (2/2). | 2.9 s / 8.2 s · 2.8 s / 7.3 s |
| 4 상영 시간 | 8시 전은 안 되고, 11시까지는 나와야 해요. | 상영 시간 열여섯 개가 세 개로 줄고, 옆에 종료 시각이 표시됩니다. | ✅ Augments "10:50 AM · 종료 12:54 PM" on all 16, filters `time ≥ 20:00` and then `endTime ≤ 23:00`, leaving 3 showtimes. It then **highlights all three remaining**, breaking its own contrast test. Two rows read "8:10 PM · 종료 10:14 PM" because IMAX and 3D are not labelled. **5 sentences, 41.5 s and 42.1 s.** | 5.1 s / 41.5 s · 5.4 s / 42.1 s |
| 5 좌석 | 두 자리 붙어서, 뒤쪽으로요. 앞줄은 말고요. | 조건에 맞는 자리 쌍이 보고 있던 좌석표 위에서 그대로 강조됩니다. | ❌ **No highlight** in either run: "뒤쪽에서 붙어 있는 두 좌석 조합이 여러 개예요. 어느 줄로 할까요?" / "…E열인가요, F열인가요?". Seven pairs qualify, and Highlight economy allows at most 3. | 3.3 s / 3.3 s (both) |

The card pages render in Korean with the right line and watch text. Each card page also says "휴대폰이 마이크 권한을 물어봅니다. **주변이 시끄러우면 타이핑으로 하셔도 됩니다.**" I checked this on `/demo/card#c=movie`: after the voice toggle is switched off, the textarea is still `readOnly` with the placeholder "마이크를 눌러 말하세요", so there is nothing to type into.

## Cross-cutting observations

- **English on a Korean screen.**
  - Agent speech: dates are spoken as "Nov 5 (Thu)", times as "9:30 PM", distances as "2.5 miles예요", and the confirm read-back uses the ISO date "2026-11-05 1:15 PM". The planner prompt asks for these to be kept as on screen (`llmPlanner.ts:493`), so this is by design. Realtime will read them in English inside a Korean sentence.
  - GUI chrome is untranslated: "Select Theater", "SELECT MOVIE", "Conversation · Hide", "Agent"/"You", "Booking Complete · Your booking has been confirmed".
  - Augment labels switch between "ends 5:58 PM" and "3:01 PM 종료" from run to run.
  - The voice-off fallback sentence `I will run select next. Reason: …` was sent 6–9 times per text-mode run. It never occurs with voice on.
- **Film names:** no mis-rendering. "클라라와 태양" resolved to Klara and the Sun and "스트리트 파이터" to Street Fighter, first time, in every run.
- **Latency:** the first visible GUI action came 1.9–5.4 s after the visitor finished, and the first spoken sentence 2.5–9.4 s after. Full-card turns settled within 3–13 s. Quick cards took 7–41 s to settle because of the verbose narration. There were no crashes and no 15 s planner stalls. The one stall (C1v) was silence by choice, not latency.
- **Repeat loops:** the same sentence came back 3–4 times in A1 (theater), A3v (seat), B4v (theater, then date) and B2t/B3v (dead end).
- **Concurrency:** two runs failed to start with "Demo is at capacity". Sessions whose tab closes without finishing stay active for `DEMO_SESSION_IDLE_TIMEOUT_MS` (15 min) and count toward `DEMO_MAX_CONCURRENT_SESSIONS=10`. At a booth this means abandoned kiosks and phones eat capacity for 15 minutes. The driver now calls `/study/sessions/finish` at the end of every run.

## Issues, ranked by harm to a live Korean demo

| # | Issue | Where seen | Harm |
|---|---|---|---|
| 1 | **Card B's dead end is handled wrong.** The conflict is not detected at the theater stage. The fallback is "change the date", which contradicts 목요일 and cannot help. Dropping IMAX or widening the distance is never offered. | B2t, B3v, B4v (3/3) | **Critical.** B is the card that shows conflict handling, and it currently shows the opposite. |
| 2 | **No typing fallback.** The composer is read-only with voice on or off; the quick card promises "타이핑으로 하셔도 됩니다". | verified on `/demo/card` with voice off | **High.** A poster hall is loud. If the mic fails or is denied, there is no way in. |
| 3 | **Seat highlights blocked by the Highlight-economy ceiling (≤3).** Quick card 5 lights nothing. Card A/C seat lines usually get a question instead of marks; when a mark appears it is the wrong size (E1–E4 for three) or is announced as "선택했어요". | Q5 2/2, A3v, C1v–C4v | **High.** Card 5's whole "watch" claim fails, and A/C end in "좌석 번호를 말씀해 주세요" loops. |
| 4 | **Silent `respond`.** An empty message under spoken brevity produces no speech, no action and no retry. | C1v (90 s) | **High** when it happens: the visitor stands in silence. Seen in 1 of 7 voice full-card runs. |
| 5 | **Redundant date confirmation (`[ask-remembered]`).** The visitor's opening line has scrolled out of the 8–12-entry history by the date stage, so a `pref_…` preference the visitor stated is treated as "remembered". | every full run that reached the date stage (10/10) | **Medium.** One extra yes per card, and the visitor wonders "I just said 오늘". |
| 6 | **Ordinal or delegating answers handled inconsistently.** "첫 번째 걸로" is sometimes selected, sometimes confirmed ("…을 말씀하신 건가요?"), refused 3×, or met with silence. "추천해 주세요" sometimes recommends and sometimes asks again. | A3v, B2t, B3v, B4v, C1v | **Medium.** These are the most natural Korean shortcuts at a booth. |
| 7 | **Quick cards narrate every step:** 19–42 s to settle, 3–5 sentences each. | Q1, Q2, Q4 | **Medium.** The quick cards exist for 90-second visitors. |
| 8 | **Quick cards 2 and 3 only partly match their "watch" lines:** no distance sort (2), and highlight instead of 6 → 2 (3). Quick card 4 shows two identical "8:10 PM" rows. | Q2 2/2, Q3 2/2, Q4 | **Medium.** The presenter says one thing and the screen does another. |
| 9 | **Memory panel language is unstable:** English for A/B, Korean for C. | all runs | **Low–medium.** Card A promises the side panel. |
| 10 | **English inside Korean speech and GUI** (dates, "miles", ISO date at confirm, untranslated chrome). | all runs | **Low.** Understandable, but it reads unfinished to a Korean audience. |
| 11 | **Invented threshold** for "다운타운에서 가까운 곳" (filter ≤9 mi). | A1 (1/4) | **Low.** Corrected by the next card line. |
| 12 | **Abandoned sessions hold demo capacity** for 15 min. | runs B1v, A4t/C3t first attempt | **Low** at KSEA scale; worth knowing. |

## Concrete fixes (not implemented; for dispatch)

1. **B dead end.** *Implemented (booth only) and measured on 24 Oct; see "Card B after the fix".*
   - `apps/tuning-agent/src/llm/llmExtractor.ts`: a format requirement (IMAX, 3D, Dolby) should also be relevant to `theater`, since `amenities` carries it.
   - `apps/tuning-agent/src/core/planner.ts`: `priorStageAlternativeCounts` should apply every hard preference relevant to a stage, not only those with a filter binding, so "목요일" makes the date count 0.
   - `apps/tuning-agent/src/llm/llmPlanner.ts` (CP_MEMORY_PROMPT_RULES, Dead-end handling, around lines 353–368): when the blocking requirement is satisfiable only where another hard requirement excludes it, name both requirements and ask which to relax instead of proposing a backtrack.
   - Add a `card-b` case to a regress script (pattern: `decisiveSelection.regress.ts`).
2. **Typing fallback.**
   - `apps/frontend/src/components/chat/ChatInput.tsx`: make `isVoiceComposer` depend on `voiceModeEnabled`, not only on `voiceModeAvailable`, so turning the mic off gives a typable box.
   - Alternatively, if that is unwanted, drop the "타이핑" sentence from `quickCardMicNote` in `apps/frontend/src/i18n/strings.ts`.
3. **Seat highlights.** *Implemented (booth only, second option) and measured on 24 Oct; see "Round 2" below.* Either:
   - change the cards: quick card 5 should name a row ("뒤쪽 E열로 두 자리요"), and A/C should delegate explicitly ("가운데쯤 한 자리 골라 주세요"); or
   - `llmPlanner.ts` (Highlight economy plus DECISIVE_SELECTION_RULES): when the visitor delegates ("추천", "골라 주세요"), mark one whole choice of the stated party size and say "추천해 드린 자리" rather than "선택했어요".
   - In both cases, fix the four-seat highlight: Highlight economy already says to mark a choice whole and of the party size, so add a regress case for three-seat parties.
4. **Silent respond.** *Implemented (booth only) and measured on 24 Oct; see "Round 2" below.* `apps/tuning-agent/src/index.ts` (around line 1618, `maybeSendAssistantMessage`): a `respond` with empty text is never a valid end of turn. Re-plan once, or fall back to the stage question in the session language.
5. **`[ask-remembered]` scope.** *Implemented (booth only) and measured on 24 Oct; see "Round 2" below.* `llmPlanner.ts:697`: limit rule (6) to `prf_` (preloaded) ids. A `pref_` id was extracted from this session's speech, so it counts as stated even after it scrolls out of history (`MAX_HISTORY_ENTRIES = 12`, `RECENT_WINDOW = 8` in `core/planner.ts`).
6. **Ordinals.** `llmPlanner.ts` DECISIVE_SELECTION_RULES (1): list a positional reference to a visible list ("첫 번째", "맨 위", "the first one") as a named option.
7. **Quick-card verbosity.** *Implemented (booth only, voice on) and measured on 24 Oct; see "Round 2" below.* `apps/frontend/src/pages/ChatPage.tsx:799`: consider letting a quick card send `spokenBrevity` too, or cap quick-card narration to the final sentence through `QUICK_CARD_VOICE_VERBOSITY`. Measure the change with `spokenBrevity.regress.ts`.
8. **Quick cards 2–4.**
   - `apps/frontend/src/study/quickDemoCards.ts`: reword the `watch` lines to match what the planner does, so card 2 drops "거리순 재정렬" and card 3 says "주말 두 날이 강조됩니다". Alternatively add "가까운 순으로" to card 2's line so a sort is asked for.
   - For card 4, include the format in time labels (augment) so the two 8:10 rows differ.
9. **Memory language.** *Implemented (booth only) and measured on 24 Oct; see "Round 2" below.* `llmExtractor.ts`: pass the conversation language and write `description` in it (the panel already takes it verbatim).
10. **Capacity.** `apps/backend/src/study/sessionService.ts`: finish a demo session when its last host socket closes, or shorten the idle timeout for demo sessions.

### Round 2: silence, memory language, quick-card brevity (24 Oct 2026)

Fixes 4, 7 and 9 are implemented on branch `worktree-agent-a67b0a5099e119ca9`, on top of `realtime-voice` @ `7989a44` (which includes the card-B fix). The commits are `203a0d6` (memory language), `44084b7` (silent respond), `1229bae` (quick-card brevity) and `1ec6a31` (drop a respond that repeats the sentence just spoken, found while measuring fix 7). Every change is behind the booth flag: `AGENT_STUDY_MODE=demo` on the agent, and on the frontend `normalizeStudyMode(...) === DEMO_STUDY_MODE`, which `plannerWritesForTheEar` already required. A study session's planner input, extractor prompt and runtime loop are unchanged. `extractorPrompt.check.ts` pins every study extractor prompt by hash, and `plannerPrompt.check.ts` still passes. The planner prompt files were not touched.

**How these runs were made.** I used an isolated stack from the worktree: backend :3200 with `NODE_ENV=development`, so the agent ran from `src`, and Vite :5373. The access code was from batch `r2b`. Every run used `--voice`. Settle time is the driver's `secondsToSettle`, the time from the visitor's line to the agent's last frame. It includes playback of every sentence except the last. The "before" quick-card runs were made in this session on `7989a44`, not taken from the table above. They differ from it because quick card 2's printed line now ends "가까운 순으로 보여 주세요". Traces are in the worktree's `logs/demo/trace/` (gitignored). The quick cards have no trace.

#### Fix 4: an empty respond never ends the visitor's turn

- **What changed.** The change is in `apps/tuning-agent/src/core/emptyRespond.ts`, called from `maybePlanAndExecute`. It applies when the visitor has spoken and nothing has been said to them since (`userTurnAwaitingAnswer`), and the planner returns a `respond` with empty text. The agent then plans once more, with a runtime note appended to history: a `system` entry whose annotation says the previous answer was empty and is never a valid end of turn. If the second answer is empty too, the agent says the stage's question in the session language, for example "어떤 영화를 보고 싶으세요?". It never uses the English "I will run…" sentence.
- **When it is left alone.** An empty respond after the visitor already heard something this turn stays as it is: the question was asked on an earlier step, and asking again would repeat it. Rule-sourced decisions also stay as they are.
- **Offline check.** `core/emptyRespond.check.ts` (in `npm run check`) drives the re-plan and fallback paths with a stub planner, using the C1v history. It also checks that the note does not stop the visitor's utterance from opening the chain, which `chainOpenedByUserUtterance` uses to keep `select` available.
- **How rare the failure is.** The 50 booth traces of 24 Oct hold **1 empty respond in 345 responds** (C1v planner-8).
- **Replaying it.** `llm/emptyRespond.regress.ts` replays that request. The logged body, byte for byte with the prompt that failed (`--raw`), came back `select m3` in **15 of 15** runs, and also 15 of 15 with the note added. Today's prompt, which has the ordinal rule (fix 6), did the same in 6 of 6 runs with and without the note. The C1v empty answer does not reproduce. It was a one-off from a stochastic model.
- **Card C, 3 runs, `1229bae`.** All three booked Wildwood, Emagine Royal Oak, Thu 5 Nov 1:15 PM, E1–E3, $63: `st_97cfa705`, `st_d28f3b05`, `st_d4178fb7`. **No turn ended silent.** Every turn up to the confirm question got speech (first sentence after 2.8–15.6 s). The last turn is the confirming "네, 좋아요", which ends the booking without a sentence, as designed. The planner returned 0 empty responds in 33. "첫 번째 걸로 할게요." at the movie stage was selected (`select m3 → next`) in 3 of 3 runs. So the guard never fired on its own.
- **Fault injection, to exercise the guard live.** I made a temporary edit, not committed and reverted afterwards: it forced the planner's answer to "첫 번째…" lines to be an empty respond.
  - Forcing only the first answer (`st_8befee68`) led to 9 re-plans in the run, at the movie, theater, date, time and seat stages. **All 9 re-plans gave a valid step**: 6 silent `select`/`next` steps, one highlight with a question, and two respond questions. The run booked.
  - Forcing both answers (`st_91b0bcec`) led to 8 fallbacks. Each spoke "어떤 영화를 보고 싶으세요?" 0.9–1.2 s after the line and finished playing before the next turn. No turn stalled.
  - At the movie stage that question repeats one already asked. It is a last resort, and it is still better than silence.
- **The 15 s playback watchdog.** The 15 s watchdog is the agent's speech barrier (`TTS_PLAYBACK_TIMEOUT_MS`). The frontend's own speak watchdogs are 30 s for Realtime and 12 s for the companion. None of them interacts with this path:
  - A barrier credit is taken only when the host accepts an `agent.message`. An empty respond sends nothing, so there was nothing to wait for. The 90 s in C1v was the driver's turn timeout, not a watchdog.
  - The re-plan happens before anything is sent, so it costs only one planner call (about 2–3 s).
  - The fallback is an ordinary `agent.message`. Its credit was released by `tts.playback.complete` in every injected turn, so no watchdog timed out.

#### Fix 9: the memory panel in the session language

- **What changed.** In a booth session the extractor prompt now gives Korean the same language line the post-study languages have: "Write every new or rewritten description in Korean", plus "The examples above are in English; write yours in Korean anyway." Film titles, cinema names, formats, seat ids, dates, times and prices are kept exactly as on screen.
- **Study sessions.** Korean adds nothing there, as before. The planner already received `language` in every session, and the extractor received it too: Korean simply had no line. So no study prompt changes in any language, and `extractorPrompt.check.ts` asserts that with hashes taken before the change. English booth sessions are also unchanged.
- **Live runs, Korean.** Every chip was in Korean:

  | Run | Commit | Chips in Korean | Outcome |
  |---|---|---|---|
  | Card A `st_1c15f15e` | `1ec6a31` | 9/9 ("Klara and the Sun을 보고 싶어 합니다.", "15마일 이내의 극장만 원합니다." …) | Booked Cinema Detroit, Tue 3 Nov 9:30 PM, C4 |
  | Card C × 3 | `1229bae` | 7/7 in each run | Booked (see fix 4) |
  | Quick cards, the 12 runs below | — | all of them | — |

  Before the change, quick card 1 and quick card 4 had written English chips in this session ("Wants a movie appropriate for an eight-year-old child…"), and quick card 2 Korean ones.
- **Output shape (`llm/extractorLanguage.regress.ts`).** This replays the 18 extractor requests logged in A2v and C2v, 2 runs each with the old booth prompt and 2 with the new one:
  - New descriptions in Korean: **10/32 before, 32/32 after.**
  - Existing preference ids dropped: 0 before, 0 after.
  - Output shape (count, kept ids, strengths, relevantStages): before against before agreed 18 of 18 pairs, and before against after 68 of 72.
  - All four disagreements come from one request, C's opener "목요일 오후에 아이 둘 데리고 영화 보러 가려고요." Before, it read as "Needs tickets for two children." with stage `seat` (both runs). After, it read as "아이 둘과 함께 볼 수 있는 영화를 원합니다." with stage `movie` (both runs). The Korean wording leads the model to a different but defensible reading, and the second card line makes the PG requirement explicit anyway.
- **`preferenceIds` coverage on planner actions** did not drop:
  - Before (A2v, A3v, C1v, C2v, C4v): filter 6/6, highlight 10/10.
  - After (the 3 C runs and A): filter 5/5, highlight 12/13.
  - The one miss is a degenerate model output in C3's seat turn. That highlight's `itemIds` turned into garbage tokens after six seat ids. It has nothing to do with the extractor; see "Still open".

#### Fix 7: quick cards write for the ear

- **What changed.** With voice on, a quick card now sends `spokenBrevity` and drops `narrateAdaptations` (`ChatPage.tsx`, `plannerWritesForTheEar`). The planner drops brevity whenever narration is on, so sending both would do nothing. With voice off, a card narrates as before.
- **Why not the other option.** Capping narration through `QUICK_CARD_VOICE_VERBOSITY` (silencing `nav`, `select` and `view`) was rejected. The gate silences by the tool a sentence rides on, and under narration the question often rides on a GUI step. Quick card 3 ends on a highlight carrying "…어느 날로 할까요?", so the cap would have made that card silent.
- **Why the watch line survives.** Under brevity the demo rules put the hidden count into the closing sentence, which is the card's "watch" line.
- **Second commit.** The first brevity runs spoke the closing sentence twice: quick card 1 repeated "3개는 PG 조건 때문에 숨겨져 있어요. 둘 중 어떤 영화를 볼까요?" from the highlight step. `1ec6a31` drops a respond that repeats, word for word, a sentence already spoken this turn (booth only). That makes the last column.

| Quick card | Before (`7989a44`): settle s / sentences | Brevity (`1229bae`) | Brevity + repeat drop (`1ec6a31`) |
|---|---|---|---|
| 1 영화 | 25.8 / 6 · 17.1 / 4 | 14.4 / 5 · 9.9 / 3 | **11.5 / 3 · 5.9 / 2** |
| 2 영화관 | 31.8 / 6 · 35.4 / 7 | 17.0 / 4 · 16.8 / 3 | **11.5 / 2 · 16.4 / 2** |
| 4 상영 시간 | 27.8 / 5 · 29.3 / 4 | 20.9 / 4 · 20.2 / 3 | **10.6 / 2 · 14.0 / 2** |

- **Settle time and length.** Settle time fell from 17–35 s to 6–16 s, and the spoken part from 4–7 sentences to 2–3. The tools are the same: augment, then filter(s), then sort or highlight.
- **The watch line.** The closing sentence states what was hidden in 11 of 12 brevity runs, for example "15마일 이내와 무료 주차 조건 때문에 2곳이 숨겨져 있어요. 어느 극장으로 할까요?" and "13개 상영은 오후 8시 이후 시작 및 오후 11시 종료 조건 때문에 숨겨져 있어요." The miss was quick card 1, run 1 of `1ec6a31`: "둘 다 조건에 맞아요. 어느 쪽으로 할까요?" never said that three films were hidden.
- **Quick card 2's sort.** 2 of 4 runs mention the sort aloud ("…가까운 순으로 정렬했어요"), and it happens on screen in all 4.
- **The cost.** The first sentence now comes later: after 5.6–14.0 s, against 3.5–5.3 s before. The visitor watches the list change in silence and then hears one sentence, where before each step was narrated as it happened. Speech/GUI sync (`speechSyncEnabled`) no longer holds anything, because the GUI steps have no sentence to wait for.
- **The regression harness.** `spokenBrevity.regress.ts` does not apply. It replays recorded study turns with narration off, and quick cards are never recorded. The brevity section it measures is unchanged; this change only lets a new kind of session reach it.

#### Still open after Round 2

- **A degenerate planner output.** In C3 (`st_d4178fb7`) the seat-stage highlight's `itemIds` and reason dissolved into garbage tokens. Nothing visible broke: the turn spoke a normal question, and the run booked. The model may still do it in the booth (`gpt-5.6-terra`), and nothing in the validator caught it.
- **Near-duplicate questions.** Exact repeats are now dropped. Near-repeats are not, such as "C4로 할까요?" right after "가운데쯤인 C4로 할까요?", or "목요일로 할까요?" right after "…이 날짜로 할까요?".
- **The fallback question.** It is the stage's generic question, so in the rare case it fires it can repeat a question already asked. It fired only under fault injection. Its ja, zh-Hans, zh-Hant, de, fr and es wordings are machine-drafted.

### Round 2: opening questions, remembered scope, seats (24 Oct 2026)

Three more booth-only planner changes, on branch `worktree-agent-af0d7b5c002895fec` on top of `realtime-voice` @ `7989a44`. Each is a demo-gated prompt section or flag. A study session's prompt is byte-identical; `plannerPrompt.check.ts` asserts that for every study configuration, and it now also pins the three booth sections by content hash.

| Change | Where | Gate |
|---|---|---|
| **Opening questions.** On entering a stage that nothing in memory or history bears on yet, ask ONE spoken question that invites a preference the stage's fields can act on, instead of "which one?". | `STAGE_OPENING_RULES` (`llmPlanner.ts`) | `openingQuestions` (demo only) |
| **Remembered scope (fix 5).** Rule (6) `[ask-remembered]` now covers `prf_` (profile-seeded) ids only. A `pref_` id was extracted from this session's speech, so it counts as said even after it scrolls out of history. A stated day is (1) `[named-option]` at the date stage, including on entry. To let the agent act on that, `select` is offered at the date stage's entry when memory holds a hard `pref_` date preference (`keepSelectAtDateEntry`, `core/planner.ts`). | `DECISIVE_SELECTION_RULES` (6), `getPlannerToolSchema` | demo only |
| **Seats (fix 3).** With a party size and a position, the agent marks up to three whole choices of exactly that size and asks which one. When the visitor delegates, it selects one whole choice and says it is a recommendation. If no party size has been given, it asks once and then books one seat. The ≤3-choices ceiling is kept; only the ban on choosing which qualifying choices to mark is lifted, and only at the seat stage. | `SEAT_CHOICE_RULES` (`llmPlanner.ts`) | `seatChoices` (demo only, GUI on) |

I checked the id prefixes in code before relying on them. The extractor mints ids through `createPreferenceId()` → `pref_…` (`core/cpMemory.ts`) and keeps an echoed id, so a restated profile preference stays `prf_`. A profile seeds `PROFILE_PREFERENCE_ID_PREFIX = 'prf_'`, and `memory.hasProfilePreferences()` already keys on that prefix.

**How these were measured.** The stack was isolated and ran from the worktree (backend :3100 with `NODE_ENV=development`, so the agent ran from `src`; Vite :5273). Every run used `--voice` and access-code batch `r2a`, with planner `gpt-5.6-terra`. "Before" means the same stack on `7989a44`, run before any source edit. The driver gained a walk-through card `W`: a visitor with nothing in mind answers each stage with "상관없어요, 첫 번째 걸로 할게요." ("No preference, the first one is fine."), and on the seat map with "상관없어요, 추천해 주시는 자리로 할게요.". It also gained a follow-up for preference questions: "no preference" plus a pick, instead of a yes that answers nothing. The prompt was revised three times during the runs, so each row below says which text it ran on. "Final" is the committed text.

#### 1. Opening questions

What the agent said on entering each stage in the walk-through, with no preset memory:

| Stage | Before (ko) | After (ko, final, `st_b677d179`) | Before (en) | After (en, `st_909ec15a`) |
|---|---|---|---|---|
| movie | 어떤 영화를 보고 싶으세요? | 장르나 관람등급, 러닝타임 중에 중요하게 보는 게 있으세요? | What kind of movie are you in the mood for? | Anything you care about, like genre, age rating, or how long it runs? |
| theater | 어느 극장에서 보실까요? | 얼마나 멀리까지 괜찮으세요? 주차나 리클라이너 좌석도 중요하면 말씀해 주세요. | Which theater would you like? | How far are you willing to go? Tell me if parking or recliners matter. |
| date | 어느 날짜로 보실까요? | 평일이 좋으세요, 주말이 좋으세요? | Which day works for you? | A weekday, or the weekend? |
| time | 어느 시간으로 보실까요? | 몇 시쯤 시작하거나 끝나면 좋으세요? | Which showtime would you like? | Roughly when should it start, or be over by? |
| seat | 어느 좌석으로 하실까요? | 몇 분이시고, 앞쪽과 뒤쪽 중 어디가 좋으세요? | Which seat would you like? | How many of you, and do you like it nearer the front or the back? |

- **Walk-throughs:** before, 9 of 10 stage openers asked "which one?". The tenth was the English movie opener, "what kind of movie". After, 20 of 20 openers across 4 walks (2 ko, 2 en) asked one preference question naming two or three of the stage's real fields. None listed every field.
- **English wording:** English sessions use the prompt's example sentences almost word for word. Korean sessions paraphrase them.
- **Position words:** the minimal answer "상관없어요, 첫 번째 걸로 할게요" selected the first visible option 16 of 16 times. That includes the answer to "평일이 좋으세요, 주말이 좋으세요?", where it picked the first date, not "weekday". The position-word rule from `4c658f9` did not misfire in any Round 2 run.
- **Cards A and C:** the opening question never took a turn that a card line should have had.
  - In all 8 after-runs (A ×4, C ×4), every one of the 32 card lines was acted on (select, augment, filter, sort or highlight). None was answered with an opening question.
  - The question fired only where nothing applied: the session start, C's theater stage (4/4), and the seat stage before the seat line (8/8). The seat line then answered it.
  - Turn counts went down: card A from 8 to 7 (in the 3 runs after the first text), card C from 11 to 8 (4 of 4). Most of the saving comes from change 2.
- **Where it still fires with a preference in memory:**
  - At card A's time stage, "Wants to see it tonight" is in memory, and the agent asked "몇 시쯤 시작하면 좋을까요?" in 4 of 4 runs. Before the change it asked "어느 시간으로 할까요?". That preference narrows nothing at that stage, so the question works as rule (4)'s narrowing question, and the next card line answers it. Strictly, it breaks the "never where a preference applies" rule.
  - One early run (`st_47bba7dc`, first text) added "주차나 리클라이너 좌석도 중요하세요?" after applying the 15-mile filter. The final text restricts the section to the turn that enters the stage, and this did not recur in the 7 later card runs.

#### 2. Remembered scope: the date stage

**Replay** (`apps/tuning-agent/src/llm/statedDay.regress.ts`, real API calls). The input is the first planner call at the date stage of every 24 Oct trace in the main checkout that had a hard date preference: 10 sessions, 3 runs each. BEFORE ran the same harness from a `git archive` of `7989a44`. `prf-control` is the same request with the date preference's id renamed to `prf_…`, which must still be asked about.

| Side | Stated day (`pref_`) | `prf-control` |
|---|---|---|
| BEFORE (`7989a44`) | **confirm-q 29/30**, statement 1 | confirm-q 30/30 |
| AFTER, prompt only (`--no-widen`) | confirm-q 4, statement 26, commit 0 | confirm-q 30/30 |
| AFTER, final (prompt + select at date entry) | **commit 25/30, all on the named day**; statement 5; confirm-q 0 | confirm-q 29/30, statement 1 |

- The prompt alone stops the question, but the agent can then only state the day, and the visitor still has to say something to move on. Offering `select` at entry is what saves the turn.
- In the remaining 5 of 30, it marks the day and states it ("오늘은 Nov 3 (Tue)예요.").
- Three wordings were tried. The first gave commit 8/30. The second added "not highlight" (23/30), and the final one added the explicit `prf_` exception (24/30, then 25/30 with every booth flag on). In the second wording, 3 of 30 `prf-control` runs took a profile day as named ("오늘 날짜로 할게요."); the exception brought that back to 30/30.

**Live:**
- Before, the date stage asked in 2 of 2 runs: A "오늘 날짜로 할까요? / 오늘로 할까요?", C "목요일 일정에 맞는 날짜예요. / Nov 5 (Thu)로 할까요?".
- After, 8 of 8 card runs (A ×4, C ×4) selected the stated day on entry and moved straight to the time stage. A said "오늘로 할게요." (4/4). C said "목요일로 할게요." (3/4) or nothing (1/4).
- No run selected a wrong day.

#### 3. Seats

| Measure | Before | After |
|---|---|---|
| Quick card 5 ("두 자리 붙어서, 뒤쪽으로요. 앞줄은 말고요."): right-size choices marked | **0/3** today (0/2 this morning): "뒤쪽에서 붙어 있는 두 자리 선택지가 여러 개예요. 어느 줄로 하실까요?" | **9/9**: three pairs in rows E/F of A–F every time (3 final-text runs, 6 on earlier texts), then "표시된 자리 중 어느 쌍으로 하시겠어요?" |
| Card C ("세 자리 붙어서요. 앞줄은 말고요."): right-size choices marked | E1–E4 (four for three), then E1–E3 and two more questions | 3/4. Final text: E2–E4, F5–F7, F8–F10 ✓, and E1–E3, F5–F7, B1–B3 (right size, but B is the second row of six). Earlier text: one run marked a pair (F9–F10) beside two triples ✗ |
| Card A ("한 자리만요. 가운데쯤으로, 앞줄은 말고요."): marked | C4 | Three single seats, 4/4 (e.g. C4, E4, E5). E is the back row of A–E, which is not "가운데쯤", in 3/4 |
| Delegation ("추천해 주시는 자리로 할게요") ends in a selection with no further question | A 1/1, C 1/1 (C after two extra questions, said "추천 좌석 E1, E2, E3로 선택했어요.") | **A 4/4, C 4/4**, first try, as a recommendation: "C4 좌석을 추천해요.", "F5, F6, F7을 추천해요.", "E2, E3, E4를 추천드려요." One early run said "추천으로 F5, F6, F7을 골랐어요." |
| Delegation with no party size (walk-through) | 8 delegations, never booked (ko and en, 0/2): "몇 분이 함께 보시나요?" ×6, "Which seat would you like?" ×6 | Booked 4/4 after 2–4 delegations: it asked "몇 자리로 할까요?" 1–3 times, then booked one seat ("E6 좌석을 추천해요.") |

- A fix found along the way: the first seat wording told the highlight step to say nothing. A quick card does not send `spokenBrevity`, so the empty sentence fell back to the English "I will run highlight next. Reason: [seat-choices] …", which was spoken in 3 of 3 quick-card runs. The final wording only keeps the question off the highlight step, and the fallback did not recur in the 6 runs that followed.
- **Party-size guesses:** at C's seat stage the agent sometimes guessed a size from "아이 둘": "두 분이 함께 앉을 자리로…" in 2 of 4 runs, one of them on the final text. The visitor's line corrects it straight away.

#### Transcript W2 (final code, voice on, Korean walk-through, `st_b677d179`)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 |
|---|---|---|---|
| 0 | — | 장르나 관람등급, 러닝타임 중에 중요하게 보는 게 있으세요? | — |
| 1 | 상관없어요, 첫 번째 걸로 할게요. | 얼마나 멀리까지 괜찮으세요? 주차나 리클라이너 좌석도 중요하면 말씀해 주세요. | select m4 → next |
| 2 | 상관없어요, 첫 번째 걸로 할게요. | 평일이 좋으세요, 주말이 좋으세요? | select t2 → next |
| 3 | 상관없어요, 첫 번째 걸로 할게요. | 몇 시쯤 시작하거나 끝나면 좋으세요? | select 2026-11-03 → next |
| 4 | 상관없어요, 첫 번째 걸로 할게요. | 몇 분이시고, 앞쪽과 뒤쪽 중 어디가 좋으세요? | select 12:50 PM → next |
| 5–7 | 상관없어요, 추천해 주시는 자리로 할게요. ×3 | 몇 자리로 할까요? ×3 | — |
| 8 | 상관없어요, 추천해 주시는 자리로 할게요. | E6 좌석을 추천해요. / The Legend of Aang: The Last Airbender, Bel Air Luxury Cinema, 11월 3일 12:50 PM, E6 좌석으로 총 $19.00예요. 예매를 확정할까요? | select E6 → next |
| 9 | 네, 좋아요. | — | next → **booked** |

Rows 5–7 show the driver's visitor refusing to give a number, which a real visitor would not do. The opening questions are rows 0–4.

**Not measured:**
- English cards A and C.
- Quick cards 1–4. The opening question is now also spoken before a quick card's line, because a quick card starts at its stage with nothing in memory.

**Card B in Round 2 (final text, 2 runs, `st_2a3c7a4d` and `st_003c5788`).** Both booked Emagine on Thursday: 6:55 PM B2–B3, and 7:15 PM 3D F1–F2.
- **Conflict:** both runs named it at the theater stage, in the same sentence as before ("IMAX는 MJR Troy Grand Digital Cinema 16에서만 가능하지만 20.4마일이에요. 가까운 곳에서 Standard 또는 3D로 볼까요, 아니면 …?"). "첫 번째 걸로" relaxed IMAX in both.
- **Date stage:** both runs said "목요일로 할게요." and selected Thursday on entry. Before Round 2 it asked "목요일로 할까요?".
- **Seat stage, two things that are new:**
  - "두 자리 붙어서요. 앞줄은 말고요." was answered with ONE pair and "B2와 B3로 할까요?" / "F1과 F2로 할까요?" — a pointer and a confirmation, not up to three choices and a which-one question. B is the second row.
  - In one run, the seat-entry step called `highlight` before the visitor had said anything about seats. Its ids were A1–A8 plus one corrupted id containing stray model output (`…assistant to=functions.respond 北京赛车…`), followed by the opening question. Guessing the party size from "공저자랑 같이" is what the seat section forbids. The corrupted id got through because `validateLlmAction` checks ids for select and selectMultiple but not for highlight (pre-existing). Nothing was spoken from it, and the booking went on normally.

Traces for the runs above are in the worktree's `logs/demo/trace/` (gitignored). The driver JSONs and replay outputs are scratch.

### Round 3: noise repeats and hidden count (24 Oct 2026)

After the KSEA poster session (eleven booth sessions in a loud hall, analysed in `.notes/ksea-2026-poster-session-analysis.md`, which is not committed), two of its "what to do next" items: noise must not become a repeated turn (item 1), and the hidden count is said once (item 3). On top of `realtime-voice` @ `6ff1c6e`. Every change is booth-only (`AGENT_STUDY_MODE=demo` on the agent, `DEMO_STUDY_MODE` on the frontend). A study session's planner prompt is byte-identical (`plannerPrompt.check.ts`), its transcript gate is the study's (the new echo rule is behind an option only the booth passes), and its runtime loop sends exactly what it sent before: the new code returns its input unchanged when `isDemoMode` is false.

What the poster logs showed, for scale: of 102 visitor turns, 30 were hall noise, bystanders or the kiosk's own voice; of 128 agent messages, 65 were cut off (40 by a VAD barge-in, 25 by a newly arriving transcript stopping the speech); 32 messages were exact and 16 near repeats of one the visitor had just heard at that stage; 7 restated a hidden count already given. `1ec6a31` (Round 2) would have dropped 6 of the 32.

| Change | Where | Gate |
|---|---|---|
| **Cross-turn repeat ledger.** Remembers the sentences spoken at the current stage, across visitor turns; cleared on any stage change (forward or a backtrack), a session reset and a language switch. Three rules, on the spoken text only, never on a tool call: (0) within one visitor turn a sentence is said once (repeatGuard compares whole messages, so "…1곳을 숨겼어요. 어느 곳으로 할까요?" and then "어느 곳으로 할까요?" both went out in a card-A run); (1) when the visitor's turn changed nothing (the preference extractor added or changed no preference), a sentence that is an exact or near (char-bigram Dice ≥ 0.8) repeat of one already said at this stage is dropped, and if nothing is left the agent stays silent; (2) a sentence stating how many options a filter hides is dropped when that count was already stated at this stage and no filter changed since, unless the visitor asked about hidden options. | `core/repeatLedger.ts`, wired in `index.ts` at the three places a planner sentence is sent | `isDemoMode` |
| **Agreements keep their commit.** The ledger filters text only, so a select or next planned on "네" always runs. A bare agreement that agrees to nothing (a "네" to an open "어느 좌석으로 할까요?") falls under rule 1 like any other nothing-new turn; a repeated yes/no question ("Cinema Detroit로 할까요?") after an agreement is kept, because then the planner failed to act on a yes and the visitor should hear it. | `isBareAgreement`, `isClosedQuestion` | — |
| **Deliberate silence.** When the ledger silenced the turn, an empty respond that follows is accepted instead of being re-planned and answered with the stage question (Round 2's empty-respond guard). | `core/emptyRespond.ts` (`deliberateSilence`) | booth only |
| **Hidden count, said once (prompt).** A booth section after decisive selection: say how many options a filter hides once per filter, in the turn that applies, changes or removes it (on one step of that turn), or when the visitor asks; not again at that stage unless the count changed, and rule (4)'s question is then the whole message. The Filtered stages rule and rule (4) stay byte-for-byte; this section wins over both. | `HIDDEN_COUNT_ONCE_RULES` (`llmPlanner.ts`), pinned in `plannerPrompt.check.ts` | `hiddenCountOnce` (demo, GUI on) |
| **Low-content transcripts do not cut the agent off.** A fragment, a bare "뭐?"/"응?", a filler or an exclamation (one token that is not an answer word, does not touch an on-screen label and carries no digit or choice particle; or two or three tokens that trail off or are a bare question) no longer calls `stopAgentSpeech()`. It is still delivered to the agent, and logged as `chat.voice_input.low_content`. | `isLowContentTranscript` (`i18n/voiceInput.ts`), `ChatPage.tsx` | booth only |
| **One echoed augment label.** A transcript that carries the "·" separator and is nothing but (a run of) one on-screen label that has it ("Clayface · R.") is a prompt echo. Saying "Clayface" or "the R-rated one" still gets through. | `isAugmentLabelEcho` (`i18n/voiceInput.ts`) | `boothEcho` option, booth only |
| **VAD.** `.env` is unchanged. `.env.example` records the hall numbers and recommends `OPENAI_REALTIME_VAD_THRESHOLD=0.7` for a booth (unmeasured in a hall). `OPENAI_REALTIME_VAD_TYPE=semantic_vad` with `OPENAI_REALTIME_VAD_EAGERNESS=low` is now possible (default off; server_vad is built exactly as before). A barge-in happens at speech start, before any transcript exists, so only the threshold or the VAD type can change the 40 VAD cuts. | `routes/speech.ts` (`buildTurnDetection`) | env, default off |

No protocol field was added. The agent's test is "did this turn change memory", which its own extractor answers, and the host's low-content verdict is only used for the host's own decision (whether to stop playback). The poster logs support that: of the 30 off-task turns the analysis tagged, the extractor changed memory on 1 (a spoken restart, which removed preferences).

**Offline replay on the logged sequences.** `llm/noiseRepeat.regress.ts` parses the three logs of the six conversing poster sessions, labels every agent message with a TypeScript port of the analysis script's rules (it reproduces 128 messages, 32 exact, 16 near, 7 hidden before reporting anything), and feeds the messages in order through what the booth agent now does with them (the ledger plus the existing in-turn dedupe), with each visitor turn's extractor outcome taken from `extraction.completed`:

| Logged repeats | Silenced | Trimmed (repeated sentence or count removed, the rest said) | Still said word for word |
|---|---|---|---|
| exact, 32 | **28** | 0 | 4 |
| near, 16 | 3 | 4 | 9 |
| hidden-count restatement, 7 | — | **7 of 7** lose the count | 0 |

- The 4 exact repeats left are on turns that changed memory (a new filter, a reset), where the question still standing is asked again. Most of the 9 near repeats left are rewordings below 0.8 ("어떤 영화를 고르실까요?" after "어떤 영화를 보고 싶으세요?").
- Hidden-count sentences spoken: 14 → 6. Agent sentences spoken overall: 173 → 117.
- The 9b9d4210 confirm stage, the acceptance case: the read-back is said once on entry, then **0 of the 8 following noise turns** are answered (before: 7 full read-backs and 2 partial ones).
- Bare agreements: 37 turns. 12 repeated sentences were dropped on them and 11 messages silenced, all open questions or statements; **0 repeated yes/no questions were dropped**. The 39 select/next calls planned on agreement turns are untouched by construction.

**Replay of the planner requests (real API, `gpt-5.6-terra`, 2 runs per side).** The 49 planner requests behind a repeated or hidden-count message, sent again with today's booth prompt (BEFORE) and with `hiddenCountOnce` added (AFTER):

| | BEFORE | AFTER |
|---|---|---|
| answers that restate a count already given at the stage | 12/98, 10/98 (two passes) | **0/98, 0/98** |
| ...on the 7 hidden-count cases (14 answers) | 12, 10 | 0, 0 |
| restated counts left after the ledger | 2, 0 | 0, 0 |
| tool mix | respond 83–85, highlight 6–8, select 4, clearModification 2, next 1 | respond 83, highlight 7, select 4, clearModification 2, next 2 |

The prompt alone removes the restatement; the ledger catches what the prompt misses. On the repeat cases the replay mostly shows something the logs could not: today's prompt (Round 2's opening questions) answers a noise turn at stage entry with the stage's preference question ("장르나 관람등급, 러닝타임 중에 중요하게 보는 게 있으세요?") rather than the old "which one?", which is not a repeat of the old build's logged sentence and so is said. Live, the same question has already been asked once, and the ledger drops it (below).

**Live runs** (isolated stack from the worktree: backend :3100 with `NODE_ENV=development`, Vite :5273, access-code batch `noise-fix`, `--voice`, planner `gpt-5.6-terra`). The driver gained `--noise`: after each visitor line, while the agent's answer is playing, one low-content line goes in through the voice-transcript funnel itself (ChatPage's `handleVoiceTranscript`), and once the agent has settled, another at the question on the floor. The lines rotate through two fragments, a bare "응?", an augmented label currently on screen read back, and a lone "네.". Headless Chromium has a silent fake microphone, so there are no VAD barge-ins here; "cut" counts only playback stopped by a transcript.

| Run | Booked | Noise lines (low-content / echo / "네.") | Agent sentences | Sentences cut | Questions spoken again at a stage (≥ 0.8) | Hidden-count sentences | Ledger drops |
|---|---|---|---|---|---|---|---|
| card A, no noise (`st_22b3f62b`) | yes, C4 9:30 PM | — | 11 messages | 0 | — | 1 | — |
| card C, no noise (`st_66427592`) | yes, E2–E4 1:15 PM | — | 11 messages | 0 | — | 1 | 1 (rule 0) |
| card A `--noise` (`st_b266fdf0`) | **yes**, C4 9:30 PM | 12 (9 / 0 / 3) | 17 | **0** | 1 | 1 | 10 |
| card C `--noise` (`st_fc84b13b`) | **yes**, F5–F7 1:15 PM | 14 (9 / 2 / 3) | 19 | 1 | 0 | 0 | 4 |

- No low-content line stopped the agent's sentence (18 of 18 that arrived mid-speech or settled); the one cut in card C was a "네." mid-speech, which is an answer and still stops it. Before this change every one of them called `stopAgentSpeech()`.
- Both on-screen echoes («Wildwood · PG · 1h 46m», «1:15 PM · 3:01 PM 종료») were dropped as `prompt_echo` and never reached the agent.
- A fragment at a settled question got silence 6 times out of 7. The exception was a reworded re-ask under 0.8 («가까운 곳, 무료 주차, 리클라이너 중 무엇이 더 중요하세요?» after «어느 쪽이 더 중요하세요—가까운 곳, 무료 주차, 아니면 리클라이너 좌석인가요?»). Card A's one "question spoken again" came on a line that DID change memory (the 15-mile filter turn re-asking «어느 영화관으로 할까요?»), which rule 1 deliberately leaves alone.
- "네." at a yes/no question committed 4 of 4 times (the theater pointer in card A, the 1:15 PM pointer in card C, and both confirm read-backs, which booked). "네." at an open question (the seat stage's opening question) got silence.

**Still open.**
- Rewordings below the 0.8 threshold: the planner's own in-turn double question in a new wording («어느 영화를 볼까요?» → «어느 쪽이 더 끌리세요?», «어느 자리로 하시겠어요?» → «표시된 자리 중 어느 쪽으로 하시겠어요?», 0.77) gets through; a containment rule was considered and not added unmeasured.
- The 40 VAD barge-in cuts are untouched in code; 0.7 and `semantic_vad` are recommendations, not measured. A hall-noise WAV through `CHROMIUM_EXTRA_FLAGS` is the way to measure them before the next booth.
- After a silenced noise turn the visitor hears nothing, which is the point; if a barge-in had cut the question being repeated, they also never hear it in full. The question stays on screen.
- The driver used to find ChatInput by walking up from the textarea's fiber, which can be the stale alternate (it read a long-enabled composer as disabled after a silent turn and aborted four noise runs). It now walks the root's current fiber tree.

### Round 3: shorter chain (24 Oct 2026)

Item 2 of the poster analysis's "what to do next": the chain of planner calls is what scales the wait. Live, the first spoken word came a median 3.8 s after the visitor stopped (p90 7.4 s). Planner calls were 56% of the silent wait and the extractor 21%. A turn that advanced a stage took a median 6.0 s, against 3.1 s for an answer-only turn. On top of `realtime-voice` @ `65e04ac`. Both changes are booth only (`isDemoMode`). No prompt changed, so a study session's planner prompt, tool schema and runtime loop are as before.

| Change | Where | Gate |
|---|---|---|
| **Deterministic `next` after a committed select.** After a select, the planner is offered one tool (`next`). In the 58 booth traces on disk it called `next` after every select: 75 of 75 tagged ones on 24 Oct. The runtime now runs that `next` itself, with no planner call, when all of these hold: the reason tag is `[named-option]`, `[single-viable]` or `[superlative]`; or it is `[seat-recommend]` at the seat stage; or it is `[other]` on a bare-agreement turn. The stage is not confirm (a `next` there books). The select's sentence asks nothing. No backtrack continuation or pending conflict is open. `suppressNavigationToolsOnce` is off. No `prev` has run since the visitor spoke. The host offers `next`. The proceed rule holds after the select (`selectedId`, or `selectedListCount > 0` at the seat stage). The `next` is queued like the deferred replan, so the speech barrier, the turn guard and the safety policy treat it exactly like a planned one. Its tool call has the same shape (`{toolName: 'next', params: {}, reason}`, with the reason opening with the select's tag) and it says nothing. The host does not annotate a `next` in history, so later planner calls see an identical history. The stage-entry planning after it runs as before. | `core/autoNext.ts` (`decideAutoNext`), `index.ts` (after the select's resync; consumed at the top of `maybePlanAndExecute`) | `isDemoMode` |
| **No extractor wait on a pure pick.** A user message that is only agreement, a deictic or positional pick, and commit words starts the first planner call at once, beside the extraction, instead of after it. Examples: «네», «그걸로 할게요», «첫 번째 걸로», «상관없어요, 첫 번째 걸로 할게요», "yes", "that one", "I'll take the second one". Before anything is executed or said, the cycle waits for the extraction, so the repeat ledger reads its final verdict through `trackBoothExtraction` as before. If the extraction changed memory (whole preference list compared, scopes included), the decision is discarded and planned again. Anything else, including a lone «상관없어요», keeps extraction first. `repeatLedger.isBareAgreement` is deliberately not used here: it matches any sentence ending in «할게요», which includes «8시 이후로 할게요». | `core/autoNext.ts` (`isPurePick`), `index.ts` (`user.message`, the `state.updated:user-message` gate, the reconcile in `maybePlanAndExecute`) | `isDemoMode` |
| Offline check | `core/autoNext.check.ts` (every refusal case, 30 pure picks and non-picks), in the root `check` line | — |

**Measured** on an isolated stack from the worktree (backend :3100 with `NODE_ENV=development`, Vite :5273). BEFORE is a `git archive` of `65e04ac` on :3110/:5283, so both sides ran the same evening against the same OpenAI latency. Both used `--voice` and planner `gpt-5.6-terra`. The runs were two at a time, 20 s apart: cards A, B and C twice each, W once (`--max-followups=12`) and quick card `theater` once, all per batch. BEFORE was run in two batches (16 runs). AFTER-final, the code as committed, is one batch of 8. An earlier AFTER batch of 8 lacked the `[seat-recommend]` commit and is pooled below.

The driver's seconds run from a line being submitted to the first `agent.message` frame and to the last frame. There is no STT and no VAD tail, so these are longer than live only where the chain is. A turn is stage-advancing when the stage after it is later than the stage before it.

| | BEFORE (16 runs) | AFTER-final (8 runs) | AFTER pooled (16 runs) |
|---|---|---|---|
| stage-advancing turns: first reply, median / p90 / max | **6.7** / 10.5 / 15.7 s (n = 54) | **4.4** / 8.6 / 10.1 s (n = 28) | 4.5 / 8.1 / 10.3 s (n = 56) |
| …of them pure picks («첫 번째 걸로 할게요», «네, 좋아요») | 6.7 s (n = 29) | 4.4 s (n = 16) | 4.3 s (n = 31) |
| …of them content lines (the card's own lines) | 6.3 s (n = 25) | 4.3 s (n = 12) | 5.7 s (n = 25) |
| stage-advancing: settle, median / max | 9.7 / 23.1 s | 8.5 / 16.7 s | 8.8 / 21.4 s |
| stage-advancing: planner calls per turn, mean (before the first reply) | 3.9 (2.9) | 2.8 (2.2) | 3.0 (2.2) |
| answer-only turns: first reply, median / max | 6.3 / 36.4 s (n = 37) | 6.3 / 9.7 s (n = 22) | 6.2 / 36.3 s (n = 42) |
| answer-only: planner calls per turn, mean (before the first reply) | 2.2 (1.7) | 2.5 (1.9) | 2.4 (1.8) |
| full cards booked | 10 / 12 | **6 / 6** | 12 / 12 |
| W booked | 0 / 2 | 0 / 1 | 0 / 2 |
| questions spoken again at a stage (≥ 0.8, all runs) | 8 | 2 | 8 |

- The target was a median first reply of ≤ 4.5 s on stage-advancing turns. It was met: 4.4 s with the final code, 4.5 s pooled. A full chain on a pure pick now looks like this (W, final code): select at +1.3–1.6 s, `next` 0.2–0.4 s after it, and the next stage's question at +3.1–4.6 s. Before, the same turn put select at +2.2–3.5 s, `next` at +3.5–5.3 s and the question at +5.4–7.6 s.
- Answer-only turns did not change (6.3 s), as expected. They are content lines, so extraction still goes first, and they have no `next` to skip. The 36 s outliers (one BEFORE card B turn, one AFTER card C turn) were each a planner request whose first fetch attempt hit the 30 s attempt timeout and was retried.
- In AFTER-final the runtime ran 34 `next` calls itself and refused none. By rule: `[named-option]` 26, `[seat-recommend]` 6, `[single-viable]` 2. No select was paired with a question in these runs, so the refusal paths are covered only by the offline check. There were 24 overlapped extractions. 2 of them changed memory and were re-planned: card B's «첫 번째 걸로 할게요» answering the IMAX-or-15-miles question, where the extractor drops IMAX (`cardB.regress.ts` extract-relax). Both runs then booked a nearby cinema without IMAX, as the card intends.
- Bookings: every full card booked after the change. The two BEFORE failures are silent stalls: a «네, 좋아요» or «첫 번째 걸로 할게요» to an open question ended in silence, and the driver gave up after 90 s. W fails the same way on both sides. At the seat stage it delegates twice without a party size, and the second delegation gets silence instead of the one seat that SEAT_CHOICE_RULES asks for. That is a Round-3 ledger/seat interaction this change does not touch (open, below).
- Repeated questions: 8 in 16 runs before, 8 in 16 after (2 in the final 8). They are the same kind on both sides: the stage's which-one question asked again after a turn that DID change memory (a filter, the conflict being resolved), which rule 1 of the ledger leaves alone. None followed an auto `next` or an overlapped extraction.
- Quick card `theater` (one line, no follow-ups, never booked by design): first reply 6.8 and 10.1 s before, 7.3 and 7.1 s after. Its line is a content line with no select, so neither shortcut applies. Its planner counts come from `agent.status` frames, because a quick card leaves no trace.

**Replay harnesses**, default modes. None of them imports `index.ts` or `core/autoNext.ts`, and no prompt changed, so they exercise code identical to BEFORE. They were run once, on the worktree:

| Harness | Earlier (Rounds 2–3) | Now |
|---|---|---|
| `statedDay.regress.ts --since 20261024` | 25 / 30 commit | 33 / 36 commit on the named day, 0 on another day. 12 sessions now qualify, against 10 then. `prf-control` asks 36 / 36 |
| `cardB.regress.ts` | theater-limit 9 / 9 | theater-limit 9 / 9 (BEFORE 0 / 9); time-deadend 9 / 9; theater-relaxed 9 / 9 and 8 / 9 |
| `noiseRepeat.regress.ts` (offline) | exact 28 / 32 silenced | 28 / 32; near 3 silenced and 4 trimmed; hidden 7 / 7; 0 repeated yes/no questions dropped on agreements |
| `decisiveSelection.regress.ts` (offline: scores what was logged) | — | named → commit 82% (47 / 57). This mode scores logs, not this code |

**Still open.**
- The 36 s outliers are the planner fetch's 30 s per-attempt timeout (`resilientFetch.ts`) before its retry. A planner call's median is 1.5 s, so a much shorter first attempt would cap them. Not changed here: it applies to study sessions too.
- The W seat-stage stall above. A second delegation with no party size should book one seat; instead it is silenced as nothing new.
- After a spoken select (`[single-viable]`, `[superlative]`, `[seat-recommend]`), the auto `next` still waits for that sentence to finish playing, as a planned one did. Running it during playback would save the remaining overlap, but the host's speech/GUI sync holds GUI steps anyway (`next` 3.9 s in the poster logs), so it was not tried unmeasured.
- Live booth latency (STT, the 0.9 s VAD tail, Realtime first audio) is not in these numbers. The saving per stage-advancing turn, about 2 s here (one planner call, plus about 0.9 s of extraction on a pure pick), should carry over, because it is chain time.

## Traces and raw run data

The trace files are in the main checkout's `logs/demo/trace/` (gitignored), one per full-card run:

| Run | Trace file |
|---|---|
| A1 | `logs/demo/trace/demo-st_7354c566b0c74da98605bceca0c6e5a3-20261024-102130.llm-trace.jsonl` |
| A2v | `logs/demo/trace/demo-st_19d4408bdf8543cea3c52d6536e09fad-20261024-102457.llm-trace.jsonl` |
| A3v | `logs/demo/trace/demo-st_91731727d8194fcd915bb7f05491e10f-20261024-102845.llm-trace.jsonl` |
| A4t | `logs/demo/trace/demo-st_d99b8e39946648cdb244e76b692744e6-20261024-103327.llm-trace.jsonl` |
| B2t | `logs/demo/trace/demo-st_6ef202cdea644d518b1d29edbb46292c-20261024-102843.llm-trace.jsonl` |
| B3v | `logs/demo/trace/demo-st_5a33d8a986ce4628813f40487b1642c8-20261024-103107.llm-trace.jsonl` |
| B4v | `logs/demo/trace/demo-st_bd2644e381784ed585fd60379781bf09-20261024-103532.llm-trace.jsonl` |
| C1v | `logs/demo/trace/demo-st_3a7e79b6d89d4010a310cb5b336fcfe9-20261024-102843.llm-trace.jsonl` |
| C2v | `logs/demo/trace/demo-st_7c0018369e9e47ee9b141421be6676a8-20261024-103106.llm-trace.jsonl` |
| C3t | `logs/demo/trace/demo-st_43257afd1c2b4ce5a8bc39a20d14f4c4-20261024-103328.llm-trace.jsonl` |
| C4v | `logs/demo/trace/demo-st_ba3b0c5d8b2842298273bda2f09d6dec-20261024-104309.llm-trace.jsonl` |

The quick cards have no trace, because `/demo/card` never records. Each run's relay frames, per-turn tool calls and final screen text were written to a JSON file next to the driver output (`--json=`); those files were scratch and are not committed. Rerun a card with the command in Method to regenerate them.

## Appendix: the other full-card transcripts

### A1 (text, all lines in a row)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 오늘 밤에 클라라와 태양 보고 싶어요. 다운타운에서 가까운 곳으로요. | `EN: I will run select next.…` / `EN: I will run next next.…` / 다운타운과의 거리를 표시할게요. / 다운타운에서 가까운 곳이라는 조건으로 9마일 이내 극장만 보여드릴게요. / 다운타운에서 가까운 조건으로 3곳이 숨겨져 있고, 현재 보이는 두 극장 중 어느 곳으로 할까요? | select m2 → next → augment (5 labels, e.g. “Cinema Detroit — 2.5 miles”) → filter distanceMiles lte 9 | 2.6 / 11.4 |
| 2 | 15마일 넘는 데는 안 돼요. | 15마일 이내 조건에 맞게 보기를 조정할게요. 현재 9마일 조건 때문에 3곳이 숨겨져 있어요. / 15마일 이내 조건으로 보기를 맞췄어요. 1곳은 이 조건 때문에 숨겨져 있어요. / 15마일 이내 조건 때문에 1곳이 숨겨져 있어요. 보이는 극장 중 어느 곳으로 할까요? | clear filter → filter distanceMiles lte 15 | 3.9 / 10.5 |
| 3 | 8시 이후에 시작해야 하고, 자정 전에는 돌아와야 해요. | 15마일 이내 조건 때문에 1곳이 숨겨져 있어요. 보이는 극장 중 어디로 할까요? | — | 3.6 / 3.6 |
| 4 | 한 자리만요. 가운데쯤으로, 앞줄은 말고요. | 15마일 이내 조건 때문에 1곳이 숨겨져 있어요. 보이는 극장 중 어디로 할까요? | — | 3.9 / 3.9 |
| 5 | 네, 좋아요. *(follow-up)* | 15마일 이내 조건 때문에 1곳이 숨겨져 있어요. 보이는 극장 중 어디로 할까요? | — | 2.5 / 2.5 |
| 6 | 네, 좋아요. *(follow-up)* | 15마일 이내 조건 때문에 1곳이 숨겨져 있어요. 보이는 극장 중 어느 곳으로 할까요? | — | 2.5 / 2.5 |
| 7 | 첫 번째 걸로 할게요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 오늘 상영인 Nov 3 (Tue)로 골랐어요. / 오늘 날짜로 진행할까요? | select t1 → next → highlight 2026-11-03 | 2.1 / 7.6 |
| 8 | 네, 좋아요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 오후 8시 이후 시작과 자정 전 종료 조건을 확인할 수 있도록 종료 시간을 표시했어요. / 오후 8시 이후 시작 조건에 맞지 않는 2개 상영 시간을 숨겼어요. / 오후 8시 이후 시작 조건 때문에 상영 시간 2개가 숨겨져 있어요. 보이는 상영 시간은 자정 전에 끝나요. 이 시간으로 할까요? | select 2026-11-03 → next → augment (3 labels, e.g. “4:00 PM — ends 5:58 PM”) → filter time gte 20:00 | 2.3 / 13.4 |

### A3v (voice, seat loop)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 오늘 밤에 클라라와 태양 보고 싶어요. 다운타운에서 가까운 곳으로요. | Cinema Detroit가 가장 가까워요. 여기로 할까요? | select m2 → next → augment (5 labels, e.g. “Cinema Detroit — 2.5 miles”) → sort distanceMiles asc | 3.1 / 9.4 |
| 2 | 15마일 넘는 데는 안 돼요. | 15마일 이내 조건을 적용했어요. / 15마일 이내 극장이 네 곳이고, 이 조건 때문에 한 곳은 숨겨져 있어요. 어느 극장으로 할까요? | filter distanceMiles lte 15 | 3.4 / 6.9 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | 오늘 날짜로 할까요? / 오늘로 할까요? | select t1 → next → highlight 2026-11-03 | 2.1 / 8.6 |
| 4 | 네, 좋아요. *(follow-up)* | 어느 시간으로 할까요? | select 2026-11-03 → next | 2.4 / 6.4 |
| 5 | 8시 이후에 시작해야 하고, 자정 전에는 돌아와야 해요. | 9:30 PM만 조건에 맞아서 선택했어요. / 어느 좌석으로 할까요? | augment (3 labels, e.g. “4:00 PM · ends 5:58 PM”) → select s_m2_t1_20261103_2130_s1 → next | 3.8 / 11.7 |
| 6 | 한 자리만요. 가운데쯤으로, 앞줄은 말고요. | 가운데 쪽에서 어느 좌석으로 할까요? | — | 3.9 / 3.9 |
| 7 | 첫 번째 걸로 할게요. *(follow-up)* | 어느 좌석을 말씀하신 건가요? | — | 2.7 / 2.7 |
| 8 | 첫 번째 걸로 할게요. *(follow-up)* | 어느 좌석을 말씀하신 건가요? | — | 2.6 / 2.6 |
| 9 | 첫 번째 걸로 할게요. *(follow-up)* | 가운데 쪽 좌석 번호를 말씀해 주세요. | — | 2.5 / 2.5 |
| 10 | 네, 좋아요. *(follow-up)* | 원하시는 좌석 번호를 말씀해 주세요. | — | 2.8 / 2.8 |

### A4t (text, booked)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 오늘 밤에 클라라와 태양 보고 싶어요. 다운타운에서 가까운 곳으로요. | `EN: I will run select next.…` / `EN: I will run next next.…` / 다운타운과의 거리를 표시할게요. / 다운타운과의 거리가 가까운 순으로 정렬했어요. / 다운타운에 가장 가까운 곳은 Cinema Detroit이며 2.5 miles예요. | select m2 → next → augment (5 labels, e.g. “Cinema Detroit — 2.5 miles”) → sort distanceMiles asc | 2.7 / 10.5 |
| 2 | 15마일 넘는 데는 안 돼요. | 15마일 이내 조건으로 1곳을 숨겼어요. 어느 극장으로 할까요? / 15마일 이내 조건으로 1곳이 숨겨져 있어요. 다운타운에 가장 가까운 Cinema Detroit로 할까요? | filter distanceMiles lte 15 | 3.5 / 5.8 |
| 3 | 네, 좋아요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 오늘 날짜인 Nov 3 (Tue)예요. 이 날짜로 할까요? / 오늘은 Nov 3 (Tue)예요. 이 날짜로 할까요? | select t1 → next → highlight 2026-11-03 | 2.4 / 8.5 |
| 4 | 네, 좋아요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 원하시는 상영 시간을 말씀해 주세요. | select 2026-11-03 → next | 2.2 / 5.6 |
| 5 | 8시 이후에 시작해야 하고, 자정 전에는 돌아와야 해요. | 종료 시간을 함께 표시할게요. / 9:30 PM 상영이 조건에 맞는 유일한 시간이라 선택했어요. / `EN: I will run next next.…` / 원하시는 좌석을 말씀해 주세요. | augment (3 labels, e.g. “4:00 PM · ends 5:58 PM”) → select s_m2_t1_20261103_2130_s1 → next | 4.4 / 10.8 |
| 6 | 한 자리만요. 가운데쯤으로, 앞줄은 말고요. | 가운데에 가까운 C4를 추천해요. 다른 좌석을 원하시면 말씀해 주세요. / 앞줄을 제외한 좌석이 여러 개예요. 어느 좌석으로 할까요? | highlight C4 | 4.1 / 9.2 |
| 7 | 추천해 주시는 자리로 할게요. *(follow-up)* | `EN: I will run selectMultiple next.…` / `EN: I will run next next.…` / Klara and the Sun을 Cinema Detroit에서 오늘 9:30 PM에 보시고, C4 좌석으로 총 $12.00입니다. 예매를 확정할까요? | selectMultiple C4 → next | 2.4 / 6.4 |
| 8 | 네, 좋아요. *(follow-up)* | 예매를 확정할게요. | next | 예매 확정 화면 (확정 뒤에는 말하지 않음) |

### B2t (text)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 공저자랑 같이 목요일 밤에 스트리트 파이터를 IMAX로 보려고요. | `EN: I will run select next.…` / `EN: I will run next next.…` / 어느 극장으로 갈까요? | select m1 → next | 2.7 / 6.7 |
| 2 | 15마일 넘게는 운전 안 할 거예요. | 15마일 이내 조건을 확인할 수 있도록 거리를 표시할게요. / 15마일 이내 극장만 보이도록 했어요. 1곳은 이 조건 때문에 숨겨져 있어요. / 15마일 이내인 극장이 2곳이고, 이 조건 때문에 1곳은 숨겨져 있어요. 어느 극장으로 할까요? | augment (3 labels, e.g. “Emagine Royal Oak — 14.2 miles”) → filter distanceMiles lte 15 | 3.3 / 8.8 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | 첫 번째로 보이는 Emagine Royal Oak을 말씀하신 건가요? | — | 3.0 / 3.0 |
| 4 | 네, 좋아요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 목요일인 Nov 5 (Thu)로 골랐어요. / 목요일 일정에는 Nov 5 (Thu)가 맞아요. 이 날짜로 할까요? | select t4 → next → highlight 2026-11-05 | 2.5 / 9.1 |
| 5 | 네, 좋아요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / IMAX 여부를 확인할 수 있도록 상영 형식을 표시했어요. / IMAX 상영이 없어 선택할 수 없어요. 다른 날짜로 돌아가 볼까요? | select 2026-11-05 → next → augment (8 labels, e.g. “12:50 PM — Standard”) | 2.5 / 10.1 |
| 6 | 6시 반 이후에 시작해서 11시까지는 끝나야 해요. | 종료 시간을 표시했어요. / IMAX 상영이 없어 선택할 수 없어요. 날짜로 돌아가 다른 날을 볼까요? | augment (8 labels, e.g. “12:50 PM — Standard, ends 2:54 PM”) | 4.6 / 7.2 |
| 7 | 첫 번째 걸로 할게요. *(follow-up)* | IMAX 상영이 가능한 날짜를 찾기 위해 날짜로 돌아갈게요. / 이전 날짜 표시를 지우고 다른 날짜를 살펴볼게요. / IMAX 상영을 찾기 위해 다른 날짜를 골라야 해요. 어느 날로 할까요? | prev → clear highlight | 2.6 / 7.5 |
| 8 | 첫 번째 걸로 할게요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / IMAX 여부와 종료 시간을 확인할 수 있도록 상영 정보를 표시할게요. / IMAX 상영이 없어 현재 날짜에서는 선택할 수 없어요. 날짜 단계로 돌아가 다른 날짜를 볼까요? | select 2026-11-03 → next → augment (8 labels, e.g. “1:00 PM · Standard · 3:04 PM 종료”) | 2.3 / 11.1 |
| 9 | 첫 번째 걸로 할게요. *(follow-up)* | 현재 날짜에는 IMAX 상영이 없어요. 날짜 단계로 돌아가 다른 날짜를 고를까요? | — | 3.3 / 3.3 |

### B4v (voice)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 공저자랑 같이 목요일 밤에 스트리트 파이터를 IMAX로 보려고요. | 어느 극장으로 갈까요? | select m1 → next | 2.6 / 5.6 |
| 2 | 15마일 넘게는 운전 안 할 거예요. | 15마일 이내 극장만 보여드릴게요. 1곳은 이 조건 때문에 숨겨져 있어요. / 1곳은 15마일 조건 때문에 숨겨져 있어요. 어느 극장으로 할까요? | augment (3 labels, e.g. “Emagine Royal Oak — 14.2 miles”) → filter distanceMiles lte 15 | 3.7 / 12.1 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | 15마일 조건 때문에 1곳이 숨겨져 있어요. 어느 극장으로 할까요? | — | 2.7 / 2.7 |
| 4 | 첫 번째 걸로 할게요. *(follow-up)* | 15마일 조건 때문에 1곳이 숨겨져 있어요. Emagine Royal Oak와 Bel Air Luxury Cinema 중 어느 곳으로 할까요? | — | 2.7 / 2.7 |
| 5 | 첫 번째 걸로 할게요. *(follow-up)* | 15마일 조건 때문에 1곳이 숨겨져 있어요. Emagine Royal Oak와 Bel Air Luxury Cinema 중 어느 곳으로 할까요? | — | 2.7 / 2.7 |
| 6 | 첫 번째 걸로 할게요. *(follow-up)* | 목요일 상영일은 Nov 5 (Thu)예요. 이 날짜로 할까요? / Nov 5 (Thu)로 할까요? | select t4 → next → highlight 2026-11-05 | 2.2 / 10.7 |
| 7 | 네, 좋아요. *(follow-up)* | IMAX 상영이 없어 날짜를 바꿔야 해요. 날짜로 돌아갈까요? | select 2026-11-05 → next → augment (8 labels, e.g. “12:50 PM — Standard”) → augment (8 labels, e.g. “12:50 PM — Standard”) | 2.3 / 12.1 |
| 8 | 6시 반 이후에 시작해서 11시까지는 끝나야 해요. | IMAX 상영이 없어 날짜를 바꿔야 해요. 날짜로 돌아갈까요? | augment (8 labels, e.g. “12:50 PM — Standard, ends 2:54 PM”) | 4.6 / 6.8 |
| 9 | 네, 좋아요. *(follow-up)* | IMAX 상영이 가능한 다른 날짜를 골라 주세요. | prev | 2.2 / 4.4 |
| 10 | 네, 좋아요. *(follow-up)* | IMAX 상영이 가능한 다른 날짜를 골라 주세요. | — | 3.0 / 3.0 |
| 11 | 네, 좋아요. *(follow-up)* | IMAX 상영이 가능한 날짜를 골라 주세요. | — | 3.6 / 3.6 |

### C1v (voice, silent stall)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 목요일 오후에 아이 둘 데리고 영화 보러 가려고요. | 아이들과 보기 적합한 PG 영화만 보여드릴게요. / PG 조건 때문에 다른 영화 3편은 숨겨져 있어요. 어떤 영화를 볼까요? | augment (5 labels, e.g. “The Legend of Aang: The Last Airbender — PG”) → filter ageRating eq PG | 3.2 / 9.3 |
| 2 | PG 이하여야 하고, 짧을수록 좋아요. | PG 조건 때문에 다른 영화 3편은 숨겨져 있어요. 어떤 영화를 볼까요? | augment (2 labels, e.g. “The Legend of Aang: The Last Airbender — PG, 1h 52m”) → sort duration asc | 3.4 / 7.4 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | *(말 없음)* | — | **90 s 무응답** |

### C3t (text, reached confirm)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 목요일 오후에 아이 둘 데리고 영화 보러 가려고요. | 아이들과 보기 좋은 연령 등급을 표시할게요. / 아이들과 보기 좋은 PG 영화 두 편을 표시했어요. 어느 쪽으로 할까요? / 아이들과 보기 좋은 PG 영화 두 편 중 어느 쪽으로 할까요? | augment (5 labels, e.g. “The Legend of Aang: The Last Airbender — PG”) → highlight m4, m3 | 3.1 / 8.0 |
| 2 | PG 이하여야 하고, 짧을수록 좋아요. | 상영 시간을 함께 표시할게요. / PG 이하인 두 편을 남겨 두고, 짧은 상영 시간 순으로 정렬했어요. 어느 영화를 볼까요? / Wildwood가 더 짧은 상영 시간 선호에 맞아요. Wildwood로 할까요? | augment (5 labels, e.g. “The Legend of Aang: The Last Airbender — PG · 1h 52m”) → sort duration asc | 4.0 / 9.7 |
| 3 | 네, 좋아요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 어느 극장에서 볼까요? | select m3 → next | 2.4 / 6.2 |
| 4 | 첫 번째 걸로 할게요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 목요일에 해당하는 날짜예요. 이 날짜로 할까요? / 목요일은 Nov 5 (Thu)예요. | select t4 → next → highlight 2026-11-05 | 1.9 / 7.4 |
| 5 | 네, 좋아요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 오후 상영 시간을 확인할 수 있게 표시했어요. / 모든 시간이 목요일 오후 상영이에요. 원하는 시간을 말씀해 주세요. | select 2026-11-05 → next → augment (5 labels, e.g. “1:15 PM · 오후”) | 2.9 / 10.7 |
| 6 | 비행기 때문에 5시까지는 나와야 해요. | 오후 5시 종료 조건을 확인할 수 있게 종료 시간을 표시했어요. / 오후 5시까지 종료 조건으로 걸러서, 4개 상영 시간을 숨겼어요. / 오후 5시까지 끝나는 상영은 1:15 PM뿐이에요. / 1:15 PM 상영이 조건에 맞아요. 이 시간으로 할까요? | augment (5 labels, e.g. “1:15 PM · 오후 · 3:01 PM 종료”) → filter endTime lte 17:00 → highlight s_m3_t4_20261105_1315_s3 | 4.0 / 11.6 |
| 7 | 네, 좋아요. *(follow-up)* | `EN: I will run select next.…` / `EN: I will run next next.…` / 원하시는 좌석을 말씀해 주세요. | select s_m3_t4_20261105_1315_s3 → next | 2.3 / 6.3 |
| 8 | 세 자리 붙어서요. 앞줄은 말고요. | 앞줄을 제외하고 붙어 있는 세 자리 조합이 여러 개예요. 어느 줄을 원하세요? | — | 4.5 / 4.5 |
| 9 | 추천해 주시는 자리로 할게요. *(follow-up)* | 앞줄을 제외한 붙어 있는 세 자리 중 한 조합을 표시했어요. 이 자리로 할까요? / 앞줄을 제외한 붙어 있는 세 자리 조합이 여러 개예요. 원하시는 줄이나 좌석을 말씀해 주세요. | highlight B1, B2, B3 | 3.0 / 6.7 |
| 10 | 네, 좋아요. *(follow-up)* | `EN: I will run selectMultiple next.…` / 다음 단계로 넘어갈게요. / Wildwood를 Emagine Royal Oak에서 2026-11-05 1:15 PM에 보시며, B1, B2, B3 좌석이고 총 $45예요. 예약을 확정할까요? | selectMultiple B1, B2, B3 → next | 2.7 / 7.1 |

### F2 (card B after the fix, voice)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 공저자랑 같이 목요일 밤에 스트리트 파이터를 IMAX로 보려고요. | IMAX 조건에 맞는 극장만 보여드릴게요. / IMAX 상영관은 이 극장뿐이에요. 여기로 할까요? | select m1 → next → augment (3 labels, e.g. “MJR Troy Grand Digital Cinema 16 — 편의시설: Reserved Seating, Free Parking, Recliner Seating, IMAX, 3D Screens, Arcade”) → filter amenities contains IMAX | 8.0 / 11.4 |
| 2 | 15마일 넘게는 운전 안 할 거예요. | IMAX는 MJR Troy Grand Digital Cinema 16에서만 가능하지만 20.4마일 떨어져 있어요. 가까운 곳에서 Standard 또는 3D로 볼까요, 아니면 Troy까지 가서 IMAX로 볼까요? | augment (3 labels, e.g. “MJR Troy Grand Digital Cinema 16 — 거리: 20.4마일 — 편의시설: Reserved Seating, Free Parking, Recliner Seating, IMAX, 3D Screens, Arcade”) | 7.4 / 7.4 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | 15마일 이내 극장만 보여드릴게요. / 15마일 제한 때문에 1곳이 숨겨져 있어요. 어느 극장으로 할까요? | clearModification filter → filter distanceMiles lte 15 | 5.2 / 8.6 |
| 4 | 첫 번째 걸로 할게요. *(follow-up)* | 목요일로 할까요? / 목요일로 할까요? | select t4 → next → highlight 05 | 6.2 / 8.4 |
| 5 | 네, 좋아요. *(follow-up)* | 저녁 시간대만 보여드려요. / 저녁 조건 때문에 4개 시간은 숨겨져 있어요. 어느 시간으로 할까요? | select 2026-11-05 → next → augment (8 labels, e.g. “10:00 PM — 시간대: 저녁”) → filter time gte 18:00 | 9.1 / 11.5 |
| 6 | 6시 반 이후에 시작해서 11시까지는 끝나야 해요. | 종료 시간 조건 때문에 6개 시간이 숨겨져 있어요. 어느 시간으로 할까요? / 시작·종료 시간 조건 때문에 6개 시간이 숨겨져 있어요. 어느 시간으로 할까요? | augment (4 labels, e.g. “10:00 PM — 종료 12:04 AM”) → filter endTime lte 23:00 | 7.3 / 13.4 |
| 7 | 첫 번째 걸로 할게요. *(follow-up)* | 붙어 있는 두 좌석 중 어느 쪽으로 할까요? | select s_m1_t4_20261105_1855_s1 → next | 7.6 / 7.6 |
| 8 | 두 자리 붙어서요. 앞줄은 말고요. | 어느 두 자리를 고를까요? / 어느 두 자리를 고를까요? | highlight B1, B2, B3, B4 | 4.2 / 6.9 |
| 9 | 추천해 주시는 자리로 할게요. *(follow-up)* | 추천 자리로 B1, B2를 골랐어요. / Street Fighter를 Emagine Royal Oak에서 11월 5일 6:55 PM에 B1, B2 좌석으로 예매합니다. 총 $30이며, 확정할까요? | selectMultiple B1, B2 → next | 3.3 / 8.7 |
| 10 | 네, 좋아요. *(follow-up)* | — | next → **booked** | — / 2.7 |

### F3 (card B after the fix, voice)

| # | 방문자 | 에이전트가 한 말 | GUI 동작 | 첫 반응 / 마무리 (s) |
|---|---|---|---|---|
| 0 | — | 어떤 영화를 보고 싶으세요? | — | — |
| 1 | 공저자랑 같이 목요일 밤에 스트리트 파이터를 IMAX로 보려고요. | IMAX 상영관만 보이도록 했어요. / IMAX 조건 때문에 다른 극장 2곳은 숨겨져 있어요. 이 극장으로 할까요? | select m1 → next → augment (3 labels, e.g. “MJR Troy Grand Digital Cinema 16 — IMAX, 3D Screens”) → filter amenities contains IMAX | 8.2 / 11.6 |
| 2 | 15마일 넘게는 운전 안 할 거예요. | IMAX는 MJR Troy Grand Digital Cinema 16에서만 가능하지만 20.4마일이에요. 가까운 곳에서 Standard 또는 3D로 볼까요, 아니면 Troy까지 가서 IMAX로 볼까요? | augment (3 labels, e.g. “MJR Troy Grand Digital Cinema 16 — 20.4 miles — IMAX, 3D Screens”) | 6.6 / 6.6 |
| 3 | 첫 번째 걸로 할게요. *(follow-up)* | 15마일 이내 극장만 보이도록 했어요. / 두 곳 모두 15마일 이내예요. 어느 극장으로 할까요? | clearModification filter → filter distanceMiles lte 15 | 5.6 / 8.7 |
| 4 | 첫 번째 걸로 할게요. *(follow-up)* | 목요일로 할까요? / 목요일로 할까요? | select t4 → next → highlight 05 | 8.7 / 10.8 |
| 5 | 네, 좋아요. *(follow-up)* | 저녁 시간대만 보여드릴게요. / 저녁 시간대 조건으로 4개가 숨겨져 있어요. 어떤 시간을 원하세요? | select 2026-11-05 → next → augment (8 labels, e.g. “10:00 PM — 3D”) → filter time gte 18:00 | 8.7 / 11.4 |
| 6 | 6시 반 이후에 시작해서 11시까지는 끝나야 해요. | 종료 시간 조건으로 2개가 숨겨져 있어요. 어떤 시간을 원하세요? / 조건에 맞지 않아 6개 시간이 숨겨져 있어요. 6:55 PM과 7:15 PM 중 어느 시간이 좋으세요? | augment (4 labels, e.g. “10:00 PM — 3D, ends 12:04 AM”) → filter endTime lte 23:00 | 6.6 / 12.3 |
| 7 | 첫 번째 걸로 할게요. *(follow-up)* | 붙어 있는 두 좌석이 여러 쌍 있어요. 어느 줄이 좋으세요? / 어느 붙어 있는 두 좌석으로 할까요? | select s_m1_t4_20261105_1855_s1 → next → highlight A1, A2, B1, B2, B3, B4, F7, F8, F9, F10 | 7.1 / 11.9 |
| 8 | 두 자리 붙어서요. 앞줄은 말고요. | 어느 줄로 할까요? / 어느 줄로 할까요? | highlight B1, B2, B3, B4, F7, F8, F9, F10 | 4.9 / 7.0 |
| 9 | 추천해 주시는 자리로 할게요. *(follow-up)* | B1, B2를 추천해요. / 어느 줄로 할까요? | highlight B1, B2 | 3.0 / 6.0 |
| 10 | 추천해 주시는 자리로 할게요. *(follow-up)* | Street Fighter, Emagine Royal Oak, 2026-11-05 6:55 PM, B1·B2, 총 $30로 예약할까요? | selectMultiple B1, B2 → next | 6.2 / 6.2 |
| 11 | 네, 좋아요. *(follow-up)* | — | next → **booked** | — / 2.6 |
