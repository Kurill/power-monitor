// ============================================================
// Power Monitor - Flash Wizard
// ============================================================

import { ESPLoader, Transport } from '/esptool-bundle.js';

// Patch Transport: setDTR buffers, setRTS sends both (for CP2102)
const patchState = { dtr: false, rts: false };
Transport.prototype.setDTR = async function(state) {
    patchState.dtr = state;
    this._DTR_state = state;
};
Transport.prototype.setRTS = async function(state) {
    patchState.rts = state;
    await this.device.setSignals({
        dataTerminalReady: patchState.dtr,
        requestToSend: patchState.rts
    });
};

// ============================================================
// Constants & State
// ============================================================

const SERVER = 'https://power-monitor.club';

let currentStep = 1;
let currentDeviceId = '';
let flashedDeviceId = null;
let flashSuccess = false;
let wifiConfigured = false;
let telegramConfigured = false;

// Flashing state
let device = null;
let transport = null;
let esploader = null;

// Improv state
let improvPort = null;
let improvReader = null;
let improvWriter = null;
let improvBuffer = [];
let improvReading = false;
let improvReaderId = 0;

// Telegram state
let currentBotToken = '';
let currentBotInfo = null;
let currentChatId = '';

// ============================================================
// DOM Elements (initialized in init())
// ============================================================

const $ = (id) => document.getElementById(id);
let elements = {};

// ============================================================
// Wizard Navigation
// ============================================================

function showStep(step) {
    currentStep = step;

    // Update step indicators
    elements.wizardSteps.forEach((el, i) => {
        const stepNum = i + 1;
        el.classList.remove('active', 'done', 'clickable');

        if (stepNum < step) {
            el.classList.add('done', 'clickable');
        } else if (stepNum === step) {
            el.classList.add('active');
        }

        // Allow clicking on completed steps
        if (stepNum < step) {
            el.onclick = () => showStep(stepNum);
        } else {
            el.onclick = null;
        }
    });

    // Update connecting lines
    elements.wizardLines.forEach((el, i) => {
        el.classList.toggle('done', i < step - 1);
    });

    // Show active panel
    elements.wizardPanels.forEach((panel, i) => {
        panel.classList.toggle('active', i + 1 === step);
    });

    // Update navigation buttons
    updateNavButtons();
}

function updateNavButtons() {
    const { btnBack, btnNext } = elements;

    // Back button
    btnBack.style.visibility = currentStep > 1 ? 'visible' : 'hidden';

    // Next button - different states based on step
    switch (currentStep) {
        case 1:
            const name = elements.deviceName.value.trim();
            btnNext.disabled = name.length < 3;
            btnNext.textContent = 'Далі';
            btnNext.className = 'btn-nav btn-nav-primary';
            break;

        case 2:
            if (flashSuccess) {
                btnNext.disabled = false;
                btnNext.textContent = 'Налаштувати WiFi →';
                btnNext.className = 'btn-nav btn-nav-success';
            } else {
                btnNext.disabled = true;
                btnNext.textContent = 'Далі';
                btnNext.className = 'btn-nav btn-nav-primary';
            }
            break;

        case 3:
            btnNext.disabled = false;
            btnNext.textContent = wifiConfigured ? 'Далі →' : 'Пропустити';
            btnNext.className = wifiConfigured ? 'btn-nav btn-nav-success' : 'btn-nav';
            break;

        case 4:
            btnNext.disabled = false;
            btnNext.textContent = 'Готово';
            btnNext.className = telegramConfigured ? 'btn-nav btn-nav-success' : 'btn-nav';
            break;
    }
}

function goBack() {
    if (currentStep > 1) {
        showStep(currentStep - 1);
    }
}

function goNext() {
    switch (currentStep) {
        case 1:
            if (elements.deviceName.value.trim().length >= 3) {
                showStep(2);
            }
            break;
        case 2:
            if (flashSuccess) {
                showStep(3);
                startWifiSetup();
            }
            break;
        case 3:
            showStep(4);
            break;
        case 4:
            // Go to dashboard
            const deviceId = flashedDeviceId || currentDeviceId;
            if (deviceId) {
                window.location.href = `/dashboard?device=${encodeURIComponent(deviceId)}`;
            } else {
                window.location.href = '/dashboard';
            }
            break;
    }
}

// ============================================================
// Step 1: Device Name
// ============================================================

function generateId(name) {
    const slug = name.toLowerCase()
        .replace(/[а-яіїєґ]/g, c => {
            const map = {'а':'a','б':'b','в':'v','г':'h','ґ':'g','д':'d','е':'e','є':'ye','ж':'zh','з':'z','и':'y','і':'i','ї':'yi','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ь':'','ю':'yu','я':'ya'};
            return map[c] || c;
        })
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 20);
    return slug + '_' + Math.random().toString(36).substring(2, 6);
}

// ============================================================
// Step 2: Flashing
// ============================================================

function log(msg, type = '') {
    elements.flashLog.classList.add('visible');
    const line = document.createElement('div');
    if (type) line.className = type;
    line.textContent = msg;
    elements.flashLog.appendChild(line);
    elements.flashLog.scrollTop = elements.flashLog.scrollHeight;
}

function setProgress(pct, text) {
    elements.progressContainer.classList.add('visible');
    elements.progressFill.style.width = pct + '%';
    elements.progressText.textContent = text;
}

const espLoaderTerminal = {
    clean() { elements.flashLog.innerHTML = ''; },
    writeLine(data) {
        if (data instanceof Uint8Array) data = new TextDecoder().decode(data);
        log(String(data));
    },
    write(data) {
        if (data instanceof Uint8Array) data = new TextDecoder().decode(data);
        log(String(data));
    }
};

function cleanUp() {
    device = null;
    transport = null;
    esploader = null;
}

async function startFlashing() {
    const name = elements.deviceName.value.trim();
    if (name.length < 3) return;

    currentDeviceId = generateId(name);

    if (!navigator.serial) {
        alert("Браузер не підтримує Web Serial. Використай Chrome або Edge.");
        return;
    }

    elements.flashBtn.disabled = true;
    elements.flashBtnText.textContent = "Підключення...";
    elements.flashBtn.classList.add('flashing');

    try {
        // 1. Request port
        log("Вибери COM порт...");
        device = await navigator.serial.requestPort({});
        const deviceInfo = device.getInfo();
        log("Port: VID=0x" + deviceInfo.usbVendorId?.toString(16) + " PID=0x" + deviceInfo.usbProductId?.toString(16));

        // 2. Create transport
        log("Створення transport...");
        transport = new Transport(device, true);

        // 3. Create loader
        log("Створення ESPLoader...");
        esploader = new ESPLoader({
            transport,
            baudrate: 115200,
            terminal: espLoaderTerminal,
            debugLogging: false
        });

        // 4. Connect to chip
        setProgress(10, "Підключення до ESP32...");
        log("Підключення до чіпа...");
        const chip = await esploader.main();
        log("Підключено: " + chip, "success");

        // 5. Download firmware
        setProgress(15, "Завантаження прошивки...");
        elements.flashBtnText.textContent = "Завантаження...";
        log("Завантаження прошивки...");

        const fwUrl = `${SERVER}/api/firmware?device=${currentDeviceId}&name=${encodeURIComponent(name)}&server=178.62.112.232&improv=true`;
        const resp = await fetch(fwUrl);
        if (!resp.ok) throw new Error("Помилка завантаження: " + resp.status);

        const fwData = new Uint8Array(await resp.arrayBuffer());
        log("Завантажено " + fwData.length + " байт", "success");

        // 6. Flash firmware + erase NVS
        setProgress(20, "Прошивка...");
        elements.flashBtnText.textContent = "Прошивка...";
        log("Очищення NVS та прошивка...");
        const startTime = Date.now();

        const NVS_ADDR = 0x9000;
        const NVS_SIZE = 0x5000;
        const blankNvs = new Uint8Array(NVS_SIZE).fill(0xFF);

        await esploader.writeFlash({
            fileArray: [
                { data: blankNvs, address: NVS_ADDR },
                { data: fwData, address: 0 }
            ],
            flashSize: 'keep',
            flashMode: 'keep',
            flashFreq: 'keep',
            eraseAll: false,
            compress: true,
            reportProgress: (fileIndex, written, total) => {
                const pct = Math.round(20 + (written / total * 75));
                setProgress(pct, `Прошивка: ${Math.round(written / total * 100)}%`);
            }
        });

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        log("Прошивка завершена за " + totalTime + " сек!", "success");

        // 7. Hard reset
        setProgress(98, "Перезавантаження...");
        log("Hard reset...");
        await device.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(r => setTimeout(r, 100));
        await device.setSignals({ dataTerminalReady: false, requestToSend: false });

        // 8. Cleanup
        const flashPort = device;
        await transport.disconnect();
        cleanUp();
        try { await flashPort.close(); } catch(e) {}

        // 9. Wait for ESP32 to boot
        setProgress(100, "Готово! Очікуємо завантаження...");
        log("Прошивка завершена. Очікуємо завантаження ESP32...", "success");
        await new Promise(r => setTimeout(r, 7000));

        // 10. Get device ID via Improv
        log("Отримуємо ID пристрою...");
        flashSuccess = true;

        try {
            improvPort = flashPort;
            await improvPort.open({ baudRate: 115200 });
            await improvPort.setSignals({ dataTerminalReady: false, requestToSend: false });

            improvReader = improvPort.readable.getReader();
            improvWriter = improvPort.writable.getWriter();
            improvBuffer = [];

            improvReading = true;
            improvReaderId++;
            const myReaderId = improvReaderId;
            (async () => {
                while (improvReading && improvReaderId === myReaderId) {
                    try {
                        const { value, done } = await improvReader.read();
                        if (done || improvReaderId !== myReaderId) break;
                        if (value) improvBuffer.push(...value);
                    } catch (e) { break; }
                }
            })();

            await new Promise(r => setTimeout(r, 1500));
            improvBuffer = [];

            let response = null;
            for (let attempt = 0; attempt < 3 && !response; attempt++) {
                if (attempt > 0) {
                    log("Повторна спроба Improv...");
                    await new Promise(r => setTimeout(r, 1000));
                }
                await improvSend(0x03, [0x03, 0x00]);
                response = await improvReadPacket(3000);
            }

            if (response && response.type === 0x04) {
                const data = response.data;
                let pos = 2;
                const strings = [];
                while (pos < data.length && strings.length < 4) {
                    const len = data[pos];
                    if (pos + 1 + len > data.length) break;
                    strings.push(new TextDecoder().decode(new Uint8Array(data.slice(pos + 1, pos + 1 + len))));
                    pos += 1 + len;
                }
                if (strings.length >= 4) {
                    flashedDeviceId = strings[3];
                    log("ID пристрою: " + flashedDeviceId, "success");
                }
            }

            // Close for now (will reopen for WiFi)
            improvReading = false;
            try { improvReader.releaseLock(); } catch(e) {}
            try { improvWriter.releaseLock(); } catch(e) {}
            try { await improvPort.close(); } catch(e) {}
            improvPort = null;
            improvReader = null;
            improvWriter = null;
        } catch (e) {
            console.error('Get device ID error:', e);
        }

        // 11. Claim device
        if (flashedDeviceId) {
            try {
                const claimUrl = '/api/claim?device=' + encodeURIComponent(flashedDeviceId) +
                    '&name=' + encodeURIComponent(name);
                const claimRes = await fetch(claimUrl);
                if (claimRes.ok) {
                    log("Пристрій додано до профілю!", "success");
                } else if (claimRes.status === 401) {
                    log("Увійдіть в акаунт щоб зберегти пристрій", "error");
                }
            } catch (e) {
                console.error('Claim error:', e);
            }
        }

        // 12. Update UI
        log("Готово! Можеш налаштувати WiFi.", "success");
        elements.flashBtnText.textContent = "Прошито ✓";
        elements.flashBtn.classList.remove('flashing');
        elements.postFlashActions.classList.add('visible');

        // Update wizard step indicator
        elements.wizardSteps[1].classList.add('done');
        updateNavButtons();

    } catch (e) {
        log("Помилка: " + e.message, "error");
        console.error(e);

        if (transport) {
            try { await transport.disconnect(); } catch(err) {}
        }
        if (device) {
            try { await device.close(); } catch(err) {}
            try { await device.forget(); } catch(err) {}
        }
        cleanUp();

        elements.flashBtn.disabled = false;
        elements.flashBtnText.textContent = "Прошити ESP32";
        elements.flashBtn.classList.remove('flashing');
        setProgress(0, "Помилка");
    }
}

// ============================================================
// Step 3: WiFi Setup (Improv Protocol)
// ============================================================

function buildImprovPacket(type, data) {
    const header = [0x49, 0x4D, 0x50, 0x52, 0x4F, 0x56];
    const version = 0x01;
    const packet = [...header, version, type, data.length, ...data];
    const checksum = packet.reduce((a, b) => a + b, 0) & 0xFF;
    return new Uint8Array([...packet, checksum]);
}

async function improvSend(type, data = []) {
    const packet = buildImprovPacket(type, data);
    await improvWriter.write(packet);
}

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
        console.log('Reader error:', e);
    }
    if (improvReaderId === myId) {
        improvReading = false;
    }
}

async function improvReadPacket(timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const packet = parsePacketFromBuffer();
        if (packet) return packet;
        await new Promise(r => setTimeout(r, 50));
    }
    return null;
}

function wifiLog(msg, type = '') {
    elements.wifiLog.classList.add('visible');
    const line = document.createElement('div');
    if (type) line.className = type;
    line.textContent = msg;
    elements.wifiLog.appendChild(line);
    elements.wifiLog.scrollTop = elements.wifiLog.scrollHeight;
}

async function improvConnect() {
    try {
        improvPort = await navigator.serial.requestPort();
        await improvPort.open({ baudRate: 115200 });
        await improvPort.setSignals({ dataTerminalReady: false, requestToSend: false });

        improvReader = improvPort.readable.getReader();
        improvWriter = improvPort.writable.getWriter();
        improvBuffer = [];

        startImprovReading();
        wifiLog('Підключено до порту');

        await new Promise(r => setTimeout(r, 1000));
        improvBuffer = [];

        return true;
    } catch (e) {
        wifiLog('Помилка: ' + e.message, 'error');
        return false;
    }
}

async function improvDisconnect() {
    improvReading = false;
    try {
        if (improvReader) { improvReader.releaseLock(); improvReader = null; }
        if (improvWriter) { improvWriter.releaseLock(); improvWriter = null; }
        if (improvPort) { await improvPort.close(); improvPort = null; }
    } catch (e) {}
}

async function startWifiSetup() {
    elements.wifiLog.innerHTML = '';
    elements.wifiLog.classList.remove('visible');
    elements.wifiNetworkList.innerHTML = '<div class="wifi-network-empty">Підключення...</div>';
    elements.wifiSsid.value = '';
    elements.wifiPass.value = '';

    if (await improvConnect()) {
        await improvScanNetworks();
    }
}

async function improvScanNetworks() {
    wifiLog('Сканування мереж...');
    elements.wifiNetworkList.innerHTML = '<div class="wifi-network-empty">Сканування...</div>';

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

        // Remove duplicates
        const uniqueNetworks = [];
        const seen = new Set();
        networks.sort((a, b) => b.rssi - a.rssi);
        for (const net of networks) {
            if (!seen.has(net.ssid)) {
                seen.add(net.ssid);
                uniqueNetworks.push(net);
            }
        }

        elements.wifiNetworkList.innerHTML = '';
        if (uniqueNetworks.length > 0) {
            uniqueNetworks.forEach(net => {
                const bars = net.rssi > -50 ? 4 : net.rssi > -60 ? 3 : net.rssi > -70 ? 2 : 1;
                const signalBars = [1,2,3,4].map(i =>
                    `<div class="wifi-signal-bar ${i <= bars ? 'active' : ''}"></div>`
                ).join('');

                const item = document.createElement('div');
                item.className = 'wifi-network-item';
                item.dataset.ssid = net.ssid;
                item.innerHTML = `
                    <span class="wifi-network-name">${escapeHtml(net.ssid)}</span>
                    <span class="wifi-network-info">
                        <span class="wifi-signal">${signalBars}</span>
                        ${net.auth ? '🔒' : ''}
                    </span>
                `;
                item.onclick = () => selectNetwork(item, net.ssid);
                elements.wifiNetworkList.appendChild(item);
            });
            wifiLog(`Знайдено ${uniqueNetworks.length} мереж`, 'success');
        } else {
            elements.wifiNetworkList.innerHTML = '<div class="wifi-network-empty">Мережі не знайдено</div>';
            wifiLog('Мережі не знайдено. Введіть SSID вручну.');
        }

    } catch (e) {
        wifiLog('Сканування недоступне. Введіть SSID вручну.', 'error');
        console.error('Scan error:', e);
        elements.wifiNetworkList.innerHTML = '<div class="wifi-network-empty">Помилка сканування</div>';
    }
}

function selectNetwork(item, ssid) {
    document.querySelectorAll('.wifi-network-item').forEach(el => el.classList.remove('selected'));
    item.classList.add('selected');
    elements.wifiSsid.value = ssid;
    elements.wifiPass.focus();
}

async function saveWifi() {
    const ssid = elements.wifiSsid.value.trim();
    const pass = elements.wifiPass.value;

    if (!ssid) {
        wifiLog('Введіть назву мережі', 'error');
        return;
    }
    if (pass && pass.length < 8) {
        wifiLog('Пароль має бути мінімум 8 символів', 'error');
        return;
    }

    elements.wifiSaveBtn.disabled = true;
    elements.wifiTestBtn.disabled = true;

    try {
        wifiLog(`Збереження "${ssid}"...`);

        const ssidBytes = new TextEncoder().encode(ssid);
        const passBytes = new TextEncoder().encode(pass);
        const totalLen = 1 + ssidBytes.length + 1 + passBytes.length;
        const data = [0x01, totalLen, ssidBytes.length, ...ssidBytes, passBytes.length, ...passBytes];

        await improvSend(0x03, data);
        await new Promise(r => setTimeout(r, 500));

        wifiLog('Збережено! Пристрій спробує підключитись при наступному запуску.', 'success');
    } catch (e) {
        wifiLog('Помилка: ' + e.message, 'error');
    }

    elements.wifiSaveBtn.disabled = false;
    elements.wifiTestBtn.disabled = false;
}

async function testWifi() {
    const ssid = elements.wifiSsid.value.trim();
    const pass = elements.wifiPass.value;

    if (!ssid) {
        wifiLog('Введіть назву мережі', 'error');
        return;
    }
    if (pass && pass.length < 8) {
        wifiLog('Пароль має бути мінімум 8 символів', 'error');
        return;
    }

    elements.wifiSaveBtn.disabled = true;
    elements.wifiTestBtn.disabled = true;

    try {
        wifiLog(`Підключення до "${ssid}"...`);

        const ssidBytes = new TextEncoder().encode(ssid);
        const passBytes = new TextEncoder().encode(pass);
        const totalLen = 1 + ssidBytes.length + 1 + passBytes.length;
        const data = [0x01, totalLen, ssidBytes.length, ...ssidBytes, passBytes.length, ...passBytes];

        await improvSend(0x03, data);

        const startTime = Date.now();
        while (Date.now() - startTime < 20000) {
            const response = await improvReadPacket(12000);
            if (!response) continue;

            if (response.type === 0x01) {
                const state = response.data[0];
                if (state === 0x03) {
                    wifiLog('Підключення...');
                } else if (state === 0x04) {
                    wifiLog('Підключено! Чекаємо URL...');
                    continue;
                }
            } else if (response.type === 0x04) {
                wifiLog('WiFi налаштовано!', 'success');
                wifiConfigured = true;

                // Save wifi_ssid to server
                const deviceId = flashedDeviceId || currentDeviceId;
                if (deviceId) {
                    try {
                        await fetch(`/api/my-devices/${deviceId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({ wifi_ssid: ssid })
                        });
                    } catch (e) {
                        console.error('Failed to save wifi_ssid:', e);
                    }
                }

                elements.wifiStatusInline.textContent = '✓ WiFi налаштовано';
                elements.wifiStatusInline.classList.add('visible');
                elements.wizardSteps[2].classList.add('done');
                updateNavButtons();

                elements.wifiSaveBtn.disabled = false;
                elements.wifiTestBtn.disabled = false;
                return;
            } else if (response.type === 0x02) {
                const errCode = response.data[0];
                if (errCode === 0) continue;
                const errors = {1: 'Invalid RPC', 2: 'Unknown RPC', 3: 'Невірний пароль або мережа недоступна', 4: 'Not authorized'};
                throw new Error(errors[errCode] || `Error ${errCode}`);
            }
        }

        throw new Error('Таймаут підключення');
    } catch (e) {
        wifiLog('Помилка: ' + e.message, 'error');
    }

    elements.wifiSaveBtn.disabled = false;
    elements.wifiTestBtn.disabled = false;
}

// ============================================================
// Step 4: Telegram Setup
// ============================================================

let tgCurrentStep = 1;

function showTgSubstep(step) {
    tgCurrentStep = step;

    elements.tgSubsteps.forEach((el, i) => {
        const stepNum = i + 1;
        el.classList.remove('active', 'done');
        if (stepNum < step) el.classList.add('done');
        else if (stepNum === step) el.classList.add('active');
    });

    elements.tgPanels.forEach((panel, i) => {
        panel.classList.toggle('active', i + 1 === step);
    });
}

function setTgStatus(el, msg, type) {
    el.textContent = msg;
    el.className = 'tg-status ' + type;
}

async function verifyToken() {
    const token = elements.tgBotToken.value.trim();
    if (!token) {
        setTgStatus(elements.tgTokenStatus, 'Введіть токен бота', 'error');
        return;
    }

    if (!token.match(/^\d+:[A-Za-z0-9_-]+$/)) {
        setTgStatus(elements.tgTokenStatus, 'Невірний формат токену', 'error');
        return;
    }

    elements.tgVerifyToken.disabled = true;
    elements.tgVerifyToken.textContent = 'Перевіряємо...';

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = await res.json();

        if (data.ok) {
            currentBotToken = token;
            currentBotInfo = data.result;

            elements.tgBotName.textContent = data.result.first_name;
            elements.tgBotUsername.textContent = '@' + data.result.username;

            setTgStatus(elements.tgTokenStatus, 'Бот знайдено!', 'success');

            setTimeout(() => showTgSubstep(2), 500);
        } else {
            setTgStatus(elements.tgTokenStatus, 'Токен недійсний: ' + (data.description || 'невідома помилка'), 'error');
        }
    } catch (e) {
        setTgStatus(elements.tgTokenStatus, 'Помилка перевірки: ' + e.message, 'error');
    }

    elements.tgVerifyToken.disabled = false;
    elements.tgVerifyToken.textContent = 'Перевірити токен';
}

async function findChats() {
    elements.tgFindChats.disabled = true;
    elements.tgFindChats.innerHTML = '<span>⏳</span> Шукаємо...';
    elements.tgChatList.style.display = 'block';
    elements.tgChatList.innerHTML = '<div class="tg-chat-empty">Шукаємо чати...</div>';

    try {
        const res = await fetch(`https://api.telegram.org/bot${currentBotToken}/getUpdates?timeout=1`);
        const data = await res.json();

        if (!data.ok) {
            throw new Error(data.description || 'Помилка отримання чатів');
        }

        const chats = new Map();
        for (const update of data.result) {
            const msg = update.message || update.channel_post || update.my_chat_member?.chat;
            if (msg && msg.chat) {
                const chat = msg.chat;
                if (!chats.has(chat.id)) {
                    chats.set(chat.id, {
                        id: chat.id,
                        title: chat.title || chat.first_name || chat.username || 'Chat',
                        type: chat.type,
                        username: chat.username
                    });
                }
            }
        }

        if (chats.size === 0) {
            elements.tgChatList.innerHTML = '<div class="tg-chat-empty">Чати не знайдено.<br>Додайте бота в групу або канал та напишіть повідомлення.</div>';
            setTgStatus(elements.tgStep2Status, 'Додайте бота в чат і надішліть повідомлення, потім натисніть "Знайти чати" ще раз', 'error');
        } else {
            elements.tgChatList.innerHTML = '';
            for (const [id, chat] of chats) {
                const icon = chat.type === 'channel' ? '📢' : chat.type === 'group' || chat.type === 'supergroup' ? '👥' : '💬';
                const typeLabel = chat.type === 'channel' ? 'Канал' : chat.type === 'group' || chat.type === 'supergroup' ? 'Група' : 'Особистий';

                const item = document.createElement('div');
                item.className = 'tg-chat-item';
                item.innerHTML = `
                    <div class="tg-chat-icon">${icon}</div>
                    <div class="tg-chat-info">
                        <div class="tg-chat-name">${escapeHtml(chat.title)}</div>
                        <div class="tg-chat-type">${typeLabel}${chat.username ? ' • @' + chat.username : ''}</div>
                    </div>
                `;
                item.onclick = () => selectChat(chat);
                elements.tgChatList.appendChild(item);
            }
            elements.tgStep2Status.className = 'tg-status';
        }
    } catch (e) {
        elements.tgChatList.innerHTML = '<div class="tg-chat-empty">Помилка: ' + e.message + '</div>';
        setTgStatus(elements.tgStep2Status, e.message, 'error');
    }

    elements.tgFindChats.disabled = false;
    elements.tgFindChats.innerHTML = '<span>🔍</span> Знайти чати';
}

async function selectChat(chat) {
    currentChatId = chat.id.toString();

    try {
        const deviceId = flashedDeviceId || currentDeviceId;
        if (!deviceId) {
            setTgStatus(elements.tgStep2Status, 'Спочатку прошийте пристрій', 'error');
            return;
        }

        const res = await fetch(`/api/my-devices/${deviceId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                bot_token: currentBotToken,
                chat_id: currentChatId
            })
        });

        if (!res.ok) {
            throw new Error('Помилка збереження: ' + res.status);
        }

        elements.tgSelectedChatName.textContent = chat.title;
        elements.tgSelectedChatId.textContent = 'ID: ' + chat.id;

        telegramConfigured = true;
        elements.wizardSteps[3].classList.add('done');
        updateNavButtons();

        showTgSubstep(3);
    } catch (e) {
        setTgStatus(elements.tgStep2Status, e.message, 'error');
    }
}

async function sendTestMessage() {
    elements.tgSendTest.disabled = true;
    elements.tgSendTest.innerHTML = '<span>⏳</span> Надсилаємо...';

    try {
        const res = await fetch(`https://api.telegram.org/bot${currentBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: currentChatId,
                text: '✅ Power Monitor підключено!\n\nТепер ви будете отримувати сповіщення про включення та виключення світла.'
            })
        });

        const data = await res.json();
        if (data.ok) {
            elements.tgSendTest.innerHTML = '<span>✓</span> Надіслано!';
            elements.tgSendTest.style.background = 'var(--success)';
            elements.tgSendTest.style.color = 'white';
        } else {
            throw new Error(data.description || 'Помилка надсилання');
        }
    } catch (e) {
        elements.tgSendTest.innerHTML = '<span>❌</span> ' + e.message;
        elements.tgSendTest.style.color = 'var(--danger)';
    }

    setTimeout(() => {
        elements.tgSendTest.disabled = false;
        elements.tgSendTest.innerHTML = '<span>📤</span> Надіслати тестове повідомлення';
        elements.tgSendTest.style = '';
    }, 3000);
}

// ============================================================
// Utilities
// ============================================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================
// Initialization
// ============================================================

function init() {
    // Initialize DOM elements
    elements = {
        browserWarning: $('browserWarning'),

        // Wizard navigation
        wizardSteps: document.querySelectorAll('.wizard-step'),
        wizardLines: document.querySelectorAll('.wizard-step-line'),
        wizardPanels: document.querySelectorAll('.wizard-panel'),
        btnBack: $('btnBack'),
        btnNext: $('btnNext'),

        // Step 1: Device name
        deviceName: $('deviceName'),

        // Step 2: Flash
        flashBtn: $('flashBtn'),
        flashBtnText: $('flashBtnText'),
        progressContainer: $('progressContainer'),
        progressFill: $('progressFill'),
        progressText: $('progressText'),
        flashLog: $('flashLog'),
        postFlashActions: $('postFlashActions'),
        btnGoToDashboard: $('btnGoToDashboard'),
        btnConfigureWifi: $('btnConfigureWifi'),

        // Step 3: WiFi
        wifiNetworkList: $('wifiNetworkList'),
        wifiSsid: $('wifiSsid'),
        wifiPass: $('wifiPass'),
        wifiSaveBtn: $('wifiSave'),
        wifiTestBtn: $('wifiTest'),
        wifiLog: $('wifiLog'),
        wifiStatusInline: $('wifiStatusInline'),

        // Step 4: Telegram
        tgSubsteps: document.querySelectorAll('.tg-substep'),
        tgPanels: document.querySelectorAll('.tg-panel'),
        tgBotToken: $('tgBotToken'),
        tgVerifyToken: $('tgVerifyToken'),
        tgTokenStatus: $('tgTokenStatus'),
        tgBotName: $('tgBotName'),
        tgBotUsername: $('tgBotUsername'),
        tgFindChats: $('tgFindChats'),
        tgChatList: $('tgChatList'),
        tgStep2Status: $('tgStep2Status'),
        tgSelectedChatName: $('tgSelectedChatName'),
        tgSelectedChatId: $('tgSelectedChatId'),
        tgSendTest: $('tgSendTest')
    };

    // Check browser support
    if (!navigator.serial) {
        elements.browserWarning.classList.add('visible');
    }

    // Event listeners
    elements.deviceName.addEventListener('input', updateNavButtons);
    elements.btnBack.addEventListener('click', goBack);
    elements.btnNext.addEventListener('click', goNext);

    // Step 2: Flash
    elements.flashBtn.addEventListener('click', startFlashing);
    elements.btnGoToDashboard.addEventListener('click', () => {
        const deviceId = flashedDeviceId || currentDeviceId;
        window.location.href = deviceId ? `/dashboard?device=${encodeURIComponent(deviceId)}` : '/dashboard';
    });
    elements.btnConfigureWifi.addEventListener('click', () => {
        showStep(3);
        startWifiSetup();
    });

    // Step 3: WiFi
    elements.wifiSaveBtn.addEventListener('click', saveWifi);
    elements.wifiTestBtn.addEventListener('click', testWifi);

    // Step 4: Telegram
    elements.tgVerifyToken.addEventListener('click', verifyToken);
    elements.tgFindChats.addEventListener('click', findChats);
    elements.tgSendTest.addEventListener('click', sendTestMessage);

    // Initialize wizard
    showStep(1);

    // Cleanup on page unload
    window.addEventListener('beforeunload', async () => {
        if (transport) {
            try { await transport.disconnect(); } catch(e) {}
        }
        await improvDisconnect();
    });
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
