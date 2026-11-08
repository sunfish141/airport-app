package com.carry.tag;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.SystemClock;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "CarryLocation")
public class CarryLocationPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicReference<Request> active = new AtomicReference<>();
    private LocationCredential credential;
    private boolean initialized;
    private long lastLookup = -10000;
    private static final class LocationError extends Exception {
        LocationError(String message) { super(message); }
    }

    private static final class Request {
        final String id;
        volatile boolean cancelled;
        volatile HttpsURLConnection connection;
        Request(String id) { this.id = id; }
    }

    @Override public void load() {
        worker.execute(() -> {
            try {
                credential = new LocationCredential(getContext());
                credential.initialize();
                initialized = true;
            } catch (Exception ignored) { /* No exception details may expose credentials. */ }
        });
    }

    @PluginMethod public void locate(PluginCall call) {
        String id = call.getString("id", "");
        if (!id.matches("[A-Za-z0-9-]{1,64}")) { call.reject("Invalid location request."); return; }
        final JSONArray points;
        try { points = accessPoints(call.getArray("wifiAccessPoints")); }
        catch (Exception ignored) { call.reject("Provide at least two usable Wi-Fi networks from the tag."); return; }
        Request request = new Request(id);
        if (!active.compareAndSet(null, request)) { call.reject("A location lookup is already running."); return; }
        worker.execute(() -> {
            try {
                if (!initialized) throw new LocationError("Could not initialize protected location storage.");
                String key = credential.read();
                if (key == null) throw new LocationError("Set up the phone's Google location key first.");
                if (request.cancelled) throw new LocationError("Location lookup cancelled.");
                long now = SystemClock.elapsedRealtime();
                if (now - lastLookup < 10000) throw new LocationError("Wait 10 seconds before updating location again.");
                byte[] body = new JSONObject().put("considerIp", false).put("wifiAccessPoints", points)
                    .toString().getBytes(StandardCharsets.UTF_8);
                HttpsURLConnection connection = (HttpsURLConnection) new URL(
                    "https://www.googleapis.com/geolocation/v1/geolocate?key=" + key).openConnection();
                request.connection = connection;
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("X-Android-Package", getContext().getPackageName());
                connection.setRequestProperty("X-Android-Cert", signingCertificate());
                connection.setFixedLengthStreamingMode(body.length);
                if (request.cancelled) throw new LocationError("Location lookup cancelled.");
                lastLookup = now;
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
                int code = connection.getResponseCode();
                if (code != 200) {
                    String error = code == 404 ? "These Wi-Fi networks could not be located."
                        : code == 403 ? "Check Google Geolocation API enablement, billing and the key's Android restrictions."
                        : code == 429 ? "Google location quota reached. Try again later."
                        : "Google could not return a location estimate. Try again.";
                    throw new LocationError(error);
                }
                byte[] response;
                try (InputStream input = connection.getInputStream(); java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream()) {
                    byte[] chunk = new byte[1024];
                    int count;
                    while ((count = input.read(chunk)) != -1) {
                        if (buffer.size() + count > 16384) throw new LocationError("Invalid location response.");
                        buffer.write(chunk, 0, count);
                    }
                    response = buffer.toByteArray();
                }
                JSONObject result = new JSONObject(new String(response, StandardCharsets.UTF_8));
                JSONObject location = result.getJSONObject("location");
                double lat = location.getDouble("lat"), lng = location.getDouble("lng"), accuracy = result.getDouble("accuracy");
                if (!Double.isFinite(lat) || Math.abs(lat) > 90 || !Double.isFinite(lng) || Math.abs(lng) > 180 ||
                    !Double.isFinite(accuracy) || accuracy <= 0) throw new LocationError("Invalid location response.");
                if (request.cancelled) throw new LocationError("Location lookup cancelled.");
                JSObject output = new JSObject();
                output.put("location", new JSObject().put("lat", lat).put("lng", lng)); output.put("accuracy", accuracy);
                call.resolve(output);
            } catch (LocationError error) {
                call.reject(error.getMessage());
            } catch (Exception ignored) {
                // Never forward a URL/exception containing the key to JS or logs.
                call.reject(request.cancelled ? "Location lookup cancelled." : "Location lookup failed. Check the phone's internet connection.");
            } finally {
                if (request.connection != null) request.connection.disconnect();
                active.compareAndSet(request, null);
            }
        });
    }

    @PluginMethod public void cancel(PluginCall call) {
        Request request = active.get();
        if (request != null && request.id.equals(call.getString("id"))) {
            request.cancelled = true;
            if (request.connection != null) request.connection.disconnect();
        }
        call.resolve();
    }

    private JSONArray accessPoints(JSArray input) throws Exception {
        if (input == null || input.length() < 2 || input.length() > 12) throw new IllegalArgumentException();
        JSONArray output = new JSONArray();
        HashSet<String> seen = new HashSet<>();
        for (int i = 0; i < input.length(); i++) {
            JSONObject point = input.getJSONObject(i);
            String mac = point.getString("macAddress").toLowerCase(Locale.ROOT);
            if (!mac.matches("([0-9a-f]{2}:){5}[0-9a-f]{2}")) throw new IllegalArgumentException();
            int rssi = point.getInt("signalStrength"), channel = point.getInt("channel");
            if (rssi != point.getDouble("signalStrength") || rssi < -100 || rssi > -10 ||
                channel != point.getDouble("channel") || channel < 1 || channel > 14) throw new IllegalArgumentException();
            if ((Integer.parseInt(mac.substring(0, 2), 16) & 3) != 0 || mac.equals("00:00:00:00:00:00") ||
                mac.startsWith("00:00:5e:") || !seen.add(mac)) continue;
            output.put(new JSONObject().put("macAddress", mac).put("signalStrength", rssi).put("channel", channel));
        }
        if (output.length() < 2) throw new IllegalArgumentException();
        return output;
    }

    @SuppressWarnings("deprecation")
    private String signingCertificate() throws Exception {
        PackageManager manager = getContext().getPackageManager();
        PackageInfo info = manager.getPackageInfo(getContext().getPackageName(),
            Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES);
        Signature[] signatures = Build.VERSION.SDK_INT >= 28 ? info.signingInfo.getApkContentsSigners() : info.signatures;
        return LocationCredential.hex(MessageDigest.getInstance("SHA-1").digest(signatures[0].toByteArray()));
    }

    @Override protected void handleOnDestroy() {
        Request request = active.get();
        if (request != null) {
            request.cancelled = true;
            if (request.connection != null) request.connection.disconnect();
        }
        worker.shutdownNow();
    }
}
