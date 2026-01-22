/*
 * Power Monitor with Improv WiFi
 *
 * Supports WiFi configuration via browser using Improv protocol.
 * After configuration, pings server every 30 seconds.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ImprovWiFiLibrary.h>
#include <Update.h>

// Placeholders - patched by server before flashing
const char DEVICE_ID[32]   = "@@DEVID@@______________________"; // 31 chars
const char DEVICE_NAME[48] = "@@NAME@@_______________________________________"; // 47 chars
const char SERVER_IP[32]   = "@@SRVR@@_______________________"; // 31 chars

Preferences prefs;
ImprovWiFi improvSerial(&Serial);

String deviceId;
String deviceName;
String serverIp;

unsigned long lastPing = 0;
const unsigned long PING_INTERVAL = 30000;

String trimPlaceholder(const char* str) {
    String s = String(str);
    while (s.endsWith("_")) s.remove(s.length() - 1);
    s.trim();
    return s;
}

// Generate device ID from MAC address
String generateDeviceId() {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char id[16];
    sprintf(id, "pm_%02x%02x%02x", mac[3], mac[4], mac[5]);
    return String(id);
}

// Called when Improv error occurs
void onImprovError(ImprovTypes::Error err) {
    Serial.printf("Improv error: %d\n", err);
}

// Called when WiFi connected via Improv
void onImprovConnected(const char* ssid, const char* password) {
    Serial.printf("WiFi configured: %s\n", ssid);

    // Save credentials
    prefs.begin("power-mon", false);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", password);
    prefs.putBool("configured", true);
    prefs.end();
}

// Custom WiFi connect function
bool customConnectWiFi(const char* ssid, const char* password) {
    Serial.printf("Connecting to %s...\n", ssid);

    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 40) {
        delay(250);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());
        return true;
    }

    Serial.println("\nConnection failed");
    return false;
}

void setup() {
    // Critical: delay before anything to let esptool sync with bootloader
    // Without this, re-flashing via browser fails
    delay(3000);

    // Init WiFi (needed for MAC address)
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    delay(100);

    deviceId = trimPlaceholder(DEVICE_ID);
    deviceName = trimPlaceholder(DEVICE_NAME);
    serverIp = trimPlaceholder(SERVER_IP);

    if (deviceId.startsWith("@@") || deviceId.length() == 0) {
        deviceId = generateDeviceId();
    }
    if (deviceName.startsWith("@@") || deviceName.length() == 0) {
        deviceName = "Power Monitor";
    }
    if (serverIp.startsWith("@@") || serverIp.length() == 0) {
        serverIp = "178.62.112.232";
    }

    // Check for saved WiFi credentials
    prefs.begin("power-mon", true);
    bool configured = prefs.getBool("configured", false);
    String savedSsid = prefs.getString("ssid", "");
    String savedPass = prefs.getString("pass", "");
    prefs.end();

    // Always enable Serial for debugging
    Serial.begin(115200);
    Serial.setRxBufferSize(256);
    delay(100);

    Serial.println("\n=== Power Monitor ===");
    Serial.printf("Device ID: %s\n", deviceId.c_str());
    Serial.printf("Device Name: %s\n", deviceName.c_str());
    Serial.printf("Server IP: %s\n", serverIp.c_str());

    // Setup Improv (always available for reconfiguration)
    String dashboardUrl = "https://power-monitor.club/dashboard?claim=" + deviceId;
    improvSerial.setDeviceInfo(
        ImprovTypes::ChipFamily::CF_ESP32,
        deviceName.c_str(),
        "1.0.0",
        "Power Monitor",
        dashboardUrl.c_str()
    );
    improvSerial.onImprovError(onImprovError);
    improvSerial.onImprovConnected(onImprovConnected);
    improvSerial.setCustomConnectWiFi(customConnectWiFi);

    if (configured && savedSsid.length() > 0) {
        // Try saved WiFi
        Serial.printf("Saved WiFi: %s\n", savedSsid.c_str());
        if (customConnectWiFi(savedSsid.c_str(), savedPass.c_str())) {
            Serial.println("WiFi connected!");
        } else {
            // Connection failed - clear saved credentials
            Serial.println("Saved WiFi failed - clearing credentials");
            prefs.begin("power-mon", false);
            prefs.putBool("configured", false);
            prefs.end();
        }
    } else {
        Serial.println("No WiFi configured - use Improv to setup");
    }
}

void loop() {
    // Handle Improv when not connected (allows reconfiguration)
    if (WiFi.status() != WL_CONNECTED) {
        improvSerial.handleSerial();
    }

    // If connected, do monitoring
    if (WiFi.status() == WL_CONNECTED) {
        unsigned long now = millis();

        if (now - lastPing >= PING_INTERVAL || lastPing == 0) {
            lastPing = now;

            String url = "http://" + serverIp + ":8090/ping?device=" + deviceId;
            Serial.printf("Ping: %s\n", url.c_str());

            HTTPClient http;
            http.begin(url);
            http.setTimeout(10000);
            int httpCode = http.GET();
            Serial.printf("HTTP response: %d\n", httpCode);
            http.end();
        }
    } else {
        // Debug WiFi status
        static unsigned long lastWifiCheck = 0;
        if (millis() - lastWifiCheck > 5000) {
            lastWifiCheck = millis();
            Serial.printf("WiFi status: %d\n", WiFi.status());
        }
    }

    delay(1);
}
