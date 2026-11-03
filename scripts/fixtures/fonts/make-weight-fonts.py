# SPDX-License-Identifier: MIT
# Copyright (c) 2026 The Bento authors
# Builds the weight-test fonts used by scripts/test-slides-font-weight*.
# Our own design (one bar glyph), MIT like the rest of the repo.
#
#   python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
#   /tmp/ft/bin/python scripts/fixtures/fonts/make-weight-fonts.py
#
# Output, next to this file:
#   BentoWeightVar.ttf / .woff / .woff2   variable, one wght axis 100..900
#   BentoWeightStatic.ttf / .woff2        static, OS/2 weight 700, italic bit
#
# The bar's stem and advance grow with wght, so a rendered weight is
# measurable: real 700 is visibly wider than the 400 instance, and a browser's
# faux bold of the 400 instance is not.

import os
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._g_v_a_r import TupleVariation
from fontTools.varLib.instancer import instantiateVariableFont

HERE = os.path.dirname(os.path.abspath(__file__))
FAMILY = 'Bento Weight Test'
CHARS = 'HIOabcdefghijklmnopqrstuvwxyz'


def bar(stem):
    pen = TTGlyphPen(None)
    pen.moveTo((50, 0)); pen.lineTo((50, 700)); pen.lineTo((50 + stem, 700)); pen.lineTo((50 + stem, 0))
    pen.closePath()
    return pen.glyph()


def empty():
    return TTGlyphPen(None).glyph()


def build():
    order = ['.notdef', 'space', 'bar']
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    cmap = {ord(' '): 'space'}
    cmap.update({ord(c): 'bar' for c in CHARS})
    fb.setupCharacterMap(cmap)
    # default instance = wght 400: stem 160, advance 260
    fb.setupGlyf({'.notdef': empty(), 'space': empty(), 'bar': bar(160)})
    fb.setupHorizontalMetrics({'.notdef': (500, 0), 'space': (250, 0), 'bar': (260, 50)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': FAMILY, 'styleName': 'Regular'})
    fb.setupOS2(usWeightClass=400, sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    # named instances make fvar big enough that WOFF stores it compressed, so the
    # WOFF row exercises the inflate path
    names = ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black']
    fb.setupFvar([('wght', 100, 400, 900, 'Weight')],
                 [{'stylename': n, 'location': {'wght': 100 * (i + 1)}} for i, n in enumerate(names)])
    # bar points: 4 outline points then 4 phantom points (left, right, top, bottom).
    # Moving the right edge and the right phantom widens stem and advance together.
    def deltas(dx):
        return [(0, 0), (0, 0), (dx, 0), (dx, 0), (0, 0), (dx, 0), (0, 0), (0, 0)]
    fb.setupGvar({
        'bar': [
            TupleVariation({'wght': (-1.0, -1.0, 0)}, deltas(-120)),  # 100: stem 40
            TupleVariation({'wght': (0, 1.0, 1.0)}, deltas(240)),     # 900: stem 400
        ],
        '.notdef': [], 'space': [],
    })
    return fb.font


def main():
    font = build()
    font.save(os.path.join(HERE, 'BentoWeightVar.ttf'))
    font.flavor = 'woff'
    font.save(os.path.join(HERE, 'BentoWeightVar.woff'))
    font.flavor = 'woff2'
    font.save(os.path.join(HERE, 'BentoWeightVar.woff2'))

    static = instantiateVariableFont(build(), {'wght': 700})
    static['OS/2'].usWeightClass = 700
    static['OS/2'].fsSelection = (static['OS/2'].fsSelection & ~0x40) | 0x01  # italic, not regular
    static['head'].macStyle |= 0x03
    static.save(os.path.join(HERE, 'BentoWeightStatic.ttf'))
    static.flavor = 'woff2'
    static.save(os.path.join(HERE, 'BentoWeightStatic.woff2'))


main()
