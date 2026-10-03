# glasses_cam

Arduino's built-in CameraWebServer example, configured for the NULLLAB ESP32-S3 CAM (OV3660).

- Board: ESP32S3 Dev Module
- USB CDC On Boot: Enabled; Flash Size: 8MB (64Mb); Partition Scheme: 8M with spiffs (3MB APP/1.5MB SPIFFS)
- PSRAM: OPI PSRAM; Upload Mode: UART0 / Hardware CDC; USB Mode: Hardware CDC and JTAG
- board_config.h: `#define CAMERA_MODEL_ESP32S3_EYE`
- Adds `#include <ESPmDNS.h>` and `MDNS.begin("glasses-cam");` after the "Camera Ready!" prints.

## Before uploading

In `glasses_cam.ino`, replace `YOUR_HOTSPOT_PASSWORD` with the hotspot password. Never commit the real one.

## Defaults

`setup()` ends the sensor setup with 800x600 frames and an upright image (`FRAMESIZE_SVGA`, `vflip` 0, `hmirror` 1). The stock example starts at 320x240, and on this mount its image is upside down, which makes the vision model misread writing.

The brain sends the same three settings to `/control` when it starts and whenever a session starts, so the camera recovers even with older firmware. Check what the camera is using with:

    curl -s http://172.20.10.4/status

It should show `"framesize":11`, `"vflip":0` and `"hmirror":1`.
