#include <Arduino.h>
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <atomic>
#include "Config.h"
#include "WifiLocation.h"
#include "WifiScanner.h"

namespace location {
namespace {
struct Request { uint16_t peer; uint16_t id; uint32_t epoch; };
QueueHandle_t requests = nullptr;
std::atomic<uint32_t> epoch{0};
std::atomic<bool> allowed{false};
portMUX_TYPE mutex = portMUX_INITIALIZER_UNLOCKED;
Snapshot snapshot;
uint16_t owner = 0xffff;
uint32_t snapshotEpoch = 0;
bool live(const Request& request) { return epoch.load() == request.epoch; }
void publish(const Request& request, const Snapshot& result) {
  portENTER_CRITICAL(&mutex);
  if (live(request)) { snapshot = result; owner = request.peer; snapshotEpoch = request.epoch; }
  portEXIT_CRITICAL(&mutex);
}
void scanner(void*) {
  Request request{};
  uint32_t lastScan = 0;
  bool scanned = false;
  for (;;) {
    if (xQueueReceive(requests, &request, portMAX_DELAY) != pdTRUE || !live(request)) continue;
    Snapshot result;
    result.request = request.id;
    if (!allowed.load() || (scanned && uint32_t(millis() - lastScan) < 10000)) {
      result.state = State::Busy; publish(request, result); continue;
    }
    result.state = State::Scanning; publish(request, result);
    scanned = true; lastScan = millis();
    // This worker runs on core 0. Wi-Fi initialization and scanning never block
    // the core-1 switch/servo loop. No association, password, HTTP or Wi-Fi NVS.
    WiFi.persistent(false);
    WiFi.setAutoReconnect(false);
    bool started = WiFi.mode(WIFI_STA);
    if (started) WiFi.disconnect(false, false);
    if (started && live(request) && allowed.load()) started = WiFi.scanNetworks(true, true, false, 120) == WIFI_SCAN_RUNNING;
    else started = false;
    int16_t count = WIFI_SCAN_FAILED;
    while (started && live(request) && allowed.load() && uint32_t(millis() - lastScan) < 6000) {
      // Arduino 2.0.17's scanComplete() times out at dwell * 20 (2.4 s),
      // prematurely failing scans extended by BLE/Wi-Fi coexistence. Wait for
      // its real completion event; keep our own bounded, cancellable deadline.
      if (WiFiGenericClass::waitStatusBits(WIFI_SCAN_DONE_BIT, 20) & WIFI_SCAN_DONE_BIT) {
        count = WiFi.scanComplete();
        break;
      }
    }
    result.state = State::Failed;
    if (started && live(request) && allowed.load() && count >= 0) {
      result.state = State::Ready;
      // Arduino's indexed scan API takes uint8_t. Cap at 255 in dense areas.
      for (int i = 0; i < count && i < 255; ++i) {
        AccessPoint ap;
        const uint8_t* mac = WiFi.BSSID(uint8_t(i));
        if (!mac) continue;
        std::memcpy(ap.mac.data(), mac, 6);
        const int32_t rssi = WiFi.RSSI(uint8_t(i));
        const int32_t channel = WiFi.channel(uint8_t(i));
        if (rssi < -100 || rssi > -10 || channel < 1 || channel > 14) continue;
        ap.rssi = int8_t(rssi); ap.channel = uint8_t(channel);
        add(result, ap);
      }
    }
    esp_wifi_scan_stop();
    WiFi.mode(WIFI_OFF);
    WiFi.scanDelete();
    // State/count only: never log SSIDs, AP addresses or the Google key.
    Serial.printf("wifi state=%u count=%u elapsed_ms=%lu\n", unsigned(result.state), unsigned(result.count),
                  static_cast<unsigned long>(millis() - lastScan));
    publish(request, result); // Disconnected/reused BLE sessions discard results.
  }
}
class Characteristic : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& info) override {
    if (!requests) return;
    const auto value = characteristic->getValue();
    if (value.size() != 3 || value[0] != 1) return;
    Request request{info.getConnHandle(), uint16_t(uint8_t(value[1]) | uint16_t(uint8_t(value[2])) << 8), epoch.load()};
    // A single pending request prevents unbounded work from repeated writes.
    xQueueOverwrite(requests, &request);
  }
  void onRead(NimBLECharacteristic* characteristic, NimBLEConnInfo& info) override {
    Snapshot result;
    portENTER_CRITICAL(&mutex);
    if (owner == info.getConnHandle() && snapshotEpoch == epoch.load()) result = snapshot;
    portEXIT_CRITICAL(&mutex);
    const auto bytes = encode(result);
    characteristic->setValue(bytes.data(), HEADER_SIZE + bytes[4] * 8);
  }
} callbacks;
}
void begin(NimBLEService* service) {
  requests = xQueueCreate(1, sizeof(Request));
  if (!requests) return;
  if (xTaskCreatePinnedToCore(scanner, "tag-wifi", 6144, nullptr, 1, nullptr, 0) != pdPASS) {
    vQueueDelete(requests); requests = nullptr; return;
  }
  auto* characteristic = service->createCharacteristic(config::WIFI_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE, PACKET_SIZE);
  characteristic->setCallbacks(&callbacks);
  const auto bytes = encode(Snapshot{});
  characteristic->setValue(bytes.data(), HEADER_SIZE);
}
void disconnected() { ++epoch; }
void allowScan(bool value) { allowed.store(value); }
}
