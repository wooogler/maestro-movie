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

There are two sets, and they are for two different visitors.

    --set full   The original four. A visitor with a few minutes books a ticket
                 end to end, and the card gives them a situation to hold to.

    --set quick  Five cards, one per selection stage, for the visitor who has
                 ninety seconds. Each carries a QR that opens the booking UI
                 ALREADY on that stage, with everything before it chosen, so the
                 whole demo is one sentence and what it does to the screen. The
                 QR embeds the booth's access code, which is why --code is
                 required: a quick card is a bearer credential, and it is printed
                 for one event.

And there are two languages, for two events.

    --lang en    UIST 2026 in Detroit, the default. Helvetica, as it always was.

    --lang ko    The KSEA Southern Chapter Poster Symposium at Virginia Tech.
                 Every printed string is Korean except the names of films and
                 cinemas, which stay as the app shows them. Set in Noto Sans KR,
                 embedded from scripts/fonts/ so the sheet prints the same on any
                 printer; Korean has no italic, so the lines a visitor says are
                 set upright and the gold of the "watch" line carries alone what
                 the oblique carried with it in English.

    python3 scripts/build-demo-cards.py
    python3 scripts/build-demo-cards.py --set quick --code AB12CD \
        --base-url https://maestro.cs.vt.edu
    python3 scripts/build-demo-cards.py --lang ko
    python3 scripts/build-demo-cards.py --lang ko --set quick --code AB12CD

Requires reportlab (pip install reportlab).
"""
import argparse
import json
import os
import re
import sys

from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.graphics.barcode import qr
from reportlab.graphics import renderPDF
from reportlab.graphics.shapes import Drawing

PAGE_W, PAGE_H = letter          # 612 x 792 pt
CARD_H = PAGE_H / 2              # 396 pt \u2014 half letter, landscape
MARGIN = 34

# The UIST 2026 palette, same split the app uses: teal is the system, gold is the
# thing the visitor is meant to notice. The gold is the darkened print value --
# UIST's #BD8C3D only reaches 3:1 on white, too thin for 9.5pt italic.
ACCENT = Color(0.008, 0.514, 0.573)   # UIST teal #028392
GOLD = Color(0.494, 0.353, 0.118)     # UIST gold, darkened for paper
INK = Color(0.161, 0.157, 0.149)      # UIST charcoal #292826
MUTED = Color(0.416, 0.400, 0.369)
RULE = Color(0.835, 0.816, 0.776)

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")

# Everything about a card that changes with the language it is printed in.
#
# Fonts are named by ROLE rather than by face. "voice" is whatever the words a
# visitor says out loud are set in: oblique in English, upright in Korean, which
# has no italic and only looks broken when one is synthesised by slanting it.
#
# Sizes are per language as well. Hangul fills more of its em than Latin does,
# so the same point size reads larger and darker; the Korean card sets its hero
# line a size down and gives every line more leading rather than squeezing the
# English numbers. The English values are the ones the UIST sheets were printed
# with and must not move.
LANGUAGES = {
    "en": {
        "fonts": {"regular": "Helvetica", "bold": "Helvetica-Bold", "voice": "Helvetica-Oblique"},
        "hero": (23, 29),
        "body": (12.5, 17),
        "quick_hero": (21, 26),
        "label_size": 8,
        "brand": "M A E S T R O   \u00b7   U I S T   2 0 2 6",
        "footer": "Today is Tuesday, 3 November 2026.  Films and cinemas are real; showtimes and seats are simulated.",
        "quick_footer": "Scan, tap once, and say the line. Everything before this step is already chosen for you.",
        "start_label": "START WITH",
        "replies_label": "IT WILL ASK. ANSWER LIKE THIS \u2014",
        "listings_label": "PLAYING, TONIGHT THROUGH SUNDAY",
        "scan_label": "SCAN THIS",
        "say_label": "THEN SAY THIS",
        "cut_label": "cut here",
        "cinemas_summary": "%(count)d cinemas, %(nearest).1f to %(farthest).0f miles out.",
        "full_title": "MAESTRO demo cards - UIST 2026, Detroit",
        "quick_title": "MAESTRO quick demo cards - UIST 2026, Detroit",
        "full_out": "docs/scenarios/uist2026-demo-cards.pdf",
        "quick_out": "docs/scenarios/uist2026-quick-cards.pdf",
    },
    "ko": {
        "fonts": {"regular": "NotoSansKR", "bold": "NotoSansKR-Bold", "voice": "NotoSansKR"},
        "hero": (21, 30),
        "body": (12, 18),
        "quick_hero": (19.5, 28),
        "label_size": 8.5,
        "brand": "M A E S T R O   \u00b7   K S E A   2 0 2 6",
        "footer": "\uc624\ub298\uc740 2026\ub144 11\uc6d4 3\uc77c \ud654\uc694\uc77c\uc785\ub2c8\ub2e4.  \uc601\ud654\uc640 \uc601\ud654\uad00\uc740 \uc2e4\uc81c\uc774\uace0, \uc0c1\uc601 \uc2dc\uac04\uacfc \uc88c\uc11d\uc740 \uc2dc\ubbac\ub808\uc774\uc158\uc785\ub2c8\ub2e4.",
        "quick_footer": "\uc2a4\uce94\ud558\uace0 \ud55c \ubc88 \ud0ed\ud55c \ub2e4\uc74c, \uc774 \ubb38\uc7a5\uc744 \ub9d0\ud558\uc138\uc694. \uc774 \ub2e8\uacc4 \uc804\uae4c\uc9c0\ub294 \uc774\ubbf8 \uace8\ub77c\uc838 \uc788\uc2b5\ub2c8\ub2e4.",
        "start_label": "\uc774\ub807\uac8c \uc2dc\uc791\ud558\uc138\uc694",
        "replies_label": "\uc5d0\uc774\uc804\ud2b8\uac00 \ubb3c\uc5b4\ubcf4\uba74 \uc774\ub807\uac8c \ub2f5\ud558\uc138\uc694 \u2014",
        "listings_label": "\uc624\ub298 \ubc24\ubd80\ud130 \uc77c\uc694\uc77c\uae4c\uc9c0 \uc0c1\uc601\uc791",
        "scan_label": "QR\uc744 \uc2a4\uce94\ud558\uc138\uc694",
        "say_label": "\uadf8\ub9ac\uace0 \uc774\ub807\uac8c \ub9d0\ud558\uc138\uc694",
        "cut_label": "\uc790\ub974\ub294 \uc120",
        "cinemas_summary": "\uc601\ud654\uad00 %(count)d\uacf3, %(nearest).1f~%(farthest).0f\ub9c8\uc77c \uac70\ub9ac.",
        "full_title": "MAESTRO \ub370\ubaa8 \uce74\ub4dc - KSEA 2026, Virginia Tech",
        "quick_title": "MAESTRO \ube60\ub978 \ub370\ubaa8 \uce74\ub4dc - KSEA 2026, Virginia Tech",
        "full_out": "docs/scenarios/ksea2026-demo-cards.ko.pdf",
        "quick_out": "docs/scenarios/ksea2026-quick-cards.ko.pdf",
        # How a Korean visitor would say each film, printed beside the title the
        # app shows. Each reading is one the agent's Korean STT aliases already
        # resolve (KO_ALIASES in decisiveSelection.regress.ts), so saying what
        # the card says is saying something the agent understands. A film with
        # no entry is printed under its English title alone.
        "film_readings": {
            "Street Fighter": "\uc2a4\ud2b8\ub9ac\ud2b8 \ud30c\uc774\ud130",
            "Klara and the Sun": "\ud074\ub77c\ub77c\uc640 \ud0dc\uc591",
            "Wildwood": "\uc640\uc77c\ub4dc\uc6b0\ub4dc",
            "The Legend of Aang": "\ub808\uc804\ub4dc \uc624\ube0c \uc544\uc559",
            "Clayface": "\ud074\ub808\uc774\ud398\uc774\uc2a4",
        },
    },
}

# Korean is the one language here Helvetica cannot draw. Its faces are the
# static Noto Sans KR Regular and Bold cuts (SIL OFL, licence beside them), and
# reportlab subsets a TrueType font on embedding, so the PDF carries only the
# glyphs the cards actually use rather than all six megabytes of each file.
EMBEDDED_FONTS = {
    "ko": {
        "NotoSansKR": "NotoSansKR-Regular.ttf",
        "NotoSansKR-Bold": "NotoSansKR-Bold.ttf",
    },
}


def register_fonts(lang):
    for name, filename in EMBEDDED_FONTS.get(lang, {}).items():
        pdfmetrics.registerFont(TTFont(name, os.path.join(FONT_DIR, filename)))


# The line to say, the conditions to hold to, and one line on what to watch,
# once per language. The conditions are compressions of the scenario's step
# briefs, written for glancing at mid-conversation rather than reading. Cards
# A-C are no longer catalog scenarios (the booth opens one demo world and the
# visitor holds the scenario on paper); what keeps their conditions honest is
# apps/backend/src/db/generator/cardFeasibility.ts, which checks each card's
# constraints against the generated world under the same ids as here.
CARD_EXTRAS = {
    "demo_card_a_tonight": {
        "letter": "A",
        "en": {
            "short_title": "Tonight, after the reception",
            "opener": "I want to see Klara and the Sun tonight, somewhere close to downtown.",
            "replies": [
                "Nothing more than 15 miles out.",
                "It has to start after 8, and I want to be back by midnight.",
                "Just one seat, near the middle \u2014 not the front rows.",
            ],
            "watch": "Watch the side panel: what you say turns into constraints.",
        },
        "ko": {
            "short_title": "\uc624\ub298 \ubc24, \ub9ac\uc149\uc158 \ub05d\ub098\uace0",
            "opener": "\uc624\ub298 \ubc24\uc5d0 \ud074\ub77c\ub77c\uc640 \ud0dc\uc591 \ubcf4\uace0 \uc2f6\uc5b4\uc694. \ub2e4\uc6b4\ud0c0\uc6b4\uc5d0\uc11c \uac00\uae4c\uc6b4 \uacf3\uc73c\ub85c\uc694.",
            "replies": [
                "15\ub9c8\uc77c \ub118\ub294 \ub370\ub294 \uc548 \ub3fc\uc694.",
                "8\uc2dc \uc774\ud6c4\uc5d0 \uc2dc\uc791\ud574\uc57c \ud558\uace0, \uc790\uc815 \uc804\uc5d0\ub294 \ub3cc\uc544\uc640\uc57c \ud574\uc694.",
                "\ud55c \uc790\ub9ac\ub9cc\uc694. \uac00\uc6b4\ub370\ucbe4\uc73c\ub85c, \uc55e\uc904\uc740 \ub9d0\uace0\uc694.",
            ],
            "watch": "\uc606 \ud328\ub110\uc744 \ubcf4\uc138\uc694. \ub9d0\ud55c \uac83\uc774 \uc870\uac74\uc73c\ub85c \ubc14\ub01d\ub2c8\ub2e4.",
        },
    },
    "demo_card_b_imax_night": {
        "letter": "B",
        "en": {
            "short_title": "IMAX night with a co-author",
            "opener": "My co-author and I want to see Street Fighter in IMAX on Thursday night.",
            "replies": [
                "I'm not driving more than 15 miles.",
                "After 6:30, and out by 11.",
                "Two seats together, not the front rows.",
            ],
            "watch": "This one cannot be booked as asked. Watch it notice, and back out.",
        },
        "ko": {
            "short_title": "\uacf5\uc800\uc790\uc640 IMAX \ubcf4\ub294 \ubc24",
            "opener": "\uacf5\uc800\uc790\ub791 \uac19\uc774 \ubaa9\uc694\uc77c \ubc24\uc5d0 \uc2a4\ud2b8\ub9ac\ud2b8 \ud30c\uc774\ud130\ub97c IMAX\ub85c \ubcf4\ub824\uace0\uc694.",
            "replies": [
                "15\ub9c8\uc77c \ub118\uac8c\ub294 \uc6b4\uc804 \uc548 \ud560 \uac70\uc608\uc694.",
                "6\uc2dc \ubc18 \uc774\ud6c4\uc5d0 \uc2dc\uc791\ud574\uc11c 11\uc2dc\uae4c\uc9c0\ub294 \ub05d\ub098\uc57c \ud574\uc694.",
                "\ub450 \uc790\ub9ac \ubd99\uc5b4\uc11c\uc694. \uc55e\uc904\uc740 \ub9d0\uace0\uc694.",
            ],
            "watch": "\uc774 \uc870\uac74\uc73c\ub85c\ub294 \uc608\ub9e4\uac00 \uc548 \ub429\ub2c8\ub2e4. \uc5d0\uc774\uc804\ud2b8\uac00 \uc54c\uc544\ucc44\uace0 \ub418\ub3cc\uc544\uac00\ub294 \uac83\uc744 \ubcf4\uc138\uc694.",
        },
    },
    "demo_card_c_family_matinee": {
        "letter": "C",
        "en": {
            "short_title": "Family matinee before the flight",
            "opener": "I'm taking two kids to a movie on Thursday afternoon.",
            "replies": [
                "It has to be PG or under, and shorter is better.",
                "We need to be out by 5 for a flight.",
                "Three seats together, not the front rows.",
            ],
            "watch": "Nothing here blocks anything \u2014 watch it re-sort instead.",
        },
        "ko": {
            "short_title": "\ube44\ud589\uae30 \ud0c0\uae30 \uc804, \uac00\uc871 \ub0ae \uc601\ud654",
            "opener": "\ubaa9\uc694\uc77c \uc624\ud6c4\uc5d0 \uc544\uc774 \ub458 \ub370\ub9ac\uace0 \uc601\ud654 \ubcf4\ub7ec \uac00\ub824\uace0\uc694.",
            "replies": [
                "PG \uc774\ud558\uc5ec\uc57c \ud558\uace0, \uc9e7\uc744\uc218\ub85d \uc88b\uc544\uc694.",
                "\ube44\ud589\uae30 \ub54c\ubb38\uc5d0 5\uc2dc\uae4c\uc9c0\ub294 \ub098\uc640\uc57c \ud574\uc694.",
                "\uc138 \uc790\ub9ac \ubd99\uc5b4\uc11c\uc694. \uc55e\uc904\uc740 \ub9d0\uace0\uc694.",
            ],
            "watch": "\ub9c9\ud788\ub294 \uc870\uac74\uc740 \uc5c6\uc2b5\ub2c8\ub2e4. \ub300\uc2e0 \uc21c\uc11c\uac00 \ub2e4\uc2dc \uc815\ub82c\ub418\ub294 \uac83\uc744 \ubcf4\uc138\uc694.",
        },
    },
    "demo_open_booking": {
        "letter": "STAR",
        "en": {
            "short_title": "Book whatever you actually want",
            "opener": "I'm looking for something to see this week.",
            "replies": None,   # the listings take this slot instead
            "watch": "Change your mind halfway through and watch it re-plan.",
        },
        "ko": {
            "short_title": "\uc6d0\ud558\ub294 \ub300\ub85c \uc608\ub9e4\ud558\uae30",
            "opener": "\uc774\ubc88 \uc8fc\uc5d0 \ubcfc \ub9cc\ud55c \uac70 \ucc3e\uace0 \uc788\uc5b4\uc694.",
            "replies": None,
            "watch": "\uc911\uac04\uc5d0 \ub9c8\uc74c\uc744 \ubc14\uafd4 \ubcf4\uc138\uc694. \ub2e4\uc2dc \uacc4\ud68d\ud558\ub294 \uac83\uc744 \ubcfc \uc218 \uc788\uc2b5\ub2c8\ub2e4.",
        },
    },
}

CARD_PAGES = [
    ["demo_card_a_tonight", "demo_card_b_imax_night"],
    ["demo_card_c_family_matinee", "demo_open_booking"],
]


# =============================================================================
# The quick set: one stage, one sentence, one QR
# =============================================================================

# Mirrors apps/frontend/src/study/quickDemoCards.ts, which is the source of
# truth for the ids, the stages and the prefill. Only the printed copy lives
# here — and `verify_quick_copy` refuses to build if a line on paper is not the
# line the app will show the visitor after they scan. That check is the whole
# reason it is safe to keep the copy in two places: a card is printed once and
# handed to strangers for two days, so drift is not something to notice later.
QUICK_CARDS = [
    {
        "id": "movie",
        "badge": "1",
        "title": {"en": "Movies", "ko": "영화"},
        "opener": {
            "en": "I've got my eight-year-old niece with me, so nothing scary.",
            "ko": "여덟 살 조카랑 같이 왔어요. 무서운 건 안 돼요.",
        },
        "watch": {
            "en": "Five films become two — and the age ratings appear on the ones that stay.",
            "ko": "영화 다섯 편이 두 편으로 줄고, 남은 영화에 연령 등급이 붙습니다.",
        },
    },
    {
        "id": "theater",
        "badge": "2",
        "title": {"en": "Cinemas", "ko": "영화관"},
        "opener": {
            "en": "I'm not driving more than 15 miles, and I don't want to pay for parking.",
            "ko": "15마일 넘게는 운전 안 할 거고, 주차비도 내기 싫어요.",
        },
        "watch": {
            "en": "Two cinemas drop out, the rest reorder by distance, and the miles appear.",
            "ko": "영화관 두 곳이 빠지고, 남은 곳은 거리순으로 재정렬되며 거리가 표시됩니다.",
        },
    },
    {
        "id": "date",
        "badge": "3",
        "title": {"en": "Dates", "ko": "날짜"},
        "opener": {
            "en": "It has to be the weekend.",
            "ko": "주말이어야 해요.",
        },
        "watch": {
            "en": "Six days on the calendar, two left standing.",
            "ko": "달력의 여섯 날 중 두 날만 남습니다.",
        },
    },
    {
        "id": "time",
        "badge": "4",
        "title": {"en": "Showtimes", "ko": "상영 시간"},
        "opener": {
            "en": "Nothing before 8, and I need to be out by 11.",
            "ko": "8시 전은 안 되고, 11시까지는 나와야 해요.",
        },
        "watch": {
            "en": "Sixteen showtimes narrow to three — and the end times appear beside them.",
            "ko": "상영 시간 열여섯 개가 세 개로 줄고, 옆에 종료 시각이 표시됩니다.",
        },
    },
    {
        "id": "seat",
        "badge": "5",
        "title": {"en": "Seats", "ko": "좌석"},
        "opener": {
            "en": "Two seats together, toward the back — not the front rows.",
            "ko": "두 자리 붙어서, 뒤쪽으로요. 앞줄은 말고요.",
        },
        "watch": {
            "en": "The pairs that actually fit light up, in place, on the map you were already looking at.",
            "ko": "조건에 맞는 자리 쌍이 보고 있던 좌석표 위에서 그대로 강조됩니다.",
        },
    },
]


def verify_quick_copy(cards_module_path, lang):
    """
    Refuses to print a line the app will not show.

    Each card's title, opener and watch line must appear in that card's block
    of the TypeScript source as the `lang` entry, quoted whole: `ko: '...'` for
    the Korean sheet, `en: '...'` (or `en: "..."`, where the line has an
    apostrophe in it) for the English one. Keyed by language and scoped to the
    card, so a Korean sheet cannot pass on the strength of an English line, or
    one card on the strength of another's. Apostrophes are the one wrinkle --
    TS escapes them inside single quotes -- so the source is normalised first.
    """
    with open(cards_module_path, encoding="utf-8") as handle:
        source = handle.read().replace("\\'", "'")

    # Each card's block runs from its `id:` to the next card's.
    starts = [(match.group(1), match.start()) for match in re.finditer(r"\bid: '([^']+)'", source)]
    blocks = {
        card_id: source[start:(starts[index + 1][1] if index + 1 < len(starts) else len(source))]
        for index, (card_id, start) in enumerate(starts)
    }

    problems = []
    for card in QUICK_CARDS:
        block = blocks.get(card["id"])
        if block is None:
            problems.append("%s: no such card in quickDemoCards.ts" % card["id"])
            continue
        for field in ("title", "opener", "watch"):
            text = card[field][lang]
            if not any("%s: %s%s%s" % (lang, quote, text, quote) in block for quote in "'\""):
                problems.append(
                    "%s: printed %s (%s) is not the one the app shows" % (card["id"], field, lang)
                )
    return problems


def build_quick_url(base_url, card_id, code, lang):
    """
    The link a QR carries. Mirrors `buildQuickDemoCardUrl` in the app.

    Both values ride the FRAGMENT. The access code is a credential that redeems
    the operator's OpenAI key, and a fragment is never sent to the server — so it
    stays out of access logs, proxy history and Referer headers, the same rule
    the companion and memory-mirror QRs follow.

    A sheet in any language but English also carries `lang`, so the phone that
    scans a Korean card opens in Korean. English carries none: it is the app's
    own default, and the UIST sheets were printed without it.
    """
    fragment = "c=%s" % card_id
    if code:
        fragment += "&k=%s" % code
    if lang != "en":
        fragment += "&lang=%s" % lang
    return "%s/demo/card#%s" % (base_url.rstrip("/"), fragment)


def fitted_size(text, font, size, width, floor):
    """The largest size up to `size` at which `text` fits on one line, but never below `floor`."""
    while size > floor and pdfmetrics.stringWidth(text, font, size) > width:
        size -= 0.25
    return size


def draw_quick_card(c, origin_y, card, url, lang):
    """One half-letter quick card: a sentence on the left, the way in on the right."""
    style = LANGUAGES[lang]
    fonts = style["fonts"]
    card = {field: (value[lang] if isinstance(value, dict) else value) for field, value in card.items()}
    left = MARGIN
    right = PAGE_W - MARGIN
    top = origin_y + CARD_H - MARGIN

    # The QR sets the column geometry: it is the one element with a fixed size,
    # and the text has to be told where to stop before it runs under it.
    qr_side = 132
    qr_x = right - qr_side
    qr_y = origin_y + MARGIN + 46
    text_w = qr_x - left - 26

    # --- header -------------------------------------------------------------
    badge = 24
    c.setFillColor(ACCENT)
    c.roundRect(left, top - badge + 4, badge, badge, 4.5, stroke=0, fill=1)
    c.setFillColor(Color(1, 1, 1))
    c.setFont("Helvetica-Bold", 13)
    c.drawCentredString(left + badge / 2, top - badge + 11, card["badge"])

    c.setFillColor(INK)
    c.setFont(fonts["bold"], 13)
    c.drawString(left + badge + 10, top - badge + 11, card["title"])

    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 7)
    c.drawRightString(right, top - badge + 11, style["brand"])

    # --- the QR, and the two words that make it obvious what to do with it ---
    widget = qr.QrCodeWidget(url, barLevel="M", barBorder=1)
    bounds = widget.getBounds()
    drawing = Drawing(qr_side, qr_side, transform=[
        qr_side / (bounds[2] - bounds[0]), 0, 0,
        qr_side / (bounds[3] - bounds[1]), 0, 0,
    ])
    drawing.add(widget)
    renderPDF.draw(drawing, c, qr_x, qr_y)

    c.setFillColor(MUTED)
    c.setFont(fonts["bold"], style["label_size"])
    c.drawCentredString(qr_x + qr_side / 2, qr_y - 14, style["scan_label"])

    # --- the sentence, which is the card ------------------------------------
    hero_size, hero_lead = style["quick_hero"]
    hero_lines = wrapped_at(c, "\u201c%s\u201d" % card["opener"], fonts["voice"], hero_size, text_w, lang)

    block_h = 10 + 20 + len(hero_lines) * hero_lead
    region_top = top - badge - 16
    region_bottom = origin_y + MARGIN + 46
    y = region_top - max(0, (region_top - region_bottom - block_h) / 2)

    c.setFillColor(MUTED)
    c.setFont(fonts["bold"], style["label_size"])
    c.drawString(left, y - 10, style["say_label"])
    y -= 30

    c.setFillColor(INK)
    c.setFont(fonts["voice"], hero_size)
    for line in hero_lines:
        c.drawString(left, y - hero_lead + 8, line)
        y -= hero_lead

    # --- footer -------------------------------------------------------------
    # The watch line has one line of room above the rule, so a long one is set
    # a little smaller rather than wrapped into the rule below it.
    footer_y = origin_y + MARGIN
    watch_size = fitted_size(card["watch"], fonts["voice"], 9.5, right - left, 8)
    c.setFillColor(GOLD)
    c.setFont(fonts["voice"], watch_size)
    c.drawString(left, footer_y + 16, card["watch"])

    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.line(left, footer_y + 10, right, footer_y + 10)

    c.setFillColor(MUTED)
    c.setFont(fonts["regular"], 6.8)
    c.drawString(left, footer_y, style["quick_footer"])

    return y - (footer_y + 30)


def load_reference(path, lang):
    """
    The week's films and cinemas, read from the generated dataset so the card
    cannot advertise a lineup the agent is not actually offering.

    Titles stay as the app shows them, in English, whatever the card's language:
    a visitor matches the card to the screen by them. Where the language has a
    reading for a title, it rides in the parentheses with the rating.
    """
    with open(path, encoding="utf-8") as handle:
        dataset = json.load(handle)
    style = LANGUAGES[lang]
    readings = style.get("film_readings", {})

    def short_title(movie):
        return movie["title"].split(":")[0]

    def annotated(movie, *details):
        title = short_title(movie)
        reading = readings.get(title)
        return "%s (%s)" % (title, ", ".join(((reading,) if reading else ()) + details))

    # Two lengths of the same list: the card uses the fuller one where the layout
    # has room for it and falls back to the terse one where it does not.
    films = " \u00b7 ".join(
        annotated(movie, movie["ageRating"], movie["duration"]) for movie in dataset["movies"]
    )
    films_terse = " \u00b7 ".join(annotated(movie, movie["ageRating"]) for movie in dataset["movies"])
    distances = sorted(theater["distanceMiles"] for theater in dataset["theaters"])
    cinemas_summary = style["cinemas_summary"] % {
        "count": len(distances),
        "nearest": distances[0],
        "farthest": distances[-1],
    }
    return {"films": films, "films_terse": films_terse, "cinemas_summary": cinemas_summary}


def wrapped(c, text, font, size, width):
    return simpleSplit(text, font, size, width)


# Where a Korean line may break first. Korean wraps between words, but a line
# broken at any space happily strands "안 돼요" as "안 / 돼요" or a modifier
# away from its noun; broken after a sentence or a clause, each line is a thing
# to say. English keeps plain word wrap: its sheets were printed that way.
CLAUSE_BREAK = re.compile(r"(?<=[.,?!])\s+")
LISTING_BREAK = re.compile(r"(?<=·)\s+")


def wrapped_at(c, text, font, size, width, lang, breaks=CLAUSE_BREAK):
    """
    Wraps `text`, preferring to break at `breaks` in languages that ask for it.

    Pieces between break points are packed greedily, whole; a piece wider than
    the line on its own falls back to word wrap. With nothing to prefer, this is
    `wrapped` exactly.
    """
    if lang == "en":
        return wrapped(c, text, font, size, width)
    lines = []
    for piece in breaks.split(text):
        if lines and pdfmetrics.stringWidth(lines[-1] + " " + piece, font, size) <= width:
            lines[-1] += " " + piece
        else:
            lines.extend(wrapped(c, piece, font, size, width))
    return lines


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


def draw_card(c, origin_y, card, reference, lang):
    """Draws one half-letter card with its bottom-left corner at (0, origin_y)."""
    style = LANGUAGES[lang]
    fonts = style["fonts"]
    extras = dict(card[lang], letter=card["letter"])
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
    c.setFont(fonts["bold"], 13)
    c.drawString(left + badge + 10, top - badge + 11, extras["short_title"])

    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 7)
    c.drawRightString(right, top - badge + 11, style["brand"])

    # --- the body, centred between the header and the footer ---------------
    # There is deliberately little on a card, and a little content pinned to the
    # top of a lot of paper reads as an unfinished form. Centred, it reads as a
    # card with one thing to do.
    hero_size, hero_lead = style["hero"]
    body_size, body_lead = style["body"]

    hero_lines = wrapped_at(c, "\u201c%s\u201d" % extras["opener"], fonts["voice"], hero_size, inner_w, lang)

    if extras["replies"]:
        # Written as further lines to say rather than a list of conditions. A
        # visitor given a checklist says the first line and then stops; given
        # three more sentences, they keep talking, which is the whole demo.
        detail_label = style["replies_label"]
        detail_lines = []
        for reply in extras["replies"]:
            for index, line in enumerate(
                wrapped_at(c, "\u201c%s\u201d" % reply, fonts["voice"], body_size, inner_w - 12, lang)
            ):
                detail_lines.append((line, INK, index == 0))
    else:
        # The open card scripts nothing, so it shows what is on instead.
        detail_label = style["listings_label"]
        detail_lines = [
            (line, INK, False)
            for line in wrapped_at(
                c, reference["films_terse"], fonts["regular"], body_size, inner_w, lang, LISTING_BREAK
            )
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
    c.setFont(fonts["bold"], style["label_size"])
    c.drawString(left, y - 10, style["start_label"])
    y -= 30

    c.setFillColor(INK)
    c.setFont(fonts["voice"], hero_size)
    for line in hero_lines:
        c.drawString(left, y - hero_lead + 8, line)
        y -= hero_lead

    y -= 24
    c.setFillColor(MUTED)
    c.setFont(fonts["bold"], style["label_size"])
    c.drawString(left, y - 10, detail_label)
    y -= 16

    reply_font = fonts["voice"] if extras["replies"] else fonts["regular"]
    c.setFont(reply_font, body_size)
    for line, color, is_first in detail_lines:
        if extras["replies"] and is_first:
            c.setFillColor(GOLD)
            c.circle(left + 3, y - body_lead + 9, 1.8, stroke=0, fill=1)
        c.setFillColor(color)
        c.setFont(reply_font, body_size)
        c.drawString(left + (12 if extras["replies"] else 0), y - body_lead + 5, line)
        y -= body_lead

    # --- footer: one line for the presenter, one disclaimer ----------------
    footer_y = origin_y + MARGIN
    watch_size = fitted_size(extras["watch"], fonts["voice"], 9.5, inner_w, 8)
    c.setFillColor(GOLD)
    c.setFont(fonts["voice"], watch_size)
    c.drawString(left, footer_y + 16, extras["watch"])

    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.line(left, footer_y + 10, right, footer_y + 10)

    c.setFillColor(MUTED)
    c.setFont(fonts["regular"], 6.8)
    c.drawString(left, footer_y, style["footer"])

    return y - (footer_y + 30)


def draw_cut_line(c, lang):
    fonts = LANGUAGES[lang]["fonts"]
    c.saveState()
    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.setDash(3, 3)
    c.line(18, CARD_H, PAGE_W - 18, CARD_H)
    c.restoreState()

    label = LANGUAGES[lang]["cut_label"]
    c.setFont(fonts["regular"], 6)
    width = c.stringWidth(label, fonts["regular"], 6)
    c.setFillColor(Color(1, 1, 1))
    c.rect(PAGE_W / 2 - width / 2 - 5, CARD_H - 3.5, width + 10, 7, stroke=0, fill=1)
    c.setFillColor(MUTED)
    c.drawCentredString(PAGE_W / 2, CARD_H - 2, label)


QUICK_CARDS_MODULE = "apps/frontend/src/study/quickDemoCards.ts"


def build_quick_set(args):
    """The five stage cards, two to a sheet, each with the QR that opens it."""
    style = LANGUAGES[args.lang]
    if not args.code:
        print(
            "[cards] --code is required for the quick set: the QR carries the "
            "booth's access code, so a sheet is printed for one event.",
            file=sys.stderr,
        )
        return 1

    problems = verify_quick_copy(QUICK_CARDS_MODULE, args.lang)
    if problems:
        for problem in problems:
            print("[cards] %s" % problem, file=sys.stderr)
        print(
            "[cards] the printed copy has drifted from %s — fix one or the other."
            % QUICK_CARDS_MODULE,
            file=sys.stderr,
        )
        return 1

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    c = canvas.Canvas(args.out, pagesize=letter)
    c.setTitle(style["quick_title"])
    c.setAuthor("MAESTRO")

    pages = [QUICK_CARDS[index:index + 2] for index in range(0, len(QUICK_CARDS), 2)]
    for page_index, page in enumerate(pages):
        for slot, card in enumerate(page):
            origin_y = CARD_H if slot == 0 else 0
            url = build_quick_url(args.base_url, card["id"], args.code, args.lang)
            slack = draw_quick_card(c, origin_y, card, url, args.lang)
            print("[cards] %-8s vertical slack %6.1f pt   %s" % (card["id"], slack, url))
            if slack < 0:
                print("[cards] %s overflows by %.1f pt" % (card["id"], -slack), file=sys.stderr)
        draw_cut_line(c, args.lang)
        if page_index < len(pages) - 1:
            c.showPage()

    c.save()
    print(
        "[cards] %s \u2014 %d cards on %d letter sheets"
        % (args.out, len(QUICK_CARDS), len(pages))
    )
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="apps/backend/scenarios/data/demo_uist2026_detroit.json")
    parser.add_argument("--out", default=None)
    parser.add_argument(
        "--set",
        dest="card_set",
        choices=["full", "quick"],
        default="full",
        help="full: the four end-to-end scenario cards. quick: five one-stage cards with QRs.",
    )
    parser.add_argument(
        "--lang",
        choices=sorted(LANGUAGES),
        default="en",
        help="en: the UIST 2026 sheets. ko: the Korean sheets for KSEA 2026.",
    )
    parser.add_argument("--code", help="Access code embedded in each quick card's QR.")
    parser.add_argument(
        "--base-url",
        default="https://maestro.cs.vt.edu",
        help="Origin the QR points at. Must be the one the booth is actually serving.",
    )
    args = parser.parse_args()
    style = LANGUAGES[args.lang]

    if args.out is None:
        args.out = style["quick_out"] if args.card_set == "quick" else style["full_out"]

    register_fonts(args.lang)

    if args.card_set == "quick":
        return build_quick_set(args)

    reference = load_reference(args.dataset, args.lang)

    # One-for-one between the pages and the copy, in the language being printed:
    # a card laid out on a sheet with no words for it would be printed blank.
    missing = [
        card for page in CARD_PAGES for card in page
        if card not in CARD_EXTRAS or args.lang not in CARD_EXTRAS[card]
    ]
    if missing:
        print(f"[cards] no {args.lang} copy written for: {', '.join(missing)}", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    c = canvas.Canvas(args.out, pagesize=letter)
    c.setTitle(style["full_title"])
    c.setAuthor("MAESTRO")

    for page_index, page in enumerate(CARD_PAGES):
        for slot, card_id in enumerate(page):
            # slot 0 is the top half of the sheet, slot 1 the bottom.
            origin_y = CARD_H if slot == 0 else 0
            slack = draw_card(c, origin_y, CARD_EXTRAS[card_id], reference, args.lang)
            print(f"[cards] {card_id:<28} vertical slack {slack:6.1f} pt")
            if slack < 0:
                print(f"[cards] {card_id} overflows by {-slack:.1f} pt", file=sys.stderr)
        draw_cut_line(c, args.lang)
        if page_index < len(CARD_PAGES) - 1:
            c.showPage()

    c.save()
    print(f"[cards] {args.out} — {sum(len(p) for p in CARD_PAGES)} cards on {len(CARD_PAGES)} letter sheets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
