#!/usr/bin/env python3
"""
Builds the printed scenario cards for the UIST 2026 booth.

A card at a busy demo reception has about ten seconds of someone's attention
while they are still standing up. So each one carries one line to say out loud,
the handful of conditions to hold them to, and nothing else. The situation, the
numbered walkthrough and the explanation all live in the running system, where
the visitor is already looking.

Output is US Letter, two half-letter cards per sheet, single-sided. Cut once
along the dashed line and you have four cards. Single-sided on purpose: duplex
alignment varies by printer and a booth is not the place to discover that yours
registers the back a few millimetres off.

    python3 scripts/build-demo-cards.py
    python3 scripts/build-demo-cards.py --out docs/scenarios/uist2026-demo-cards.pdf

Requires reportlab (pip install reportlab).
"""
import argparse
import json
import os
import sys

from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas

PAGE_W, PAGE_H = letter          # 612 x 792 pt
CARD_H = PAGE_H / 2              # 396 pt \u2014 half letter, landscape
MARGIN = 34

ACCENT = Color(0.898, 0.035, 0.078)   # the app's primary red
INK = Color(0.10, 0.10, 0.11)
MUTED = Color(0.42, 0.42, 0.45)
RULE = Color(0.82, 0.82, 0.84)

FOOTER = "Today is Tuesday, 3 November 2026.  Films and cinemas are real; showtimes and seats are simulated."

# The line to say, the conditions to hold to, and one line on what to watch.
# The conditions are compressions of the scenario's stepBriefs, written for
# glancing at mid-conversation rather than reading; CARD_PAGES is checked against
# the catalog at build time so a card cannot outlive the scenario it belongs to.
CARD_EXTRAS = {
    "demo_card_a_tonight": {
        "letter": "A",
        "short_title": "Tonight, after the reception",
        "opener": "I want to see Klara and the Sun tonight, somewhere close to downtown.",
        "replies": [
            "Nothing more than 15 miles out.",
            "It has to start after 8, and I want to be back by midnight.",
            "Just one seat, near the middle \u2014 not the front rows.",
        ],
        "watch": "Watch the side panel: what you say turns into constraints.",
    },
    "demo_card_b_imax_night": {
        "letter": "B",
        "short_title": "IMAX night with a co-author",
        "opener": "My co-author and I want to see Street Fighter in IMAX on Thursday night.",
        "replies": [
            "I'm not driving more than 15 miles.",
            "After 6:30, and out by 11.",
            "Two seats together, not the front rows.",
        ],
        "watch": "This one cannot be booked as asked. Watch it notice, and back out.",
    },
    "demo_card_c_family_matinee": {
        "letter": "C",
        "short_title": "Family matinee before the flight",
        "opener": "I'm taking two kids to a movie on Thursday afternoon.",
        "replies": [
            "It has to be PG or under, and shorter is better.",
            "We need to be out by 5 for a flight.",
            "Three seats together, not the front rows.",
        ],
        "watch": "Nothing here blocks anything \u2014 watch it re-sort instead.",
    },
    "demo_open_booking": {
        "letter": "STAR",
        "short_title": "Book whatever you actually want",
        "opener": "I'm looking for something to see this week.",
        "replies": None,   # the listings take this slot instead
        "watch": "Change your mind halfway through and watch it re-plan.",
    },
}

CARD_PAGES = [
    ["demo_card_a_tonight", "demo_card_b_imax_night"],
    ["demo_card_c_family_matinee", "demo_open_booking"],
]


def load_reference(path):
    """
    The week's films and cinemas, read from the generated dataset so the card
    cannot advertise a lineup the agent is not actually offering.
    """
    with open(path, encoding="utf-8") as handle:
        dataset = json.load(handle)

    # Two lengths of the same list: the card uses the fuller one where the layout
    # has room for it and falls back to the terse one where it does not.
    films = " \u00b7 ".join(
        "%s (%s, %s)" % (movie["title"].split(":")[0], movie["ageRating"], movie["duration"])
        for movie in dataset["movies"]
    )
    films_terse = " \u00b7 ".join(
        "%s (%s)" % (movie["title"].split(":")[0], movie["ageRating"])
        for movie in dataset["movies"]
    )
    distances = sorted(theater["distanceMiles"] for theater in dataset["theaters"])
    cinemas_summary = "%d cinemas, %.1f to %.0f miles out." % (
        len(distances),
        distances[0],
        distances[-1],
    )
    return {"films": films, "films_terse": films_terse, "cinemas_summary": cinemas_summary}


def load_catalog(path):
    with open(path, encoding="utf-8") as handle:
        catalog = json.load(handle)
    return {entry["id"]: entry for entry in catalog.get("scenarios", [])}


def wrapped(c, text, font, size, width):
    return simpleSplit(text, font, size, width)


def draw_paragraph(c, text, x, y, width, font, size, leading, color):
    """Draws wrapped text downward from y and returns the new y."""
    c.setFont(font, size)
    c.setFillColor(color)
    for line in wrapped(c, text, font, size, width):
        c.drawString(x, y, line)
        y -= leading
    return y


def paragraph_height(c, text, width, font, size, leading):
    return len(wrapped(c, text, font, size, width)) * leading


def draw_star(c, cx, cy, radius):
    """A five-pointed star as a path — Helvetica has no star glyph to rely on."""
    import math

    path = c.beginPath()
    for index in range(10):
        angle = math.pi / 2 + index * math.pi / 5
        r = radius if index % 2 == 0 else radius * 0.42
        x = cx + r * math.cos(angle)
        y = cy + r * math.sin(angle)
        if index == 0:
            path.moveTo(x, y)
        else:
            path.lineTo(x, y)
    path.close()
    c.drawPath(path, stroke=0, fill=1)


def draw_card(c, origin_y, scenario, extras, reference):
    """Draws one half-letter card with its bottom-left corner at (0, origin_y)."""
    left = MARGIN
    right = PAGE_W - MARGIN
    top = origin_y + CARD_H - MARGIN
    inner_w = right - left

    # --- header: enough for the presenter to grab the right card ------------
    badge = 24
    c.setFillColor(ACCENT)
    c.roundRect(left, top - badge + 4, badge, badge, 4.5, stroke=0, fill=1)
    c.setFillColor(Color(1, 1, 1))
    if extras["letter"] == "STAR":
        draw_star(c, left + badge / 2, top - badge + 16, 8)
    else:
        c.setFont("Helvetica-Bold", 13)
        c.drawCentredString(left + badge / 2, top - badge + 11, extras["letter"])

    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(left + badge + 10, top - badge + 11, extras["short_title"])

    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 7)
    c.drawRightString(right, top - badge + 11, "M A E S T R O   \u00b7   U I S T   2 0 2 6")

    # --- the body, centred between the header and the footer ---------------
    # There is deliberately little on a card, and a little content pinned to the
    # top of a lot of paper reads as an unfinished form. Centred, it reads as a
    # card with one thing to do.
    hero_size, hero_lead = 23, 29
    body_size, body_lead = 12.5, 17

    hero_lines = wrapped(c, "\u201c%s\u201d" % extras["opener"], "Helvetica-Oblique", hero_size, inner_w)

    if extras["replies"]:
        # Written as further lines to say rather than a list of conditions. A
        # visitor given a checklist says the first line and then stops; given
        # three more sentences, they keep talking, which is the whole demo.
        detail_label = "IT WILL ASK. ANSWER LIKE THIS \u2014"
        detail_lines = []
        for reply in extras["replies"]:
            for index, line in enumerate(
                wrapped(c, "\u201c%s\u201d" % reply, "Helvetica-Oblique", body_size, inner_w - 12)
            ):
                detail_lines.append((line, INK, index == 0))
    else:
        # The open card scripts nothing, so it shows what is on instead.
        detail_label = "PLAYING, TONIGHT THROUGH SUNDAY"
        detail_lines = [
            (line, INK, False) for line in wrapped(c, reference["films_terse"], "Helvetica", body_size, inner_w)
        ] + [(reference["cinemas_summary"], MUTED, False)]

    block_h = (
        10 + 20                                  # SAY THIS label and its gap
        + len(hero_lines) * hero_lead
        + 24 + 10 + 6                            # gap, detail label, its gap
        + len(detail_lines) * body_lead
        + (4 * max(0, len(extras["replies"] or []) - 1))
    )

    region_top = top - badge - 14
    region_bottom = origin_y + MARGIN + 34
    y = region_top - max(0, (region_top - region_bottom - block_h) / 2)

    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(left, y - 10, "START WITH")
    y -= 30

    c.setFillColor(INK)
    c.setFont("Helvetica-Oblique", hero_size)
    for line in hero_lines:
        c.drawString(left, y - hero_lead + 8, line)
        y -= hero_lead

    y -= 24
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(left, y - 10, detail_label)
    y -= 16

    reply_font = "Helvetica-Oblique" if extras["replies"] else "Helvetica"
    c.setFont(reply_font, body_size)
    for line, color, is_first in detail_lines:
        if extras["replies"] and is_first:
            c.setFillColor(ACCENT)
            c.circle(left + 3, y - body_lead + 9, 1.8, stroke=0, fill=1)
        c.setFillColor(color)
        c.setFont(reply_font, body_size)
        c.drawString(left + (12 if extras["replies"] else 0), y - body_lead + 5, line)
        y -= body_lead

    # --- footer: one line for the presenter, one disclaimer ----------------
    footer_y = origin_y + MARGIN
    c.setFillColor(ACCENT)
    c.setFont("Helvetica-Oblique", 9.5)
    c.drawString(left, footer_y + 16, extras["watch"])

    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.line(left, footer_y + 10, right, footer_y + 10)

    c.setFillColor(MUTED)
    c.setFont("Helvetica", 6.8)
    c.drawString(left, footer_y, FOOTER)

    return y - (footer_y + 30)


def draw_cut_line(c):
    c.saveState()
    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.setDash(3, 3)
    c.line(18, CARD_H, PAGE_W - 18, CARD_H)
    c.restoreState()

    label = "cut here"
    c.setFont("Helvetica", 6)
    width = c.stringWidth(label, "Helvetica", 6)
    c.setFillColor(Color(1, 1, 1))
    c.rect(PAGE_W / 2 - width / 2 - 5, CARD_H - 3.5, width + 10, 7, stroke=0, fill=1)
    c.setFillColor(MUTED)
    c.drawCentredString(PAGE_W / 2, CARD_H - 2, label)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="apps/backend/scenarios/catalog.json")
    parser.add_argument("--dataset", default="apps/backend/scenarios/data/demo_uist2026_detroit.json")
    parser.add_argument("--out", default="docs/scenarios/uist2026-demo-cards.pdf")
    args = parser.parse_args()

    scenarios = load_catalog(args.catalog)
    reference = load_reference(args.dataset)
    printed = [card for page in CARD_PAGES for card in page]
    missing = [card for card in printed if card not in scenarios]
    if missing:
        print(f"[cards] catalog is missing: {', '.join(missing)}", file=sys.stderr)
        return 1

    # A demo scenario with no card would go undemonstrated; a card with no
    # scenario would send someone to a session that cannot be started.
    uncarded = [key for key in scenarios if key.startswith("demo_") and key not in printed]
    if uncarded:
        print(f"[cards] catalog has demo scenarios with no card: {', '.join(uncarded)}", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    c = canvas.Canvas(args.out, pagesize=letter)
    c.setTitle("MAESTRO demo cards - UIST 2026, Detroit")
    c.setAuthor("MAESTRO")

    for page_index, page in enumerate(CARD_PAGES):
        for slot, scenario_id in enumerate(page):
            # slot 0 is the top half of the sheet, slot 1 the bottom.
            origin_y = CARD_H if slot == 0 else 0
            slack = draw_card(
                c, origin_y, scenarios[scenario_id], CARD_EXTRAS[scenario_id], reference
            )
            print(f"[cards] {scenario_id:<28} vertical slack {slack:6.1f} pt")
            if slack < 0:
                print(f"[cards] {scenario_id} overflows by {-slack:.1f} pt", file=sys.stderr)
        draw_cut_line(c)
        if page_index < len(CARD_PAGES) - 1:
            c.showPage()

    c.save()
    print(f"[cards] {args.out} — {sum(len(p) for p in CARD_PAGES)} cards on {len(CARD_PAGES)} letter sheets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
