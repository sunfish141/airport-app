#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>

#include "Config.h"
#include "Controller.h"
#include "BoardConfig.h"
#include "WifiScanner.h"

#if !defined(CONFIG_IDF_TARGET_ESP32)
#error "Use the esp32_wroom32 PlatformIO environment for the purchased ESP-WROOM-32 board."
#endif

namespace {
Preferences preferences;
NimBLECharacteristic* statusCharacteristic = nullptr;
QueueHandle_t commandQueue = nullptr;
std::atomic<bool> overflow{false};
struct Message { uint8_t length; char bytes[17]; };
bool storageReady = false;
uint32_t flashStarted = 0;
bool flashing = false;
bool pwmAttached = false;

class Board : public tag::Hardware {
 public:
  bool save(const tag::Record& record) override {
    if (!storageReady) return false;
    const auto bytes = tag::encodeRecord(record);
    // One NVS blob keeps assignment, pending intent and fault latch atomic.
    return preferences.putBytes("state", bytes.data(), bytes.size()) == bytes.size();
  }
  bool drive(tag::Pending direction) override {
    if (ledcSetup(boardconfig::PWM_CHANNEL, boardconfig::SERVO_HZ, boardconfig::PWM_RESOLUTION) == 0) return false;
    ledcAttachPin(boardconfig::SERVO_PIN, boardconfig::PWM_CHANNEL);
    pwmAttached = true;
    const uint16_t pulse = direction == tag::Pending::Open ? boardconfig::OPEN_PULSE_US : boardconfig::CLOSED_PULSE_US;
    const uint32_t duty = uint32_t(pulse) * ((1u << boardconfig::PWM_RESOLUTION) - 1) / boardconfig::SERVO_PERIOD_US;
    ledcWrite(boardconfig::PWM_CHANNEL, duty);
    return true;
  }
  void stop() override {
    if (pwmAttached) { ledcWrite(boardconfig::PWM_CHANNEL, 0); ledcDetachPin(boardconfig::SERVO_PIN); pwmAttached = false; }
    digitalWrite(boardconfig::SERVO_PIN, LOW);
  }
  void flash(uint32_t now) override { flashing = true; flashStarted = now; }
  void publish(const tag::Status& status) override {
    const auto bytes = tag::encodeStatus(status);
    if (statusCharacteristic) {
      statusCharacteristic->setValue(bytes.data(), bytes.size());
      statusCharacteristic->notify();
    }
  }
} board;
tag::Controller controller(board);
tag::DebouncedInput openInput, closedInput, buttonInput;

class Commands : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo&) override {
    // BLE callbacks never operate the servo, NVS or controller directly.
    const auto value = characteristic->getValue();
    Message message{};
    message.length = value.size() > 17 ? 18 : uint8_t(value.size());
    if (message.length <= 17) std::memcpy(message.bytes, value.data(), message.length);
    if (xQueueSend(commandQueue, &message, 0) != pdTRUE) overflow.store(true);
  }
} commands;
// Read the requesting phone's link, rather than a global/previous peer's RSSI.
// This runs on the BLE task, keeping HCI queries out of the actuator loop.
class Signal : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic* characteristic, NimBLEConnInfo& info) override {
    int8_t rssi = 127; // HCI sentinel: RSSI unavailable.
    const bool valid = ble_gap_conn_rssi(info.getConnHandle(), &rssi) == 0 && rssi >= -127 && rssi <= 20;
    const uint8_t bytes[] = {1, uint8_t(valid), valid ? uint8_t(rssi) : uint8_t(0), 0};
    characteristic->setValue(bytes, sizeof(bytes));
  }
} signalCallbacks;
class ServerCallbacks : public NimBLEServerCallbacks {
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override { location::disconnected(); NimBLEDevice::startAdvertising(); }
} serverCallbacks;

void sample(uint32_t now) {
  openInput.update(digitalRead(boardconfig::OPEN_PIN) == LOW, now);
  closedInput.update(digitalRead(boardconfig::CLOSED_PIN) == LOW, now);
  buttonInput.update(digitalRead(boardconfig::BUTTON_PIN) == LOW, now);
}
}

void setup() {
  // The external LED uses GPIO26; UART0 and flash pins are left unused.
  // No serial logging of tokens or passenger data.
  pinMode(boardconfig::SERVO_PIN, OUTPUT);
  digitalWrite(boardconfig::SERVO_PIN, LOW);
  pinMode(boardconfig::OPEN_PIN, INPUT_PULLUP);
  pinMode(boardconfig::CLOSED_PIN, INPUT_PULLUP);
  pinMode(boardconfig::BUTTON_PIN, INPUT_PULLUP);
  pinMode(boardconfig::LED_PIN, OUTPUT);
  commandQueue = xQueueCreate(8, sizeof(Message));
  if (!commandQueue) { while (true) { digitalWrite(boardconfig::LED_PIN, !digitalRead(boardconfig::LED_PIN)); delay(100); } }

  storageReady = preferences.begin("luggage", false);
  tag::Record record;
  tag::LoadResult result = tag::LoadResult::Unavailable;
  if (storageReady) {
    if (!preferences.isKey("state")) result = tag::LoadResult::Missing;
    else {
      std::array<uint8_t, tag::RECORD_SIZE> bytes{};
      const size_t size = preferences.getBytesLength("state");
      result = size == bytes.size() && preferences.getBytes("state", bytes.data(), bytes.size()) == bytes.size() && tag::decodeRecord(bytes.data(), bytes.size(), record) ? tag::LoadResult::Valid : tag::LoadResult::Corrupt;
    }
  }
  // Wait for stable initial inputs. No servo command is issued at boot.
  do { sample(millis()); delay(1); } while (!openInput.ready() || !closedInput.ready() || !buttonInput.ready());

  const uint64_t chipId = ESP.getEfuseMac();
  char name[18];
  std::snprintf(name, sizeof(name), "Carry-%06X", unsigned((chipId >> 24) & 0xffffff));
  NimBLEDevice::init(name);
  auto* server = NimBLEDevice::createServer();
  server->setCallbacks(&serverCallbacks);
  auto* service = server->createService(config::SERVICE_UUID);
  auto* commandCharacteristic = service->createCharacteristic(config::COMMAND_UUID, NIMBLE_PROPERTY::WRITE, 64);
  commandCharacteristic->setCallbacks(&commands);
  statusCharacteristic = service->createCharacteristic(config::STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, 12);
  auto* signalCharacteristic = service->createCharacteristic(config::SIGNAL_UUID, NIMBLE_PROPERTY::READ, 4);
  signalCharacteristic->setCallbacks(&signalCallbacks);
  const uint8_t noSignal[] = {1, 0, 0, 0};
  signalCharacteristic->setValue(noSignal, sizeof(noSignal));
  location::begin(service);
  controller.begin(record, result, {openInput.pressed(), closedInput.pressed()}, millis());
  service->start();
  auto* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(config::SERVICE_UUID);
  advertising->setName(name);
  advertising->enableScanResponse(true);
  advertising->start();
}

void loop() {
  const uint32_t now = millis();
  sample(now);
  controller.tick({openInput.pressed(), closedInput.pressed()}, buttonInput.pressed(), now);
  Message message{};
  // One command per loop keeps switch monitoring and service recovery responsive.
  if (xQueueReceive(commandQueue, &message, 0) == pdTRUE) controller.command(message.bytes, message.length, now);
  if (overflow.exchange(false)) controller.rejectBusy(now);
  location::allowScan(controller.status().state != tag::State::Moving && controller.status().setupMs == 0 && !buttonInput.pressed());
  if (flashing && uint32_t(now - flashStarted) >= 2000) flashing = false;
  const bool fault = controller.status().state == tag::State::Fault;
  const bool setup = controller.status().setupMs > 0;
  digitalWrite(boardconfig::LED_PIN, flashing ? (uint32_t(now - flashStarted) / 100) % 2 : fault ? (now / 250) % 2 : setup ? (now / 500) % 2 : LOW);
  delay(2);
}
