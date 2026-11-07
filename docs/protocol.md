# BLE protocol v1

Reference for custom clients. Normal testing uses the [mobile app](../mobile/README.md). Select `Carry-XXXXXX`; use one controlling phone per tag. The app retains the selected platform device ID for reconnecting. The display name and boarding-pass token are not used to select a device automatically; no pass token is advertised. NFC is not involved.

## GATT

| Item | UUID | Access |
| --- | --- | --- |
| Service | `7db10001-3a7e-4f5c-9b21-51c61a7e0001` | Advertised |
| Command | `7db10002-3a7e-4f5c-9b21-51c61a7e0001` | Write with response |
| Status | `7db10003-3a7e-4f5c-9b21-51c61a7e0001` | Read, notify |
| Signal | `7db10004-3a7e-4f5c-9b21-51c61a7e0001` | Read; optional on older firmware |
| Wi-Fi scan | `7db10005-3a7e-4f5c-9b21-51c61a7e0001` | Read/write with response; optional |

## Commands

Send raw ASCII without a terminator. Tokens are exactly 16 hexadecimal characters, normalized to uppercase; whitespace is rejected.

| Bytes | Action |
| --- | --- |
| `L` + token (17 bytes) | Assign and close; requires open/unassigned and an active physical setup window |
| `U` + token (17 bytes) | Release only if the stored token matches |
| `C` (1 byte) | Close open/unassigned tag for storage |
| `F` (1 byte) | Flash external LED for 2 seconds |

A 3-second physical button hold requests service opening. There is no BLE service-override command.

## Status

Exactly 12 bytes; multibyte integers are little-endian.

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 1 | Version: `1` |
| 1 | 1 | State |
| 2 | 1 | Last event’s error |
| 3 | 1 | Flags: bit 0 assigned, bit 1 open contact, bit 2 closed contact |
| 4 | 2 | Setup milliseconds remaining, 0–10000 |
| 6 | 4 | Event sequence, unsigned 32-bit with wraparound |
| 10 | 1 | ASCII source: `L`, `U`, `C`, `F`, `S` (physical service), `-` (other) |
| 11 | 1 | Reserved: `0` |

States: `0 OPEN_FREE`, `1 CLOSED_FREE`, `2 LOCKED_ASSIGNED`, `3 MOVING`, `4 FAULT`.

Errors: `0 NONE`, `1 MALFORMED`, `2 UNKNOWN_COMMAND`, `3 BUSY`, `4 ASSIGNED`, `5 NOT_OPEN`, `6 SETUP_REQUIRED`, `7 UNASSIGNED`, `8 TOKEN_MISMATCH`, `9 TIMEOUT`, `10 SENSOR_CONFLICT`, `11 RECOVERY_REQUIRED`, `12 STORAGE`, `13 ACTUATOR`.

## Confirming a command

Subscribe before the initial read; ignore duplicate/older sequences using unsigned wraparound comparison. Reset sequence tracking on reconnect.

Allow one outstanding command. A write response confirms delivery only. Wait for a newer matching-source status with either an error or the target state: `L → LOCKED_ASSIGNED`, `U → OPEN_FREE`, `C → CLOSED_FREE`. `MOVING` is not completion; `F` acknowledges the flash request.

The app waits 5 seconds. A disconnect or missing result requires reconnect/readback; movement commands are never retried automatically. Connection retries use the retained device, increasing the delay from 1 second to a maximum of 30 seconds. Each connection handshake is limited to 10 seconds. Retries pause in the background and stop on manual disconnect/forget. After reconnecting, resubscribe and read fresh status before enabling controls. A newer `S` event interrupts a pending movement request. Errors do not replace the state: a wrong pass leaves the tag locked. A fault requires physical recovery.

## Signal readings

Reading Signal queries RSSI for the requesting phone’s connection using NimBLE `ble_gap_conn_rssi`. Its independent 4-byte response is `[version=1, valid=0/1, signed RSSI in dBm, reserved=0]`. Accept RSSI only when valid is 1 and the value is −127 through +20; HCI’s +127 unavailable sentinel is never valid. This is signal received by the tag, not a distance or position measurement.

The finder reads about once per second while visible. It requires 3 valid readings, uses a 5-sample median plus smoothing, and gives bands with 3 dB hysteresis. A sustained change of at least 5 dB gives stronger/weaker guidance; noisy samples suppress that trend. After 5 seconds without valid data, clear the indication. Reads/writes are serialized, with reads skipped during pending commands and a 2.5-second read timeout. These packets never confirm an actuator command. Missing Signal support leaves lock/release available.

## Connected Wi-Fi scan

Write `[version=1, requestId uint16 LE]` to Wi-Fi scan, then poll its value. Response: `[version=1, state, requestId uint16 LE, count, reserved=0]`, followed by `count` records of `[BSSID 6 bytes, signed RSSI int8, channel uint8]`. States: `0 idle`, `1 scanning`, `2 ready`, `3 failed`, `4 busy`. Only ready responses contain records, up to 12; length is exactly `6 + 8×count`. Match the current request ID and BLE session. These packets never acknowledge motor commands.

The core-0 worker performs an asynchronous scan only after a connected peer writes a request. It keeps the strongest unique globally administered unicast BSSIDs, excludes zero/IANA addresses, and sends no SSIDs. Scans are limited to one per 10 seconds, refused during movement/setup and invalidated on disconnect. Wi-Fi is off between scans; there is no network association or HTTP on the tag. One controlling phone is supported; other peers cannot read the requesting peer's snapshot.

The client bounds scanning to 8 seconds and each GATT operation to 2.5 seconds. It stops on background/close/disconnect, validates readings, requires at least two usable APs and sends them to a phone-side location relay with IP fallback disabled. Lookup results remain in memory only. The app clears them on disconnect/background/close and displays the provider's radius and age. A map link represents the estimate's center, not a measured bag position. Missing scan support does not disable lock/release.
