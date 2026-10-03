// Glasses HUD firmware
// Board: XIAO_ESP32C3 (Tools > USB CDC On Boot: Enabled)
// Wiring: OLED VCC->3V3, GND->GND, SDA->D4, SCL->D5
// Libraries: Adafruit SSD1306, Adafruit GFX
//
// Send text from your Mac:
//   curl -G --data-urlencode "text=Hello there" http://glasses-hud.local/show
// Clear the screen:
//   curl http://glasses-hud.local/clear

#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

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

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
WebServer server(80);

void applyFlip() {
  // Segment remap: 0xA1 is the library default, 0xA0 mirrors left-right.
  display.ssd1306_command(FLIP_HORIZONTAL ? 0xA0 : 0xA1);
  // COM scan direction: 0xC8 is the library default, 0xC0 flips top-bottom.
  display.ssd1306_command(FLIP_VERTICAL ? 0xC0 : 0xC8);
}

void setMaxBrightness() {
  display.ssd1306_command(SSD1306_SETCONTRAST);
  display.ssd1306_command(0xFF);
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

void sendOk() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "ok");
}

void handleShow() {
  String msg = "";
  if (server.hasArg("text"))       msg = server.arg("text");
  else if (server.hasArg("plain")) msg = server.arg("plain");  // raw POST body
  showText(msg);
  Serial.println("Showing: " + msg);
  sendOk();
}

void handleClear() {
  display.clearDisplay();
  display.display();
  sendOk();
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
  server.begin();

  // Boot screen: name and address, small font so it fits
  showText(String(HOSTNAME) + ".local " + WiFi.localIP().toString(), 1);
}

void loop() {
  server.handleClient();
}
