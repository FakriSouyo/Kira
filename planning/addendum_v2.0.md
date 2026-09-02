# REVISI ARSITEKTUR · V2.0 — Financial Agent Harness

## Dari MVP Hackathon Menuju Full-Scope, Tanpa Batas Waktu Event

Hilangnya deadline event mengubah kalkulasi scope — tapi bukan berarti semua batasan v1.2 gugur otomatis. Dokumen ini memisahkan apa yang murni korban waktu (aman dibuka penuh) dari apa yang merupakan keputusan arsitektur sadar (butuh guardrail tetap, bukan dibuka begitu saja).

Dua keputusan yang membentuk seluruh revisi ini: **Agent Configurator diperluas cakupannya, guardrail tetap dikunci**; dan **proyek berpotensi dipublikasikan/dipakai orang lain** — bukan lagi cuma demo untuk satu orang yang paham arsitekturnya sendiri.

> Versi Draft 2.0 · September 2026 · Menggantikan kerangka roadmap v1.0–v1.2

---

## Daftar Isi

- 01 Dua Kategori Perubahan: Korban Waktu vs Keputusan Sadar
- 02 Command & Agent Library: Dari Ditunda ke Dibangun Penuh
- 03 Intent Router: Naik dari L1 ke L2
- 04 Tiga Mekanisme Kehati-hatian Router
- 05 Roadmap Berbasis Ketergantungan, Bukan Kalender
- 06 Tool Mapping Diperluas (Peninjauan Ulang Bagian 08 v1.2)
- 07 Agent Configurator: Perluas Cakupan, Guardrail Tetap
- 08 Trust & Regulasi: Berlaku ke Semua Command Penghasil Skor
- 09 Risiko Jangka Panjang (Pengganti Risiko "Kejar Waktu")
- 10 Kesimpulan

---

## Bagian 01 — Dua Kategori Perubahan: Korban Waktu vs Keputusan Sadar

Hilangnya deadline event mengubah kalkulasi — tapi tidak semua yang ditunda di v1.2 ditunda karena alasan yang sama. Mencampur keduanya berisiko membuat desain longgar lagi, padahal v1.2 baru saja mengunci itu.

| Kategori | Perlakuan di v2.0 |
|----------|-------------------|
| **Murni korban waktu** — `/research`, `/investigate`, `/challenge`; seluruh Agent Library (Dividend, Insider Activity, Sector, Macro, Technical, Risk, Sector News, Cross-Market Signal); Intent Router L2 | Aman dibuka jadi scope penuh — sudah didesain, cuma menunggu waktu |
| **Bukan sekadar korban waktu** — Batas Bagian 05 v1.2 (Configurator dikunci ke pilihan tervalidasi, prompt/API bebas dilarang) — alasannya keamanan skema evidence & auditability, bukan waktu mepet | Butuh keputusan sadar, bukan otomatis dibuka — dijawab di Bagian 07 dokumen ini |

Dua keputusan yang mengunci arah dokumen ini:

- **P: Batas Agent Configurator di versi final?** → Perluas cakupan, guardrail tetap
- **P: Proyek ini dipakai siapa?** → Berpotensi dipublikasikan/dipakai orang lain

> Dua jawaban ini saling menguatkan: kalau berpotensi dipakai orang asing yang tidak paham arsitektur sistem, guardrail justru makin penting — bukan lagi soal meyakinkan juri, tapi tanggung jawab beneran atas output yang bisa dibaca sebagai saran finansial.

---

## Bagian 02 — Command & Agent Library: Dari Ditunda ke Dibangun Penuh

Bagian ini murni korban waktu di v1.0–v1.2 — sudah didesain penuh, cuma disebut di pitch tanpa implementasi karena Minggu 4 tidak cukup. Tanpa deadline event, semuanya pindah ke scope aktif.

| Item | Status di v2.0 |
|------|----------------|
| `/research`, `/investigate`, `/challenge` | Scope penuh — dibangun sungguhan, bukan lagi "disebut di pitch, tidak wajib berfungsi saat demo" |
| Agent Library: Dividend, Insider Activity, Sector, Macro, Technical, Risk Analyst, Sector News, Cross-Market Signal | Semua diimplementasikan sungguhan — bukan cuma tersedia di kertas sebagai visi produk |

> **Yang tidak otomatis ikut naik cakupan:** pembukaan agent baru ke Library tetap mengikuti disiplin Bagian 06 v1.2 — tim mendefinisikan template + skema evidence sekali, baru tersedia lewat Configurator. "Full-scope" berarti semua agent yang sudah didesain dibangun, bukan pintu authoring bebas per-user dibuka — itu pertanyaan arsitektur terpisah, dijawab di Bagian 07.

---

## Bagian 03 — Intent Router: Naik dari L1 ke L2

"Pintar" yang dimaksud bukan router yang bebas mengarang graph — itu levelnya L2, bukan L1, dan filosofi Bagian 02 v1.0 ("harness = komposabilitas primitives tervalidasi, bukan ketiadaan struktur") tetap dipertahankan. Yang naik levelnya, bukan struktur yang hilang.

| Level | Kemampuan | Status |
|-------|-----------|--------|
| **L1** | Pilih satu template dari Template Library yang sudah ada | Baseline aman — tetap jadi fallback di v2.0 |
| **L2** | Compose dari primitive nodes mengikuti aturan komposisi eksplisit — router tetap tidak boleh mengarang node baru, hanya menyusun urutan dari node yang sudah divalidasi tim | Dibangun penuh di v2.0 (sebelumnya "dicoba kalau Minggu 4 sisa waktu" di v1.2) |

**Contoh query majemuk:** "evaluasi BBCA dan bandingkan juga dengan BBRI" tidak butuh template gabungan baru — router L2 menyusunnya dari node yang sudah ada: `Judge(BBCA)` + `Judge(BBRI)` + `Compare`. Bandingkan dengan L1 (Bagian 03 v1.2), yang hanya bisa memilih satu template utuh seperti `JUDGE_DEEP` dan tidak bisa menangani query yang menyentuh dua template sekaligus.

---

## Bagian 04 — Tiga Mekanisme Kehati-hatian Router

Naik ke L2 berarti router punya lebih banyak ruang gerak. Tanpa tekanan deadline, tiga mekanisme berikut bisa ditambahkan sekarang alih-alih ditunda:

| Mekanisme | Fungsi |
|-----------|-----------|
| **Confidence threshold** | Kalau skor klasifikasi di bawah ambang, klarifikasi jadi wajib, bukan opsional |
| **Preview-before-execute** | Untuk compound/mahal (multi-agent, multi-ticker), tampilkan rencana hasil router terlebih dulu — *"Akan menjalankan Judge untuk BBCA dan BBRI, lalu membandingkan — lanjut?"* — sebelum benar-benar jalan. Juga menjaga biaya API untuk proyek yang dibiayai sendiri per-call |
| **Routing decision log** | Setiap keputusan router (input, komposisi yang dipilih, parameter, confidence) ikut tersimpan sebagai bagian evidence trail — kalau output aneh, bisa ditelusuri apakah salah rute atau salah agent |

---

## Bagian 05 — Roadmap Berbasis Ketergantungan, Bukan Kalender

Tanpa event, "Minggu 1–4" (Bagian 09 v1.2) tidak lagi relevan sebagai alat perencanaan. Tapi menghapusnya tanpa pengganti memindahkan risiko: bukan lagi "keburu waktu", tapi "scope tidak pernah kelar". Setiap fase karena itu tetap butuh kriteria selesai eksplisit — bukan tanggal, tapi kondisi terverifikasi.

| Fase | Fokus | Kriteria selesai (bukan tanggal) |
|-------|--------|----------------------------------|
| 1 | Evidence Store + command inti | `/judge`, `/screen`, `/compare`, `/research`, `/investigate`, `/challenge` semuanya berjalan penuh dengan evidence-linkage tervalidasi |
| 2 | Intent Router L1 sebagai baseline aman | Semua command di Fase 1 bisa dipicu lewat natural language dengan tingkat kesalahan rute yang bisa diterima, fallback klarifikasi berfungsi |
| 3 | Agent Library penuh + tool mapping diperluas | Seluruh agent di Bagian 02 dokumen ini live; tool mapping diperluas mengikuti disiplin audit Bagian 06 |
| 4 | Router naik ke L2 | Query majemuk seperti contoh Bagian 03 berhasil diverifikasi berjalan benar, lengkap dengan tiga mekanisme kehati-hatian (Bagian 04) |
| 5 | Agent Configurator diperluas | Granularitas skill, parameter preset/range, dan pemecahan domain (Bagian 07) tersedia, tetap tanpa kolom instruksi bebas |

---

## Bagian 06 — Tool Mapping Diperluas (Peninjauan Ulang Bagian 08 v1.2)

Bagian 08 v1.2 sengaja men-skip sejumlah endpoint API Sectors. Alasan skip-nya perlu dipisah: kalau murni keberatan waktu, sekarang layak ditinjau ulang; kalau keberatan arsitektur, tetap di luar scope.

| Endpoint | Alasan skip di v1.2 | Status di v2.0 |
|----------|---------------------|----------------|
| **SGX & KLSE (seluruh endpoint)** | Currency handling baru (SGD/MYR), skema Evidence Store baru, testing lingkungan regulasi lain — murni beban implementasi, bukan keberatan prinsip | Layak ditinjau sebagai investasi, karena keberatannya waktu, bukan arsitektur |
| **Mining Extension (13 endpoint)** | Domain data paralel penuh di luar roadmap 4 minggu | Layak ditinjau — sama seperti SGX/KLSE, keberatannya beban waktu implementasi |
| **Top Brokers (market-wide)** | Tidak menempel ke satu ticker/claim spesifik — gap konseptual, bukan cuma waktu | Tetap dievaluasi terpisah sebagai agent baru ("Broker Activity Analyst") di Agent Library, bukan otomatis ikut "full-scope" tanpa desain tersendiri |

> **Disiplin yang tetap berlaku:** perluasan tool mapping mengikuti audit dokumentasi API langsung, persis seperti disiplin Bagian 08 v1.2 — bukan menambah endpoint dari nama yang terlihat relevan tanpa verifikasi. **Corporate Actions** (dicatat sebagai belum terverifikasi di v1.2) tetap perlu dicek nama endpoint pastinya sebelum masuk spec manapun.

---

## Bagian 07 — Agent Configurator: Perluas Cakupan, Guardrail Tetap

Ini jawaban untuk pertanyaan yang sengaja tidak dijawab otomatis di Bagian 01: batas Bagian 05 v1.2 (dilarang prompt/API bebas) alasannya keamanan skema evidence & auditability — bukan waktu. Keputusan yang dikunci: **perluas cakupan pilihan, guardrail (checklist, bukan teks bebas) tetap.**

| Dimensi | Perluasan konkret |
|---------|-------------------|
| **Granularitas skill** | Naik dari checkbox tunggal ("Valuation") ke variasi metode di dalamnya (DCF, multiples-based, DDM) sebagai pilihan terpisah — tetap checklist, tanpa kolom teks bebas |
| **Endpoint di Bagian 06** | SGX/KLSE, Mining Extension ditinjau ulang sebagai investasi yang masuk akal (bukan lagi terlalu berat untuk waktu hackathon) |
| **Parameter dalam skill** | Bobot rubrik Judge, threshold modul valuation, dst. dibuka jadi pilihan dari preset/range tervalidasi — tetap bukan angka atau instruksi bebas, tapi lebih fleksibel dari sekadar on/off |
| **Domain/sektor** | Dipecah lebih halus dari daftar broad yang ada sekarang |

> **Yang tetap tidak berubah dari Bagian 05 v1.2:** kolom instruksi/prompt bebas tetap dilarang di semua level perluasan di atas. Contoh yang dilarang di v1.2 (*"Instructions: Analyze banking-specific indicators however you see fit..."*) tetap dilarang di v2.0 — cakupan pilihan bertambah, tapi bentuknya tetap checklist/preset, bukan teks bebas. Ini yang membuat "perluas cakupan" dan "guardrail tetap" bisa berjalan bersamaan tanpa kontradiksi.

---

## Bagian 08 — Trust & Regulasi: Berlaku ke Semua Command Penghasil Skor

Potensi dipakai orang asing (Bagian 01) menaikkan prioritas tiga hal dari "nice to have" jadi wajib.

| Item | Perubahan dari v1.2 |
|------|----------------------|
| **Reframing ala Bagian 07 v1.2** | Sebelumnya hanya untuk `/screen`. Di v2.0, berlaku ke semua command yang menghasilkan skor/opini — `/judge` dan `/compare` juga menghasilkan penilaian yang bisa dibaca sebagai rekomendasi |
| **Evidence Store & routing decision log** | Sebelumnya alat debug developer. Di v2.0, jadi lapisan pertanggungjawaban ke user asing yang mengandalkan output untuk keputusan nyata |
| **Kontrol biaya (rate limiting)** | Perlu dipikirkan kalau user luar bisa memicu banyak agent call sekaligus — beban biaya API tidak lagi ditanggung satu orang yang tahu persis pola pemakaiannya sendiri |

---

## Bagian 09 — Risiko Jangka Panjang (Pengganti Risiko "Kejar Waktu")

Tabel risiko Bagian 10 v1.2 didominasi risiko kejar-deadline. Tanpa deadline, jenis risikonya bergeser — bukan hilang.

| Risiko | Dampak bila diabaikan | Mitigasi |
|--------|-----------------------|----------|
| **Scope creep tanpa henti** | Tanpa titik henti kalender, proyek jalan terus tanpa pernah "selesai" | Kriteria selesai eksplisit per fase (Bagian 05) — bukan tanggal, tapi kondisi terverifikasi (mis. "query majemuk X berhasil diverifikasi") |
| **Biaya API membengkak** | Agent Library tumbuh + user luar memicu banyak call sekaligus | Preview-before-execute (Bagian 04) + rate limiting (Bagian 08) |
| **Beban tanggung jawab ke publik** | Output sistem berpotensi dibaca sebagai saran finansial oleh orang yang tidak paham arsitekturnya | Reframing berlaku ke semua command penghasil skor (Bagian 08) + Evidence Store & routing log sebagai lapisan pertanggungjawaban, bukan cuma alat debug |

---

## Bagian 10 — Kesimpulan

Hilangnya deadline event tidak mengubah filosofi inti proyek — hanya mengubah berapa banyak dari desain yang sudah ada bisa benar-benar dibangun. Command, Agent Library, dan Intent Router L2 pindah dari "didesain di kertas" ke "dibangun penuh" karena keterbatasannya murni waktu. Batas Agent Configurator tidak ikut gugur otomatis, karena alasannya sejak awal bukan waktu — melainkan keamanan skema evidence dan auditability, yang justru makin relevan begitu proyek berpotensi dipakai orang yang tidak paham arsitekturnya sendiri.

Roadmap kalender digantikan roadmap ketergantungan dengan kriteria selesai eksplisit, supaya hilangnya deadline tidak berubah jadi proyek yang tidak pernah selesai. Dan trust layer (reframing, evidence-linkage, rate limiting) naik dari "bagus untuk demo" jadi wajib, karena publikasi ke orang lain mengubah taruhannya dari reputasi ke tanggung jawab.