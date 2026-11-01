# AGY Telegram Bridge (Powered by tg-rich-messages)

Jembatan interaktif Telegram untuk **Antigravity CLI (agy)** yang diintegrasikan langsung dengan builder resmi **[tg-rich-messages](https://github.com/vdistortion/tg-rich-messages)** dan Telegram Bot API 10.3 (`sendRichMessage`).

---

## 📦 Prasyarat Sistem

Sebelum menginstal, pastikan server / komputer Anda sudah terpasang:
1. **Node.js** (v18.0 atau lebih baru) & **npm**
   ```bash
   node -v
   npm -v
   ```
2. **Antigravity CLI (`agy`)**
   - Pastikan binary `agy` sudah terpasang dan dapat dijalankan (cek dengan `agy --version` atau `which agy`).
   - Default path biasanya di `~/.local/bin/agy` atau `/usr/local/bin/agy`.
3. **Telegram Bot Token**
   - Dapatkan token bot dari [@BotFather](https://t.me/BotFather) di Telegram melalui perintah `/newbot`.
4. *(Opsional)* **FFmpeg & Python 3**:
   - Diperlukan jika ingin menggunakan fitur transkrip pesan suara (voice notes).
   ```bash
   sudo apt update && sudo apt install -y ffmpeg python3
   ```

---

## ⚙️ Panduan Instalasi Langkah Demi Langkah

### 1. Ekstrak Folder
Ekstrak arsip zip dan masuk ke direktori proyek:
```bash
unzip agy-telegram.zip
cd agy-telegram
```

### 2. Install Dependensi Node.js
```bash
npm install
```

### 3. Konfigurasi Lingkungan (`.env`)
Salin file `.env.example` menjadi `.env` lalu sesuaikan pengaturannya:
```bash
cp .env.example .env
nano .env
```
Contoh isi file `.env`:
```env
# Telegram Bot Token dari @BotFather di Telegram
TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"

# ID Pengguna Telegram yang diizinkan (pisahkan dengan koma jika lebih dari satu)
# Jika dikosongkan, bot akan memberi tahu ID Telegram Anda saat pertama kali chat
ALLOWED_USERS="1821599046"

# ID Forum Topic Telegram yang diizinkan (opsional jika bot dimasukkan ke group forum)
# ALLOWED_TOPICS="19"

# Path ke binary agy
AGY_PATH="/home/ubuntu/.local/bin/agy"

# Default Working Directory saat mengeksekusi perintah
DEFAULT_WORKING_DIR="/home/ubuntu"
```

### 4. Berikan Hak Akses Eksekusi Script Shell
```bash
chmod +x start.sh status.sh stop.sh
```

---

## 🚀 Cara Menjalankan Bot

### Opsi A: Jalankan Langsung (Testing / Foreground)
```bash
node bot.mjs
```

### Opsi B: Jalankan Sebagai Systemd Service (Rekomendasi di Server)
Bot akan otomatis berjalan di background dan otomatis restart bila server reboot atau crash.

1. Sesuaikan path dan user pada `agy-telegram.service` jika user server Anda bukan `ubuntu` atau path node berbeda:
   ```ini
   User=ubuntu
   WorkingDirectory=/home/ubuntu/agy-telegram
   ExecStart=/usr/local/bin/node /home/ubuntu/agy-telegram/bot.mjs
   ```
   *(Cek path node Anda dengan `which node`)*

2. Salin dan aktifkan service:
   ```bash
   sudo cp agy-telegram.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now agy-telegram
   ```

3. Kelola service dengan script bawaan:
   ```bash
   ./status.sh   # Cek status & 10 log terakhir
   ./start.sh    # Restart service
   ./stop.sh     # Stop service
   ```
   Atau via perintah `systemctl`:
   ```bash
   sudo systemctl status agy-telegram
   sudo journalctl -u agy-telegram -f
   ```

---

## 🚀 Fitur Utama

- **Telegram Bot API 10.3 `sendRichMessage`**: Menggunakan endpoint resmi Telegram Rich Messages dengan document-block tree builder.
- **Rich Document Elements**:
  - `table` bordered untuk tabel data status & dashboard
  - `heading` (H1–H3) untuk judul bagian yang rapi
  - `blockquote` untuk kutipan & panduan
  - `pre` dengan highlight sintaksis kode bahasa
  - `divider` garis pemisah estetis
  - `spoiler`, `bold`, `italic`, `code`
- **Inline Keyboard Interaktif**: Tombol kontrol instan untuk ganti model, effort, mode kerja, riwayat / resume sesi, logs kode, dan reset sesi.
- **Smart Task Queue (Multi-Process Handling)**:
  - Instruksi yang dikirim saat bot sedang sibuk tidak akan ditolak; otomatis masuk antrian FIFO dan diproses berurutan.
  - Tombol batal antrian untuk menghapus pesan tertunda kapan saja.
- **Side Query & Background Workers**:
  - `/btw <tanya>`: Mengajukan pertanyaan cepat atau konsultasi tanpa memotong / mengganggu task utama yang sedang berjalan.
  - `/bgtask <task>`: Menjalankan tugas panjang secara independen di latar belakang dengan ID task tersendiri.
- **Real-time Code Execution & Logs**:
  - Live progress update saat agent mengeksekusi kode, bash command, manipulasi file, hingga instruksi berbasis foto/screenshot.
  - Tombol interaktif `📜 Logs Kode` di bawah setiap respons untuk melihat detail command, parameter, syntax highlighting, dan exit output.
  - Hub Log terpusat `/logs` untuk meninjau status monitor agent aktif (menghitung jumlah proses yang sedang berjalan), log kode turn terakhir, riwayat sesi, dan service systemd bot.
  - Proteksi Action Cap (≥ 100 tool executions): Ketika sebuah task mencapai milestone aksi tinggi atau mendekati 100 aksi, bot menampilkan badge proteksi, menyimpan checkpoint berkala, dan menjamin laporan eksekusi tidak hilang/menghilang tiba-tiba.
- **Smart Multi-Auth & Quota Management**:
  - `/agusage`: Visualisasi progress bar kuota 14 akun Google Auth AGY.
  - `/agswitch [slot]`: Berpindah slot akun aktif secara manual atau interaktif via inline keyboard.
  - `/aglogin <slot>`: Wizard login OAuth Google langsung via chat Telegram.
  - `/aglogin validate [path]`: Validasi file JSON akun bulk di isolated sandbox, cek validitas token/kuota (PRO/FREE), dan import otomatis 1-klik ke slot 1-14 dengan backup otomatis (`backup_previous.json`).
- **Git Operations Hub**:
  - `/git` untuk inspeksi branch, status perubahan, git diff visual, commit, dan push langsung dari Telegram.
- **Resume & Riwayat Percakapan**: Melanjutkan sesi obrolan sebelumnya melalui menu interaktif atau perintah langsung `/resume <nomor|ID|kata kunci>`.
- **Dua Arah Transfer File**:
  - Download file server ke HP: `/get <nama_file>`
  - Upload file HP ke server: Cukup kirim file/foto ke bot (mendukung album debouncing).
- **Direct Terminal Shell**: `/sh <cmd>` untuk menjalankan perintah Linux secara instan.

---

## 🎮 Daftar Perintah

| Perintah | Fungsi |
|---|---|
| `/menu` / `/settings` | Tampilkan Dashboard Utama dengan tabel dan Inline Keyboard |
| `/btw <pertanyaan>` | Tanya info/konsultasi cepat tanpa memotong/mengganggu tugas aktif |
| `/bgtask <task>` | Jalankan perintah/tugas berat secara mandiri di latar belakang |
| `/agusage` | Cek kuota visual & status 14 slot akun Google Auth |
| `/agswitch [slot]` | Pindah slot akun aktif (inline keyboard atau nomor slot) |
| `/aglogin [slot\|validate [file]]` | Wizard login OAuth manual per-slot atau validasi & import file JSON akun bulk |
| `/git [status\|diff\|push\|pull]` | Hub manajemen git repository dari Telegram |
| `/model` | Keyboard visual pemilihan model AI |
| `/models` | Daftar lengkap model yang tersedia |
| `/effort` | Atur intensitas penalaran (Low/Med/High/Max) |
| `/mode` | Atur mode kerja agent (Auto/Plan/Accept-Edits) |
| `/resume [id]` | Lanjutkan sesi percakapan sebelumnya (menu visual / nomor / ID / keyword) |
| `/logs [agent\|code\|conv\|bot]` | Hub & viewer monitor agent berjalan, log kode, transcript, dan service |
| `/get <file>` | Download file server ke chat Telegram |
| `/sh <cmd>` | Eksekusi shell terminal langsung |
| `/ls` | Lihat daftar file di folder server aktif |
| `/cd <path>` | Navigasi direktori kerja server |
| `/pwd` | Cek path lokasi kerja saat ini |
| `/stop` | Hentikan eksekusi aktif dan bersihkan antrian |
| `/restart` | Reboot service AGY Telegram Bridge dengan notifikasi recovery |
| `/new` / `/reset` | Reset sesi memori percakapan |
| `/help` | Panduan lengkap seluruh fitur |

---

## 🛠️ Layanan Systemd (Linux Service)

Service berjalan di background dengan auto-restart:
- Status: `/home/ubuntu/agy-telegram/status.sh` atau `sudo systemctl status agy-telegram`
- Restart: `/home/ubuntu/agy-telegram/start.sh` atau `sudo systemctl restart agy-telegram`
- Stop: `/home/ubuntu/agy-telegram/stop.sh` atau `sudo systemctl stop agy-telegram`
- Live Logs: `sudo journalctl -u agy-telegram -f`

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah lisensi [MIT](LICENSE).
