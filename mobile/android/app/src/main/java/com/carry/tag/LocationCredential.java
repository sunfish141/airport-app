package com.carry.tag;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.spec.MGF1ParameterSpec;
import javax.crypto.Cipher;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import org.json.JSONObject;

// One phone's prototype credential. The APK contains no provider key. Only
// ciphertext is imported over USB; its private decryption key never leaves
// Android Keystore. Plaintext is used only in native memory for HTTPS requests.
final class LocationCredential {
    private static final String ALIAS = "carry.location.credential.v1";
    private final Context context;
    private final SharedPreferences preferences;
    private KeyStore store;

    LocationCredential(Context context) {
        this.context = context;
        preferences = context.getSharedPreferences("carry-location", Context.MODE_PRIVATE);
    }

    void initialize() throws Exception {
        store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(2048).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1).build());
            generator.generateKeyPair();
        }
        File directory = context.getExternalFilesDir(null);
        if (directory == null) throw new IllegalStateException("App provisioning storage unavailable");
        String pem = "-----BEGIN PUBLIC KEY-----\n" + Base64.encodeToString(
            store.getCertificate(ALIAS).getPublicKey().getEncoded(), Base64.NO_WRAP).replaceAll("(.{64})", "$1\n") +
            "\n-----END PUBLIC KEY-----\n";
        Files.write(new File(directory, "carry-location-public.pem").toPath(), pem.getBytes(StandardCharsets.US_ASCII));
        File incoming = new File(directory, "carry-location-key.enc");
        if (incoming.exists()) {
            try {
                if (incoming.length() != 256) throw new IllegalArgumentException("Invalid credential envelope");
                byte[] encrypted = Files.readAllBytes(incoming.toPath());
                decrypt(encrypted); // Validate before replacing a working credential.
                if (!preferences.edit().putString("encrypted", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) {
                    throw new IllegalStateException("Could not save location configuration");
                }
            } finally { Files.deleteIfExists(incoming.toPath()); }
        }
        String encrypted = preferences.getString("encrypted", null);
        JSONObject status = new JSONObject().put("configured", encrypted != null);
        if (encrypted != null) status.put("credentialId", hex(MessageDigest.getInstance("SHA-256")
            .digest(Base64.decode(encrypted, Base64.NO_WRAP))));
        // Public installation status only. Never export decrypted credentials.
        Files.write(new File(directory, "carry-location-status.json").toPath(), status.toString().getBytes(StandardCharsets.UTF_8));
    }

    String read() throws Exception {
        String encrypted = preferences.getString("encrypted", null);
        return encrypted == null ? null : decrypt(Base64.decode(encrypted, Base64.NO_WRAP));
    }

    private String decrypt(byte[] encrypted) throws Exception {
        Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding");
        cipher.init(Cipher.DECRYPT_MODE, (PrivateKey) store.getKey(ALIAS, null),
            new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT));
        byte[] plaintext = cipher.doFinal(encrypted);
        try {
            String key = new String(plaintext, StandardCharsets.US_ASCII).trim();
            if (!key.matches("[A-Za-z0-9_-]{20,160}")) throw new IllegalArgumentException("Invalid location credential");
            return key;
        } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
    }

    static String hex(byte[] value) {
        StringBuilder text = new StringBuilder();
        for (byte b : value) text.append(String.format(java.util.Locale.ROOT, "%02X", b & 255));
        return text.toString();
    }
}
