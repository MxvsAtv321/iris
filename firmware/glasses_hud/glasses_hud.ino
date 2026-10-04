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

#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "eye_frames.h"

// ---------- Change these ----------
const char* WIFI_SSID = "YOUR_HOTSPOT_NAME";
const char* WIFI_PASS = "YOUR_HOTSPOT_PASSWORD";
const char* HOSTNAME  = "glasses-hud";   // reachable as glasses-hud.local

// Flip settings for the mirror. Find the right combo on the optics bench:
// text reads backwards -> toggle FLIP_HORIZONTAL; upside down -> toggle FLIP_VERTICAL.
const bool FLIP_HORIZONTAL = true;
const bool FLIP_VERTICAL   = false;
// ----------------------------------

#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_ADDR     0x3C

// 400 kHz during and after a transfer: a full frame then takes about 25 ms, which leaves room for 30 a second.
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1, 400000UL, 400000UL);
WebServer server(80);

// ---------- The eye: what is playing ----------
// A request turns into a short list of steps. loop() plays one frame at a time and
// goes back to the web server in between, so nothing here ever waits.
enum StepKind : uint8_t { STEP_ANIM, STEP_LOOP, STEP_IDLE, STEP_TEXT, STEP_FADE_OUT };
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
const uint8_t  FADE_OUT_FRAMES   = 4;
const uint8_t  MAX_STEPS         = 8;

Step     steps[MAX_STEPS];
uint8_t  stepCount = 0, stepAt = 0;
bool     stepEntered = false;
uint32_t stepStarted = 0, nextFrameAt = 0, nextBlinkAt = 0;
uint16_t frameAt = 0;
bool     blinking = false;
bool     eyeOpen = false;          // the open eye is on the display right now
String   stepText = "";
uint8_t  contrastNow = 0xFF;

int8_t A_OPEN = -1, A_BLINK = -1, A_CLOSE = -1;

// numbers for /status
uint32_t cmdAt = 0, cmdToFirstFrameMs = 0, framesDrawn = 0, drawMsTotal = 0;
bool     waitingFirstFrame = false;
uint32_t fpsWindowStart = 0;
uint16_t fpsWindowFrames = 0;
float    fpsLast = 0;

void applyFlip() {
  // Segment remap: 0xA1 is the library default, 0xA0 mirrors left-right.
  display.ssd1306_command(FLIP_HORIZONTAL ? 0xA0 : 0xA1);
  // COM scan direction: 0xC8 is the library default, 0xC0 flips top-bottom.
  display.ssd1306_command(FLIP_VERTICAL ? 0xC0 : 0xC8);
}

void setContrast(uint8_t c) {
  if (c == contrastNow) return;
  display.ssd1306_command(SSD1306_SETCONTRAST);
  display.ssd1306_command(c);
  contrastNow = c;
}

void setMaxBrightness() {
  contrastNow = 0;
  setContrast(0xFF);
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
  display.display();
  noteFrame(t0);
}

// Word-wrapped text. forcedSize 0 = auto (big for short messages, small for long).
void showText(const String& text, int forcedSize = 0) {
  int size = forcedSize > 0 ? forcedSize : (text.length() <= 40 ? 2 : 1);
  int charsPerLine = SCREEN_WIDTH / (6 * size);
  int lineHeight   = 8 * size;
  int maxLines     = SCREEN_HEIGHT / lineHeight;

  display.clearDisplay();
  display.setTextSize(size);
  display.setTextColor(SSD1306_WHITE);

  String line = "";
  int lineCount = 0;
  int i = 0;
  while (i <= (int)text.length() && lineCount < maxLines) {
    int sp = text.indexOf(' ', i);
    if (sp == -1) sp = text.length();
    String word = text.substring(i, sp);
    i = sp + 1;

    String candidate = line.length() ? line + " " + word : word;
    if ((int)candidate.length() <= charsPerLine) {
      line = candidate;
    } else {
      if (line.length()) {
        display.setCursor(0, lineCount * lineHeight);
        display.print(line);
        lineCount++;
      }
      line = word.substring(0, charsPerLine);  // hard-cut very long words
    }
  }
  if (line.length() && lineCount < maxLines) {
    display.setCursor(0, lineCount * lineHeight);
    display.print(line);
  }
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
void planCloseAndFade() {
  planAdd(STEP_ANIM, A_CLOSE, 0);
  planAdd(STEP_FADE_OUT, -1, 0);
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
      setContrast(0xFF);
      drawFrame(EYE_ANIMS[A_OPEN].first + EYE_ANIMS[A_OPEN].count - 1);
      eyeOpen = true;
      nextBlinkAt = now + random(3000, 5001);   // a natural blink every 3 to 5 seconds
      return;
    }
    if (s.kind == STEP_TEXT) {
      setContrast(0xFF);
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
      if (s.anim == A_OPEN) {
        setContrast(24 + (uint16_t)(231) * idx / last);   // fade in gently as the lids part
      } else {
        setContrast(0xFF);
      }
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
      setContrast(0xFF);
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
    case STEP_FADE_OUT: {
      // out quickly: a few steps down, then dark
      if (frameAt < FADE_OUT_FRAMES) {
        setContrast(200 - (uint16_t)190 * frameAt / (FADE_OUT_FRAMES - 1));
        frameAt++;
      } else {
        display.clearDisplay();
        display.display();
        setContrast(0xFF);
        eyeOpen = false;
        nextStep();
      }
      break;
    }
  }
}

const char* stateName() {
  if (stepAt >= stepCount) return eyeOpen ? "open" : "dark";
  switch (steps[stepAt].kind) {
    case STEP_ANIM:
    case STEP_LOOP:     return EYE_ANIMS[steps[stepAt].anim].name;
    case STEP_IDLE:     return "idle";
    case STEP_TEXT:     return "text";
    case STEP_FADE_OUT: return "fading";
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
      planAdd(STEP_FADE_OUT, -1, 0);
    } else {
      planAdd(STEP_ANIM, A_OPEN, 0, 2);
      planAdd(STEP_IDLE, -1, AFTER_ANSWER_MS);
      planCloseAndFade();
    }
    planStart();
  } else {
    setContrast(0xFF);
    showText(msg);          // as before: the text stays until it is replaced or cleared
    eyeOpen = false;
  }
  sendOk();
}

void handleClear() {
  planClear();
  display.clearDisplay();
  display.display();
  setContrast(0xFF);
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
    planAdd(STEP_FADE_OUT, -1, 0);
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
    planCloseAndFade();
  }
  planStart();
  sendOk();
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
  applyFlip();
  setMaxBrightness();
  showText("Connecting to WiFi...", 1);

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
  server.begin();

  // Boot screen: name and address, small font so it fits
  showText(String(HOSTNAME) + ".local " + WiFi.localIP().toString(), 1);
}

void loop() {
  server.handleClient();
  tickEye();
}
