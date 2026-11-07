#pragma once
#include <stdint.h>
class NimBLEService;
namespace location {
void begin(NimBLEService* service);
void disconnected();
void allowScan(bool allowed);
}
