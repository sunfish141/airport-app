# Luggage tag BLE protocol v1

The app and firmware each declare the same UUIDs:

| Item | UUID | Properties |
| --- | --- | --- |
| Service | `7db10001-3a7e-4f5c-9b21-51c61a7e0001` | Advertised |
| Command | `7db10002-3a7e-4f5c-9b21-51c61a7e0001` | Write with response |
| Status | `7db10003-3a7e-4f5c-9b21-51c61a7e0001` | Read, notify |

## Commands

Commands are raw ASCII bytes, with no newline, null byte or other terminator. Maximum command length is 17 bytes. Hex tokens normalize to uppercase on both sides. Whitespace, non-hex characters and extra/missing bytes are rejected.

| Command | Length | Meaning |
| --- | --- | --- |
| `L` + token | 17 | Assign and close; requires unassigned/open and active setup window |
| `U` + token | 17 | Open; firmware must compare against stored assignment |
| `C` | 1 | Close for storage; requires unassigned/open |
| `F` | 1 | Flash LED for two seconds |

Service opening is available only through the physical button; there is no BLE service-override command. Commands received while moving are rejected with `BUSY`.

## Status packet

Status is a fixed **12-byte binary** value, which fits a default ATT MTU of 23 (20-byte notification payload). All multibyte integers use little endian.

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 1 | Protocol version: `1` |
| 1 | 1 | State enum |
| 2 | 1 | Error enum for this event; zero is no error |
| 3 | 1 | Flags: bit 0 assigned, bit 1 open switch active, bit 2 closed switch active |
| 4 | 2 | Setup time remaining in milliseconds; 0–10000 |
| 6 | 4 | Event sequence, incrementing uint32, wrapping to zero |
| 10 | 1 | Event source as ASCII: `L`, `U`, `C`, `F`, `S` (physical service), `-` (autonomous/malformed/unknown) |
| 11 | 1 | Reserved: zero |

The sequence restarts at boot. Every new connection discards its previous sequence. Within one connection, readers ignore duplicate/older events using unsigned 32-bit sequence arithmetic. The app subscribes before reading so the initial read cannot overwrite a newer notification. Setup notifications arrive on each second boundary; the app counts down locally between them. No token, phone identity or passenger details appear in status.

| State byte | State |
| --- | --- |
| 0 | `OPEN_FREE` |
| 1 | `CLOSED_FREE` |
| 2 | `LOCKED_ASSIGNED` |
| 3 | `MOVING` |
| 4 | `FAULT` |

| Error byte | Code |
| --- | --- |
| 0 | `NONE` |
| 1 | `MALFORMED` |
| 2 | `UNKNOWN_COMMAND` |
| 3 | `BUSY` |
| 4 | `ASSIGNED` |
| 5 | `NOT_OPEN` |
| 6 | `SETUP_REQUIRED` |
| 7 | `UNASSIGNED` |
| 8 | `TOKEN_MISMATCH` |
| 9 | `TIMEOUT` |
| 10 | `SENSOR_CONFLICT` |
| 11 | `RECOVERY_REQUIRED` |
| 12 | `STORAGE` |
| 13 | `ACTUATOR` |

Errors describe the last event and do not imply a new physical state. For example, `TOKEN_MISMATCH` is sent with the current `LOCKED_ASSIGNED` state and assigned flag retained. The firmware state remains `FAULT` after a rejected movement command until physical recovery. `F` may flash while faulted and does not repair the fault.

## Completion

The app permits one outstanding command. A GATT write response means delivery only. It waits up to five seconds for a newer status with the same source opcode and either an error or the sensor-confirmed target state: `L → LOCKED_ASSIGNED`, `U → OPEN_FREE`, `C → CLOSED_FREE`. `MOVING` is not success. `F` acknowledges the bounded flash request. A missing result or disconnect invalidates the connection; the app requires reconnection/readback rather than retrying automatically. There is no request identifier in the guide's command format, so clients must serialize commands and use one controlling phone at a time.

Golden status example: `01 02 00 05 00 00 78 56 34 12 4C 00` means version 1, locked/assigned, no error, assigned + closed switch, no setup window, sequence `0x12345678`, source `L`.
