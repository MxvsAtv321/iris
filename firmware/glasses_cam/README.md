# glasses_cam

Arduino's built-in CameraWebServer example, configured for the NULLLAB ESP32-S3 CAM (OV3660).

- Board: ESP32S3 Dev Module
- USB CDC On Boot: Enabled; Flash Size: 8MB (64Mb); Partition Scheme: 8M with spiffs (3MB APP/1.5MB SPIFFS)
- PSRAM: OPI PSRAM; Upload Mode: UART0 / Hardware CDC; USB Mode: Hardware CDC and JTAG
- board_config.h: `#define CAMERA_MODEL_ESP32S3_EYE`
- Adds `#include <ESPmDNS.h>` and `MDNS.begin("glasses-cam");` after the "Camera Ready!" prints.

Copy your working sketch folder here, with the WiFi password replaced by a placeholder before committing.
