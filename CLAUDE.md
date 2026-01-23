# Power Monitor — мониторинг электричества

ESP32 пингует сервер, при пропадании пинга — алерт в Telegram.

## Архитектура

```
ESP32 (дома, без UPS)
    → пинг каждые 30 сек →
Сервер waterline:8090
    → если 90 сек без пинга →
Telegram канал @power18b89
```

## ESP32

- **Плата**: ESP32 DevKit с CP2102 (USB-UART)
- **Скетч**: `electricity_monitor/electricity_monitor.ino`
- **WiFi**: `kkurill` / `73827382`
- **Пинг**: `http://178.62.112.232:8090/ping` каждые 30 сек

### Прошивка
1. Arduino IDE + ESP32 board (Espressif)
2. Board: ESP32 Dev Module
3. Port: `/dev/cu.usbserial-0001` (CP2102) или `/dev/cu.wchusbserial*` (CH340)
4. Upload

### Покупка аналога
Любая "ESP32 DevKit" с USB. Чипы CP2102 или CH340 — оба ок.
Пример: "ESP32 WiFi Bluetooth WROOM-32 CH340 type-C DEVKIT 30 pin"

## Сервер (waterline)

- **Путь**: `/opt/power-monitor/`
- **Сервис**: `power-monitor.service`
- **Порт**: 8090
- **IP**: 178.62.112.232

### Подключение
```bash
ssh waterline
```
Алиас настроен в `~/.ssh/config`. Если нет — `ssh root@178.62.112.232`

### Параметры
- `timeout = 90 * time.Second` — время без пинга до алерта
- Аватарки: `green.png` (свет есть), `red.png` (света нет)

### Команды
```bash
ssh waterline
sudo systemctl status power-monitor
sudo systemctl restart power-monitor
sudo journalctl -u power-monitor -f
```

### Изменение timeout
```bash
ssh waterline "sed -i 's/timeout = .*/timeout = 90 * time.Second/' /opt/power-monitor/main.go && cd /opt/power-monitor && go build -o power-monitor main.go && sudo systemctl restart power-monitor"
```

## Telegram

- **Канал**: @power18b89 (ID: -1003651630488)
- **Бот**: @kurillsPowerBot_bot
- **Token**: `8220457340:AAEavEwZFiFjYB4536_p0IPyxq_EkQwbvzg`

### Формат сообщений
```
🟢 01:25 Світло з'явилось
🕓 Його не було 2год 15хв

🔴 03:30 Світло зникло
🕓 Воно було 4год 30хв
```

## Healthchecks.io (не используется)

Был вариант с healthchecks.io, но сделали свой сервер для кастомных сообщений.
URL был: `https://hc-ping.com/eb322cef-7b16-4943-a092-9e1b58f0d41e`

## Связанные проекты

- **k-tg-bot**: боты Дипп и Клод мониторят канал @elight_voskresenska_18_18a_18b (ДТЭК) и могут писать в @power18b89 через tool `send_to_channel`

## Веб-прошивка (flash.html)

Страница `https://power-monitor.club/flash` позволяет прошить ESP32 через браузер.

### Файлы на сервере
- `/opt/power-monitor/flash.html` — страница прошивки
- `/opt/power-monitor/esptool-bundle.js` — esptool-js собранный из GitHub (с flushInput fix)
- `/opt/power-monitor/firmware_improv.bin` — merged binary (4MB): bootloader + partition table + app

### esptool-js
Стандартная npm версия (0.5.7) не работала — не было `flushInput()` перед sync. Собрали из GitHub main branch:
```bash
git clone https://github.com/nicerloop/nicerloop-esptool-js
cd nicerloop-esptool-js && npm install && npm run build
# результат в dist/esptool.js
```

### Improv WiFi — свой handler
Improv WiFi Serial SDK (`improv-wifi-serial-sdk`) не работает после esptool — read loop сразу закрывается.

**Решение:** Свой минимальный Improv handler в flash.html.

#### Формат Improv пакета
```
[IMPROV header (6 bytes)] [version] [type] [length] [data...] [checksum]
```

#### WiFi credentials — RPC команда
- **Type:** `0x03` (RPC Command)
- **Data:** `[command_id=0x01, total_len, ssid_len, ssid_bytes, pass_len, pass_bytes]`
- где `total_len = 1 + ssid_len + 1 + pass_len`

**Важно:** Type `0x01` (WIFI_SETTINGS) — НЕ работает. Нужен именно RPC.

#### WiFi scan — RPC команда
- **Type:** `0x03` (RPC Command)
- **Data:** `[command_id=0x04]`
- **Response:** `RPC_RESULT (0x04)` с данными: `[cmd_id, ssid_len, ssid, rssi_len, rssi, auth_len, auth]...`
- `auth` = "YES" или "NO"

### Прошивка через браузер
- `eraseAll: false` — только перезаписываем нужные секторы
- `eraseAll: true` и `eraseFlash()` — ломают ESP32 (стирают bootloader)

### Сброс WiFi credentials
Для сброса сохранённого WiFi — стереть NVS регион:
```bash
esptool.py --chip esp32 --port /dev/cu.usbserial-1130 erase_region 0x9000 0x5000
```

### Прошивка ESP32 с Improv
- Скетч: `power-monitor/power_monitor_improv.ino`
- Библиотека: ImprovWiFiLibrary
- Serial всегда включен (115200 baud)
- Improv всегда доступен для переконфигурации WiFi

### Веб-прошивка: важные детали
- При прошивке стираем NVS регион (0x9000, 0x5000) чтобы очистить сохранённый WiFi
- Это обязательно, иначе ESP32 подключится к старому WiFi и Improv не получит новые credentials
- Используем Transport patch для одновременной установки DTR+RTS (нужно для CP2102)
- Baudrate 115200 (CP2102 нестабилен на 460800)
