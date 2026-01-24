// ============================================================
// Power Monitor - Flash Wizard (ESP Web Tools version)
// ============================================================

// ============================================================
// Constants & State
// ============================================================

let currentStep = 1;
let deviceName = '';
let flashedDeviceId = null;
let flashSuccess = false;
let telegramConfigured = false;

// Telegram state
let currentBotToken = '';
let currentBotInfo = null;
let currentChatId = '';

// ============================================================
// DOM Elements
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
                btnNext.textContent = 'Налаштувати Telegram →';
                btnNext.className = 'btn-nav btn-nav-success';
            } else {
                btnNext.disabled = true;
                btnNext.textContent = 'Прошийте пристрій';
                btnNext.className = 'btn-nav btn-nav-primary';
            }
            break;

        case 3:
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
                deviceName = elements.deviceName.value.trim();
                showStep(2);
            }
            break;
        case 2:
            if (flashSuccess) {
                showStep(3);
            }
            break;
        case 3:
            // Go to dashboard
            if (flashedDeviceId) {
                window.location.href = `/dashboard?device=${encodeURIComponent(flashedDeviceId)}`;
            } else {
                window.location.href = '/dashboard';
            }
            break;
    }
}

// ============================================================
// ESP Web Tools Integration
// ============================================================

function setupEspWebTools() {
    const espButton = elements.espWebInstall;

    // Listen for dialog close event
    espButton.addEventListener('closed', async () => {
        console.log('ESP Web Tools dialog closed');

        // Try to get device ID via Improv
        await getDeviceIdAfterFlash();
    });
}

async function getDeviceIdAfterFlash() {
    // Try to connect and get device ID
    try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });

        // Keep DTR=false to avoid reset
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });

        const reader = port.readable.getReader();
        const writer = port.writable.getWriter();

        // Wait for device to be ready
        await new Promise(r => setTimeout(r, 1500));

        // Buffer for reading
        let buffer = [];
        let reading = true;

        // Start reading in background
        (async () => {
            try {
                while (reading) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) buffer.push(...value);
                }
            } catch (e) {}
        })();

        // Clear any boot messages
        await new Promise(r => setTimeout(r, 500));
        buffer = [];

        // Send GET_DEVICE_INFO (RPC command 0x03)
        const packet = buildImprovPacket(0x03, [0x03, 0x00]);
        await writer.write(packet);

        // Wait for response
        const response = await waitForImprovPacket(buffer, 3000);

        if (response && response.type === 0x04) {
            // Parse device info
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
                console.log('Got device ID:', flashedDeviceId);
            }
        }

        // Cleanup
        reading = false;
        try { reader.releaseLock(); } catch(e) {}
        try { writer.releaseLock(); } catch(e) {}
        try { await port.close(); } catch(e) {}

    } catch (e) {
        console.log('Could not get device ID:', e.message);
    }

    // If we got a device ID, claim it
    if (flashedDeviceId) {
        await claimDevice();
    }

    // Mark flash as successful and update UI
    flashSuccess = true;
    elements.postFlashStatus.classList.add('visible');
    elements.deviceIdDisplay.textContent = flashedDeviceId
        ? `ID: ${flashedDeviceId}`
        : 'Пристрій готовий до налаштування';
    elements.wizardSteps[1].classList.add('done');
    updateNavButtons();
}

function buildImprovPacket(type, data) {
    const header = [0x49, 0x4D, 0x50, 0x52, 0x4F, 0x56];
    const version = 0x01;
    const packet = [...header, version, type, data.length, ...data];
    const checksum = packet.reduce((a, b) => a + b, 0) & 0xFF;
    return new Uint8Array([...packet, checksum]);
}

function parseImprovPacket(buffer) {
    while (buffer.length >= 10) {
        const headerIdx = buffer.findIndex((v, i) =>
            i <= buffer.length - 6 &&
            buffer[i] === 0x49 && buffer[i+1] === 0x4D &&
            buffer[i+2] === 0x50 && buffer[i+3] === 0x52 &&
            buffer[i+4] === 0x4F && buffer[i+5] === 0x56
        );

        if (headerIdx === -1) {
            buffer.splice(0, buffer.length - 5);
            return null;
        }

        if (headerIdx > 0) buffer.splice(0, headerIdx);
        if (buffer.length < 10) return null;

        const dataLen = buffer[8];
        const packetLen = 9 + dataLen + 1;

        if (buffer.length < packetLen) return null;

        const packet = buffer.slice(0, packetLen);
        buffer.splice(0, packetLen);

        return {
            type: packet[7],
            data: packet.slice(9, 9 + dataLen)
        };
    }
    return null;
}

async function waitForImprovPacket(buffer, timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const packet = parseImprovPacket(buffer);
        if (packet) return packet;
        await new Promise(r => setTimeout(r, 50));
    }
    return null;
}

async function claimDevice() {
    if (!flashedDeviceId || !deviceName) return;

    try {
        const claimUrl = '/api/claim?device=' + encodeURIComponent(flashedDeviceId) +
            '&name=' + encodeURIComponent(deviceName);
        const res = await fetch(claimUrl, { credentials: 'include' });
        if (res.ok) {
            console.log('Device claimed successfully');
        } else if (res.status === 401) {
            console.log('Not logged in, device not claimed');
        }
    } catch (e) {
        console.error('Claim error:', e);
    }
}

// ============================================================
// Step 3: Telegram Setup
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
        if (!flashedDeviceId) {
            setTgStatus(elements.tgStep2Status, 'Спочатку прошийте пристрій', 'error');
            return;
        }

        const res = await fetch(`/api/my-devices/${flashedDeviceId}`, {
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
        elements.wizardSteps[2].classList.add('done');
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
        espWebInstall: $('espWebInstall'),
        flashBtn: $('flashBtn'),
        postFlashStatus: $('postFlashStatus'),
        deviceIdDisplay: $('deviceIdDisplay'),

        // Step 3: Telegram
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

    // Step 2: ESP Web Tools
    setupEspWebTools();

    // Step 3: Telegram
    elements.tgVerifyToken.addEventListener('click', verifyToken);
    elements.tgFindChats.addEventListener('click', findChats);
    elements.tgSendTest.addEventListener('click', sendTestMessage);

    // Initialize wizard
    showStep(1);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
