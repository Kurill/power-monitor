package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const (
	timeout = 90 * time.Second
	port    = ":8090"
	dbPath  = "/opt/power-monitor/power.db"
)

var googleOAuthConfig = &oauth2.Config{
	ClientID:     "1050918869349-h376llgagsqilcocbt03mnshmhk0f4l6.apps.googleusercontent.com",
	ClientSecret: "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",
	RedirectURL:  "https://power-monitor.club/auth/callback",
	Scopes:       []string{"https://www.googleapis.com/auth/userinfo.email"},
	Endpoint:     google.Endpoint,
}

const (
	greenAvatar = "/opt/power-monitor/green.png"
	redAvatar   = "/opt/power-monitor/red.png"
)

type DeviceConfig struct {
	ID         string
	Name       string
	ChatID     string
	BotToken   string
	Configured bool
	OwnerEmail string
	WifiSSID   string
	Paused     bool
	Timeout    int // seconds, 0 = default (90)
}

type DeviceState struct {
	LastPing  time.Time
	IsDown    bool
	DownSince time.Time
	UpSince   time.Time
}

type Session struct {
	Email     string
	ExpiresAt time.Time
}

var (
	devices  = make(map[string]*DeviceConfig)
	states   = make(map[string]*DeviceState)
	sessions = make(map[string]*Session)
	mu       sync.Mutex
	kyivLoc  *time.Location
	db       *sql.DB
)

func initDB() error {
	var err error
	db, err = sql.Open("sqlite3", dbPath)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			timestamp DATETIME NOT NULL,
			duration_seconds INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_device_time ON events(device_id, timestamp DESC);

		CREATE TABLE IF NOT EXISTS devices (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			chat_id TEXT,
			bot_token TEXT,
			owner_email TEXT,
			wifi_ssid TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`)
	
	// Migration: add columns if not exists (for existing DBs)
	db.Exec("ALTER TABLE devices ADD COLUMN owner_email TEXT")
	db.Exec("ALTER TABLE devices ADD COLUMN wifi_ssid TEXT")
	db.Exec("ALTER TABLE devices ADD COLUMN paused INTEGER DEFAULT 0")
	db.Exec("ALTER TABLE devices ADD COLUMN timeout INTEGER DEFAULT 0")

	// Create subscriptions table
	db.Exec(`CREATE TABLE IF NOT EXISTS subscriptions (
		email TEXT NOT NULL,
		device_id TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (email, device_id)
	)`)
	
	return err
}

func loadDevices() {
	rows, err := db.Query("SELECT id, name, chat_id, bot_token, owner_email, wifi_ssid, paused, COALESCE(timeout, 0) FROM devices")
	if err != nil {
		log.Printf("Failed to load devices: %v", err)
	}
	defer rows.Close()

	for rows.Next() {
		var d DeviceConfig
		var chatID, botToken, ownerEmail, wifiSSID sql.NullString
		var paused sql.NullBool
		var timeoutVal int
		rows.Scan(&d.ID, &d.Name, &chatID, &botToken, &ownerEmail, &wifiSSID, &paused, &timeoutVal)
		d.ChatID = chatID.String
		d.BotToken = botToken.String
		d.OwnerEmail = ownerEmail.String
		d.WifiSSID = wifiSSID.String
		d.Paused = paused.Bool
		d.Timeout = timeoutVal
		d.Configured = d.ChatID != "" && d.BotToken != ""
		devices[d.ID] = &d
		log.Printf("Loaded device: %s (%s) owner=%s paused=%v", d.ID, d.Name, d.OwnerEmail, d.Paused)
	}
}

func saveDevice(d *DeviceConfig) error {
	_, err := db.Exec(`
		INSERT OR REPLACE INTO devices (id, name, chat_id, bot_token, owner_email, wifi_ssid, paused, timeout)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, d.ID, d.Name, d.ChatID, d.BotToken, d.OwnerEmail, d.WifiSSID, d.Paused, d.Timeout)
	return err
}

func saveEvent(deviceID, eventType string, ts time.Time, durationSec int64) {
	// Check if last event is same type - skip duplicate
	var lastType string
	db.QueryRow("SELECT event_type FROM events WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1", deviceID).Scan(&lastType)
	if lastType == eventType {
		log.Printf("[%s] Skipping duplicate %s event", deviceID, eventType)
	}

	_, err := db.Exec(
		"INSERT INTO events (device_id, event_type, timestamp, duration_seconds) VALUES (?, ?, ?, ?)",
		deviceID, eventType, ts, durationSec,
	)
	if err != nil {
		log.Printf("DB error: %v", err)
	}
}

func loadLastState(deviceID string) (*DeviceState, error) {
	state := &DeviceState{IsDown: true, DownSince: time.Now(),
		LastPing: time.Time{},
		
	}

	var eventType string
	var ts time.Time
	err := db.QueryRow(
		"SELECT event_type, timestamp FROM events WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1",
		deviceID,
	).Scan(&eventType, &ts)

	if err == sql.ErrNoRows {
		return state, nil
	}
	if err != nil {
		return state, err
	}

	if eventType == "down" {
		state.IsDown = true
		state.DownSince = ts
	} else {
		state.UpSince = ts
	}
	return state, nil
}

// Session helpers
func generateSessionID() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

func getSessionEmail(r *http.Request) string {
	cookie, err := r.Cookie("session")
	if err != nil {
		return ""
	}
	mu.Lock()
	defer mu.Unlock()
	if s, ok := sessions[cookie.Value]; ok && time.Now().Before(s.ExpiresAt) {
		return s.Email
	}
	return ""
}

func setSession(w http.ResponseWriter, email string) {
	sessionID := generateSessionID()
	mu.Lock()
	sessions[sessionID] = &Session{
		Email:     email,
		ExpiresAt: time.Now().Add(30 * 24 * time.Hour),
	}
	mu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    sessionID,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		MaxAge:   30 * 24 * 60 * 60,
	})
}

// OAuth handlers
func authLoginHandler(w http.ResponseWriter, r *http.Request) {
	state := generateSessionID()
	mu.Lock()
	sessions["oauth_"+state] = &Session{ExpiresAt: time.Now().Add(10 * time.Minute)}
	mu.Unlock()
	
	url := googleOAuthConfig.AuthCodeURL(state, oauth2.AccessTypeOffline)
	http.Redirect(w, r, url, http.StatusTemporaryRedirect)
}

func authCallbackHandler(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	mu.Lock()
	_, valid := sessions["oauth_"+state]
	delete(sessions, "oauth_"+state)
	mu.Unlock()
	
	if !valid {
		http.Error(w, "Invalid state", 400)
	}

	code := r.URL.Query().Get("code")
	token, err := googleOAuthConfig.Exchange(context.Background(), code)
	if err != nil {
		http.Error(w, "Failed to exchange token: "+err.Error(), 500)
	}

	client := googleOAuthConfig.Client(context.Background(), token)
	resp, err := client.Get("https://www.googleapis.com/oauth2/v2/userinfo")
	if err != nil {
		http.Error(w, "Failed to get user info", 500)
	}
	defer resp.Body.Close()

	var userInfo struct {
		Email string `json:"email"`
	}
	json.NewDecoder(resp.Body).Decode(&userInfo)

	setSession(w, userInfo.Email)
	log.Printf("User logged in: %s", userInfo.Email)
	http.Redirect(w, r, "/dashboard", http.StatusTemporaryRedirect)
}

func authLogoutHandler(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("session")
	if err == nil {
		mu.Lock()
		delete(sessions, cookie.Value)
		mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{
		Name:   "session",
		Value:  "",
		Path:   "/",
		MaxAge: -1,
	})
	http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
}

var dashboardHTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Power Monitor</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html { background: #1a1a2e; }
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
        h1 { text-align: center; margin-bottom: 30px; color: #fff; }
        .devices { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; }
        a.device {
            background: #16213e; border-radius: 16px; padding: 24px;
            min-width: 320px; max-width: 400px; text-align: center;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            text-decoration: none; color: inherit; display: block;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        a.device:hover { transform: translateY(-4px); box-shadow: 0 8px 30px rgba(0,0,0,0.4); }
        .device.up { border: 3px solid #22c55e; }
        .device.down { border: 3px solid #ef4444; }
        .device.pending { border: 3px solid #f59e0b; }
        .status-icon { font-size: 64px; margin: 16px 0; }
        .device-name { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
        .status-text { font-size: 24px; font-weight: bold; margin: 12px 0; }
        .up .status-text { color: #22c55e; }
        .down .status-text { color: #ef4444; }
        .pending .status-text { color: #f59e0b; }
        .duration { color: #888; font-size: 14px; margin: 8px 0; }
        .last-ping { color: #666; font-size: 12px; }
        .refresh { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
        .refresh a { color: #3b82f6; }
    </style>
</head>
<body>
    <h1>⚡ Power Monitor</h1>
    <div class="devices" id="devices"></div>
    <div class="refresh">Оновлення кожні 5 секунд • <a href="/flash">Прошити новий пристрій</a> • <a href="/dashboard">Мої пристрої</a></div>
    <script>
        function formatDuration(seconds) {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            if (h > 0) return h + 'год ' + m + 'хв';
            if (m > 0) return m + 'хв';
            return Math.floor(seconds) + 'сек';
        }
        async function update() {
            try {
                const resp = await fetch('/api/status');
                const data = await resp.json();
                const container = document.getElementById('devices');
                let html = '';
                for (const [id, device] of Object.entries(data)) {
                    const statusClass = device.configured ? device.status : 'pending';
                    const lastPing = new Date(device.last_ping);
                    const since = new Date(device.since);
                    const sinceSeconds = (Date.now() - since.getTime()) / 1000;
                    let statusIcon = device.status === 'up' ? '💡' : '🔌';
                    let statusText = device.status === 'up' ? 'Світло є' : 'Світла нема';
                    if (!device.configured) { statusIcon = '⚙️'; statusText = 'Очікує налаштування'; }
                    html += '<a href="/history?device=' + id + '" class="device ' + statusClass + '">' +
                        '<div class="device-name">' + device.name + '</div>' +
                        '<div class="status-icon">' + statusIcon + '</div>' +
                        '<div class="status-text">' + statusText + '</div>' +
                        '<div class="duration">Вже ' + formatDuration(sinceSeconds) + '</div>' +
                        '<div class="last-ping">Останній пінг: ' + lastPing.toLocaleTimeString('uk-UA') + '</div></a>';
                }
                if (html === '') html = '<div style="color:#666;text-align:center;padding:40px;">Немає пристроїв. <a href="/flash" style="color:#3b82f6">Додати перший?</a></div>';
                container.innerHTML = html;
            } catch (e) { console.error(e); }
        }
        update();
        setInterval(update, 5000);
    </script>
</body>
</html>`

var adminHTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Мої пристрої — Power Monitor</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: #1a1a2e; color: #eee; font-family: -apple-system, sans-serif; padding: 20px; min-height: 100vh; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
        h1 { font-size: 24px; }
        .user-info { display: flex; align-items: center; gap: 12px; font-size: 14px; color: #888; }
        .logout { color: #ef4444; text-decoration: none; }
        .device-card { background: #16213e; border-radius: 12px; padding: 20px; margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); }
        .device-card.pending { border-color: #f59e0b; }
        .device-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .device-name { font-size: 18px; font-weight: 600; }
        .device-id { color: #666; font-size: 12px; }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
        .badge.ok { background: #22c55e; }
        .badge.pending { background: #f59e0b; }
        .form-group { margin-bottom: 12px; }
        label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; }
        input { width: 100%; padding: 10px; background: #0d0d1a; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 14px; }
        input:focus { outline: none; border-color: #3b82f6; }
        .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
        .btn-save { background: #3b82f6; color: white; }
        .btn-delete { background: #ef4444; color: white; margin-left: 8px; }
        .back-link { display: block; margin-top: 24px; color: #666; text-decoration: none; }
        .empty { color: #666; text-align: center; padding: 40px; }
        .empty a { color: #3b82f6; }
    </style>
</head>
<body>
    <div class="header">
        <h1>⚙️ Мої пристрої</h1>
        <div class="user-info">
            <span id="userEmail"></span>
            <a href="/auth/logout" class="logout">Вийти</a>
        </div>
    </div>
    <div id="devices"></div>
    <a href="/" class="back-link">← Повернутись</a>
    <script>
        async function loadDevices() {
            const resp = await fetch('/api/my-devices');
            const data = await resp.json();
            
            if (data.error === 'unauthorized') {
                window.location.href = '/auth/login';
                return;
            }
            
            document.getElementById('userEmail').textContent = data.email;
            const container = document.getElementById('devices');
            let html = '';
            
            for (const d of data.devices || []) {
                const isPending = !d.configured;
                html += '<div class="device-card' + (isPending ? ' pending' : '') + '">' +
                    '<div class="device-header">' +
                        '<div><div class="device-name">' + d.name + '</div><div class="device-id">' + d.id + '</div></div>' +
                        '<span class="badge ' + (isPending ? 'pending' : 'ok') + '">' + (isPending ? 'Очікує' : 'OK') + '</span>' +
                    '</div>' +
                    '<div class="form-group"><label>Bot Token</label><input type="text" id="token_' + d.id + '" value="' + (d.bot_token || '') + '" placeholder="Від @BotFather"></div>' +
                    '<div class="form-group"><label>Chat ID</label><input type="text" id="chat_' + d.id + '" value="' + (d.chat_id || '') + '" placeholder="-100..."></div>' +
                    '<button class="btn btn-save" onclick="saveDevice(\'' + d.id + '\')">Зберегти</button>' +
                    '<button class="btn btn-delete" onclick="deleteDevice(\'' + d.id + '\')">Видалити</button>' +
                '</div>';
            }
            
            if (html === '') {
                html = '<div class="empty">У вас ще немає пристроїв. <a href="/flash">Прошити перший?</a></div>';
            }
            container.innerHTML = html;
        }
        
        async function saveDevice(id) {
            const token = document.getElementById('token_' + id).value;
            const chat = document.getElementById('chat_' + id).value;
            const resp = await fetch('/api/my-devices/' + id, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({bot_token: token, chat_id: chat})
            });
            if (resp.ok) { alert('Збережено!'); loadDevices(); }
            else alert('Помилка: ' + await resp.text());
        }
        
        async function deleteDevice(id) {
            if (!confirm('Видалити пристрій ' + id + '?')) return;
            const resp = await fetch('/api/my-devices/' + id, {method: 'DELETE'});
            if (resp.ok) loadDevices();
        }
        
        loadDevices();
    </script>
</body>
</html>`

func testFlashHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/test-flash.html")
	w.Header().Set("Content-Type", "text/html")
	w.Write(content)
}

func main() {
	kyivLoc, _ = time.LoadLocation("Europe/Kyiv")

	if err := initDB(); err != nil {
		log.Fatalf("Failed to init DB: %v", err)
	}
	defer db.Close()

	loadDevices()

	for deviceID := range devices {
		state, _ := loadLastState(deviceID)
		// state.LastPing loaded from DB
		states[deviceID] = state
	}

	http.HandleFunc("/", landingHandler)
	http.HandleFunc("/dashboard", dashboardHandler)
	http.HandleFunc("/ping", pingHandler)
	http.HandleFunc("/api/status", apiStatusHandler)
	http.HandleFunc("/api/history", historyHandler)
	http.HandleFunc("/history", historyPageHandler)
	http.HandleFunc("/flash", flashPageHandler)
	http.HandleFunc("/test-flash", testFlashHandler)
	http.HandleFunc("/esptool-bundle.js", esptoolBundleHandler)
	http.HandleFunc("/flash.css", flashCssHandler)
	http.HandleFunc("/flash.js", flashJsHandler)
	http.HandleFunc("/manifest.json", staticManifestHandler)
	http.HandleFunc("/firmware_improv.bin", firmwareBinHandler)
	http.HandleFunc("/firmware.bin", firmwareBinHandler)
	http.HandleFunc("/dashboard.css", dashboardCssHandler)
	http.HandleFunc("/dashboard.js", dashboardJsHandler)
	http.HandleFunc("/improv.js", improvJsHandler)
	http.HandleFunc("/api/firmware", firmwareHandler)
	http.HandleFunc("/api/my-devices", myDevicesHandler)
	http.HandleFunc("/api/my-devices/", myDeviceHandler)
	http.HandleFunc("/auth/login", authLoginHandler)
	http.HandleFunc("/auth/callback", authCallbackHandler)
	http.HandleFunc("/api/me", apiMeHandler)
	http.HandleFunc("/api/claim", claimDeviceHandler)
	http.HandleFunc("/api/subscribe", subscribeHandler)
	http.HandleFunc("/api/unsubscribe/", unsubscribeHandler)
	http.HandleFunc("/api/stats", apiStatsHandler)
	http.HandleFunc("/auth/logout", authLogoutHandler)
	http.HandleFunc("/esptool-js/", esptoolJsHandler)
	http.HandleFunc("/improv-wifi-sdk/", improvSdkHandler)

	go monitor()

	log.Printf("Power monitor started on %s", port)
	log.Fatal(http.ListenAndServe(port, nil))
}

func dashboardHandler(w http.ResponseWriter, r *http.Request) {
	email := getSessionEmail(r)
	if email == "" {
		http.Redirect(w, r, "/auth/login", http.StatusTemporaryRedirect)
	}
	http.ServeFile(w, r, "dashboard.html")
}

func oldDashboardHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(dashboardHTML))
}

func adminHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.Redirect(w, r, "/dashboard", http.StatusMovedPermanently)
}


func myDevicesHandler(w http.ResponseWriter, r *http.Request) {
	email := getSessionEmail(r)
	if email == "" {
		http.Error(w, "Unauthorized", 401)
		return
	}

	mu.Lock()
	defer mu.Unlock()
	
	// Get owned devices
	var owned []map[string]interface{}
	for id, d := range devices {
		if d.OwnerEmail == email {
			status := "offline"
			lastPing := time.Time{}
			if state, ok := states[id]; ok {
				lastPing = state.LastPing
				if time.Since(state.LastPing) < getDeviceTimeout(d) {
					status = "online"
				}
			}
			owned = append(owned, map[string]interface{}{
				"id":        id,
				"name":      d.Name,
				"status":    status,
				"last_ping": lastPing.Format(time.RFC3339),
				"bot_token": d.BotToken,
				"chat_id":   d.ChatID,
				"wifi_ssid": d.WifiSSID,
				"paused":    d.Paused,
				"timeout":   d.Timeout,
			})
		}
	}
	
	// Get subscribed devices from database
	var subscribed []map[string]interface{}
	rows, err := db.Query("SELECT device_id FROM subscriptions WHERE email = ?", email)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var deviceID string
			rows.Scan(&deviceID)
			
			if d, ok := devices[deviceID]; ok {
				status := "offline"
				lastPing := time.Time{}
				if state, ok := states[deviceID]; ok {
					lastPing = state.LastPing
					if time.Since(state.LastPing) < getDeviceTimeout(d) {
						status = "online"
					}
				}
				subscribed = append(subscribed, map[string]interface{}{
					"id":        deviceID,
					"name":      d.Name,
					"status":    status,
					"last_ping": lastPing.Format(time.RFC3339),
				})
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"owned":      owned,
		"subscribed": subscribed,
	})
}

func myDeviceHandler(w http.ResponseWriter, r *http.Request) {
	email := getSessionEmail(r)
	if email == "" {
		http.Error(w, "unauthorized", 401)
	}

	id := r.URL.Path[len("/api/my-devices/"):]
	if id == "" {
		http.Error(w, "device id required", 400)
	}

	mu.Lock()
	defer mu.Unlock()

	d, exists := devices[id]
	if !exists || d.OwnerEmail != email {
		http.Error(w, "device not found", 404)
	}

	switch r.Method {
	case "PUT":
		var data struct {
			Name     string `json:"name"`
			BotToken string `json:"bot_token"`
			ChatID   string `json:"chat_id"`
			WifiSSID string `json:"wifi_ssid"`
			Paused   *bool  `json:"paused"`
			Timeout  *int   `json:"timeout"`
		}
		json.NewDecoder(r.Body).Decode(&data)
		if data.Name != "" {
			d.Name = data.Name
		}
		if data.BotToken != "" || data.ChatID != "" {
			d.BotToken = data.BotToken
			d.ChatID = data.ChatID
			d.Configured = data.BotToken != "" && data.ChatID != ""
		}
		if data.WifiSSID != "" {
			d.WifiSSID = data.WifiSSID
		}
		if data.Paused != nil {
			d.Paused = *data.Paused
		}
		if data.Timeout != nil {
			t := *data.Timeout
			if t < 30 { t = 30 }
			if t > 300 { t = 300 }
			d.Timeout = t
		}
		saveDevice(d)
		w.Write([]byte("ok"))

	case "DELETE":
		delete(devices, id)
		delete(states, id)
		db.Exec("DELETE FROM devices WHERE id = ?", id)
		db.Exec("DELETE FROM events WHERE device_id = ?", id)
		db.Exec("DELETE FROM subscriptions WHERE device_id = ?", id)
		w.Write([]byte("ok"))

	default:
		http.Error(w, "method not allowed", 405)
	}
}

func apiStatusHandler(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()

	result := make(map[string]interface{})
	for id, d := range devices {
		state := states[id]
		if state == nil {
			state = &DeviceState{IsDown: true, LastPing: time.Time{}, DownSince: time.Now()}
		}
		status := "up"
		since := state.UpSince
		if state.IsDown {
			status = "down"
			since = state.DownSince
		}
		result[id] = map[string]interface{}{
			"name":       d.Name,
			"status":     status,
			"last_ping":  state.LastPing.Format(time.RFC3339),
			"since":      since.Format(time.RFC3339),
			"configured": d.Configured,
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func apiStatsHandler(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	online := 0
	for _, state := range states {
		if state != nil && !state.IsDown {
			online++
		}
	}
	mu.Unlock()

	today := time.Now().Format("2006-01-02")
	var eventsToday int
	db.QueryRow("SELECT COUNT(*) FROM events WHERE date(timestamp) = ?", today).Scan(&eventsToday)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"devices_online": online,
		"events_today":   eventsToday,
	})
}

func historyHandler(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device")
	limit := 10
	if l := r.URL.Query().Get("limit"); l != "" {
		fmt.Sscanf(l, "%d", &limit)
	}
	if limit > 100 { limit = 100 }

	result := make(map[string][]map[string]interface{})
	deviceList := []string{}
	if deviceID != "" {
		deviceList = append(deviceList, deviceID)
	} else {
		for id := range devices { deviceList = append(deviceList, id) }
	}

	for _, id := range deviceList {
		rows, err := db.Query("SELECT event_type, timestamp, duration_seconds FROM events WHERE device_id = ? ORDER BY timestamp DESC LIMIT ?", id, limit)
		if err != nil { continue }
		var events []map[string]interface{}
		for rows.Next() {
			var eventType string
			var ts time.Time
			var duration sql.NullInt64
			rows.Scan(&eventType, &ts, &duration)
			ev := map[string]interface{}{"type": eventType, "time": ts.Format(time.RFC3339)}
			if duration.Valid { ev["duration"] = duration.Int64 }
			events = append(events, ev)
		}
		rows.Close()
		result[id] = events
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func pingHandler(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device")
	if deviceID == "" { deviceID = "default" }

	mu.Lock()
	config, exists := devices[deviceID]
	if !exists {
		config = &DeviceConfig{ID: deviceID, Name: deviceID}
		devices[deviceID] = config
		saveDevice(config)
		log.Printf("Auto-registered device: %s", deviceID)
	}

	state, exists := states[deviceID]
	if !exists {
		state = &DeviceState{UpSince: time.Now()}
		states[deviceID] = state
	}

	// state.LastPing loaded from DB
	wasDown := state.IsDown
	downTime := state.DownSince
	state.LastPing = time.Now()
	state.IsDown = false
	if wasDown { state.UpSince = time.Now() }
	mu.Unlock()

	if wasDown {
		duration := time.Since(downTime)
		log.Printf("[%s] Light ON after %s", deviceID, formatDuration(duration))
		saveEvent(deviceID, "up", time.Now(), int64(duration.Seconds()))
		if config.Configured && !config.Paused {
			now := time.Now().In(kyivLoc)
			msg := fmt.Sprintf("🟢 %s Світло з'явилось\n🕓 Його не було %s", now.Format("15:04"), formatDuration(duration))
			msgID := sendTelegram(config.BotToken, config.ChatID, msg)
			setChatPhoto(config.BotToken, config.ChatID, greenAvatar, msgID)
		}
	}

	w.Write([]byte("ok"))
}

func getDeviceTimeout(d *DeviceConfig) time.Duration {
	if d.Timeout > 0 {
		return time.Duration(d.Timeout) * time.Second
	}
	return timeout
}

func monitor() {
	for {
		time.Sleep(10 * time.Second)
		mu.Lock()
		for deviceID, state := range states {
			config := devices[deviceID]
			if config == nil { continue }
			if !state.IsDown && time.Since(state.LastPing) > getDeviceTimeout(config) {
				state.IsDown = true
				state.DownSince = state.LastPing
				upDuration := state.DownSince.Sub(state.UpSince)
				log.Printf("[%s] Light OFF after %s up", deviceID, formatDuration(upDuration))
				go saveEvent(deviceID, "down", time.Now(), int64(upDuration.Seconds()))
				if config.Configured && !config.Paused {
					now := time.Now().In(kyivLoc)
					msg := fmt.Sprintf("🔴 %s Світло зникло\n🕓 Воно було %s", now.Format("15:04"), formatDuration(upDuration))
					go func(bt, ci, m, pp string) {
						msgID := sendTelegram(bt, ci, m)
						setChatPhoto(bt, ci, pp, msgID)
					}(config.BotToken, config.ChatID, msg, redAvatar)
				}
			}
		}
		mu.Unlock()
	}
}

func sendTelegram(botToken, chatID, text string) int {
	if botToken == "" || chatID == "" { return 0 }
	apiURL := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", botToken)
	resp, err := http.PostForm(apiURL, url.Values{"chat_id": {chatID}, "text": {text}})
	if err != nil { return 0 }
	defer resp.Body.Close()
	var result struct {
		OK     bool `json:"ok"`
		Result struct {
			MessageID int `json:"message_id"`
		} `json:"result"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	return result.Result.MessageID
}

func setChatPhoto(botToken, chatID, photoPath string, afterMsgID int) {
	if botToken == "" || chatID == "" || photoPath == "" { return }
	file, err := os.Open(photoPath)
	if err != nil { return }
	defer file.Close()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	writer.WriteField("chat_id", chatID)
	part, _ := writer.CreateFormFile("photo", filepath.Base(photoPath))
	io.Copy(part, file)
	writer.Close()
	apiURL := fmt.Sprintf("https://api.telegram.org/bot%s/setChatPhoto", botToken)
	req, _ := http.NewRequest("POST", apiURL, body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		defer resp.Body.Close()
		ioutil.ReadAll(resp.Body)
		// Delete service message about photo change (it is afterMsgID + 1)
		if afterMsgID > 0 {
			time.Sleep(300 * time.Millisecond)
			deleteURL := fmt.Sprintf("https://api.telegram.org/bot%s/deleteMessage?chat_id=%s&message_id=%d",
				botToken, chatID, afterMsgID+1)
			http.Get(deleteURL)
		}
	}
}


func formatDuration(d time.Duration) string {
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	if h > 0 { return fmt.Sprintf("%dгод %dхв", h, m) }
	return fmt.Sprintf("%dхв", m)
}

func flashPageHandler(w http.ResponseWriter, r *http.Request) {
	email := getSessionEmail(r)
	if email == "" {
		http.Redirect(w, r, "/auth/login", http.StatusTemporaryRedirect)
	}
	content, _ := os.ReadFile("/opt/power-monitor/flash.html")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(content)
}

func flashTestHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/flash-test.html")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(content)
}

func staticManifestHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/manifest.json")
	w.Header().Set("Content-Type", "application/json")
	w.Write(content)
}

func esptoolBundleHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/esptool-bundle.js")
	w.Header().Set("Content-Type", "application/javascript")
	w.Write(content)
}

func historyPageHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/history.html")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(content)
}

func manifestHandler(w http.ResponseWriter, r *http.Request) {
	device := r.URL.Query().Get("device")
	ssid := r.URL.Query().Get("ssid")
	pass := r.URL.Query().Get("pass")
	server := r.URL.Query().Get("server")
	name := r.URL.Query().Get("name")
	botToken := r.URL.Query().Get("bot_token")
	chatID := r.URL.Query().Get("chat_id")
	improv := r.URL.Query().Get("improv")

	if server == "" { server = "power-monitor.club" }

	// Get user email from session
	ownerEmail := getSessionEmail(r)

	if name != "" && device != "" {
		mu.Lock()
		if _, exists := devices[device]; !exists {
			d := &DeviceConfig{
				ID: device, Name: name,
				BotToken: botToken, ChatID: chatID,
				Configured: botToken != "" && chatID != "",
				OwnerEmail: ownerEmail,
			}
			devices[device] = d
			states[device] = &DeviceState{LastPing: time.Time{}, UpSince: time.Now()}
			saveDevice(d)
			log.Printf("Pre-registered device: %s (%s) owner=%s", device, name, ownerEmail)
		}
		mu.Unlock()
	}

	params := url.Values{}
	params.Set("device", device)
	params.Set("ssid", ssid)
	params.Set("pass", pass)
	params.Set("server", server)
	params.Set("name", name)
	if improv == "true" {
		params.Set("improv", "true")
	}

	manifest := map[string]interface{}{
		"name": "Power Monitor - " + device, "version": "1.0", "new_install_improv_wait_time": 0,
		"builds": []map[string]interface{}{{
			"chipFamily": "ESP32",
			"parts": []map[string]interface{}{{"path": "/api/firmware?" + params.Encode(), "offset": 0}},
		}},
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(manifest)
}

func firmwareHandler(w http.ResponseWriter, r *http.Request) {
	device := r.URL.Query().Get("device")
	ssid := r.URL.Query().Get("ssid")
	pass := r.URL.Query().Get("pass")
	server := r.URL.Query().Get("server")
	_ = r.URL.Query().Get("name")
	improv := r.URL.Query().Get("improv")

	var firmwarePath string
	var placeholders map[string]string

	if improv == "true" {
		// Improv firmware - serve merged.bin as-is, no patching (breaks checksum)
		firmwarePath = "/opt/power-monitor/firmware_improv.bin"
		placeholders = map[string]string{} // empty - no patching
	} else {
		// Classic firmware with hardcoded WiFi
		firmwarePath = "/opt/power-monitor/firmware.bin"
		placeholders = map[string]string{
			"@@SSID@@_______________________": padTo31(ssid),
			"@@PASS@@_______________________": padTo31(pass),
			"@@DEVID@@______________________": padTo31(device),
			"@@SRVR@@_______________________": padTo31(server),
		}
	}

	firmware, err := os.ReadFile(firmwarePath)
	if err != nil {
		http.Error(w, "Firmware not found", 500)
	}

	for placeholder, value := range placeholders {
		firmware = bytes.Replace(firmware, []byte(placeholder), []byte(value), -1)
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(firmware)
}

func padTo31(s string) string {
	if len(s) > 31 { s = s[:31] }
	for len(s) < 31 { s += "_" }
	return s
}

func padTo47(s string) string {
	if len(s) > 47 { s = s[:47] }
	for len(s) < 47 { s += "_" }
	return s
}

func apiMeHandler(w http.ResponseWriter, r *http.Request) {
	email := getSessionEmail(r)
	if email == "" {
		http.Error(w, "Not authenticated", http.StatusUnauthorized)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"email": email})
}

func landingHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
	}
	http.ServeFile(w, r, "landing.html")
}

func subscribeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
	}
	
	email := getSessionEmail(r)
	if email == "" {
		http.Error(w, "Unauthorized", 401)
		return
	}
	
	var req struct {
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", 400)
	}
	
	// Check if device exists
	mu.Lock()
	_, exists := devices[req.DeviceID]
	mu.Unlock()
	
	if !exists {
		http.Error(w, "Пристрій не знайдено", 404)
	}
	
	_, err := db.Exec("INSERT OR IGNORE INTO subscriptions (email, device_id) VALUES (?, ?)", email, req.DeviceID)
	if err != nil {
		http.Error(w, "Database error", 500)
	}
	
	w.WriteHeader(200)
}

func unsubscribeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "DELETE" {
		http.Error(w, "Method not allowed", 405)
	}
	
	email := getSessionEmail(r)
	if email == "" {
		http.Error(w, "Unauthorized", 401)
		return
	}
	
	deviceID := r.URL.Path[len("/api/unsubscribe/"):]
	if deviceID == "" {
		http.Error(w, "Device ID required", 400)
	}
	
	db.Exec("DELETE FROM subscriptions WHERE email = ? AND device_id = ?", email, deviceID)
	w.WriteHeader(200)
}


func esptoolJsHandler(w http.ResponseWriter, r *http.Request) {
	// Serve local esptool-js files
	filename := r.URL.Path[len("/esptool-js/"):]
	if filename == "" {
		http.NotFound(w, r)
	}
	// Security: prevent path traversal
	if filepath.Base(filename) != filename {
		http.NotFound(w, r)
	}
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, "/opt/power-monitor/esptool-js/"+filename)
}

func improvSdkHandler(w http.ResponseWriter, r *http.Request) {
	// Serve Improv WiFi SDK files
	path := r.URL.Path[len("/improv-wifi-sdk/"):]
	if path == "" {
		http.NotFound(w, r)
	}
	// Security: prevent path traversal (allow subdirs like web/)
	cleanPath := filepath.Clean(path)
	if cleanPath != path || cleanPath[0] == '/' || cleanPath == ".." || len(cleanPath) > 2 && cleanPath[:3] == "../" {
		http.NotFound(w, r)
	}
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, "/opt/power-monitor/improv-wifi-sdk/"+cleanPath)
}

func claimDeviceHandler(w http.ResponseWriter, r *http.Request) {
	email := getSessionEmail(r)
	if email == "" {
		http.Error(w, "Unauthorized", 401)
		return
	}

	deviceID := r.URL.Query().Get("device")
	if deviceID == "" {
		http.Error(w, "device required", 400)
		return
	}
	deviceName := r.URL.Query().Get("name")

	mu.Lock()
	defer mu.Unlock()

	d, exists := devices[deviceID]
	if !exists {
		// Create new device if it doesn't exist yet
		d = &DeviceConfig{
			ID:   deviceID,
			Name: deviceName,
		}
		devices[deviceID] = d
		states[deviceID] = &DeviceState{}
		log.Printf("Device %s created during claim", deviceID)
	}

	// If device has different owner, add them as subscriber before transferring
	if d.OwnerEmail != "" && d.OwnerEmail != email {
		db.Exec("INSERT OR IGNORE INTO subscriptions (email, device_id) VALUES (?, ?)", d.OwnerEmail, deviceID)
		log.Printf("Device %s: old owner %s added to subscribers", deviceID, d.OwnerEmail)
	}

	d.OwnerEmail = email
	if deviceName != "" {
		d.Name = deviceName
	}
	// Clear WiFi on re-flash (NVS is erased on ESP32)
	d.WifiSSID = ""
	saveDevice(d)
	log.Printf("Device %s claimed by %s", deviceID, email)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "device": deviceID})
}

func flashCssHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/flash.css")
	w.Header().Set("Content-Type", "text/css")
	w.Write(content)
}

func flashJsHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/flash.js")
	w.Header().Set("Content-Type", "application/javascript")
	w.Write(content)
}

func dashboardCssHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/dashboard.css")
	w.Header().Set("Content-Type", "text/css")
	w.Write(content)
}

func dashboardJsHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/dashboard.js")
	w.Header().Set("Content-Type", "application/javascript")
	w.Write(content)
}

func improvJsHandler(w http.ResponseWriter, r *http.Request) {
	content, _ := os.ReadFile("/opt/power-monitor/improv.js")
	w.Header().Set("Content-Type", "application/javascript")
	w.Write(content)
}

func firmwareBinHandler(w http.ResponseWriter, r *http.Request) {
	content, err := os.ReadFile("/opt/power-monitor/firmware_improv.bin")
	if err != nil {
		http.Error(w, "Firmware not found", 404)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=firmware_improv.bin")
	w.Write(content)
}
