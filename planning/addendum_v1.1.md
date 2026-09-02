# ADDENDUM DESAIN · V1.1 — Financial Agent Harness

## Dari Command Harness Menuju Natural-Language-First Architecture

Revisi arsitektur atas Dokumen Desain v1.0, disusun berdasarkan diskusi lanjutan mengenai kebebasan interaksi pengguna, batas agent authoring, dan prioritas roadmap menjelang hackathon.

> Versi Draft 1.1 · September 2026 · Melengkapi Dokumen Desain v1.0

---

## Daftar Isi

- 01 Ringkasan Perubahan dari v1.0
- 02 Prinsip Tambahan: Natural-Language-First
- 03 Arsitektur Revisi: Intent Router & Template Library
- 04 Command Sebagai Shortcut, Bukan Satu-satunya Pintu
- 05 Agent Configurator (Custom Agent Terbatas)
- 06 Agent Library: Memperluas Cakupan, Bukan Membuka Otorship Bebas
- 07 Reframing /screen & Catatan Regulasi
- 08 Revisi Roadmap 4 Minggu
- 09 Risiko Tambahan & Kesimpulan

---

## Bagian 01 — Ringkasan Perubahan dari v1.0

Dokumen v1.0 memposisikan sistem sebagai kumpulan command tetap (`/judge`, `/compare`, dst.) dengan execution graph yang di-hardcode per command. Diskusi lanjutan mengangkat pertanyaan mendasar: apakah ini benar-benar sebuah harness, atau sekadar katalog fitur yang dibungkus tampilan command-line?

Kesimpulannya: keresahan itu valid — tapi solusinya bukan menghapus struktur dan membiarkan planner menyusun apa pun secara bebas. Justru sebaliknya: empat pilar desain v1.0 dipertahankan penuh (evidence-first, raw data tidak pernah dikirim antar-agent, structured intermediate output, debate berbatas). Yang berubah adalah titik masuk sistem — dari "user harus tahu nama command" menjadi "user bertanya bebas, sistem yang merutekan ke pipeline yang tepat" — tanpa planner kehilangan batasnya.

### Apa yang tetap, apa yang berubah

| Tetap dari v1.0 | Berubah di v1.1 |
|-----------------|-----------------|
| Evidence Store & evidence ID wajib di tiap klaim | Titik masuk: natural language jadi jalur utama, command jadi shortcut |
| Structured claim → evidence → confidence kategorikal | Prioritas command: `/screen` naik dari roadmap menjadi MVP |
| Bull / Bear / Debate maksimum 2 ronde | Definisi "custom agent": dari wacana bebas menjadi Agent Configurator terbatas |
| Judge dengan rubrik bobot eksplisit & deterministik | Reframing output `/screen`: dari implikasi prediksi ke kriteria historis objektif |
| Empat pilar desain (Bagian 03, v1.0) | Alokasi roadmap 4 minggu disesuaikan (Bagian 08 addendum ini) |

---

## Bagian 02 — Prinsip Tambahan: Natural-Language-First

"Harness" dan "kebebasan penuh untuk user" adalah dua sumbu yang berbeda. Sebuah test harness bersifat fleksibel bukan karena test yang dijalankan bisa berupa apa saja tanpa batas, melainkan karena ia punya struktur yang bisa diisi banyak test case. Fleksibilitas ada pada komposabilitas primitives, bukan pada ketiadaan struktur. Prinsip ini yang dipakai untuk merevisi arsitektur interaksi Financial Agent Harness.

**Prinsip ke-5: Natural-Language-First, Command sebagai Shortcut.** User tidak perlu menghafal sintaks command untuk memakai sistem — cukup bertanya dengan bahasa natural. Command tetap ada sebagai jalur cepat bagi power user, menembak ke template eksekusi yang persis sama dengan yang dipakai jalur natural language.

### Spektrum kebebasan interaksi

Empat level berikut dipakai sebagai referensi untuk menentukan seberapa jauh kebebasan dibuka di tiap fase — supaya "kebebasan" tidak jadi keputusan sekali jalan yang mengorbankan auditability.

| Level | Deskripsi | Status di v1.1 |
|-------|-----------|----------------|
| L0 | User harus tahu nama & sintaks command persis | Digantikan — command jadi opsional, bukan satu-satunya jalur |
| **L1** | NL bebas → Intent Router mengklasifikasi ke template + extract parameter | Scope v1.1 — dibangun untuk hackathon |
| L2 | Planner menyusun urutan dari node primitif mengikuti aturan komposisi | Roadmap v1.2 — dicoba bila waktu Minggu 4 tersisa |
| L3 | Drag-and-drop graph builder, agent authoring API/skill bebas | Visi jangka panjang — di-pitch, tidak dibangun |

> Router pada L1 tidak pernah mengarang urutan agent baru dari nol — ia hanya memilih satu dari sejumlah template yang sudah tervalidasi. Ini menjaga auditability dan cost control dari v1.0 tetap utuh, sekaligus menjawab keresahan bahwa sistem "belum terasa seperti harness".

---

## Bagian 03 — Arsitektur Revisi: Intent Router & Template Library

Titik masuk sistem sekarang bercabang dua — natural language atau slash command — tetapi keduanya berujung pada komponen baru, **Intent Router**, sebelum masuk ke execution graph yang sama seperti v1.0 (Bagian 04).

```text
 Pertanyaan Bebas (NL)                    Slash Command
 "Saham apa yang konsisten tumbuh?"       /screen "profitable, growing"
            ↘                                        ↙
        Intent Router / Planner
        Klasifikasi ke template + extract parameter
                    ↓
   /judge   /screen   /compare   /research   /investigate
                    ↓
 Evidence Store → Researcher → Bull/Bear/Debate/Judge
 (sama seperti v1.0, Bagian 04–07)
```

> **Gambar A1 — Intent Router menembak ke template yang sama, dari dua pintu masuk berbeda**

### Peran Intent Router

| Aspek | Detail |
|-------|--------|
| Input | Pertanyaan bebas (natural language) ATAU slash command eksplisit |
| Proses | Klasifikasi intent ke satu template yang sudah ada + extract parameter (ticker, kriteria, sektor, dsb.) — pola yang sama dengan cara claim divalidasi terhadap evidence_id: structured output classification, bukan generative planning bebas |
| Output normal | Nama template + parameter terisi → dieksekusi seperti execution graph v1.0 |
| Output bila tidak yakin | Mengajukan pertanyaan klarifikasi ke user — tidak mengarang graph baru |
| Yang tidak dilakukan | Menyusun urutan agent baru dari nol, atau memanggil agent di luar Template & Agent Library yang sudah tervalidasi |

---

## Bagian 04 — Command Sebagai Shortcut, Bukan Satu-satunya Pintu

Command tidak dihapus — ia tetap berguna sebagai jalur cepat bagi power user yang sudah hafal sintaksnya. Yang berubah hanya prioritas build, mengikuti kebutuhan riil yang muncul dari contoh penggunaan ("saham apa yang konsisten naik" = kebutuhan `/screen`, bukan kebutuhan agent authoring bebas).

| Command | Deskripsi | Contoh trigger NL | Prioritas v1.1 |
|---------|-----------|-------------------|----------------|
| `/judge` | Evaluasi investasi 1 ticker | "Apakah BBCA layak dikoleksi?" | MVP — Minggu 1–2 (tidak berubah) |
| `/screen` | Saring saham lintas ticker berdasar kriteria | "Saham apa yang konsisten tumbuh?" | Naik ke MVP — Minggu 2–3 (semula "didesain, belum diimplementasi") |
| `/compare` | Bandingkan beberapa ticker sejenis | "BBCA vs BBRI vs BMRI, mana lebih baik?" | MVP — Minggu 4 (tidak berubah) |
| `/research` | Riset mentah tanpa opini/skor | "Apa yang terjadi di BBCA minggu ini?" | Roadmap — kandidat kuat Minggu 4 (reuse Researcher) |
| `/investigate` | Selidiki pergerakan harga tak biasa | "Kenapa BBCA naik tajam hari ini?" | Roadmap, didesain & di-pitch |
| `/challenge` | Uji satu klaim spesifik dari user | "Menurutmu BBCA overvalued, benar?" | Roadmap, didesain & di-pitch |

> **Catatan:** Intent Router dan slash command tidak menjalankan dua logic terpisah — keduanya menembak ke template Graph yang persis sama (Bagian 03). Tidak ada duplikasi implementasi antara "mode command" dan "mode natural language".

---

## Bagian 05 — Agent Configurator (Custom Agent Terbatas)

Kebutuhan "user bisa membuat agent baru" dipenuhi lewat **Agent Configurator** — kombinasi pilihan dari komponen yang sudah tervalidasi, bukan authoring bebas (prompt bebas, API bebas). Hasilnya tetap terasa seperti "membuat analyst sendiri", tapi secara teknis adalah instance baru dari template yang sudah ada dengan parameter berbeda — sehingga tetap patuh ke skema claim → evidence_id yang menjaga auditability.

| Bisa dikonfigurasi user | Tidak dibuka ke user (di v1.1) |
|-------------------------|-------------------------------|
| Domain fokus (mis. banking, consumer, mining — dari daftar sektor yang sudah didukung Sectors API) | Endpoint API bebas / sumber data di luar yang sudah terhubung ke Evidence Store |
| Data source — checklist dari sumber yang sudah terhubung (Sectors, News feed) | Prompt / system instruction bebas untuk agent |
| Skill / modul analisis — checklist dari modul yang sudah dibangun (valuation, sentiment, dividend, dsb.) | Skill baru yang belum ada implementasinya di sistem |
| Nama & deskripsi agent (label tampilan saja) | Struktur output di luar skema claim → evidence_id |

> **Batas eksplisit:** Free-form agent authoring (API benar-benar bebas, skill benar-benar baru) tetap dicatat sebagai visi produk (L3, Bagian 02), tapi eksplisit di luar scope hackathon. Disebutkan di pitch sebagai arah pengembangan — pola yang sama dengan bagaimana v1.0 memperlakukan `/challenge` dan `/screen`: didesain, tidak wajib berfungsi penuh saat demo.

---

## Bagian 06 — Agent Library: Memperluas Cakupan, Bukan Membuka Otorship Bebas

Kebutuhan akan "banyak agent spesifik" (pengumpul data menyeluruh, agent berita khusus satu sektor, dst.) dijawab lewat **Agent Library** yang tumbuh — ditambah oleh tim, secara inkremental, bukan diotorisasi bebas oleh user. Ini memperluas Bagian 09 v1.0 (Agent Ekstensi) tanpa membuka risiko integrasi atau evidence hallucination yang datang dari user authoring.

| Agent Inti (selalu aktif) | Agent Library (dipilih via Configurator / `--with`) |
|-------------------------|------------------------------------------------------|
| Financial Researcher | Dividend Analyst |
| Market Researcher | Insider Activity Analyst |
| News Researcher | Sector Analyst |
| Bull / Bear Agent | Macro Analyst |
| Judge Agent | Technical Analyst, Risk Analyst |
| **Sector News Agent (baru)** — filter berita relevan ke satu sektor spesifik, bukan seluruh pasar | |
| **Cross-Market Signal Agent (baru)** — mengaitkan sinyal antar sektor, mis. suku bunga → perbankan | |

> Menambah agent baru ke Library berarti tim mendefinisikan template + skema evidence-nya sekali, lalu tersedia untuk semua user lewat Configurator. Ini jauh lebih murah dan aman dibanding infrastruktur agent authoring bebas per-user (Bagian 05), sekaligus tetap menjawab kebutuhan variasi agent yang luas.

---

## Bagian 07 — Reframing /screen & Catatan Regulasi

`/screen` naik prioritas karena langsung menjawab kebutuhan riil ("saham apa yang konsisten naik"). Tapi framing outputnya perlu diubah — pertanyaan asli mengandung implikasi prediksi harga masa depan, yang levelnya lebih sensitif secara regulasi (ranah OJK di Indonesia) dibanding skor evaluasi satu ticker di `/judge` yang sudah punya disclaimer.

| Sebelum (berisiko) | Sesudah — v1.1 |
|--------------------|------------------|
| Framing pertanyaan: "Saham yang akan naik konsisten" | "Saham dengan riwayat pertumbuhan laba/margin konsisten N kuartal terakhir" |
| Implikasi: Prediksi harga ke depan | Pola historis terukur, tertaut evidence |
| Bentuk output: Ranking + implikasi "beli" | Ranking + kriteria yang terpenuhi + evidence per kriteria |

> **Wajib sebelum `/screen` didemokan:** disclaimer yang lebih menonjol dibanding `/judge` — bukan hanya di footer, tapi ditampilkan berdekatan dengan setiap hasil ranking, karena sifatnya cross-ticker dan lebih dekat ke "rekomendasi daftar saham" dibanding evaluasi satu ticker.

---

## Bagian 08 — Revisi Roadmap 4 Minggu

| Minggu | Fokus | Deliverable (perubahan dari v1.0 ditandai) |
|--------|-------|-------------------------------------------|
| 1 | Spine | Sama seperti v1.0 (Planner + DAG engine, skema Evidence Store, Sectors API → Financial Researcher) **+ skema dasar Intent Router (klasifikasi rule-based sederhana dulu, belum LLM penuh)** |
| 2 | Debate + Judge + validasi | Sama seperti v1.0 (Market & News Researcher paralel, Bull+Bear+Debate 1 ronde, evidence validator wajib) **+ `/screen` mulai dibangun paralel (reuse Financial Researcher, tambah logic ranking sederhana)** |
| 3 | UI + robustness | Sama seperti v1.0 (live UI, caching, fallback data) **+ Intent Router pakai LLM classification penuh, NL query jadi input utama di UI (bukan hanya slash command) + `/screen` selesai dengan reframing kriteria historis (Bagian 07)** |
| 4 | Perluasan roadmap + polish | Sama seperti v1.0 (`/compare`, model routing 2 tier, dokumentasi) **+ Agent Configurator versi ringan (2–3 pilihan domain/data source/skill yang sudah ada) sebagai bukti konsep; command lain tetap sebagai "next" di pitch** |

---

## Bagian 09 — Risiko Tambahan & Kesimpulan

Tiga risiko baru muncul akibat perubahan di addendum ini, melengkapi tabel risiko Bagian 12 v1.0:

| Risiko | Dampak bila diabaikan | Mitigasi |
|--------|-----------------------|----------|
| **Intent misclassification** | Router salah merutekan pertanyaan ke template yang keliru | Fallback klarifikasi eksplisit ("maksud kamu evaluasi BBCA, atau screening semua bank?"), bukan menebak; command slash tetap tersedia sebagai override manual |
| **Configurator jadi celah scope creep** | Tim tergoda menambah opsi konfigurasi terus-menerus mendekati deadline | Kunci daftar data source & skill yang bisa dipilih di awal Minggu 4; tidak menambah opsi baru H-3 sebelum demo |
| **Risiko regulasi meningkat pada `/screen`** | Output cross-ticker terbaca sebagai rekomendasi daftar saham | Reframing kriteria historis (Bagian 07) + disclaimer menonjol, wajib sebelum `/screen` didemokan |

### Kesimpulan Revisi

Addendum ini tidak mengubah fondasi v1.0 — Evidence Store, validasi evidence, dan Judge tetap seperti semula. Yang berubah adalah bagaimana user masuk ke sistem (natural language, bukan hafalan command) dan bagaimana ekstensibilitas ditangani (Agent Library yang tumbuh dari tim + Agent Configurator terbatas, bukan authoring bebas per-user). Dengan begitu, kata "harness" tetap punya makna teknis yang jujur — komposabilitas dari primitives yang tervalidasi — tanpa mengorbankan empat pilar yang sudah terbukti solid di v1.0.