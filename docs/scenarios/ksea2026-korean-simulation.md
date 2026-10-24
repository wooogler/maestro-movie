# KSEA 2026: Korean simulation of the demo cards

What happens when a Korean visitor reads the printed MAESTRO cards aloud to the current system? I ran each card end to end on 24 Oct 2026 against the dev stack (`realtime-voice` @ `13529c6`, agent dist rebuilt from it). The full cards ran 3–4 times each and the quick cards twice each, all in Korean. Every session is mine; there is no participant data here.

## The short answer

| Card | Does it go the way the card promises? |
|---|---|
| **A 오늘 밤** | **Mostly.** All 3 stage-paced runs land on a valid showing: Cinema Detroit 9:30 PM, ends 11:28 PM, the only one that fits at the nearest cinema. "자정" was read correctly as an end time every time, and 15 miles was never violated. 2 of 3 reached a confirmed booking. The weak spot is the seat line: in 1 of 3 runs the agent marked nothing and asked "어느 좌석을 말씀하신 건가요?" four times in a row. |
| **B IMAX 밤** | **No (0 of 3).** The agent never tells the visitor that IMAX exists only 20.4 miles out. It filters to ≤15 mi without checking IMAX, books its way to a non-IMAX cinema, finds the dead end only at the showtime screen, and then offers **"날짜를 바꿔볼까요?"** That fallback contradicts the visitor's own "목요일" and cannot fix anything, because the cinema has no IMAX on any day. It never offers to drop IMAX or relax the distance. |
| **C 가족 낮 상영** | **Yes, with friction.** 2 of 3 runs reached a correct confirm read-back (Wildwood, Thu 1:15 PM, ends 3:01 PM, three adjacent seats). The runtime re-sort happened 3/3. The PG filter happened 1/3; the other 2 runs only highlighted. One run went **silent for 90 s** after "첫 번째 걸로 할게요". |
| **Quick 1 영화** | ✅ 5 → 2 films, ratings shown. The settle took 19.7 s of narration. |
| **Quick 2 영화관** | ⚠️ 5 → 3 cinemas with miles shown, but **no reorder by distance** (2 of 2 runs), and 23 s of narration. |
| **Quick 3 날짜** | ⚠️ The two weekend days are **highlighted, not left standing alone**: all 6 stay on the calendar (2 of 2 runs). |
| **Quick 4 상영 시간** | ✅ 16 → 3 with end times shown, but it took **41 s** with five spoken sentences. Two of the three survivors read identically: "8:10 PM · 종료 10:14 PM" (one is IMAX, one is 3D). |
| **Quick 5 좌석** | ❌ **Nothing lights up** (2 of 2). The agent asks "E열인가요, F열인가요?" instead. The planner's Highlight-economy ceiling (≤3 choices) forbids marking the 7 pairs the card counts on. |

Three findings go beyond the cards:

- **Typing does not work.** Switching voice off leaves the composer read-only ("마이크를 눌러 말하세요"), so the quick card's own line "주변이 시끄러우면 타이핑으로 하셔도 됩니다" is false.
- **Every full card gets an extra date-confirmation turn.** At the date stage the agent asks to confirm a day the visitor already said ("오늘 날짜로 할까요?", "Nov 5 (Thu)로 할까요?"). This happened in 9 of 9 runs that reached the date stage.
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

## Card C: 가족 낮 상영

**Expected:** nothing blocks. Films are filtered to PG or under and re-sorted by runtime, a showing on Thu 5 Nov ends by 5 PM, and the party gets three adjacent seats.

| Run | Mode | Trace | Outcome |
|---|---|---|---|
| C1v | voice | `demo-st_3a7e79b6…-20261024-102843` | ✅ PG filter (5 → 2) and duration sort. Then "첫 번째 걸로 할게요." got **nothing: 90 s of silence.** The planner chose `respond` with an empty message, and under spoken brevity that is no speech, no tool, and no retry. |
| C2v | voice | `demo-st_7c0018369…-20261024-103106` | Reached confirm: Wildwood, Emagine Royal Oak, Thu 1:15 PM (ends 3:01 PM), E1–E3, $63. At the movie stage it highlighted PG films instead of filtering. At the seat stage it **highlighted E1–E4 (four seats) for a party of three**, then selected E1–E3. Stopped one "네" short because the driver's follow-up cap was then 6. |
| C3t | text | `demo-st_43257afd…-20261024-103328` | Reached confirm: Wildwood, Emagine, Thu 1:15 PM, **B1–B3** (second row of six), $45. The time stage filtered `endTime ≤ 17:00`. It stopped at the confirm question for the same cap reason. |

- **Runtime sort:** 3/3. **PG filter:** 1/3; the other two highlighted Aang and Wildwood but left all five films on screen. Either way, the card's "PG 이하로 걸러진다" is only half true as shown.
- After "짧을수록 좋아요" the planner asks which film rather than selecting the shorter one. That is by design: a soft preference does not decide. Only C3t suggested Wildwood ("Wildwood가 더 짧은 상영 시간 선호에 맞아요. Wildwood로 할까요?").
- **5 PM end time:** correct whenever it was applied (C2v, C3t). Only 1:15 PM survives at Emagine.
- **Seats:** "세 자리 붙어서요. 앞줄은 말고요." never produced a highlight on its own (3/3), because there are too many qualifying blocks. A highlight came only after the driver said "추천해 주시는 자리로 할게요". Once it was the wrong size (4 seats), and once it was row B of A–F, which a visitor may not count as "앞줄 말고".
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

All quick-card runs were voice on, from `/demo/card#c=<id>&k=<code>&lang=ko`. A quick card never sends `spokenBrevity` (`plannerWritesForTheEar` excludes `quickStartCard`), so it narrates every step. That is why these settle times are long.

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
| 3 | **Seat highlights blocked by the Highlight-economy ceiling (≤3).** Quick card 5 lights nothing. Card A/C seat lines usually get a question instead of marks; when a mark appears it is the wrong size (E1–E4 for three) or is announced as "선택했어요". | Q5 2/2, A3v, C1–3 | **High.** Card 5's whole "watch" claim fails, and A/C end in "좌석 번호를 말씀해 주세요" loops. |
| 4 | **Silent `respond`.** An empty message under spoken brevity produces no speech, no action and no retry. | C1v (90 s) | **High** when it happens: the visitor stands in silence. Seen in 1 of 6 voice full-card runs. |
| 5 | **Redundant date confirmation (`[ask-remembered]`).** The visitor's opening line has scrolled out of the 8–12-entry history by the date stage, so a `pref_…` preference the visitor stated is treated as "remembered". | every full run that reached the date stage (9/9) | **Medium.** One extra yes per card, and the visitor wonders "I just said 오늘". |
| 6 | **Ordinal or delegating answers handled inconsistently.** "첫 번째 걸로" is sometimes selected, sometimes confirmed ("…을 말씀하신 건가요?"), refused 3×, or met with silence. "추천해 주세요" sometimes recommends and sometimes asks again. | A3v, B2t, B3v, B4v, C1v | **Medium.** These are the most natural Korean shortcuts at a booth. |
| 7 | **Quick cards narrate every step:** 19–42 s to settle, 3–5 sentences each. | Q1, Q2, Q4 | **Medium.** The quick cards exist for 90-second visitors. |
| 8 | **Quick cards 2 and 3 only partly match their "watch" lines:** no distance sort (2), and highlight instead of 6 → 2 (3). Quick card 4 shows two identical "8:10 PM" rows. | Q2 2/2, Q3 2/2, Q4 | **Medium.** The presenter says one thing and the screen does another. |
| 9 | **Memory panel language is unstable:** English for A/B, Korean for C. | all runs | **Low–medium.** Card A promises the side panel. |
| 10 | **English inside Korean speech and GUI** (dates, "miles", ISO date at confirm, untranslated chrome). | all runs | **Low.** Understandable, but it reads unfinished to a Korean audience. |
| 11 | **Invented threshold** for "다운타운에서 가까운 곳" (filter ≤9 mi). | A1 (1/4) | **Low.** Corrected by the next card line. |
| 12 | **Abandoned sessions hold demo capacity** for 15 min. | runs B1v, A4t/C3t first attempt | **Low** at KSEA scale; worth knowing. |

## Concrete fixes (not implemented; for dispatch)

1. **B dead end.**
   - `apps/tuning-agent/src/llm/llmExtractor.ts`: a format requirement (IMAX, 3D, Dolby) should also be relevant to `theater`, since `amenities` carries it.
   - `apps/tuning-agent/src/core/planner.ts`: `priorStageAlternativeCounts` should apply every hard preference relevant to a stage, not only those with a filter binding, so "목요일" makes the date count 0.
   - `apps/tuning-agent/src/llm/llmPlanner.ts` (CP_MEMORY_PROMPT_RULES, Dead-end handling, around lines 353–368): when the blocking requirement is satisfiable only where another hard requirement excludes it, name both requirements and ask which to relax instead of proposing a backtrack.
   - Add a `card-b` case to a regress script (pattern: `decisiveSelection.regress.ts`).
2. **Typing fallback.**
   - `apps/frontend/src/components/chat/ChatInput.tsx`: make `isVoiceComposer` depend on `voiceModeEnabled`, not only on `voiceModeAvailable`, so turning the mic off gives a typable box.
   - Alternatively, if that is unwanted, drop the "타이핑" sentence from `quickCardMicNote` in `apps/frontend/src/i18n/strings.ts`.
3. **Seat highlights.** Either:
   - change the cards: quick card 5 should name a row ("뒤쪽 E열로 두 자리요"), and A/C should delegate explicitly ("가운데쯤 한 자리 골라 주세요"); or
   - `llmPlanner.ts` (Highlight economy plus DECISIVE_SELECTION_RULES): when the visitor delegates ("추천", "골라 주세요"), mark one whole choice of the stated party size and say "추천해 드린 자리" rather than "선택했어요".
   - In both cases, fix the four-seat highlight: Highlight economy already says to mark a choice whole and of the party size, so add a regress case for three-seat parties.
4. **Silent respond.** `apps/tuning-agent/src/index.ts` (around line 1618, `maybeSendAssistantMessage`): a `respond` with empty text is never a valid end of turn. Re-plan once, or fall back to the stage question in the session language.
5. **`[ask-remembered]` scope.** `llmPlanner.ts:697`: limit rule (6) to `prf_` (preloaded) ids. A `pref_` id was extracted from this session's speech, so it counts as stated even after it scrolls out of history (`MAX_HISTORY_ENTRIES = 12`, `RECENT_WINDOW = 8` in `core/planner.ts`).
6. **Ordinals.** `llmPlanner.ts` DECISIVE_SELECTION_RULES (1): list a positional reference to a visible list ("첫 번째", "맨 위", "the first one") as a named option.
7. **Quick-card verbosity.** `apps/frontend/src/pages/ChatPage.tsx:799`: consider letting a quick card send `spokenBrevity` too, or cap quick-card narration to the final sentence through `QUICK_CARD_VOICE_VERBOSITY`. Measure the change with `spokenBrevity.regress.ts`.
8. **Quick cards 2–4.**
   - `apps/frontend/src/study/quickDemoCards.ts`: reword the `watch` lines to match what the planner does, so card 2 drops "거리순 재정렬" and card 3 says "주말 두 날이 강조됩니다". Alternatively add "가까운 순으로" to card 2's line so a sort is asked for.
   - For card 4, include the format in time labels (augment) so the two 8:10 rows differ.
9. **Memory language.** `llmExtractor.ts`: pass the conversation language and write `description` in it (the panel already takes it verbatim).
10. **Capacity.** `apps/backend/src/study/sessionService.ts`: finish a demo session when its last host socket closes, or shorten the idle timeout for demo sessions.

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
