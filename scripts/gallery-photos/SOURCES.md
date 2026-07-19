# Gallery deck photos — all public domain

| file | source | credit / provenance |
|---|---|---|
| orbital-earth.jpg | NASA images (iss040e091208) | ISS Expedition 40 night Earth observation — public domain (NASA) |
| orbital-nebula.jpg | NASA images (GSFC_20171208_Archive_e001955) | Hubble, heart of the Lagoon Nebula — public domain (NASA) |
| signal-press.jpg | Wikimedia Commons / Library of Congress (LC 8d22725) | Marjory Collins, "Composing room of the New York Times", 1942, FSA/OWI — public domain |
| picnic-fair.jpg | Wikimedia Commons / Library of Congress | Jack Delano, ferris wheel at the Vermont state fair, Rutland, 1941 Kodachrome, FSA/OWI — public domain (film border cropped) |
| terra-v1.jpg | Met Museum open access (239499) | "Vase with blue jay", ca. 1882, CC0 |
| terra-v2.jpg | Met Museum open access (239487) | "Vase with goat masks", ca. 1894, CC0 |
| terra-v3.jpg | Met Museum open access (239506) | "Vase", 1879, CC0 |

Added 2026-07-18 (v3):

| file | source | credit / provenance |
|---|---|---|
| orbital-stars.jpg | NASA images (iss063e058409) | Milky Way over Earth's airglow limb, ISS Expedition 63 — public domain (top hardware strip cropped) |
| orbital-aurora.jpg | NASA images (iss030e119777) | Green/red aurora curtain from the ISS, Expedition 30 — public domain |
| orbital-dragon.jpg | NASA images (iss071e256593) | SpaceX Dragon Endeavour against the Milky Way, Expedition 71 — public domain |
| thumbs/*.jpg | derived | small renditions of the above for the landing page's gallery posters |

Added 2026-07-18 (v4 — cover backgrounds):

| file | source | credit / provenance |
|---|---|---|
| picnic-fairwide.jpg | Wikimedia Commons / Library of Congress (LCCN2017877389) | Jack Delano, backstage at the Vermont state fair, Rutland, 1941 Kodachrome, FSA/OWI — public domain (film mount cropped) |

Added 2026-07-18 (v5 — quality pass):

The five `orbital-*.jpg` files were re-rendered from the full-resolution NASA
originals — earth iss040e091208 (4256×2832), stars iss063e058409 (5568×3712),
aurora iss030e119777 (4256×2832), dragon iss071e256593 (8256×5504, via
images-assets.nasa.gov ~orig), nebula GSFC_20171208_Archive_e001955 (3924×2006).
Prominent heroes (stars cover, earth) render at 3200 px on the long edge; the
three backdrops that render dimmed under heavy scrims (nebula, aurora, dragon)
at 2600 px. q90. The earlier renditions were low-res/heavily compressed. Same
frames/crops (orbital-stars re-cropped a touch lower to drop the ISS-hardware
strip). New second photo for the Signal deck so slide 4 no longer repeats the
cover:

| file | source | credit / provenance |
|---|---|---|
| signal-press2.jpg | Library of Congress FSA/OWI master TIFF (fsa 8d22695, 4802×5113) | Marjory Collins, "Pressroom of the New York Times" — freshly printed papers off the press, 1942, FSA/OWI — public domain (rendered from the master TIFF at 2600 px; scan border + caption strip cropped). NOTE: LoC's IIIF `full/` endpoint tops out at the 962×1024 service copy — pull `…/master/pnp/fsa/…u.tif` for real resolution. |

Added 2026-07-18 (v6 — sharpness pass):

Several originals were technically high-res but the PHOTOGRAPHS were soft (ISS
night shots motion-blur during the long exposure; the 8d22695 press frame had a
shallow depth of field). Replaced the blurry ones with similar-composition but
tack-sharp frames:

| file | replaces | source | credit / provenance |
|---|---|---|---|
| orbital-earth.jpg | iss034e005935 | Wikimedia Commons / NASA (`ISS064-E-37584`, "View of Earth") | Tokyo at night from the ISS, Expedition 64 — dense city lights radiating around Tokyo Bay — public domain (NASA JSC "Gateway to Astronaut Photography of Earth"; Commons licence = pd). 16:9 centre crop; 3200 px, q90. |
| orbital-stars.jpg | iss062e081621 | Wikimedia Commons / NASA (`ISS007-E-10807`, "Iss007e10807_darker") | ISS Expedition 7 — a sunlit Earth from orbit: the Sun flaring over the limb with sunglint on the ocean and clouds casting long shadows — public domain (NASA; the Commons file is a brightness-darkened derivative, no added rights). Rotated +1.3° (CCW) to level the horizon — measured by fitting the airglow limb — then inward-cropped to drop the rotation wedges; 16:9 top-biased crop (keeps the Sun); 3200 px, q90. (Alternates rendered & considered, all ISS/NASA public domain: iss072e807123 moonlit Italy, iss072e725406 aurora — kept in scratchpad if a different mood is wanted.) |
| signal-press2.jpg | 8d22695 (shallow DoF) | Library of Congress FSA/OWI master TIFF (fsa 8d22713, 4832×4824) | Marjory Collins, New York Times rotary press — a pressman at the press, the newspaper type sharp on the plate cylinder, 1942, FSA/OWI — public domain (master TIFF, 16:9 crop, 2600 px; scan border + caption strip cropped). |

(The dimmed hidden-state backdrops — aurora, dragon — and the naturally-diffuse
nebula were left as-is: they render at 0.5–0.55 opacity under heavy scrims where
softness reads as texture.)

Added 2026-07-19 (v7 — Orbital subsystem backdrops, all public domain NASA):
the aurora/dragon/nebula slots were repurposed and renamed to match their new
content:

| file | used by | source | credit / provenance |
|---|---|---|---|
| orbital-cubesats.jpg | INGEST state slide | Wikimedia Commons / NASA (`iss072e352045`) | A trio of CubeSats ejected into orbit from the ISS deployer, Expedition 72 — public domain (NASA JSC). 16:9 crop, 2600 px. |
| orbital-jwst.jpg | MODEL state slide | Wikimedia Commons / NASA (`James Webb Primary Mirror`) | The gold JWST primary-mirror segments in test, with an engineer for scale — public domain (NASA/MSFC/David Higginbotham). 16:9 crop, 2600 px. |

(The closing slide's backdrop image was dropped — it now sits on pure void black — so `orbital-nightglobe.jpg` / the `eo20/night_limb` NASA globe is no longer used.)

Embedded webfont (`scripts/gallery-fonts/`, used by the Orbital deck):

| file | source | licence |
|---|---|---|
| SpaceMono-{400,700}-latin.woff2 | Google Fonts (fonts.gstatic.com), latin subset | Space Mono, SIL Open Font License 1.1 |

Added 2026-07-18 (v5.1 — Orbital compression pass):

The five orbital-*.jpg were re-encoded smaller: the deck was ~7.9 MB, most of
it Orbital photography. The two heroes (stars cover, earth full-bleed) drop to
2200 px q70 — the deck canvas is 1280 px wide, so 3200 px was far past what any
display shows. The three STATE backdrops (nebula, aurora, dragon) render dimmed
under 55–72% scrims, where fine detail is invisible: nebula 1600 px q60, aurora
& dragon 1800 px q64. Orbital photos 5.7 MB → 2.0 MB; deck ~7.9 MB → ~4.1 MB.
Spot-checked at full brightness — no visible artefacts. Same frames/crops.

## Media (v0.9.18)

- `gallery-media/chime.wav` — a short major-pentatonic chime **synthesised in
  `scripts/build-example-decks.mjs`** (native WAV, no external source), so it is
  original work released into the **public domain**. Embedded in the Picnic
  deck cover to demonstrate the audio media element.
