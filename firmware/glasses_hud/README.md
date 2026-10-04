# glasses_hud

The display on the glasses: a 128x64 one-colour OLED on a XIAO ESP32C3, seen through a half-mirror, so only lit pixels show and they float in the wearer's view.

- Board: XIAO_ESP32C3; USB CDC On Boot: Enabled
- Wiring: OLED VCC to 3V3, GND to GND, SDA to D4, SCL to D5
- Libraries: Adafruit SSD1306, Adafruit GFX

## Calls

| Call | What it does |
| --- | --- |
| `/show?text=...` | Shows the text until it is replaced or cleared. |
| `/show?text=...&eye=answer` | The eye blinks, the text shows, then the eye rests open and closes. |
| `/show?text=...&eye=nudge` | The eye flicks open and blinks, the text shows, then the display goes dark. |
| `/eye?anim=<name>` | `open`, `listening`, `thinking`, `speaking`, `idle`, `blink` or `close`. |
| `/clear` | Stops everything and clears the display. |
| `/status` | Frame rate, and the time from the last call to its first frame. |

Details and defaults are in `docs/contracts.md`.

## The eye

![The eye, in order](art/preview/all_in_order.gif)

`art/make_eye.py` draws the eye as vector shapes (two arcs for the lids, circles and radial lines for the iris) and traces them one pixel wide onto the 128x64 grid. Lines only, never fills: about 6% of the pixels are lit.

    python art/make_eye.py            # previews in art/preview/
    python art/make_eye.py header     # also rewrites eye_frames.h, which the sketch includes

It needs Pillow (`pip install pillow`).

## Uploading

In `glasses_hud.ino`, replace `YOUR_HOTSPOT_NAME` and `YOUR_HOTSPOT_PASSWORD`. Never commit the real ones. Then, with the board plugged in by USB:

    arduino-cli compile -b esp32:esp32:XIAO_ESP32C3 firmware/glasses_hud
    arduino-cli upload  -b esp32:esp32:XIAO_ESP32C3 -p <port> firmware/glasses_hud

`arduino-cli board list` shows the port.
