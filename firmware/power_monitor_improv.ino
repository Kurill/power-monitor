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

// Enter download mode - stop serial and halt
// esptool will reset via DTR/RTS and catch bootloader
void enterDownloadMode() {
    Serial.flush();
    Serial.end();
    // Completely stop - let esptool reset us
    while(1) {
        __asm__ __volatile__("nop");
    }
}

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

// Check first byte - if it's 0xC0 (SLIP frame), likely esptool
void checkForBootloaderRequest() {
    if (Serial.available()) {
        uint8_t b = Serial.peek();
        if (b == 0xC0) {
            // esptool sync detected - stop and wait for hardware reset
            enterDownloadMode();
        }
    }
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
        // Check for esptool during WiFi connect
        checkForBootloaderRequest();
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
    // Start Serial FIRST to catch esptool sync
    Serial.begin(115200);
    Serial.setRxBufferSize(256);

    // Wait for esptool sync - give it 500ms window after reset
    // esptool sends 0xC0 sync frames when trying to connect
    unsigned long bootTime = millis();
    while (millis() - bootTime < 500) {
        if (Serial.available()) {
            uint8_t b = Serial.peek();
            if (b == 0xC0) {
                // esptool detected - stop and wait for hardware reset
                enterDownloadMode();
            }
            // Not esptool - clear the byte and continue waiting
            Serial.read();
        }
        delay(1);
    }

    // Init WiFi (needed for MAC address)
    WiFi.mode(WIFI_STA);
    WiFi.disconnect();
    delay(100);

    deviceId = trimPlaceholder(DEVICE_ID);
    deviceName = trimPlaceholder(DEVICE_NAME);
    serverIp = trimPlaceholder(SERVER_IP);

    // If placeholders not patched, use defaults
    if (deviceId.startsWith("@@") || deviceId.length() == 0) {
        deviceId = generateDeviceId();
    }
    if (deviceName.startsWith("@@") || deviceName.length() == 0) {
        deviceName = "Power Monitor";
    }
    if (serverIp.startsWith("@@") || serverIp.length() == 0) {
        serverIp = "178.62.112.232";
    }

    Serial.println("\n=== Power Monitor ===");
    Serial.printf("Device: %s\n", deviceId.c_str());
    Serial.printf("Name: %s\n", deviceName.c_str());
    Serial.printf("Server: %s\n", serverIp.c_str());

    // Setup Improv with dashboard URL + claim parameter
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

    // Check for saved credentials
    prefs.begin("power-mon", true);
    bool configured = prefs.getBool("configured", false);
    String savedSsid = prefs.getString("ssid", "");
    String savedPass = prefs.getString("pass", "");
    prefs.end();

    if (configured && savedSsid.length() > 0) {
        Serial.println("Found saved WiFi, connecting...");
        customConnectWiFi(savedSsid.c_str(), savedPass.c_str());
    } else {
        Serial.println("No WiFi configured - use Improv to setup");
    }
}

void loop() {
    // Check if esptool/browser is trying to flash
    checkForBootloaderRequest();

    // Handle Improv for WiFi configuration
    improvSerial.handleSerial();

    // If connected, do monitoring
    if (improvSerial.isConnected() || WiFi.status() == WL_CONNECTED) {
        unsigned long now = millis();

        if (now - lastPing >= PING_INTERVAL || lastPing == 0) {
            lastPing = now;

            String url = "http://" + serverIp + ":8090/ping?device=" + deviceId;

            HTTPClient http;
            http.begin(url);
            http.setTimeout(10000);
            int code = http.GET();
            Serial.printf("Ping -> %d\n", code);
            http.end();
        }
    }

    // Minimal delay, check for esptool frequently
    delay(1);
}
