        let currentUser = null;

        async function init() {
            try {
                const res = await fetch('/api/me');
                if (!res.ok) {
                    window.location.href = '/auth/login';
                    return;
                }
                const data = await res.json();
                currentUser = data.email;
                document.getElementById('userEmail').textContent = currentUser;
                
                // Check for claim parameter
                const urlParams = new URLSearchParams(window.location.search);
                const claimId = urlParams.get('claim');
                if (claimId) {
                    try {
                        const claimRes = await fetch('/api/claim?device=' + encodeURIComponent(claimId));
                        if (claimRes.ok) {
                            console.log('Device claimed:', claimId);
                        }
                    } catch (e) {
                        console.error('Claim failed:', e);
                    }
                    // Remove claim param from URL
                    window.history.replaceState({}, '', '/dashboard');
                }
                
                loadDevices();
            } catch (e) {
                window.location.href = '/';
            }
        }

        async function loadDevices() {
            try {
                const res = await fetch('/api/my-devices');
                if (!res.ok) throw new Error('Failed');
                const data = await res.json();
                render(data.owned || [], data.subscribed || []);
            } catch (e) {
                document.getElementById('content').innerHTML =
                    '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Помилка</div><div class="empty-desc">Не вдалось завантажити</div></div>';
            }
        }

        function render(owned, subscribed) {
            const content = document.getElementById('content');
            let html = '';

            // Sort: online first, then by name
            const sortDevices = (a, b) => {
                const aOnline = a.status === 'online' ? 0 : 1;
                const bOnline = b.status === 'online' ? 0 : 1;
                if (aOnline !== bOnline) return aOnline - bOnline;
                return (a.name || '').localeCompare(b.name || '');
            };
            owned.sort(sortDevices);
            subscribed.sort(sortDevices);

            // Owned devices
            html += `<div class="section-title">Мої пристрої <span class="section-count">${owned.length}</span></div>`;

            if (owned.length === 0) {
                html += `
                    <div class="empty-state" style="margin-bottom: 32px;">
                        <div class="empty-icon">📡</div>
                        <div class="empty-title">Немає пристроїв</div>
                        <div class="empty-desc">Прошийте ESP32 щоб почати моніторинг</div>
                    </div>
                `;
            } else {
                html += '<div class="devices-list">';
                owned.forEach(d => {
                    html += renderDevice(d, true);
                });
                html += '</div>';
            }

            // Subscribed devices
            if (subscribed.length > 0) {
                html += `<div class="section-title">Підписки <span class="section-count">${subscribed.length}</span></div>`;
                html += '<div class="devices-list">';
                subscribed.forEach(d => {
                    html += renderDevice(d, false);
                });
                html += '</div>';
            }

            content.innerHTML = html;
        }

        function renderDevice(d, isOwned) {
            const statusClass = d.status === 'online' ? 'status-online' : 'status-offline';
            const statusText = d.status === 'online' ? 'Онлайн' : 'Офлайн';
            const cardClass = isOwned ? 'device-card owned' : 'device-card';

            let settingsHtml = '';
            if (isOwned) {
                settingsHtml = `
                    <div class="device-settings" id="settings_${d.id}">
                        <div class="settings-title">Назва пристрою</div>
                        <div class="form-row">
                            <div class="form-group" style="flex:1">
                                <input type="text" class="form-input" id="name_${d.id}" value="${esc(d.name || '')}" placeholder="Моя квартира">
                            </div>
                            <button class="btn-save" onclick="renameDevice('${d.id}')">Зберегти</button>
                        </div>
                        <div class="settings-title" style="margin-top:16px">Налаштування</div>
                        <div class="settings-buttons">
                            <button class="wifi-wizard-btn ${d.wifi_ssid ? 'configured' : ''}" onclick="openWifiDialog('${d.id}')">
                                ${d.wifi_ssid ? '✓ ' + esc(d.wifi_ssid) : '📶 WiFi'}
                            </button>
                            <button class="tg-wizard-btn ${d.bot_token && d.chat_id ? 'configured' : ''}" onclick="openTelegramWizard('${d.id}')">
                                ${d.bot_token && d.chat_id ? '✓ Telegram' : '🤖 Telegram'}
                            </button>
                        </div>
                        <div class="pause-row">
                            <span class="pause-label">Сповіщення</span>
                            <button class="pause-toggle ${d.paused ? 'paused' : ''}" onclick="togglePause('${d.id}', ${!d.paused})">
                                <span class="pause-toggle-slider"></span>
                                <span class="pause-toggle-text">${d.paused ? 'Вимк' : 'Увімк'}</span>
                            </button>
                        </div>
                        <div class="timeout-row">
                            <span class="timeout-label">Таймаут <span class="timeout-value" id="timeoutVal_${d.id}">${d.timeout || 90}с</span></span>
                            <input type="range" class="timeout-slider" id="timeout_${d.id}" min="30" max="300" step="10" value="${d.timeout || 90}" oninput="updateTimeoutLabel('${d.id}', this.value)" onchange="saveTimeout('${d.id}', this.value)">
                        </div>
                    </div>
                `;
            }

            return `
                <div class="${cardClass}">
                    <div class="device-main">
                        <div class="device-info">
                            <div class="device-name">${esc(d.name)}</div>
                            <div class="device-meta">
                                <span class="device-id">${d.id}</span>
                            </div>
                        </div>
                        <div class="device-status ${statusClass}">
                            <span class="status-dot"></span>
                            ${statusText}
                        </div>
                    </div>
                    <div class="device-actions">
                        <a href="/history?device=${d.id}" class="device-action">📊 Історія</a>
                        ${isOwned ? `<button class="device-action" onclick="toggleSettings('${d.id}')">⚙️ Налаштування</button>` : ''}
                        ${isOwned ? `<button class="device-action" onclick="deleteDevice('${d.id}')">🗑️ Видалити</button>` : ''}
                        ${!isOwned ? `<button class="device-action" onclick="unsubscribe('${d.id}')">✕ Відписатись</button>` : ''}
                    </div>
                    ${settingsHtml}
                </div>
            `;
        }

        function esc(s) {
            if (!s) return '';
            return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function toggleSettings(id) {
            const el = document.getElementById('settings_' + id);
            el.classList.toggle('open');
        }

        async function saveDevice(id) {
            const token = document.getElementById('token_' + id).value.trim();
            const chatId = document.getElementById('chat_' + id).value.trim();
            const statusEl = document.getElementById('status_' + id);

            try {
                const res = await fetch('/api/my-devices/' + id, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bot_token: token, chat_id: chatId })
                });

                statusEl.textContent = res.ok ? '✓ Збережено' : '✗ Помилка';
                statusEl.style.color = res.ok ? 'var(--online)' : 'var(--offline)';
                if (res.ok) setTimeout(() => statusEl.textContent = '', 3000);
            } catch (e) {
                statusEl.textContent = '✗ Помилка';
                statusEl.style.color = 'var(--offline)';
            }
        }

        async function deleteDevice(id) {
            if (!confirm("Видалити пристрій " + id + "?")) return;
            try {
                const res = await fetch("/api/my-devices/" + id, {method: "DELETE"});
                if (res.ok) loadDevices();
                else alert("Помилка видалення");
            } catch (e) { alert("Помилка видалення"); }
        }

        async function renameDevice(id) {
            const name = document.getElementById("name_" + id).value.trim();
            if (!name) return;
            try {
                const res = await fetch("/api/my-devices/" + id, {
                    method: "PUT",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({name: name})
                });
                if (res.ok) loadDevices();
                else alert("Помилка збереження");
            } catch (e) { alert("Помилка збереження"); }
        }

        async function togglePause(id, paused) {
            try {
                const res = await fetch("/api/my-devices/" + id, {
                    method: "PUT",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({paused: paused})
                });
                if (res.ok) loadDevices();
                else alert("Помилка");
            } catch (e) { alert("Помилка"); }
        }

        function updateTimeoutLabel(id, val) {
            document.getElementById('timeoutVal_' + id).textContent = val + 'с';
        }

        async function saveTimeout(id, val) {
            try {
                const res = await fetch('/api/my-devices/' + id, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({timeout: parseInt(val)})
                });
                if (!res.ok) alert('Помилка');
            } catch (e) { alert('Помилка'); }
        }

        function openSubscribeModal() {
            document.getElementById('subscribeModal').classList.add('open');
            document.getElementById('subscribeId').focus();
        }

        function closeSubscribeModal() {
            document.getElementById('subscribeModal').classList.remove('open');
            document.getElementById('subscribeId').value = '';
        }

        async function subscribe() {
            const deviceId = document.getElementById('subscribeId').value.trim();
            if (!deviceId) return;

            try {
                const res = await fetch('/api/subscribe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device_id: deviceId })
                });

                if (res.ok) {
                    closeSubscribeModal();
                    loadDevices();
                } else {
                    alert(await res.text() || 'Пристрій не знайдено');
                }
            } catch (e) {
                alert('Помилка');
            }
        }

        async function unsubscribe(id) {
            if (!confirm('Відписатись від цього пристрою?')) return;
            await fetch('/api/unsubscribe/' + id, { method: 'DELETE' });
            loadDevices();
        }

        function logout() {
            window.location.href = '/auth/logout';
        }

        // Enter key in modal
        document.getElementById('subscribeId').addEventListener('keypress', e => {
            if (e.key === 'Enter') subscribe();
        });

        // ===============================
        // Telegram Wizard
        // ===============================
        let tgCurrentDeviceId = null;
        let tgBotToken = '';
        let tgBotInfo = null;
        let tgChatId = '';

        function openTelegramWizard(deviceId) {
            tgCurrentDeviceId = deviceId;
            tgBotToken = '';
            tgBotInfo = null;
            tgChatId = '';

            document.getElementById('tgBotToken').value = '';
            document.getElementById('tgTokenStatus').className = 'tg-status';
            document.getElementById('tgStep2Status').className = 'tg-status';
            document.getElementById('tgChatList').style.display = 'none';
            showTgStep(1);

            document.getElementById('telegramDialog').classList.add('open');
        }

        function closeTelegramDialog() {
            document.getElementById('telegramDialog').classList.remove('open');
            loadDevices(); // Refresh to show updated status
        }

        function showTgStep(step) {
            document.getElementById('tgStep1').style.display = step === 1 ? 'block' : 'none';
            document.getElementById('tgStep2').style.display = step === 2 ? 'block' : 'none';
            document.getElementById('tgStep3').style.display = step === 3 ? 'block' : 'none';

            document.getElementById('tgStep1Ind').className = 'tg-step' + (step >= 1 ? ' active' : '') + (step > 1 ? ' done' : '');
            document.getElementById('tgStep2Ind').className = 'tg-step' + (step >= 2 ? ' active' : '') + (step > 2 ? ' done' : '');
            document.getElementById('tgStep3Ind').className = 'tg-step' + (step >= 3 ? ' active' : '') + (step > 3 ? ' done' : '');
        }

        function setTgStatus(el, msg, type) {
            el.textContent = msg;
            el.className = 'tg-status ' + type;
        }

        // Step 1: Verify token
        document.getElementById('tgVerifyToken').onclick = async () => {
            const token = document.getElementById('tgBotToken').value.trim();
            const statusEl = document.getElementById('tgTokenStatus');

            if (!token) {
                setTgStatus(statusEl, 'Введіть токен бота', 'error');
                return;
            }

            if (!token.match(/^\d+:[A-Za-z0-9_-]+$/)) {
                setTgStatus(statusEl, 'Невірний формат токену', 'error');
                return;
            }

            const btn = document.getElementById('tgVerifyToken');
            btn.disabled = true;
            btn.textContent = 'Перевіряємо...';

            try {
                const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
                const data = await res.json();

                if (data.ok) {
                    tgBotToken = token;
                    tgBotInfo = data.result;

                    document.getElementById('tgBotName').textContent = data.result.first_name;
                    document.getElementById('tgBotUsername').textContent = '@' + data.result.username;

                    setTgStatus(statusEl, 'Бот знайдено!', 'success');
                    setTimeout(() => showTgStep(2), 500);
                } else {
                    setTgStatus(statusEl, 'Токен недійсний: ' + (data.description || 'помилка'), 'error');
                }
            } catch (e) {
                setTgStatus(statusEl, 'Помилка перевірки: ' + e.message, 'error');
            }

            btn.disabled = false;
            btn.textContent = 'Перевірити токен';
        };

        // Step 2: Find chats
        document.getElementById('tgFindChats').onclick = async () => {
            const btn = document.getElementById('tgFindChats');
            const chatList = document.getElementById('tgChatList');
            const statusEl = document.getElementById('tgStep2Status');

            btn.disabled = true;
            btn.innerHTML = '<span>⏳</span> Шукаємо...';
            chatList.style.display = 'block';
            chatList.innerHTML = '<div class="tg-chat-empty">Шукаємо чати...</div>';

            try {
                const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/getUpdates?timeout=1`);
                const data = await res.json();

                if (!data.ok) throw new Error(data.description || 'Помилка');

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
                    chatList.innerHTML = '<div class="tg-chat-empty">Чати не знайдено.<br>Додайте бота в групу та напишіть повідомлення.</div>';
                    setTgStatus(statusEl, 'Додайте бота в чат і натисніть "Знайти чати" ще раз', 'error');
                } else {
                    chatList.innerHTML = '';
                    for (const [id, chat] of chats) {
                        const icon = chat.type === 'channel' ? '📢' : chat.type === 'group' || chat.type === 'supergroup' ? '👥' : '💬';
                        const typeLabel = chat.type === 'channel' ? 'Канал' : chat.type === 'group' || chat.type === 'supergroup' ? 'Група' : 'Особистий';

                        const item = document.createElement('div');
                        item.className = 'tg-chat-item';
                        item.innerHTML = `
                            <div class="tg-chat-icon">${icon}</div>
                            <div class="tg-chat-info">
                                <div class="tg-chat-name">${esc(chat.title)}</div>
                                <div class="tg-chat-type">${typeLabel}${chat.username ? ' • @' + chat.username : ''}</div>
                            </div>
                        `;
                        item.onclick = () => selectTgChat(chat);
                        chatList.appendChild(item);
                    }
                    statusEl.className = 'tg-status';
                }
            } catch (e) {
                chatList.innerHTML = '<div class="tg-chat-empty">Помилка: ' + e.message + '</div>';
                setTgStatus(statusEl, e.message, 'error');
            }

            btn.disabled = false;
            btn.innerHTML = '<span>🔍</span> Знайти чати';
        };

        async function selectTgChat(chat) {
            tgChatId = chat.id.toString();
            const statusEl = document.getElementById('tgStep2Status');

            try {
                const res = await fetch('/api/my-devices/' + tgCurrentDeviceId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        bot_token: tgBotToken,
                        chat_id: tgChatId
                    })
                });

                if (!res.ok) throw new Error('Помилка збереження');

                document.getElementById('tgSelectedChatName').textContent = chat.title;
                document.getElementById('tgSelectedChatId').textContent = 'ID: ' + chat.id;
                showTgStep(3);
            } catch (e) {
                setTgStatus(statusEl, e.message, 'error');
            }
        }

        // Step 3: Send test
        document.getElementById('tgSendTest').onclick = async () => {
            const btn = document.getElementById('tgSendTest');
            btn.disabled = true;
            btn.innerHTML = '<span>⏳</span> Надсилаємо...';

            try {
                const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: tgChatId,
                        text: '✅ Power Monitor підключено!\n\nТепер ви будете отримувати сповіщення про світло.'
                    })
                });

                const data = await res.json();
                if (data.ok) {
                    btn.innerHTML = '<span>✓</span> Надіслано!';
                    btn.style.background = 'var(--online)';
                } else {
                    throw new Error(data.description || 'Помилка');
                }
            } catch (e) {
                btn.innerHTML = '<span>❌</span> ' + e.message;
                btn.style.background = 'var(--offline)';
            }

            setTimeout(() => {
                btn.disabled = false;
                btn.innerHTML = '<span>📤</span> Надіслати тестове повідомлення';
                btn.style.background = '';
            }, 3000);
        };

        // =============================================
        // WiFi Setup
        // =============================================

        let wifiDeviceId = null;

        function openWifiDialog(deviceId) {
            wifiDeviceId = deviceId;
            document.getElementById('wifiDialog').classList.add('open');
            document.getElementById('wifiMain').style.display = 'none';
            document.getElementById('wifiSuccess').style.display = 'none';
            document.getElementById('wifiConnectBtn').style.display = 'flex';
            document.getElementById('wifiLog').innerHTML = '';
            document.getElementById('wifiLog').classList.remove('visible');
            document.getElementById('wifiSsid').value = '';
            document.getElementById('wifiPass').value = '';
        }

        function closeWifiDialog() {
            document.getElementById('wifiDialog').classList.remove('open');
            if (window.Improv) {
                Improv.disconnect();
            }
        }

        function wifiLog(msg, type = '') {
            const log = document.getElementById('wifiLog');
            log.classList.add('visible');
            const line = document.createElement('div');
            if (type) line.className = type;
            line.textContent = msg;
            log.appendChild(line);
            log.scrollTop = log.scrollHeight;
        }

        document.getElementById('wifiConnectBtn').onclick = async () => {
            const btn = document.getElementById('wifiConnectBtn');
            btn.disabled = true;
            btn.innerHTML = '<span>⏳</span> Підключення...';

            if (!navigator.serial) {
                alert('Браузер не підтримує Web Serial. Використай Chrome або Edge.');
                btn.disabled = false;
                btn.innerHTML = '<span>🔌</span> Підключитись до пристрою';
                return;
            }

            const connected = await Improv.connect(wifiLog);
            if (connected) {
                btn.style.display = 'none';
                document.getElementById('wifiMain').style.display = 'block';

                // Start scanning
                document.getElementById('wifiNetworkList').innerHTML = '<div class="wifi-network-empty">Сканування...</div>';
                const networks = await Improv.scan(wifiLog);
                renderWifiNetworks(networks);
            } else {
                btn.disabled = false;
                btn.innerHTML = '<span>🔌</span> Підключитись до пристрою';
            }
        };

        function renderWifiNetworks(networks) {
            const list = document.getElementById('wifiNetworkList');
            if (networks.length === 0) {
                list.innerHTML = '<div class="wifi-network-empty">Мережі не знайдено. Введи SSID вручну.</div>';
                return;
            }

            list.innerHTML = '';
            networks.forEach(net => {
                const bars = net.rssi > -50 ? 4 : net.rssi > -60 ? 3 : net.rssi > -70 ? 2 : 1;
                const signalBars = [1,2,3,4].map(i =>
                    `<div class="wifi-signal-bar ${i <= bars ? 'active' : ''}"></div>`
                ).join('');

                const item = document.createElement('div');
                item.className = 'wifi-network-item';
                item.innerHTML = `
                    <span class="wifi-network-name">${escapeHtml(net.ssid)}</span>
                    <span class="wifi-network-info">
                        <span class="wifi-signal">${signalBars}</span>
                        ${net.auth ? '🔒' : ''}
                    </span>
                `;
                item.onclick = () => selectWifiNetwork(item, net.ssid);
                list.appendChild(item);
            });
        }

        function selectWifiNetwork(item, ssid) {
            document.querySelectorAll('.wifi-network-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            document.getElementById('wifiSsid').value = ssid;
            document.getElementById('wifiPass').focus();
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        document.getElementById('wifiSaveBtn').onclick = async () => {
            const ssid = document.getElementById('wifiSsid').value.trim();
            const pass = document.getElementById('wifiPass').value;

            if (!ssid) {
                wifiLog('Введи назву мережі', 'error');
                return;
            }
            if (pass && pass.length < 8) {
                wifiLog('Пароль має бути мінімум 8 символів', 'error');
                return;
            }

            document.getElementById('wifiSaveBtn').disabled = true;
            document.getElementById('wifiTestBtn').disabled = true;

            const success = await Improv.saveWifi(ssid, pass, wifiLog);
            if (success) {
                // Save SSID to server
                try {
                    await fetch('/api/my-devices/' + wifiDeviceId, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ wifi_ssid: ssid })
                    });
                    loadDevices(); // Refresh to show updated WiFi status
                } catch (e) {
                    console.error('Failed to save SSID:', e);
                }
            }

            document.getElementById('wifiSaveBtn').disabled = false;
            document.getElementById('wifiTestBtn').disabled = false;
        };

        document.getElementById('wifiTestBtn').onclick = async () => {
            const ssid = document.getElementById('wifiSsid').value.trim();
            const pass = document.getElementById('wifiPass').value;

            if (!ssid) {
                wifiLog('Введи назву мережі', 'error');
                return;
            }
            if (pass && pass.length < 8) {
                wifiLog('Пароль має бути мінімум 8 символів', 'error');
                return;
            }

            document.getElementById('wifiSaveBtn').disabled = true;
            document.getElementById('wifiTestBtn').disabled = true;

            const success = await Improv.testWifi(ssid, pass, wifiLog);
            if (success) {
                // Save SSID to server
                try {
                    await fetch('/api/my-devices/' + wifiDeviceId, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ wifi_ssid: ssid })
                    });
                } catch (e) {
                    console.error('Failed to save SSID:', e);
                }

                document.getElementById('wifiMain').style.display = 'none';
                document.getElementById('wifiSuccess').style.display = 'block';

                // Reload devices to show updated WiFi status
                setTimeout(() => {
                    closeWifiDialog();
                    loadDevices();
                }, 1500);
            }

            document.getElementById('wifiSaveBtn').disabled = false;
            document.getElementById('wifiTestBtn').disabled = false;
        };

        init();
