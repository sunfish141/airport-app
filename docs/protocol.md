# BLE protocol v1

Reference for custom clients. Normal testing uses the [phone app](../app/README.md). Connect to `Carry-XXXXXX`; use one controlling phone per tag. NFC is not involved.

## GATT

| Item | UUID | Access |
| --- | --- | --- |
| Service | `7db10001-3a7e-4f5c-9b21-51c61a7e0001` | Advertised |
| Command | `7db10002-3a7e-4f5c-9b21-51c61a7e0001` | Write with response |
| Status | `7db10003-3a7e-4f5c-9b21-51c61a7e0001` | Read, notify |

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

The app waits 5 seconds. A disconnect or missing result requires reconnect/readback, not automatic retry. A newer `S` event interrupts a pending movement request. Errors do not replace the state: a wrong pass leaves the tag locked. A fault requires physical recovery.
