# Generated demo world — UIST 2026, Detroit

The booth demo does not run on a hand-authored scenario. It runs on a world that
is generated from rules, because the people it is demonstrated to are conference
attendees who state their own preferences rather than reading from a card.

Hand-authored datasets could not support that. In the study scenarios, the paths
the participant was not scripted to take often had a single option or none at
all, and seat occupancy was uniform noise — the front row as full as the middle,
every showing at 70-80%. That is invisible while everyone follows the script and
obvious the moment someone does not.

## Running it

```bash
npm run scenarios:generate            # rewrite the dataset (default seed 20261103)
npm run scenarios:generate -- --seed 42
npm run check:scenarios               # verify the checked-in dataset still matches
npm run db:seed:scenarios             # rebuild the template DBs from the dataset
```

Generation is deterministic: the same seed always produces the same world, so a
problem found at the booth can be reproduced afterwards.

## What it generates

Five films genuinely in theaters on Tuesday 3 November 2026 and five real
Detroit-area cinemas, over the six days from the demo reception through Sunday
8 November. Roughly 680 showings and 50,000 seats.

Titles, release dates, theater names, distances, screen counts and amenities are
real. **Runtimes, MPAA ratings, critic scores, house layouts, prices and every
showtime are invented** — those values do not exist yet for unreleased films.
Anything printed for visitors should say the showtimes are simulated.

## The rules

*Lineups.* A 16-plex carries everything. A two-screen arthouse carries the
prestige title and family animation, not a tournament-fighter tentpole. A
single-screen repertory house runs one title a night and cycles through its
repertory. Large-format screens run every day, with the title rotating so the
biggest release takes the IMAX screen every other day and the others still get
their turn — and a cinema has the auditoriums it has, so only one title can be in
IMAX on a given day.

*Showtimes.* Each screen is planned across the theater's operating window: the
number of slots that fit between opening and last-start, spread so the last show
lands near closing. One screen showing one film therefore produces a regular
series; the ragged look of a real listing comes from screens opening at different
times. Weekday openings are pushed back at the multiplexes only — pushing back a
two-screen evening house takes its late show off the board, which is how an
after-dinner plan ends up with nothing to book.

*Seats.* Occupancy is a function of the film's popularity, the day of the week,
the time of day, the format and the house, and it is filled by parties of one to
four rather than seat by seat. Parties take the middle of the room first and the
front corners last, split up when they cannot sit together, and leave a courtesy
seat between strangers when the room is quiet. A quiet house comes out with empty
front rows and clustered groups in the middle; a busy one fills to the edges.

## The invariants

`invariants.ts` asserts the properties that keep every branch of the booking tree
alive, and the generator refuses to write a dataset that violates any of them.
Among them: every film plays at three or more cinemas and on every date; every
cinema-day-film has at least two showtimes; every advertised format runs every
day; no two showings overlap on one screen; no showing sells out; every showing
keeps two adjacent seats free; and every film-date keeps a four-seat block and a
premium pair somewhere.

`cardFeasibility.ts` additionally checks the three printed cards, which are the
one part of the demo with constraints fixed in advance and therefore the one part
that can quietly stop working when the world is regenerated. Cards A and C must
resolve to several options across several cinemas. Card B must **not** resolve —
the only IMAX in the region is 20 miles out and the card will not drive past 15,
which is the conflict it exists to trigger — and must have at least two ways out.

Both run inside `npm run check`.

## Printed cards

Visitors who arrive without a plan get a card. Four of them — three scripted
scenarios and one that tells the visitor to book whatever they actually want,
which is the default for conference attendees.

```bash
npm run cards:build        # -> docs/scenarios/uist2026-demo-cards.pdf
```

US Letter, two half-letter cards per sheet, **single-sided**. Print two sheets,
cut each once along the dashed line, and you have the set. Single-sided is
deliberate: duplex back-registration varies by printer and a booth is not where
you want to find out about yours.

A card at a busy reception has roughly ten seconds of someone's attention while
they are still standing up, so each one carries **one line to say out loud**, set
large, and the handful of conditions to hold them to, written as fragments to
glance at rather than sentences to read. The situation, the walkthrough and the
explanation are all in the running system, which is where the visitor is already
looking. A small line at the foot says what to watch for — that one is really for
whoever is presenting.

Card B is the one that cannot be booked as printed. That is the point of it.

The card's title comes from the catalog and the film list from the generated
dataset. The spoken line and the condition fragments are written in
`scripts/build-demo-cards.py`, because a compression of the scenario's step
briefs is an editorial act, not a transformation. They can therefore drift from
the catalog: the build only guarantees that every printed card has a scenario and
every `demo_*` scenario has a card, so re-read the fragments after changing a
scenario's constraints.

Requires `reportlab` (`pip install reportlab`); it is the only dependency outside
the Node workspaces.
