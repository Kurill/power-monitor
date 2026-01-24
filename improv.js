// ============================================================
// Improv WiFi Protocol Implementation
// Shared between flash.js and dashboard.html
// ============================================================

let improvPort = null;
let improvReader = null;
let improvWriter = null;
let improvBuffer = [];
let improvReading = false;
let improvReaderId = 0;

// Build Improv packet
function buildImprovPacket(type, data) {
    const header = [0x49, 0x4D, 0x50, 0x52, 0x4F, 0x56]; // "IMPROV"
    const version = 0x01;
    const packet = [...header, version, type, data.length, ...data];
    const checksum = packet.reduce((a, b) => a + b, 0) & 0xFF;
    return new Uint8Array([...packet, checksum]);
}

// Send Improv packet
async function improvSend(type, data = []) {
    const packet = buildImprovPacket(type, data);
    await improvWriter.write(packet);
}

// Parse packet from buffer
function parsePacketFromBuffer() {
    while (improvBuffer.length >= 10) {
        const headerIdx = improvBuffer.findIndex((v, i) =>
            i <= improvBuffer.length - 6 &&
            improvBuffer[i] === 0x49 && improvBuffer[i+1] === 0x4D &&
            improvBuffer[i+2] === 0x50 && improvBuffer[i+3] === 0x52 &&
            improvBuffer[i+4] === 0x4F && improvBuffer[i+5] === 0x56
        );

        if (headerIdx === -1) {
            improvBuffer = improvBuffer.slice(-5);
            return null;
        }

        if (headerIdx > 0) improvBuffer = improvBuffer.slice(headerIdx);
        if (improvBuffer.length < 10) return null;

        const dataLen = improvBuffer[8];
        const packetLen = 9 + dataLen + 1;

        if (improvBuffer.length < packetLen) return null;

        const packet = improvBuffer.slice(0, packetLen);
        improvBuffer = improvBuffer.slice(packetLen);

        return {
            type: packet[7],
            data: packet.slice(9, 9 + dataLen)
        };
    }
    return null;
}

// Background read loop
async function startImprovReading() {
    const myId = ++improvReaderId;
    improvReading = true;

    try {
        while (improvReading && improvReader && improvReaderId === myId) {
            const { value, done } = await improvReader.read();
            if (done) break;
            if (value && value.length > 0) {
                improvBuffer.push(...value);
            }
        }
    } catch (e) {
        console.log('Improv reader error:', e);
    }
    if (improvReaderId === myId) {
        improvReading = false;
    }
}

// Read packet with timeout
async function improvReadPacket(timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const packet = parsePacketFromBuffer();
        if (packet) return packet;
        await new Promise(r => setTimeout(r, 50));
    }
    return null;
}

// Connect to device
async function improvConnect(logFn = console.log) {
    try {
        improvPort = await navigator.serial.requestPort();
        await improvPort.open({ baudRate: 115200 });
        await improvPort.setSignals({ dataTerminalReady: false, requestToSend: false });

        improvReader = improvPort.readable.getReader();
        improvWriter = improvPort.writable.getWriter();
        improvBuffer = [];

        startImprovReading();
        logFn('Підключено до порту');

        await new Promise(r => setTimeout(r, 1000));
        improvBuffer = [];

        return true;
    } catch (e) {
        logFn('Помилка: ' + e.message, 'error');
        return false;
    }
}

// Disconnect
async function improvDisconnect() {
    improvReading = false;
    try {
        if (improvReader) { improvReader.releaseLock(); improvReader = null; }
        if (improvWriter) { improvWriter.releaseLock(); improvWriter = null; }
        if (improvPort) { await improvPort.close(); improvPort = null; }
    } catch (e) {}
}

// Scan WiFi networks
async function improvScanNetworks(logFn = console.log) {
    logFn('Сканування мереж...');

    try {
        await new Promise(r => setTimeout(r, 500));
        improvBuffer = [];

        const scanPacket = buildImprovPacket(0x03, [0x04, 0x00]);
        await improvWriter.write(scanPacket);

        const networks = [];
        const startTime = Date.now();
        let gotResults = false;

        while (Date.now() - startTime < 15000) {
            const response = await improvReadPacket(gotResults ? 2000 : 10000);
            if (!response) {
                if (gotResults) break;
                continue;
            }

            if (response.type === 0x04) {
                gotResults = true;
                const data = response.data;

                if (data.length <= 2 || (data.length > 1 && data[1] === 0)) {
                    break;
                }

                let offset = 2;

                if (offset >= data.length) continue;
                const ssidLen = data[offset++];
                if (offset + ssidLen > data.length) continue;
                const ssid = new TextDecoder().decode(new Uint8Array(data.slice(offset, offset + ssidLen)));
                offset += ssidLen;

                if (offset >= data.length) continue;
                const rssiLen = data[offset++];
                if (offset + rssiLen > data.length) continue;
                let rssi = 0;
                if (rssiLen === 1) {
                    rssi = data[offset] > 127 ? data[offset] - 256 : data[offset];
                } else {
                    rssi = parseInt(new TextDecoder().decode(new Uint8Array(data.slice(offset, offset + rssiLen)))) || 0;
                }
                offset += rssiLen;

                if (offset >= data.length) continue;
                const authLen = data[offset++];
                if (offset + authLen > data.length) continue;
                const auth = new TextDecoder().decode(new Uint8Array(data.slice(offset, offset + authLen)));

                if (ssid) {
                    networks.push({ ssid, rssi, auth: auth === 'YES' });
                }
            } else if (response.type === 0x02) {
                const errCode = response.data[0];
                throw new Error(`Scan error: ${errCode}`);
            }
        }

        // Remove duplicates, keep strongest signal
        const uniqueNetworks = [];
        const seen = new Set();
        networks.sort((a, b) => b.rssi - a.rssi);
        for (const net of networks) {
            if (!seen.has(net.ssid)) {
                seen.add(net.ssid);
                uniqueNetworks.push(net);
            }
        }

        logFn(`Знайдено ${uniqueNetworks.length} мереж`, 'success');
        return uniqueNetworks;

    } catch (e) {
        logFn('Сканування недоступне: ' + e.message, 'error');
        console.error('Scan error:', e);
        return [];
    }
}

// Send WiFi credentials (save only, don't wait for connection)
async function improvSaveWifi(ssid, password, logFn = console.log) {
    try {
        logFn(`Збереження "${ssid}"...`);

        const ssidBytes = new TextEncoder().encode(ssid);
        const passBytes = new TextEncoder().encode(password);
        const totalLen = 1 + ssidBytes.length + 1 + passBytes.length;
        const data = [0x01, totalLen, ssidBytes.length, ...ssidBytes, passBytes.length, ...passBytes];

        await improvSend(0x03, data);
        await new Promise(r => setTimeout(r, 500));

        logFn('Збережено!', 'success');
        return true;
    } catch (e) {
        logFn('Помилка: ' + e.message, 'error');
        return false;
    }
}

// Send WiFi credentials and wait for connection result
async function improvTestWifi(ssid, password, logFn = console.log, retryCount = 0) {
    try {
        logFn(`Підключення до "${ssid}"...`);

        // Clear buffer before sending
        improvBuffer = [];
        await new Promise(r => setTimeout(r, 300));

        const ssidBytes = new TextEncoder().encode(ssid);
        const passBytes = new TextEncoder().encode(password);
        const totalLen = 1 + ssidBytes.length + 1 + passBytes.length;
        const data = [0x01, totalLen, ssidBytes.length, ...ssidBytes, passBytes.length, ...passBytes];

        await improvSend(0x03, data);

        const startTime = Date.now();
        while (Date.now() - startTime < 25000) {
            const response = await improvReadPacket(15000);
            if (!response) continue;

            if (response.type === 0x01) {
                const state = response.data[0];
                if (state === 0x03) {
                    logFn('Підключення...');
                } else if (state === 0x04) {
                    logFn('Підключено! Чекаємо URL...');
                    continue;
                }
            } else if (response.type === 0x04) {
                logFn('WiFi налаштовано!', 'success');
                return true;
            } else if (response.type === 0x02) {
                const errCode = response.data[0];
                if (errCode === 0) continue;
                const errors = {1: 'Invalid RPC', 2: 'Unknown RPC', 3: 'Невірний пароль або мережа недоступна', 4: 'Not authorized'};
                throw new Error(errors[errCode] || `Error ${errCode}`);
            }
        }

        throw new Error('Таймаут підключення');
    } catch (e) {
        // Auto-retry once on timeout
        if (e.message === 'Таймаут підключення' && retryCount < 1) {
            logFn('Повторна спроба...', 'error');
            return improvTestWifi(ssid, password, logFn, retryCount + 1);
        }
        logFn('Помилка: ' + e.message, 'error');
        return false;
    }
}

// Export for use as module
if (typeof window !== 'undefined') {
    window.Improv = {
        connect: improvConnect,
        disconnect: improvDisconnect,
        scan: improvScanNetworks,
        saveWifi: improvSaveWifi,
        testWifi: improvTestWifi
    };
}
