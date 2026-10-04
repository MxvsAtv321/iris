// Glasses HUD firmware
// Board: XIAO_ESP32C3 (Tools > USB CDC On Boot: Enabled)
// Wiring: OLED VCC->3V3, GND->GND, SDA->D4, SCL->D5
// Libraries: Adafruit SSD1306, Adafruit GFX
//
// Send text from your Mac:
//   curl -G --data-urlencode "text=Hello there" http://glasses-hud.local/show
// Clear the screen:
//   curl http://glasses-hud.local/clear
// The Iris eye (frames in eye_frames.h, drawn by art/make_eye.py):
//   curl "http://glasses-hud.local/eye?anim=listening"     open, listening, thinking, speaking, idle, blink, close
//   curl -G --data-urlencode "text=12g protein per bar" "http://glasses-hud.local/show?eye=answer"
//   curl http://glasses-hud.local/status
// Text is drawn in a bold sans, centred, at the largest size that fits (the rule is shared with brain/hud_text.py).
// See which part of the screen the lens shows, then move everything into it (saved on the board, no re-flash):
//   curl http://glasses-hud.local/test                       border, crosshair, TL TR BL BR, and the content area (dashed)
//   curl "http://glasses-hud.local/test?grid=1"              a grid of labels A1..C7, to read off how much of the screen is visible
//   curl "http://glasses-hud.local/calibrate?x=10&y=-6"      +x moves right, +y moves down, as the wearer reads
//   curl "http://glasses-hud.local/calibrate?w=100&h=44"     optional: make the content area smaller or larger
//   curl "http://glasses-hud.local/calibrate?flip_h=0&flip_v=1"   mirror left-right or top-bottom, for the way the lens shows it

#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Preferences.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>
#include "eye_frames.h"

// ---------- Change these ----------
const char* WIFI_SSID = "YOUR_HOTSPOT_NAME";
const char* WIFI_PASS = "YOUR_HOTSPOT_PASSWORD";
const char* HOSTNAME  = "glasses-hud";   // reachable as glasses-hud.local

// How the picture is turned for the optics, until /calibrate?flip_h=..&flip_v=.. saves something else on the board.
// Text reads backwards -> the other flip_h; upside down -> the other flip_v; both -> turned 180 degrees.
const bool FLIP_HORIZONTAL = false;
const bool FLIP_VERTICAL   = true;
// ----------------------------------

#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_ADDR     0x3C

// 400 kHz during and after a transfer: a full frame then takes about 25 ms, which leaves room for 30 a second.
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1, 400000UL, 400000UL);
WebServer server(80);
Preferences prefs;

// ---------- Where things go ----------
// Text and the eye are centred on the screen, then moved by an offset that /calibrate saves on the board, so
// they can be shifted into the part of the screen the lens shows. Text also stays inside a content area in
// the middle (116x52 unless /calibrate changes it), clear of the lens's edges.
const int16_t MAX_OFF_X = 40, MAX_OFF_Y = 20;
int16_t offX = 0, offY = 0;          // +x is right, +y is down, as the wearer reads
int16_t areaW = 116, areaH = 52;
bool flipH = FLIP_HORIZONTAL, flipV = FLIP_VERTICAL;
bool boost = true;                   // drive the panel at 9 V instead of 7.5 V (see applyBoost)

// The text sizes, largest first. The same table is in brain/hud_text.py; change both together.
struct Face {
  const GFXfont* font;
  uint8_t cap;        // height of a capital letter
  uint8_t descent;    // how far g, p, y hang below the line
  uint8_t step;       // baseline to baseline
  uint8_t maxLines;
};
const Face FACES[] = {
  {&FreeSansBold24pt7b, 33, 12, 0, 1},    // "12g"
  {&FreeSansBold18pt7b, 25, 8, 0, 1},     // "Stay in"
  {&FreeSansBold12pt7b, 17, 6, 23, 2},    // "12g protein", "Line 2: 7x8 is 56"
  {&FreeSansBold9pt7b, 12, 5, 16, 3},     // anything longer: a last resort
};
const uint8_t MAX_LINES = 3;

// The content area actually used: never wider than what is left of the screen once it has been moved.
int fitW() { return min((int)areaW, SCREEN_WIDTH - 2 * abs(offX)); }
int fitH() { return min((int)areaH, SCREEN_HEIGHT - 2 * abs(offY)); }

// ---------- The eye: what is playing ----------
// A request turns into a short list of steps. loop() plays one frame at a time and
// goes back to the web server in between, so nothing here ever waits.
enum StepKind : uint8_t { STEP_ANIM, STEP_LOOP, STEP_IDLE, STEP_TEXT, STEP_DARK };
struct Step {
  StepKind kind;
  int8_t   anim;     // index into EYE_ANIMS, for STEP_ANIM and STEP_LOOP
  uint32_t ms;       // how long a loop, the idle eye or the text stays; 0 = text stays until replaced
  uint8_t  stride;   // STEP_ANIM: 1 plays every frame, 2 or 3 play it faster
};

const uint16_t FRAME_MS          = 33;      // about 30 frames a second
const uint32_t LOOP_DEFAULT_MS   = 15000;   // a loop nobody ends closes by itself, so the eye is never left open
const uint32_t IDLE_DEFAULT_MS   = 6000;
const uint32_t ANSWER_HOLD_MS    = 4000;
const uint32_t NUDGE_HOLD_MS     = 5000;
const uint32_t AFTER_ANSWER_MS   = 2800;    // the eye rests open this long after an answer, then closes
const uint8_t  MAX_STEPS         = 8;

Step     steps[MAX_STEPS];
uint8_t  stepCount = 0, stepAt = 0;
bool     stepEntered = false;
uint32_t stepStarted = 0, nextFrameAt = 0, nextBlinkAt = 0;
uint16_t frameAt = 0;
bool     blinking = false;
bool     eyeOpen = false;          // the open eye is on the display right now
String   stepText = "";

int8_t A_OPEN = -1, A_BLINK = -1, A_CLOSE = -1;

// numbers for /status
uint32_t cmdAt = 0, cmdToFirstFrameMs = 0, framesDrawn = 0, drawMsTotal = 0;
bool     waitingFirstFrame = false;
uint32_t fpsWindowStart = 0;
uint16_t fpsWindowFrames = 0;
float    fpsLast = 0;

void applyFlip() {
  // Segment remap: 0xA1 is the library default, 0xA0 mirrors left-right.
  display.ssd1306_command(flipH ? 0xA0 : 0xA1);
  // COM scan direction: 0xC8 is the library default, 0xC0 flips top-bottom.
  display.ssd1306_command(flipV ? 0xC0 : 0xC8);
}

// Contrast is already as high as it goes; the one thing left is the voltage the panel is driven at. Newer
// controllers (SSD1306B, SSD1315) can make 9 V instead of the usual 7.5 V, which is visibly brighter; older ones
// ignore the extra bits. /calibrate?boost=0 turns it off, saved on the board, if the picture misbehaves.
void applyBoost() {
  display.ssd1306_command(SSD1306_CHARGEPUMP);
  display.ssd1306_command(boost ? 0x95 : 0x14);
  display.ssd1306_command(SSD1306_DISPLAYON);
}

// The display is always at full brightness: thin lines seen through a half-mirror need all of it. Sent again
// before every picture (two bytes), so a display that lost the setting gets it back with the next frame.
void fullBrightness() {
  display.ssd1306_command(SSD1306_SETCONTRAST);
  display.ssd1306_command(0xFF);
}

int8_t animIndex(const String& name) {
  for (uint8_t i = 0; i < EYE_ANIM_COUNT; i++) {
    if (name == EYE_ANIMS[i].name) return i;
  }
  return -1;
}

void noteFrame(uint32_t startedAt) {
  uint32_t now = millis();
  framesDrawn++;
  drawMsTotal += now - startedAt;
  if (waitingFirstFrame) {
    cmdToFirstFrameMs = now - cmdAt;
    waitingFirstFrame = false;
  }
  fpsWindowFrames++;
  if (now - fpsWindowStart >= 1000) {
    fpsLast = fpsWindowFrames * 1000.0 / (now - fpsWindowStart);
    fpsWindowStart = now;
    fpsWindowFrames = 0;
  }
}

// Move what is in the display buffer by the saved offset. The buffer is eight rows of bytes, each byte a
// column of 8 pixels, so one screen column is a 64-bit number and moving it up or down is a shift.
void shiftBuffer(int dx, int dy) {
  if (!dx && !dy) return;
  static uint8_t from[SCREEN_WIDTH * SCREEN_HEIGHT / 8];
  uint8_t* buf = display.getBuffer();
  memcpy(from, buf, sizeof(from));
  memset(buf, 0, sizeof(from));
  for (int x = 0; x < SCREEN_WIDTH; x++) {
    int to = x + dx;
    if (to < 0 || to >= SCREEN_WIDTH) continue;
    uint64_t col = 0;
    for (int p = 0; p < 8; p++) col |= (uint64_t)from[x + p * SCREEN_WIDTH] << (8 * p);
    col = dy >= 0 ? col << dy : col >> -dy;
    for (int p = 0; p < 8; p++) buf[to + p * SCREEN_WIDTH] = (uint8_t)(col >> (8 * p));
  }
}

// Unpack one frame straight into the display buffer and send it.
void drawFrame(uint16_t index) {
  uint32_t t0 = millis();
  uint8_t* buf = display.getBuffer();
  uint32_t i   = pgm_read_dword(&EYE_FRAME_START[index]);
  uint32_t end = pgm_read_dword(&EYE_FRAME_START[index + 1]);
  uint16_t o = 0;
  const uint16_t size = SCREEN_WIDTH * SCREEN_HEIGHT / 8;
  while (i < end && o < size) {
    uint8_t b = pgm_read_byte(&EYE_DATA[i++]);
    if (b) {
      buf[o++] = b;
    } else {
      uint16_t n = pgm_read_byte(&EYE_DATA[i++]);
      if (o + n > size) n = size - o;
      memset(buf + o, 0, n);
      o += n;
    }
  }
  shiftBuffer(offX, offY);
  fullBrightness();
  display.display();
  noteFrame(t0);
}

// ---------- Text ----------
// Only the characters the font has, on one line, single-spaced.
String cleanText(const String& raw) {
  String out = "";
  bool gap = false;
  for (unsigned int i = 0; i < raw.length() && out.length() < 160; i++) {
    uint8_t c = raw[i];
    if (c > ' ' && c <= '~') {
      if (gap && out.length()) out += ' ';
      out += (char)c;
      gap = false;
    } else {
      gap = true;
    }
  }
  return out;
}

int textWidth(const GFXfont* font, const String& text) {
  int w = 0;
  for (unsigned int i = 0; i < text.length(); i++) w += font->glyph[(uint8_t)text[i] - font->first].xAdvance;
  return w;
}

// Break the text into lines no wider than the content area. -> how many lines, or 0 if it can't be done in this face.
uint8_t wrapText(const Face& f, const String& text, String lines[]) {
  uint8_t n = 0;
  String line = "";
  int i = 0, len = text.length(), wide = fitW();
  while (i < len) {
    int sp = text.indexOf(' ', i);
    if (sp < 0) sp = len;
    String word = text.substring(i, sp);
    i = sp + 1;
    if (textWidth(f.font, word) > wide) return 0;
    String trial = line.length() ? line + " " + word : word;
    if (textWidth(f.font, trial) <= wide) {
      line = trial;
    } else {
      if (n + 2 > f.maxLines) return 0;
      lines[n++] = line;
      line = word;
    }
  }
  lines[n++] = line;
  return n;
}

bool hangsBelow(const String& line) {
  for (unsigned int i = 0; i < line.length(); i++) {
    if (strchr("gjpqy,;", line[i])) return true;
  }
  return false;
}

// Text too long for any of the faces: the small built-in font, so it is still all there.
void showSmall(const String& text) {
  int perLine = max(1, fitW() / 6), maxLines = min((int)8, max(1, fitH() / 8));
  String lines[8];
  int n = 0;
  String line = "";
  int i = 0, len = text.length();
  while (i < len && n < maxLines) {
    int sp = text.indexOf(' ', i);
    if (sp < 0) sp = len;
    String word = text.substring(i, sp);
    i = sp + 1;
    String trial = line.length() ? line + " " + word : word;
    if ((int)trial.length() <= perLine) {
      line = trial;
    } else {
      if (line.length()) lines[n++] = line;
      line = word.substring(0, perLine);   // hard-cut very long words
    }
  }
  if (line.length() && n < maxLines) lines[n++] = line;
  display.setFont();
  display.setTextSize(1);
  int top = (SCREEN_HEIGHT - n * 8) / 2 + offY;
  for (int k = 0; k < n; k++) {
    display.setCursor((SCREEN_WIDTH - (int)lines[k].length() * 6) / 2 + offX, top + k * 8);
    display.print(lines[k]);
  }
}

// The text, centred, in the largest face it fits in.
void showText(const String& raw) {
  String text = cleanText(raw);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextWrap(false);
  display.setTextSize(1);
  bool drawn = text.length() == 0;
  String lines[MAX_LINES];
  for (const Face& f : FACES) {
    if (drawn) break;
    uint8_t n = wrapText(f, text, lines);
    if (!n) continue;
    int block = f.cap + (n - 1) * f.step + (hangsBelow(lines[n - 1]) ? f.descent : 0);
    if (block > fitH()) continue;
    int top = (SCREEN_HEIGHT - block) / 2;
    display.setFont(f.font);
    for (uint8_t k = 0; k < n; k++) {
      // with these fonts the cursor is the left end of the baseline
      display.setCursor((SCREEN_WIDTH - textWidth(f.font, lines[k])) / 2 + offX, top + f.cap + k * f.step + offY);
      display.print(lines[k]);
    }
    display.setFont();
    drawn = true;
  }
  if (!drawn) showSmall(text);
  fullBrightness();
  display.display();
}

// ---------- The test pattern ----------
void cornerLabel(const char* label, int x, int y) {
  display.fillRect(x - 1, y - 1, 13, 9, SSD1306_BLACK);
  display.setCursor(x, y);
  display.print(label);
}

String signedNumber(int v) {
  return String(v < 0 ? "-" : "+") + String(abs(v));
}

// The screen's edge, a crosshair at its middle and a label in each corner: these never move, so they show which
// part of the screen the lens shows. Dashed: the content area, where text and the eye go, moved by the offset.
void drawTest() {
  display.clearDisplay();
  display.setFont();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setTextWrap(false);
  int w = fitW(), h = fitH();
  int left = (SCREEN_WIDTH - w) / 2 + offX, top = (SCREEN_HEIGHT - h) / 2 + offY;
  for (int x = left; x < left + w; x++) {
    if ((x / 2) % 2) continue;
    display.drawPixel(x, top, SSD1306_WHITE);
    display.drawPixel(x, top + h - 1, SSD1306_WHITE);
  }
  for (int y = top; y < top + h; y++) {
    if ((y / 2) % 2) continue;
    display.drawPixel(left, y, SSD1306_WHITE);
    display.drawPixel(left + w - 1, y, SSD1306_WHITE);
  }
  display.drawRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
  display.drawFastHLine(SCREEN_WIDTH / 2 - 6, SCREEN_HEIGHT / 2, 13, SSD1306_WHITE);
  display.drawFastVLine(SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2 - 6, 13, SSD1306_WHITE);
  cornerLabel("TL", 3, 3);
  cornerLabel("TR", SCREEN_WIDTH - 3 - 11, 3);
  cornerLabel("BL", 3, SCREEN_HEIGHT - 3 - 7);
  cornerLabel("BR", SCREEN_WIDTH - 3 - 11, SCREEN_HEIGHT - 3 - 7);
  String label = "x" + signedNumber(offX) + " y" + signedNumber(offY);
  display.setCursor((SCREEN_WIDTH - (int)label.length() * 6) / 2 + offX, SCREEN_HEIGHT / 2 + 10 + offY);
  display.print(label);
  fullBrightness();
  display.display();
}

// ---------- The eye: building and playing the steps ----------
void planClear() {
  stepCount = 0;
  stepAt = 0;
  stepEntered = false;
  blinking = false;
}

void planAdd(StepKind kind, int8_t anim, uint32_t ms, uint8_t stride = 1) {
  if (stepCount < MAX_STEPS) steps[stepCount++] = {kind, anim, ms, stride};
}

void planStart() {
  stepAt = 0;
  stepEntered = false;
  nextFrameAt = millis();
  cmdAt = millis();
  waitingFirstFrame = true;
}

// Every plan that shows the eye ends with it closing and the display going dark.
void planCloseAndDark() {
  planAdd(STEP_ANIM, A_CLOSE, 0);
  planAdd(STEP_DARK, -1, 0);
}

void nextStep() {
  stepAt++;
  stepEntered = false;
}

void tickEye() {
  if (stepAt >= stepCount) return;
  uint32_t now = millis();
  if ((int32_t)(now - nextFrameAt) < 0) return;
  nextFrameAt = now + FRAME_MS;

  Step& s = steps[stepAt];
  if (!stepEntered) {
    stepEntered = true;
    stepStarted = now;
    frameAt = 0;
    blinking = false;
    if (s.kind == STEP_IDLE) {
      drawFrame(EYE_ANIMS[A_OPEN].first + EYE_ANIMS[A_OPEN].count - 1);
      eyeOpen = true;
      nextBlinkAt = now + random(3000, 5001);   // a natural blink every 3 to 5 seconds
      return;
    }
    if (s.kind == STEP_TEXT) {
      showText(stepText);
      eyeOpen = false;
      if (s.ms == 0) nextStep();                 // the text stays; nothing more to do
      return;
    }
  }

  switch (s.kind) {
    case STEP_ANIM: {
      const EyeAnim& a = EYE_ANIMS[s.anim];
      uint16_t last = a.count - 1;
      uint16_t idx = frameAt > last ? last : frameAt;
      drawFrame(a.first + idx);
      if (idx == last) {
        eyeOpen = (s.anim != A_CLOSE);
        nextStep();
      } else {
        frameAt += s.stride;
      }
      break;
    }
    case STEP_LOOP: {
      const EyeAnim& a = EYE_ANIMS[s.anim];
      drawFrame(a.first + frameAt);
      frameAt = (frameAt + 1) % a.count;
      if (now - stepStarted >= s.ms) nextStep();
      break;
    }
    case STEP_IDLE: {
      const EyeAnim& b = EYE_ANIMS[A_BLINK];
      if (blinking) {
        drawFrame(b.first + frameAt);
        if (++frameAt >= b.count) {
          blinking = false;
          nextBlinkAt = now + random(3000, 5001);
        }
      } else if (now - stepStarted >= s.ms) {
        nextStep();
      } else if ((int32_t)(now - nextBlinkAt) >= 0) {
        blinking = true;
        frameAt = 0;
      }
      break;
    }
    case STEP_TEXT:
      if (now - stepStarted >= s.ms) nextStep();
      break;
    case STEP_DARK:
      display.clearDisplay();
      display.display();
      eyeOpen = false;
      nextStep();
      break;
  }
}

const char* stateName() {
  if (stepAt >= stepCount) return eyeOpen ? "open" : "dark";
  switch (steps[stepAt].kind) {
    case STEP_ANIM:
    case STEP_LOOP:     return EYE_ANIMS[steps[stepAt].anim].name;
    case STEP_IDLE:     return "idle";
    case STEP_TEXT:     return "text";
    case STEP_DARK:     return "dark";
  }
  return "dark";
}

// ---------- HTTP ----------
void sendOk() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "ok");
}

uint32_t argMs(const char* name, uint32_t fallback) {
  if (!server.hasArg(name)) return fallback;
  long v = server.arg(name).toInt();
  return v > 0 ? (uint32_t)(v > 60000 ? 60000 : v) : fallback;
}

void handleShow() {
  String msg = "";
  if (server.hasArg("text"))       msg = server.arg("text");
  else if (server.hasArg("plain")) msg = server.arg("plain");  // raw POST body
  String eye = server.hasArg("eye") ? server.arg("eye") : "";
  Serial.println("Showing: " + msg);

  planClear();
  if (eye == "answer" || eye == "nudge") {
    // answer: blink, the text, then the eye rests open and closes
    // nudge:  the eye flicks open, blinks, the text, then dark
    bool nudge = (eye == "nudge");
    stepText = msg;
    if (!eyeOpen) planAdd(STEP_ANIM, A_OPEN, 0, nudge ? 3 : 2);
    planAdd(STEP_ANIM, A_BLINK, 0);
    planAdd(STEP_TEXT, -1, argMs("hold", nudge ? NUDGE_HOLD_MS : ANSWER_HOLD_MS));
    if (nudge) {
      planAdd(STEP_DARK, -1, 0);
    } else {
      planAdd(STEP_ANIM, A_OPEN, 0, 2);
      planAdd(STEP_IDLE, -1, AFTER_ANSWER_MS);
      planCloseAndDark();
    }
    planStart();
  } else {
    showText(msg);          // as before: the text stays until it is replaced or cleared
    eyeOpen = false;
  }
  sendOk();
}

void handleClear() {
  planClear();
  display.clearDisplay();
  display.display();
  eyeOpen = false;
  sendOk();
}

void handleEye() {
  String name = server.hasArg("anim") ? server.arg("anim") : "open";
  int8_t anim = animIndex(name);
  if (anim < 0 && name != "idle") {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(400, "text/plain", "anim must be open, listening, thinking, speaking, idle, blink or close");
    return;
  }

  // what was looping, so a blink can go back to it
  int8_t   resume = -1;
  uint32_t resumeMs = 0;
  if (stepAt < stepCount && steps[stepAt].kind == STEP_LOOP) {
    resume = steps[stepAt].anim;
    uint32_t used = millis() - stepStarted;
    resumeMs = steps[stepAt].ms > used ? steps[stepAt].ms - used : 0;
  }

  planClear();
  if (name == "close") {
    if (eyeOpen) planAdd(STEP_ANIM, A_CLOSE, 0);
    planAdd(STEP_DARK, -1, 0);
  } else {
    if (!eyeOpen) planAdd(STEP_ANIM, A_OPEN, 0);
    if (name == "blink") {
      planAdd(STEP_ANIM, A_BLINK, 0);
      if (resume >= 0 && resumeMs > 0) planAdd(STEP_LOOP, resume, resumeMs);
      else                             planAdd(STEP_IDLE, -1, argMs("for", AFTER_ANSWER_MS));
    } else if (name == "open" || name == "idle") {
      planAdd(STEP_IDLE, -1, argMs("for", IDLE_DEFAULT_MS));
    } else {
      planAdd(STEP_LOOP, anim, argMs("for", LOOP_DEFAULT_MS));
    }
    planCloseAndDark();
  }
  planStart();
  sendOk();
}

String placementJson() {
  return "\"offset\":{\"x\":" + String(offX) + ",\"y\":" + String(offY) + "}"
         ",\"area\":{\"w\":" + String(fitW()) + ",\"h\":" + String(fitH()) + "}"
         ",\"flip\":{\"h\":" + String(flipH ? 1 : 0) + ",\"v\":" + String(flipV ? 1 : 0) + "}"
         ",\"boost\":" + String(boost ? 1 : 0);
}

// A grid of labels over the whole screen, 16 pixels apart: A1 to A7 along the top, then rows B and C. The labels
// the wearer can read say exactly which part of the screen the lens shows. Nothing here moves with the offset.
void drawGrid() {
  display.clearDisplay();
  display.setFont();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setTextWrap(false);
  display.drawRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
  for (int row = 1; row <= 3; row++) {
    for (int col = 1; col <= 7; col++) {
      display.setCursor(16 * col - 6, 16 * row - 4);      // the label's middle is at x = 16 * col, y = 16 * row
      display.print((char)('A' + row - 1));
      display.print((char)('0' + col));
    }
  }
  fullBrightness();
  display.display();
}

void handleTest() {
  planClear();
  if (server.hasArg("grid")) drawGrid();
  else drawTest();
  eyeOpen = false;
  sendOk();
}

// /calibrate?x=..&y=..  moves text and the eye; optional w= and h= resize the content area, and flip_h= and
// flip_v= (0 or 1) mirror the picture left-right and top-bottom, and boost= (0 or 1) is the brighter panel voltage.
// Saved on the board.
// Without arguments it changes nothing. Either way it draws the test pattern and answers with where things are.
void handleCalibrate() {
  bool changed = false;
  if (server.hasArg("x")) { offX = constrain((int)server.arg("x").toInt(), -MAX_OFF_X, MAX_OFF_X); changed = true; }
  if (server.hasArg("y")) { offY = constrain((int)server.arg("y").toInt(), -MAX_OFF_Y, MAX_OFF_Y); changed = true; }
  if (server.hasArg("w")) { areaW = constrain((int)server.arg("w").toInt(), 48, SCREEN_WIDTH); changed = true; }
  if (server.hasArg("h")) { areaH = constrain((int)server.arg("h").toInt(), 24, SCREEN_HEIGHT); changed = true; }
  if (server.hasArg("flip_h")) { flipH = server.arg("flip_h").toInt() != 0; changed = true; }
  if (server.hasArg("flip_v")) { flipV = server.arg("flip_v").toInt() != 0; changed = true; }
  if (server.hasArg("boost")) { boost = server.arg("boost").toInt() != 0; changed = true; }
  if (changed) {
    prefs.putBool("bo", boost);
    applyBoost();
    prefs.putBool("fh", flipH);
    prefs.putBool("fv", flipV);
    applyFlip();              // the left-right flip shows with the next picture, which drawTest sends below
    prefs.putShort("ox", offX);
    prefs.putShort("oy", offY);
    prefs.putShort("aw", areaW);
    prefs.putShort("ah", areaH);
  }
  planClear();
  drawTest();
  eyeOpen = false;
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", "{" + placementJson() + "}");
}

void handleStatus() {
  String j = "{";
  j += "\"state\":\"" + String(stateName()) + "\"";
  j += ",\"eye_open\":" + String(eyeOpen ? "true" : "false");
  j += ",\"fps\":" + String(fpsLast, 1);
  j += ",\"draw_ms\":" + String(framesDrawn ? (float)drawMsTotal / framesDrawn : 0.0, 1);
  j += ",\"cmd_to_first_frame_ms\":" + String(cmdToFirstFrameMs);
  j += ",\"frames\":" + String(framesDrawn);
  j += ",\"uptime_ms\":" + String(millis());
  j += "," + placementJson();
  j += "}";
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", j);
}

void setup() {
  Serial.begin(115200);
  Wire.begin();  // XIAO ESP32C3 defaults: SDA = D4, SCL = D5

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("OLED not found. Check wiring and address 0x3C.");
    while (true) delay(1000);
  }
  prefs.begin("hud", false);
  flipH = prefs.getBool("fh", FLIP_HORIZONTAL);
  flipV = prefs.getBool("fv", FLIP_VERTICAL);
  boost = prefs.getBool("bo", true);
  applyFlip();
  applyBoost();
  offX  = constrain((int)prefs.getShort("ox", 0), -MAX_OFF_X, MAX_OFF_X);
  offY  = constrain((int)prefs.getShort("oy", 0), -MAX_OFF_Y, MAX_OFF_Y);
  areaW = constrain((int)prefs.getShort("aw", 116), 48, SCREEN_WIDTH);
  areaH = constrain((int)prefs.getShort("ah", 52), 24, SCREEN_HEIGHT);
  showText("Connecting to WiFi...");

  A_OPEN  = animIndex("open");
  A_BLINK = animIndex("blink");
  A_CLOSE = animIndex("close");
  randomSeed(esp_random());

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("Connected: " + WiFi.localIP().toString());

  if (MDNS.begin(HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
  }

  server.on("/show", handleShow);
  server.on("/clear", handleClear);
  server.on("/eye", handleEye);
  server.on("/status", handleStatus);
  server.on("/test", handleTest);
  server.on("/calibrate", handleCalibrate);
  server.begin();

  // Boot screen: name and address (too long for the large faces, so it shows in the small font)
  showText(String(HOSTNAME) + ".local " + WiFi.localIP().toString());
}

void loop() {
  server.handleClient();
  tickEye();
}
