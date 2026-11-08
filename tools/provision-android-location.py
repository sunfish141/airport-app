#!/usr/bin/env python3
"""Provision one Android phone using its public key, never plaintext over ADB.

Requires OpenSSL and ADB (or the previously installed Windows tools under WSL).
The installed Carry app must have been opened once to create its Keystore key.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
REMOTE = "/sdcard/Android/data/com.carry.tag/files"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True, help="Target phone's ADB serial")
    args = parser.parse_args()
    powershell = Path("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
    windows_adb = ROOT / "mobile/android/.gradle/carry-tools/windows-adb/platform-tools/adb.exe"
    use_windows = powershell.exists() and windows_adb.exists()
    adb_path = str(windows_adb) if use_windows else shutil.which("adb")
    if not adb_path or not shutil.which("openssl"):
        raise SystemExit("Install ADB and OpenSSL first.")

    def host_path(path):
        return subprocess.check_output(["wslpath", "-w", str(path)], text=True).strip() if use_windows else str(path)

    def adb(*parts, check=True):
        command = [host_path(windows_adb) if use_windows else adb_path, "-s", args.serial, *parts]
        if use_windows:
            # Only paths, public keys and ciphertext go into these arguments.
            quote = lambda value: "'" + str(value).replace("'", "''") + "'"
            script = "& " + " ".join(quote(part) for part in command) + "; exit $LASTEXITCODE"
            command = [str(powershell), "-NoProfile", "-NonInteractive", "-Command", script]
        return subprocess.run(command, check=check, capture_output=True).stdout

    # Node's built-in dotenv reader supports the same local file as the relay.
    key = subprocess.check_output([
        "node", "--env-file=app/server/.env.local", "-e",
        'process.stdout.write(process.env.GOOGLE_GEOLOCATION_API_KEY || "")',
    ], cwd=ROOT).strip()
    if not key or len(key) > 160:
        raise SystemExit("Save GOOGLE_GEOLOCATION_API_KEY in app/server/.env.local first.")
    with tempfile.TemporaryDirectory(prefix="carry-location-") as directory:
        public = Path(directory) / "public.pem"
        envelope = Path(directory) / "credential.enc"
        for attempt in range(20):
            try:
                adb("pull", f"{REMOTE}/carry-location-public.pem", host_path(public))
                break
            except subprocess.CalledProcessError:
                if attempt == 19:
                    raise
                time.sleep(0.5)
        encrypted = subprocess.run([
            "openssl", "pkeyutl", "-encrypt", "-pubin", "-inkey", str(public),
            "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256",
            "-pkeyopt", "rsa_mgf1_md:sha1",
        ], input=key, capture_output=True, check=True).stdout
        envelope.write_bytes(encrypted)
        envelope.chmod(0o600)
        credential_id = hashlib.sha256(encrypted).hexdigest()
        adb("push", host_path(envelope), f"{REMOTE}/carry-location-key.enc")
        adb("shell", "am", "force-stop", "com.carry.tag")
        adb("shell", "am", "start", "-W", "-n", "com.carry.tag/.MainActivity")
        for _ in range(20):
            try:
                status = json.loads(adb("shell", "cat", f"{REMOTE}/carry-location-status.json"))
                if status.get("configured") and status.get("credentialId", "").lower() == credential_id:
                    print("Google location credential installed in this phone's protected native storage.")
                    print("No plaintext key was sent through ADB or added to the APK.")
                    return
            except (json.JSONDecodeError, subprocess.CalledProcessError):
                pass
            time.sleep(1)
        raise SystemExit("Credential import was not confirmed. Check the app's native storage setup.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError:
        # Avoid exposing subprocess output; it can contain local configuration.
        raise SystemExit("Provisioning failed. Check the phone connection and open Carry once before retrying.")
