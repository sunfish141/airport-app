#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <atomic>
#include "Controller.h"

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
    if (ledcSetup(config::PWM_CHANNEL, 50, config::PWM_RESOLUTION) == 0) return false;
    ledcAttachPin(config::SERVO_PIN, config::PWM_CHANNEL);
    pwmAttached = true;
    const uint16_t pulse = direction == tag::Pending::Open ? config::OPEN_PULSE_US : config::CLOSED_PULSE_US;
    const uint32_t duty = uint32_t(pulse) * ((1u << config::PWM_RESOLUTION) - 1) / 20000u;
    ledcWrite(config::PWM_CHANNEL, duty);
    return true;
  }
  void stop() override {
    if (pwmAttached) { ledcWrite(config::PWM_CHANNEL, 0); ledcDetachPin(config::SERVO_PIN); pwmAttached = false; }
    digitalWrite(config::SERVO_PIN, LOW);
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
    if (message.length <= 17) memcpy(message.bytes, value.data(), message.length);
    if (xQueueSend(commandQueue, &message, 0) != pdTRUE) overflow.store(true);
  }
} commands;
class ServerCallbacks : public NimBLEServerCallbacks {
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override { NimBLEDevice::startAdvertising(); }
} serverCallbacks;

void sample(uint32_t now) {
  openInput.update(digitalRead(config::OPEN_PIN) == LOW, now);
  closedInput.update(digitalRead(config::CLOSED_PIN) == LOW, now);
  buttonInput.update(digitalRead(config::BUTTON_PIN) == LOW, now);
}
}

void setup() {
  // GPIO21 is the external status LED. Do not enable UART serial on this pin.
  pinMode(config::SERVO_PIN, OUTPUT);
  digitalWrite(config::SERVO_PIN, LOW);
  pinMode(config::OPEN_PIN, INPUT_PULLUP);
  pinMode(config::CLOSED_PIN, INPUT_PULLUP);
  pinMode(config::BUTTON_PIN, INPUT_PULLUP);
  pinMode(config::LED_PIN, OUTPUT);
  commandQueue = xQueueCreate(8, sizeof(Message));
  if (!commandQueue) { while (true) { digitalWrite(config::LED_PIN, !digitalRead(config::LED_PIN)); delay(100); } }

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
  snprintf(name, sizeof(name), "Carry-%06X", unsigned((chipId >> 24) & 0xffffff));
  NimBLEDevice::init(name);
  auto* server = NimBLEDevice::createServer();
  server->setCallbacks(&serverCallbacks);
  auto* service = server->createService(config::SERVICE_UUID);
  auto* commandCharacteristic = service->createCharacteristic(config::COMMAND_UUID, NIMBLE_PROPERTY::WRITE, 64);
  commandCharacteristic->setCallbacks(&commands);
  statusCharacteristic = service->createCharacteristic(config::STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY, 12);
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
  if (flashing && uint32_t(now - flashStarted) >= 2000) flashing = false;
  const bool fault = controller.status().state == tag::State::Fault;
  const bool setup = controller.status().setupMs > 0;
  digitalWrite(config::LED_PIN, flashing ? (uint32_t(now - flashStarted) / 100) % 2 : fault ? (now / 250) % 2 : setup ? (now / 500) % 2 : LOW);
  delay(2);
}
