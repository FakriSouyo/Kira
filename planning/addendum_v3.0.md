# ADDENDUM FINAL · V3.1 — Financial Agent Harness

## Interactive REPL dengan Evidence-First Architecture

Dokumen final yang mengkonsolidasikan seluruh keputusan arsitektur dari diskusi mendalam tentang Financial Agent Harness: dari command-based system menuju interactive REPL harness dengan embedded SQLite, reasoning arena, dan zero-setup deployment.

> Version 3.1 · Revisi konsistensi Phase 0 (3-agent flow, 5-kategori rubrik, model routing dua-tier) · Januari 2025 · Complete Architecture Specification

---

## Apa yang Berubah di v3.1 (Revisi Konsistensi)

v3.1 adalah revisi konsistensi untuk menjadikan dokumen **siap dieksekusi** — tidak menambah fitur, hanya menyelaraskan kontradiksi internal yang ditemukan saat persiapan Phase 0:

| # | Isu di v3.0 | Resolusi di v3.1 |
|---|-------------|------------------|
| 1 🔴 | Information Flow & Multi-Agent Flow masih menyertakan **Bear + Bull rebuttal** sebagai bagian Phase 0, padahal "Debate ronde 2 → Phase 1" (kontradiksi scope) | **Phase 0 = 3 agent saja: Researcher → Bull → Judge.** Bear & rebuttal → Phase 1, sinkron dengan out-of-scope |
| 2 🟠 | DDL `judgments.breakdown` (3 kategori) tidak sinkron dengan Judge prompt (5 kategori) | **Breakdown = 5 kategori**; `marketMomentum` & `risk` **nullable** di Phase 0 (butuh data Market yang belum ada) |
| 3 🟡 | Cek ketersediaan JSON1 untuk better-sqlite3 | Ditegas kembali: JSON1 bundled dengan SQLite modern (≥3.38) yang dikirim better-sqlite3; verifikasi cepat saat setup + tidak bergantung di jalur utama (lihat §10) |
| 4 🟡 | Nama field campur `claimId`/`claim_id`, `messageId`/`message_id` | **snake_case di DB, camelCase di TS/Zod, dipetakan eksplisit** via Drizzle column mapping (lihat §11 & §16) |
| 5 🟠 | Model routing dua-tier (router murah, agent mahal) belum eksplisit & belum ada `maxTokens` | **Konfigurasi dua-tier eksplisit + field `maxTokens`** untuk kontrol biaya |

---

## Table of Contents

### Part I: Vision & Architecture
- [01. Executive Summary](#01-executive-summary)
- [02. Perjalanan Desain: v1.0 → v3.0](#02-perjalanan-desain-v10--v30)
- [03. Core Value Proposition](#03-core-value-proposition)
- [04. Prinsip Arsitektur (Locked)](#04-prinsip-arsitektur-locked)

### Part II: Technical Architecture
- [05. System Architecture](#05-system-architecture)
- [06. Information Flow](#06-information-flow)
- [07. Evidence Store: Ground Truth Layer](#07-evidence-store-ground-truth-layer)
- [08. Conversation Layer: Reasoning Arena](#08-conversation-layer-reasoning-arena)
- [09. REPL: Interactive Harness](#09-repl-interactive-harness)

### Part III: Data Layer
- [10. SQLite: Embedded Database](#10-sqlite-embedded-database)
- [11. Database Schema](#11-database-schema)
- [12. File Structure](#12-file-structure)
- [13. Content-Addressed Storage](#13-content-addressed-storage)

### Part IV: Agent System
- [14. Multi-Agent Flow](#14-multi-agent-flow)
- [15. Agent Design: Pure Functions](#15-agent-design-pure-functions)
- [16. Validation: Multi-Layer System](#16-validation-multi-layer-system)
- [17. LLM Integration](#17-llm-integration)

### Part V: User Experience
- [18. REPL Commands](#18-repl-commands)
- [19. CLI Output: Conversational](#19-cli-output-conversational)
- [20. Natural Language Input](#20-natural-language-input)
- [21. Error Handling & Recovery](#21-error-handling--recovery)

### Part VI: Implementation
- [22. Tech Stack (Final)](#22-tech-stack-final)
- [23. Monorepo Structure](#23-monorepo-structure)
- [24. Phase 0 Scope](#24-phase-0-scope)
- [24-A. Phase 1 · Market & News Researcher — Kontrak Data & Desain](#24-a-phase-1--market--news-researcher--kontrak-data--desain)
- [24-B. Pola Disiplin (Adaptasi DeepSeek Harness)](#24-b-pola-disiplin-adaptasi-deepseek-harness)
- [25. Task Breakdown](#25-task-breakdown)
- [26. Success Criteria](#26-success-criteria)

### Part VII: Roadmap & Vision
- [27. Phase Roadmap](#27-phase-roadmap)
- [28. GUI Vision](#28-gui-vision)
- [29. Deployment Strategy](#29-deployment-strategy)
- [30. Conclusion](#30-conclusion)

---

## Part I: Vision & Architecture

### 01. Executive Summary

**Financial Agent Harness** adalah interactive REPL system untuk riset dan evaluasi saham berbasis multi-agent architecture, di mana:

1. **Evidence Store** = ground truth ("Dari mana agent tahu?")
2. **Conversation Store** = reasoning layer ("Bagaimana agent sampai pada kesimpulan?")
3. **REPL Interface** = premium UX (slash commands + natural language)

**Diferensiasi kunci:**
- Bukan chatbot yang melempar saran — tapi reasoning arena yang dapat diaudit
- Bukan dashboard metric — tapi dialog reasoning yang argumentatif (Bull thesis + Judge; Bear/"debate ronde 2" di Phase 1)
- Bukan aplikasi web — tapi CLI developer-tool dengan zero-setup

**Target user:**
- Individual investor yang technically literate
- Financial analyst yang butuh research tool
- Developer yang ingin extend/customize agent behavior

---

### 02. Perjalanan Desain: v1.0 → v3.0

#### v1.0: Command-Based Harness (September 2026)
```
Command → Planner → DAG → Researcher → Bull/Bear → Judge
```

**Keputusan kunci:**
- Evidence Store sebagai lapisan terpisah dari LLM context
- Structured intermediate output (claim → evidence → confidence)
- Judge dengan rubrik scoring eksplisit
- Command system: `/judge`, `/compare`, `/screen`, etc.

**Masalah:** Terlalu rigid, user harus hafal command syntax

#### v1.1: Natural-Language-First (September 2026)
```
Natural Language → Intent Router → Template → Execution
```

**Keputusan kunci:**
- Intent Router L1: klasifikasi ke template yang sudah ada
- Command sebagai shortcut, bukan satu-satunya jalur
- Agent Configurator terbatas (checklist, bukan free-form)

**Masalah:** Masih terasa seperti form input, bukan conversation

#### v1.2: Tool Mapping & Refinement (September 2026)
```
NL/Command → Structured Intent → Tool Execution → Evidence
```

**Keputusan kunci:**
- Pemetaan tool eksplisit ke Sectors API
- Canonical JSON hashing untuk deduplication
- Run-scoped validation (evidence membership check)

**Masalah:** Output masih progress bar, bukan dialog

#### v2.0: Conversation-First Architecture (Januari 2025)
```
Evidence (ground truth) + Conversation (reasoning) = Reasoning Arena
```

**Keputusan kunci:**
- Conversation Store sebagai reasoning layer terpisah
- CLI output conversational (🔍 🐂 🐻 ⚖️)
- Bull ↔ Bear debate sebagai konsep *future* / pemikiran desain (bukan wajib di Phase 0)

**Masalah:** PostgreSQL online terlalu heavy untuk developer tool

> **Catatan konsistensi:** Di v2.0, Bull–Bear debate digambarkan sebagai "first-class citizen". Ini adalah **visi jangka panjang (Phase 1+)**. Di Phase 0 (v3.0+) kita memakai **3-agent flow (Researcher → Bull → Judge)** untuk vertical slice yang minimal dan konsisten dengan scope "Debate ronde 2 → Phase 1". Bear & rebuttal **bukan** bagian Phase 0.

#### v3.0: Interactive REPL + Embedded SQLite (Januari 2025 - FINAL)
```
pnpm finharness → REPL → Slash Commands + NL → Local SQLite
```

**Keputusan final:**
- Interactive REPL (pola DeepSeek Harness / Claude Code)
- SQLite embedded (zero-setup, file-based)
- Local-first runtime dengan optional sync
- Slash commands = fitur MVP yang dijual
- **Phase 0 flow = 3 agent: Researcher → Bull → Judge** (tanpa Bear/rebuttal)

---

### 03. Core Value Proposition

#### Untuk User

**Traditional stock screener:**
```
Input: BBCA
Output: Score 72/100 ✓
```

❌ **Masalah:**
- Tidak tahu bagaimana score dihitung
- Tidak tahu data mana yang dipakai
- Tidak ada argumentasi berlawanan

**Financial Agent Harness:**
```
> /judge BBCA

🐂 BULL: ROE 23.1% shows strong profitability...
         → Evidence: evidence_a1b2c3d4

⚖️ JUDGE: Bull presents consistent signals.
           Note: only that data available in Phase 0 supports
           the thesis; momentum/risk not evaluated yet.
           Score: 72/100 (BULLISH)
```

> **Catatan Phase 0:** Output di atas adalah **3-agent flow** (Researcher → Bull → Judge). Tidak ada Bear & rebuttal di Phase 0 — keduanya masuk Phase 1 sebagai "Debate ronde 2". Ini menjaga vertical slice tetap minimal dan output instan.

✅ **Keuntungan:**
- **Transparency**: Setiap klaim tertaut ke evidence
- **Reasoning**: Bull memaparkan tesis dengan tautan evidence yang bisa diaudit
- **Auditability**: User bisa trace evidence_a1b2c3d4 → raw data

#### Untuk Developer

**Traditional approach:**
```python
# Hardcode di aplikasi
result = llm.complete("Analyze BBCA")
score = parse_somehow(result)
```

❌ **Masalah:**
- Tidak bisa extend tanpa edit code
- Tidak bisa replay/debug execution
- Tidak bisa customize agent behavior

**Financial Agent Harness:**
```bash
$ pnpm finharness

> /judge BBCA
# Runs with default agents

> /judge BBCA --with dividend risk
# Extends with optional agents

> /session replay run_8f31
# Replay exact execution for debugging
```

✅ **Keuntungan:**
- **Extensible**: Agent baru via plugin system
- **Debuggable**: Full event log per execution
- **Customizable**: Config file untuk agent behavior

---

### 04. Prinsip Arsitektur (Locked)

#### 1. Evidence-First (Non-Negotiable)

**Rule:** Agent hanya boleh terima `evidenceIds[]`, tidak pernah raw data.

```typescript
// ✅ GOOD
bullAgent.analyze({
  ticker: "BBCA",
  evidenceIds: ["evidence_001", "evidence_002"]
})

// ❌ BAD
bullAgent.analyze({
  ticker: "BBCA",
  data: { revenue: 100, profit: 20 } // Bypasses audit trail
})
```

**Alasan:**
- Setiap claim dapat ditelusuri ke sumber
- Tidak ada "floating claim" tanpa evidence
- Evidence Store = single source of truth

#### 2. Schema-First (Non-Negotiable)

**Rule:** Zod mendefinisikan struktur, LLM mengisi konten.

```typescript
// System defines structure
const ClaimSchema = z.object({
  statement: z.string(),
  confidence: z.enum(["strong", "moderate", "weak"]),
  evidenceIds: z.array(z.string().uuid()).min(1)
});

// LLM fills content
const claim = await llm.generateObject({
  schema: ClaimSchema,
  prompt: "..."
});
```

**Alasan:**
- LLM tidak boleh menentukan struktur sistem
- Type safety end-to-end
- Validation deterministik

#### 3. Conversation Layer (New in v2.0)

**Rule:** Natural language reasoning disimpan terpisah dari structured claims.

```
Evidence Store → Ground truth (data)
Conversation Store → Reasoning (how agent thinks)
Claims → Structured extraction (what agent concludes)
```

**Alasan:**
- User memahami **proses**, bukan hanya hasil
- GUI bisa replay conversation
- Debugging lebih mudah (lihat reasoning chain)

#### 4. Run-Scoped Validation (New in v1.2)

**Rule:** Claim hanya valid jika `evidenceIds ⊆ allowedEvidenceIds`.

```typescript
// Workflow creates run with specific evidence
const allowedEvidenceIds = ["evidence_001", "evidence_002"];

// Claim validator checks membership
await validator.validate(claims, allowedEvidenceIds);
// → Error if claim references evidence_003
```

**Alasan:**
- Prevent agent hallucinating evidence IDs
- Prevent agent using evidence from different runs
- Evidence provenance tetap jelas

#### 5. Local-First Runtime (New in v3.0)

**Rule:** Execution berjalan lokal, database optional sync.

```
Runtime (Local)
  ↓
Agent conversation + events
  ↓
~/.finharness/finharness.db (SQLite)
  ↓
Optional: Sync to PostgreSQL (future)
```

**Alasan:**
- Zero-setup (pnpm finharness → langsung jalan)
- Offline-capable (hasil tersimpan lokal)
- No network latency (no round-trip ke database online)

#### 6. Pure Agents (Non-Negotiable)

**Rule:** Agent tidak boleh touch database, workflow handles persistence.

```typescript
// Agent returns pure data
const response = await bullAgent.analyze({ evidenceIds });

// Workflow handles persistence
await conversationStore.addMessage({
  content: response.reasoning,
  evidenceIds: response.evidenceIds
});

await claimStore.save(response.claims);
```

**Alasan:**
- Agent mudah di-test (pure functions)
- Separation of concerns
- Agent bisa di-reuse di context berbeda

#### 7. Canonical Hashing (New in v1.2)

**Rule:** Content hash menggunakan deterministic JSON serialization.

```typescript
// These are considered identical:
{"revenue": 100, "profit": 20}
{"profit": 20, "revenue": 100}

// Both produce same canonical hash
canonicalHash(data) // → "sha256_xxx"
```

**Alasan:**
- Deduplication yang reliable
- Evidence tidak duplikat meskipun key order berbeda
- Save API calls (1500 point limit)

#### 8. Minimal Abstraction (Phase 0)

**Rule:** Hardcode workflow dulu, abstract setelah terbukti pattern.

```typescript
// Phase 0: Hardcoded workflow
async function judgeWorkflow(ticker: string) {
  const evidence1 = await fetchCompanyReport(ticker);
  const evidence2 = await fetchQuarterlyFinancials(ticker);
  const bull = await bullAgent.analyze({ evidenceIds: [e1, e2] });
  const judge = await judgeAgent.evaluate({ claims: bull.claims });
  return judge;
}

// Phase 3: Generic orchestration (jika perlu)
// const workflow = new WorkflowBuilder()
//   .addNode("fetch", fetchEvidence)
//   .addNode("bull", bullAgent)
//   ...
```

**Alasan:**
- Don't over-engineer before validation
- Abstraction premature = complexity debt
- Extract patterns after 2-3 workflows solid

---

## Part II: Technical Architecture

### 05. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 pnpm finharness                         │
│              (Interactive REPL Entry)                   │
└──────────────────────┬──────────────────────────────────┘
                       │
            ┌──────────┴──────────┐
            │     REPL Loop       │
            │  • Parse input      │
            │  • Route command    │
            │  • Execute          │
            │  • Render output    │
            └──────────┬──────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        v              v              v
    /judge        /screen        /challenge
        │              │              │
        └──────────────┴──────────────┘
                       │
                       v
              ┌────────────────┐
              │ Intent Router  │
              │ (NL → Command) │
              └────────┬───────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        v              v              v
   Sectors API    LLM Client    SQLite DB
        │              │       ~/.finharness/
        │              │              │
        └──────────────┴──────────────┘
                       │
                       v
              ┌────────────────┐
              │ Evidence Store │
              │ (ground truth) │
              └────────┬───────┘
                       │
                       v
              ┌────────────────┐
              │ Conversation   │
              │ (reasoning)    │
              └────────────────┘
```

### 06. Information Flow

#### Execution Flow (High-Level)

> **Phase 0 flow = 3 agent: Researcher → Bull → Judge.** Bear & rebuttal ("Debate ronde 2") tidak termasuk di sini.

```
User Input (REPL)
    ↓
Parse & Route
    ↓
Execute Command (e.g., /judge BBCA)
    ↓
1. Fetch Evidence (Sectors API)
    ↓
2. Save to Evidence Store (SQLite)
    ↓
3. Bull Agent analyzes
    ├─→ Natural language reasoning → Conversation Store
    └─→ Structured claims → Claims table
    ↓
4. Judge evaluates
    ├─→ Decision reasoning → Conversation Store
    └─→ Judgment → Judgments table
    ↓
Render Output (Conversational)
    ↓
Save Session (optional)
```

#### Data Flow (Detailed)

```
┌─────────────────────────────────────────────────┐
│              Sectors API                        │
│  • Company Report                               │
│  • Quarterly Financials                         │
└──────────────────┬──────────────────────────────┘
                   │
                   │ HTTP Request
                   ▼
            ┌──────────────┐
            │ API Client   │
            │ (with cache) │
            └──────┬───────┘
                   │
                   │ Raw JSON Response
                   ▼
         ┌─────────────────────┐
         │  Evidence Store     │
         │  • Canonical hash   │
         │  • Deduplication    │
         │  • Metadata         │
         │  • JSON payload     │
         └─────────┬───────────┘
                   │
                   │ evidence_id
                   ▼
         ┌─────────────────────┐
         │  Agent Runtime      │
         │  • Bull             │
         │  • Judge            │
         │  (Bear → Phase 1)   │
         └─────────┬───────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        │ NL reasoning        │ Structured claims
        ▼                     ▼
┌───────────────────┐  ┌──────────────┐
│ Conversation      │  │ Claims       │
│ Store             │  │ (validated)  │
└───────────────────┘  └──────────────┘
        │                     │
        └──────────┬──────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │  Judgment           │
         │  • Score            │
         │  • Stance           │
         │  • Breakdown        │
         └─────────────────────┘
```

---

### 07. Evidence Store: Ground Truth Layer

#### Purpose

**Evidence Store menjawab:** "Dari mana agent tahu?"

Setiap klaim yang dibuat agent harus tertaut ke evidence yang:
- Dapat ditelusuri ke sumber (Sectors API endpoint + timestamp)
- Immutable (content hash)
- Deduplicated (no redundant API calls)

#### Schema

```sql
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,              -- UUID v4
  run_id TEXT NOT NULL,             -- FK to executions
  
  ticker TEXT NOT NULL,
  source TEXT NOT NULL,             -- 'sectors.company_report'
  source_type TEXT NOT NULL,        -- 'api' | 'manual' | 'cached'
  
  content_hash TEXT NOT NULL,       -- SHA-256 of canonical JSON
  retrieved_at TEXT NOT NULL,       -- ISO 8601 timestamp
  valid_at TEXT,                    -- Data validity period (optional)
  
  data TEXT NOT NULL,               -- JSON payload (raw API response)
  provenance TEXT,                  -- JSON metadata (API version, etc)
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  UNIQUE(content_hash)              -- Deduplication
);

CREATE INDEX idx_evidence_run ON evidence(run_id);
CREATE INDEX idx_evidence_ticker ON evidence(ticker);
CREATE INDEX idx_evidence_hash ON evidence(content_hash);
CREATE INDEX idx_evidence_source ON evidence(source, ticker);
```

#### Operations

```typescript
interface EvidenceStore {
  // Save evidence (with dedup)
  save(params: {
    runId: string;
    ticker: string;
    source: string;
    data: Record<string, any>;
  }): Promise<Evidence>;
  
  // Retrieve evidence by IDs (primary agent API)
  getManyByIds(ids: string[]): Promise<Evidence[]>;
  
  // Query by ticker (for debugging/UI)
  getByTicker(ticker: string): Promise<Evidence[]>;
  
  // Query by run (for audit trail)
  getByRun(runId: string): Promise<Evidence[]>;
}
```

#### Content-Addressed Storage

**Canonical JSON hashing:**

```typescript
function canonicalHash(data: Record<string, any>): string {
  // 1. Sort keys recursively
  const sorted = sortKeysDeep(data);
  
  // 2. Deterministic serialization
  const json = JSON.stringify(sorted);
  
  // 3. SHA-256 hash
  return crypto.createHash('sha256')
    .update(json)
    .digest('hex');
}

// These produce identical hash:
canonicalHash({"revenue": 100, "profit": 20})
canonicalHash({"profit": 20, "revenue": 100})
// → "a3f8b9c..."
```

**Deduplication behavior:**

```typescript
// First save
const e1 = await evidenceStore.save({
  runId: "run_001",
  ticker: "BBCA",
  source: "sectors.company_report",
  data: companyReport
});
// → Creates new evidence, hash = "a3f8b9c..."

// Second save (same data, different run)
const e2 = await evidenceStore.save({
  runId: "run_002",  // Different run
  ticker: "BBCA",
  source: "sectors.company_report",
  data: companyReport // Same data
});
// → Returns existing evidence (e1.id === e2.id)
// → Both runs reference same evidence
```

**Benefits:**
- Save API calls (1500 point limit)
- Consistent evidence across runs
- Storage efficiency

---

### 08. Conversation Layer: Reasoning Arena

#### Purpose

**Conversation Store menjawab:** "Bagaimana agent sampai pada kesimpulan?"

Menyimpan natural language reasoning dari setiap agent, menciptakan audit trail yang human-readable.

#### Schema

```sql
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  
  agent TEXT NOT NULL CHECK(agent IN ('researcher', 'bull', 'bear', 'judge')),
  message_type TEXT NOT NULL CHECK(message_type IN (
    'observation', 'claim', 'challenge', 'response', 'decision'
  )),
  
  content TEXT NOT NULL,            -- Natural language reasoning
  evidence_ids TEXT NOT NULL,       -- JSON array of evidence IDs
  
  metadata TEXT,                    -- JSON (confidence, reasoning_chain)
  
  sequence_order INTEGER NOT NULL,  -- Order in conversation
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  UNIQUE(run_id, message_id)
);

CREATE INDEX idx_messages_run ON agent_messages(run_id);
CREATE INDEX idx_messages_sequence ON agent_messages(run_id, sequence_order);
CREATE INDEX idx_messages_agent ON agent_messages(agent);
```

#### Message Types

| Type | Agent | Ketersediaan | Description |
|------|-------|--------------|-------------|
| `observation` | Researcher | **Phase 0** | "I'm fetching Company Report..." |
| `claim` | Bull | **Phase 0** | "ROE 23.1% shows strong profitability..." |
| `decision` | Judge | **Phase 0** | "After considering both sides..." |
| `challenge` | Bear | Phase 1 (reserved) | "I disagree because..." |
| `response` | Bull | Phase 1 (reserved) | "Fair point. Let me check..." |

> Tipe `challenge`/`response` dan agent `bear` tetap **reserved di schema** (CHECK constraint tidak diubah) supaya Phase 1 tidak butuh migrasi — tapi Phase 0 tidak akan pernah menulisnya.

#### Operations

```typescript
interface ConversationStore {
  // Add message to conversation
  addMessage(params: {
    runId: string;
    messageId: string;
    agent: 'researcher' | 'bull' | 'bear' | 'judge';
    messageType: 'observation' | 'claim' | 'challenge' | 'response' | 'decision';
    content: string;
    evidenceIds: string[];
    sequenceOrder: number;
  }): Promise<void>;
  
  // Get full conversation (ordered)
  getByRun(runId: string): Promise<AgentMessage[]>;
  
  // Filter by agent
  getByAgent(runId: string, agent: string): Promise<AgentMessage[]>;
}
```

#### Example Conversation

```typescript
const conversation = await conversationStore.getByRun("run_001");

[
  {
    agent: "researcher",
    messageType: "observation",
    content: "I'm starting with Company Report and Quarterly Financials...",
    evidenceIds: [],
    sequenceOrder: 0
  },
  {
    agent: "bull",
    messageType: "claim",
    content: "ROE is at 23.1% and ROA at 3.4%. This shows BBCA still generates strong returns. Net income also grew 8.7% YoY...",
    evidenceIds: ["evidence_001", "evidence_002"],
    sequenceOrder: 1
  },
  {
    agent: "judge",
    messageType: "decision",
    content: "Bull presents consistent, evidence-backed signals on profitability and growth. No counterargument in this run (Bear = Phase 1). Overall: BULLISH.",
    evidenceIds: [],
    sequenceOrder: 2
  }
]
```

> Contoh conversation dengan Bear (challenge/response, sequence 2–3) ada di addendum v2.0 sebagai referensi Phase 1.

---

### 09. REPL: Interactive Harness

#### Entry Point

```bash
$ pnpm finharness

┌─────────────────────────────────────────────────┐
│  ⚡ Financial Agent Harness v0.1.0              │
│  Evidence-based stock research system           │
│  Type /help for available commands              │
└─────────────────────────────────────────────────┘

> 
```

#### REPL Loop

```typescript
async function replLoop() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
    completer: tabComplete // Autocomplete for slash commands
  });
  
  rl.prompt();
  
  for await (const line of rl) {
    try {
      // Parse input
      const parsed = parseInput(line);
      
      // Route to handler
      if (parsed.type === 'command') {
        await executeCommand(parsed.command, parsed.args);
      } else if (parsed.type === 'natural_language') {
        await handleNaturalLanguage(parsed.text);
      }
      
    } catch (error) {
      renderError(error);
    }
    
    rl.prompt();
  }
}
```

#### Input Parsing

```typescript
function parseInput(line: string): ParsedInput {
  // Slash command
  if (line.startsWith('/')) {
    const [command, ...args] = line.slice(1).split(' ');
    return {
      type: 'command',
      command,
      args
    };
  }
  
  // Natural language
  return {
    type: 'natural_language',
    text: line
  };
}
```

#### Tab Completion

```typescript
function tabComplete(line: string): [string[], string] {
  const commands = [
    '/judge',
    '/screen',
    '/challenge',
    '/compare',
    '/research',
    '/investigate',
    '/help',
    '/history',
    '/export',
    '/exit'
  ];
  
  const hits = commands.filter(cmd => cmd.startsWith(line));
  
  return [hits.length ? hits : commands, line];
}
```

#### Ctrl+C Handling

```typescript
rl.on('SIGINT', async () => {
  if (isExecuting) {
    // Cancel current task
    await cancelCurrentExecution();
    console.log('\n⚠️  Execution cancelled.');
    rl.prompt();
  } else {
    // Confirm exit
    const answer = await rl.question('Exit? (y/n) ');
    if (answer.toLowerCase() === 'y') {
      process.exit(0);
    } else {
      rl.prompt();
    }
  }
});
```

---

## Part III: Data Layer

### 10. SQLite: Embedded Database

#### Why SQLite (Not PostgreSQL for Phase 0)

| Criteria | SQLite | PostgreSQL |
|----------|--------|-----------|
| **Setup** | Zero-setup, embedded | Requires server/Docker |
| **Deployment** | Single file | Connection string, auth |
| **Portability** | Copy `~/.finharness/finharness.db` → works | Need dump/restore |
| **Latency** | In-process (microseconds) | Network round-trip (10-80ms) |
| **Dependencies** | Included with better-sqlite3 | External service |
| **Backup** | File copy | pg_dump |
| **Vector support** | sqlite-vec/sqlite-vss | pgvector (native) |

**Decision:** SQLite for Phase 0 (zero-setup), migrate to PostgreSQL Phase 3+ if needed.

**Catatan JSON1 (locked):** Semua kolom JSON (`data`, `evidence_ids`, `metadata`, `breakdown`) disimpan sebagai **TEXT berisi JSON** — SQLite tidak punya tipe JSONB. JSON1 sudah bundled di SQLite yang dikirim better-sqlite3 (SQLite ≥ 3.38; better-sqlite3 selalu compile dengan `SQLITE_ENABLE_JSON1`), jadi `json_extract()` dll. tersedia bila perlu. Verifikasi cepat saat setup: `SELECT json_valid('{"a":1}');` harus mengembalikan `1`. Jalur utama (save/read store) **tidak bergantung pada fungsi JSON1** — parsing dilakukan di aplikasi (Drizzle mapper) supaya migrasi ke PostgreSQL (JSONB) tidak menyentuh query.

**Abstraksi store (locked):** `EvidenceStore`, `ConversationStore`, `ExecutionStore` didefinisikan sebagai **interface murni** (lihat Operations §07/§08) tanpa tipe Drizzle di signature-nya. Implementasi konkret (`*StoreSqlite`, membungkus Drizzle) hidup di `packages/database`, dan konsumen (agent, workflow, CLI) hanya mengimpor interface. Migrasi ke PostgreSQL berarti menulis implementasi baru dari interface yang sama — agent/workflow tidak berubah.

#### Configuration

```typescript
// Database location
const DB_PATH = process.env.FINHARNESS_HOME 
  ? path.join(process.env.FINHARNESS_HOME, 'finharness.db')
  : path.join(os.homedir(), '.finharness', 'finharness.db');

// better-sqlite3 setup
const db = new Database(DB_PATH, {
  verbose: console.log // Development only
});

// Enable WAL mode (Write-Ahead Logging)
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
```

#### WAL Mode Benefits

**Write-Ahead Logging:**
- Readers don't block writers
- Writers don't block readers
- Better concurrency
- Crash-safe (append-only log)

**File structure:**
```
~/.finharness/
├── finharness.db        # Main database
├── finharness.db-wal    # Write-ahead log
└── finharness.db-shm    # Shared memory
```

---

### 11. Database Schema

#### Executions (Run Tracking)

```sql
CREATE TABLE executions (
  id TEXT PRIMARY KEY,              -- 'run_8f31...'
  ticker TEXT NOT NULL,
  command TEXT NOT NULL,            -- 'judge' | 'screen' | 'challenge'
  status TEXT NOT NULL              -- 'running' | 'completed' | 'failed'
    CHECK(status IN ('running', 'completed', 'failed')),
  
  execution_time REAL,              -- Seconds (NULL if running/failed)
  error TEXT,                       -- Error message (NULL if successful)
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX idx_executions_ticker ON executions(ticker);
CREATE INDEX idx_executions_status ON executions(status);
CREATE INDEX idx_executions_created ON executions(created_at DESC);
```

#### Evidence (Ground Truth)

```sql
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  
  ticker TEXT NOT NULL,
  source TEXT NOT NULL,
  source_type TEXT NOT NULL,
  
  content_hash TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  valid_at TEXT,
  
  data TEXT NOT NULL,               -- JSON text (SQLite: no JSONB; JSON1 functions available)
  provenance TEXT,
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  UNIQUE(content_hash)
);

CREATE INDEX idx_evidence_run ON evidence(run_id);
CREATE INDEX idx_evidence_ticker ON evidence(ticker);
CREATE INDEX idx_evidence_hash ON evidence(content_hash);
CREATE INDEX idx_evidence_source ON evidence(source, ticker);
```

#### Agent Messages (Conversation)

```sql
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  
  agent TEXT NOT NULL 
    CHECK(agent IN ('researcher', 'bull', 'bear', 'judge')),
  message_type TEXT NOT NULL 
    CHECK(message_type IN ('observation', 'claim', 'challenge', 'response', 'decision')),
  
  content TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,       -- JSON array
  
  metadata TEXT,                    -- JSON
  
  sequence_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  UNIQUE(run_id, message_id)
);

CREATE INDEX idx_messages_run ON agent_messages(run_id);
CREATE INDEX idx_messages_sequence ON agent_messages(run_id, sequence_order);
CREATE INDEX idx_messages_agent ON agent_messages(agent);
```

#### Claims (Structured Extraction)

```sql
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  message_id TEXT,                  -- FK to agent_messages (optional)
  
  claim_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence TEXT NOT NULL 
    CHECK(confidence IN ('strong', 'moderate', 'weak')),
  reasoning TEXT,
  evidence_ids TEXT NOT NULL,       -- JSON array, NOT empty
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  UNIQUE(run_id, claim_id)
);

CREATE INDEX idx_claims_run ON claims(run_id);
CREATE INDEX idx_claims_message ON claims(message_id);
```

#### Judgments (Final Evaluation)

```sql
CREATE TABLE judgments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  stance TEXT CHECK(stance IN ('bullish', 'bearish', 'neutral')),
  confidence TEXT CHECK(confidence IN ('high', 'moderate', 'low')),
  
  breakdown TEXT NOT NULL,          -- JSON: 5 kategori rubrik —
                                    -- {financialHealth, growth, valuation,
                                    --  marketMomentum, risk}
                                    -- Phase 0: marketMomentum & risk = null
                                    -- (butuh data Market yang belum di-fetch)
  summary TEXT,
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  UNIQUE(run_id)
);

CREATE INDEX idx_judgments_run ON judgments(run_id);
CREATE INDEX idx_judgments_ticker ON judgments(ticker);
CREATE INDEX idx_judgments_score ON judgments(score DESC);
```

---

### 12. File Structure

```
~/.finharness/
├── finharness.db               # SQLite database (WAL mode)
├── finharness.db-wal           # Write-ahead log
├── finharness.db-shm           # Shared memory
│
├── config.json                 # User configuration
│   ├── llm.agent.provider      # 'openai' | 'anthropic' — Tier 1 (Bull/Judge)
│   ├── llm.agent.model         # 'gpt-4o' | 'claude-3-5-sonnet'
│   ├── llm.agent.maxTokens     # Batas output agent (kontrol biaya, mis. 2000)
│   ├── llm.router.provider     # Tier 2 (Intent Router)
│   ├── llm.router.model        # 'gpt-4o-mini' | 'claude-3-haiku'
│   ├── llm.router.maxTokens    # Output router kecil (mis. 256)
│   ├── sectors_api_key
│   ├── auto_sync               # Boolean
│   └── mock_mode               # Boolean
│
├── cache/                      # API response cache
│   └── sectors_api/
│       ├── BBCA_company_report_2024-01-15.json
│       └── BBCA_quarterly_financials_2024-01-15.json
│
└── sessions/                   # Session history (optional, future)
    └── session_001.jsonl
```

#### Environment Variables

```bash
# Override data directory
export FINHARNESS_HOME=~/my-custom-path

# API keys (alternative to config.json)
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-...
export SECTORS_API_KEY=...

# Development flags
export FINHARNESS_MOCK_SECTORS=true
export FINHARNESS_DEBUG=true
```

#### config.json Example

```json
{
  "llm": {
    "agent": {
      "provider": "openai",
      "model": "gpt-4o",
      "temperature": 0.2,
      "maxTokens": 2000
    },
    "router": {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "temperature": 0.0,
      "maxTokens": 256
    }
  },
  "sectors_api": {
    "key": "your_api_key_here",
    "base_url": "https://api.sectors.app/v1",
    "cache_ttl_hours": 24
  },
  "features": {
    "auto_sync": false,
    "mock_mode": false
  }
}
```

> **Pemisahan config vs kredensial (kebijakan — diwujudkan dari pola DSH).** Nilai key mentah
> sedapat mungkin **tidak ditaruh di `config.json`**. Prioritas key: **env →
> `~/.finharness/.credentials.json` → config.json (legacy) → default**.
>
> `~/.finharness/.credentials.json` *(opsional; mode file `0600` dianjurkan)* hanya menyimpan key:
>
> ```json
> {
>   "sectors_api": { "key": "sk-..." },
>   "llm": { "agent": { "api_key": "sk-..." }, "router": { "api_key": "sk-..." } }
> }
> ```
>
> `config.json` kini difokuskan pada pengaturan non-secret (provider, model, `base_url`,
> cache TTL). `sectors_api.key` / `llm.*.api_key` tetap dibaca sebagai **fallback legacy**
> agar tidak breaking, tapi preferensi dipindah ke file credential; env (`SECTORS_API_KEY`,
> `LLM_API_KEY`) menggantikan keduanya (CI/headless). Alasan: `config.json` yang bersih aman
> di-screenshot/di-share untuk debug tanpa membawa key.

#### Referensi DeepSeek Harness (Kebijakan)

DSH dipakai sebagai **referensi pola, bukan kode yang disalin**: REPL loop, local-first data dir (`~/.dsh` → `~/.finharness`), append-only session log, content-addressed storage, credential handling (env + credential file, tidak pernah materialize ke proses). Jika nanti perlu membandingkan implementasi, salin hanya file terpilih (home-paths, session-persistence sqlite/jsonl, attachment-local) ke `reference/deepseek-harness/` untuk diselidiki — jangan seluruh monorepo DSH (web bundle, cordis, dll. tidak relevan untuk Phase 0).

---

### 13. Content-Addressed Storage

#### Canonical JSON Hashing

**Purpose:** Ensure identical data produces identical hash, regardless of key order.

```typescript
function canonicalHash(data: Record<string, any>): string {
  // 1. Sort keys recursively
  function sortKeys(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(sortKeys);
    }
    
    if (obj !== null && typeof obj === 'object') {
      return Object.keys(obj)
        .sort()
        .reduce((result, key) => {
          result[key] = sortKeys(obj[key]);
          return result;
        }, {} as any);
    }
    
    return obj;
  }
  
  // 2. Deterministic serialization
  const sorted = sortKeys(data);
  const json = JSON.stringify(sorted);
  
  // 3. SHA-256 hash
  const hash = crypto.createHash('sha256')
    .update(json, 'utf8')
    .digest('hex');
  
  return hash;
}
```

#### Deduplication Logic

```typescript
async function saveEvidence(params: {
  runId: string;
  ticker: string;
  source: string;
  data: Record<string, any>;
}): Promise<Evidence> {
  // Calculate canonical hash
  const contentHash = canonicalHash(params.data);
  
  // Check if evidence already exists
  const existing = await db
    .prepare('SELECT * FROM evidence WHERE content_hash = ?')
    .get(contentHash);
  
  if (existing) {
    // Evidence already exists, just link to current run
    // (No need to insert again due to UNIQUE constraint)
    return existing as Evidence;
  }
  
  // Insert new evidence
  const evidenceId = generateUUID();
  await db.prepare(`
    INSERT INTO evidence (id, run_id, ticker, source, source_type, content_hash, retrieved_at, data)
    VALUES (?, ?, ?, ?, 'api', ?, datetime('now'), ?)
  `).run(
    evidenceId,
    params.runId,
    params.ticker,
    params.source,
    contentHash,
    JSON.stringify(params.data)
  );
  
  return await getEvidenceById(evidenceId);
}
```

#### Cache Strategy

**Level 1: Content-hash dedup (automatic)**
- Same data → same hash → no duplicate in DB

**Level 2: Time-based cache (optional)**
```typescript
async function fetchCompanyReport(ticker: string): Promise<any> {
  // Check cache first
  const cacheKey = `${ticker}_company_report_${getToday()}`;
  const cached = await getCachedResponse(cacheKey);
  
  if (cached) {
    console.log('📦 Using cached data');
    return cached;
  }
  
  // Fetch from API
  const data = await sectorsAPI.getCompanyReport(ticker);
  
  // Save to cache
  await saveCachedResponse(cacheKey, data);
  
  return data;
}
```

**Benefits:**
- Save API calls (1500 point limit)
- Faster development iteration
- Consistent evidence across runs

---

## Part IV: Agent System

### 14. Multi-Agent Flow

#### Execution Graph

> **Phase 0 = 3-agent flow: Researcher → Bull → Judge.** Bear challenge & Bull rebuttal adalah langkah Phase 1 ("Debate ronde") dan TIDAK ADA di graf ini.

```
User Input: /judge BBCA
    ↓
1. Create Run (status = 'running')
    ↓
2. Researcher observes
    ├─→ Fetch Company Report
    │   → Save Evidence (evidence_001)
    └─→ Fetch Quarterly Financials
        → Save Evidence (evidence_002)
    ↓
3. Bull Agent analyzes
    ├─→ Input: evidenceIds [001, 002]
    ├─→ Output: {reasoning, claims[]}
    └─→ Save: Conversation + Claims
    ↓
4. Judge evaluates
    ├─→ Input: allClaims + conversation
    ├─→ Output: {judgment}
    └─→ Save: Conversation + Judgment
    ↓
5. Complete Run (status = 'completed')
    ↓
Render Output (Conversational)
```

#### Agent Responsibilities

| Agent | Input | Output | Responsibility |
|-------|-------|--------|----------------|
| **Researcher** | Ticker | Evidence IDs | Fetch & store raw data |
| **Bull** | Evidence IDs | Reasoning + Claims | Generate bullish thesis |
| **Judge** | All Claims + Conversation | Judgment | Final evaluation |

> **Phase 1 (Debate ronde):** Bear (challenge) dan Bull (rebuttal) disisipkan di antara Bull dan Judge — tidak mengubah interface agent lain.

---

### 15. Agent Design: Pure Functions

> **Catatan prompt (cache):** Semua prompt builder merakit evidence block lewat helper deterministik `renderEvidenceBlock()` (§17 · Token & Cache Strategy) dan menaruhnya di zona [1] prompt yang identik antar agent dalam satu run — bukan `JSON.stringify(e.data)` inline. Contoh kode di bawah sudah memakai helper tersebut.

#### Bull Agent

```typescript
class BullAgent {
  constructor(
    private llmClient: LLMClient,
    private evidenceStore: EvidenceStore
  ) {}
  
  async analyze(params: {
    ticker: string;
    evidenceIds: string[];
  }): Promise<BullAnalysisResponse> {
    // 1. Fetch evidence (read-only)
    const evidence = await this.evidenceStore.getManyByIds(params.evidenceIds);
    
    // 2. Build prompt with evidence context
    const prompt = this.buildAnalysisPrompt(params.ticker, evidence);
    
    // 3. Generate structured output
    const result = await this.llmClient.generateObject({
      schema: BullResponseSchema,
      prompt,
      system: BULL_SYSTEM_PROMPT
    });
    
    // 4. Return pure response (no DB writes)
    return {
      messageId: `bull_${Date.now()}`,
      reasoning: result.reasoning,
      claims: result.claims,
      evidenceIds: result.evidenceIds
    };
  }

  // NOTE: rebuttal({ ticker, evidenceIds, bearChallenges }) — Phase 1 (Debate ronde).
  // Polanya identik: fetch evidence → build prompt → generate → return pure response.
  
  private buildAnalysisPrompt(ticker: string, evidence: Evidence[]): string {
    return `
You are a bullish analyst evaluating ${ticker}.

Available evidence:
${renderEvidenceBlock(evidence)}

Analyze the evidence and provide:
1. Natural language reasoning explaining why ${ticker} is a good investment
2. Structured claims with evidence references

Requirements:
- Only reference evidence IDs provided above
- Each claim must cite specific evidence
- Explain your reasoning clearly
    `.trim();
  }
}
```

**System Prompt:**

```
You are Bull Agent, an optimistic financial analyst.

Your role:
- Find positive signals in the evidence
- Build bullish thesis with strong claims
- Reference specific evidence for each claim
- Explain reasoning in natural language

Output structure:
1. reasoning: Natural language explanation (2-3 paragraphs)
2. claims: Array of structured claims
   - statement: Clear assertion
   - confidence: strong | moderate | weak
   - evidenceIds: Array of evidence IDs that support this claim
   - reasoning: Brief justification

Rules:
- Only use evidence IDs provided in context
- Be optimistic but honest
- If evidence is mixed, acknowledge it but emphasize positives
```

#### Bear Agent (Phase 1 — referensi desain, tidak dieksekusi di Phase 0)

> **Keputusan terkunci:** Phase 0 memakai 3-agent flow (Researcher → Bull → Judge). Bear Agent TIDAK diimplementasikan di Phase 0 — desain di bawah dipertahankan utuh sebagai spesifikasi siap-eksekusi untuk Phase 1 ("Debate ronde").

```typescript
class BearAgent {
  constructor(
    private llmClient: LLMClient,
    private evidenceStore: EvidenceStore
  ) {}
  
  async challenge(params: {
    ticker: string;
    evidenceIds: string[];
    bullClaims: Claim[];
  }): Promise<BearChallengeResponse> {
    // 1. Fetch evidence
    const evidence = await this.evidenceStore.getManyByIds(params.evidenceIds);
    
    // 2. Build challenge prompt
    const prompt = this.buildChallengePrompt(
      params.ticker,
      params.bullClaims,
      evidence
    );
    
    // 3. Generate structured output
    const result = await this.llmClient.generateObject({
      schema: BearResponseSchema,
      prompt,
      system: BEAR_SYSTEM_PROMPT
    });
    
    // 4. Return pure response
    return {
      messageId: `bear_${Date.now()}`,
      reasoning: result.reasoning,
      counterpoints: result.counterpoints,
      evidenceIds: result.evidenceIds
    };
  }
  
  private buildChallengePrompt(
    ticker: string,
    bullClaims: Claim[],
    evidence: Evidence[]
  ): string {
    return `
You are a bearish analyst evaluating ${ticker}.

Bull Agent made the following claims:
${bullClaims.map((c, i) => `
${i + 1}. ${c.statement} (Confidence: ${c.confidence})
   Evidence: ${c.evidenceIds.join(', ')}
   Reasoning: ${c.reasoning}
`).join('\n')}

Available evidence:
${renderEvidenceBlock(evidence)}

Challenge the bull thesis:
1. Natural language reasoning explaining risks/concerns
2. Structured counterpoints targeting specific claims

Requirements:
- Point out weaknesses in bull's arguments
- Use evidence to support your challenges
- Be critical but fair
    `.trim();
  }
}
```

**System Prompt:**

```
You are Bear Agent, a skeptical financial analyst.

Your role:
- Find risks and weaknesses in bull's thesis
- Challenge claims with evidence-based counterarguments
- Point out missing data or alternative interpretations

Output structure:
1. reasoning: Natural language explanation (2-3 paragraphs)
2. counterpoints: Array of challenges
   - targetClaimId: Which bull claim you're challenging
   - argument: Your counterargument
   - strength: high | moderate | low

Rules:
- Focus on factual concerns, not just pessimism
- Use evidence to support your challenges
- If a claim is solid, acknowledge it but find nuance
```

#### Judge Agent

```typescript
class JudgeAgent {
  constructor(private llmClient: LLMClient) {}
  
  async evaluate(params: {
    ticker: string;
    claims: Claim[];
    conversation: AgentMessage[];
  }): Promise<Judgment> {
    // 1. Build evaluation prompt with full context
    const prompt = this.buildEvaluationPrompt(
      params.ticker,
      params.claims,
      params.conversation
    );
    
    // 2. Generate structured judgment
    const result = await this.llmClient.generateObject({
      schema: JudgmentSchema,
      prompt,
      system: JUDGE_SYSTEM_PROMPT
    });
    
    // 3. Return judgment
    return result;
  }
  
  private buildEvaluationPrompt(
    ticker: string,
    claims: Claim[],
    conversation: AgentMessage[]
  ): string {
    return `
You are Judge Agent, a neutral financial analyst.

Ticker: ${ticker}

Full conversation:
${conversation.map(m => `
${m.agent.toUpperCase()}: ${m.content}
`).join('\n')}

All claims:
${claims.map((c, i) => `
${i + 1}. ${c.statement} (${c.confidence})
   Evidence: ${c.evidenceIds.join(', ')}
`).join('\n')}

Evaluate and produce final judgment:
1. Score breakdown (0-100 per category)
2. Overall stance (bullish/bearish/neutral)
3. Confidence level
4. Summary explaining your decision

Scoring rubrik:
- Financial Health (25%): ROE, ROA, margins, balance sheet quality
- Growth (20%): Revenue & earnings growth consistency
- Valuation (20%): P/E, P/B relative to peers & historical
- Market Momentum (20%): Price performance, liquidity, trends
- Risk (15%): Volatility, concentration risk, negative sentiment

Phase 0 note: evidence yang tersedia hanya fundamental (Company Report,
Quarterly Financials). Market Momentum dan Risk TIDAK dievaluasi —
set keduanya ke null dan sebutkan di summary bahwa belum dinilai.
Overall score = weighted average dari kategori yang dinilai saja
(bobot direnormalisasi proporsional dari 25/20/20 atas total 65).
    `.trim();
  }
}
```

**System Prompt:**

```
You are Judge Agent, a neutral arbiter.

Your role:
- Evaluate all presented arguments fairly (Phase 0: hanya argumen Bull; Bear masuk Phase 1)
- Weigh evidence strength
- Produce balanced judgment with clear reasoning

Scoring rubrik (NON-NEGOTIABLE):
- Financial Health: 25%
- Growth: 20%
- Valuation: 20%
- Market Momentum: 20%
- Risk: 15%

Output structure:
{
  score: number (0-100),
  stance: "bullish" | "bearish" | "neutral",
  confidence: "high" | "moderate" | "low",
  breakdown: {
    financialHealth: number (0-100),
    growth: number (0-100),
    valuation: number (0-100),
    marketMomentum: number | null,   // null di Phase 0 (tidak ada data Market)
    risk: number | null              // null di Phase 0
  },
  summary: string (2-3 paragraphs)
}

Rules:
- Overall score = weighted average of breakdown
- Phase 0: momentum/risk null → renormalisasi bobot kategori tersisa
  (financialHealth 25/65 ≈ 38%, growth 20/65 ≈ 31%, valuation 20/65 ≈ 31%)
- Stance should align with score (>60 = bullish, <40 = bearish, else neutral)
- Acknowledge both strong and weak arguments
- Be clear about what tipped the balance
- Jika tidak ada argumen tandingan (Phase 0 tanpa Bear), nilai klaim
  Bull langsung terhadap evidence — jangan mengarang argumen lawan
```

---

### 16. Validation: Multi-Layer System

#### Three-Layer Validation

```typescript
class ClaimValidator {
  constructor(private evidenceStore: EvidenceStore) {}
  
  async validate(
    claims: Claim[],
    allowedEvidenceIds: string[]
  ): Promise<Claim[]> {
    // Layer 1: Structural validation (Zod)
    const parsed = ClaimSchema.array().parse(claims);
    
    // Layer 2: Evidence existence check (DB)
    const allEvidenceIds = [...new Set(
      parsed.flatMap(c => c.evidenceIds)
    )];
    
    const evidence = await this.evidenceStore.getManyByIds(allEvidenceIds);
    const existingIds = new Set(evidence.map(e => e.id));
    
    for (const evidenceId of allEvidenceIds) {
      if (!existingIds.has(evidenceId)) {
        throw new ValidationError(
          `Evidence ${evidenceId} does not exist in database`
        );
      }
    }
    
    // Layer 3: Run membership check
    for (const claim of parsed) {
      for (const evidenceId of claim.evidenceIds) {
        if (!allowedEvidenceIds.includes(evidenceId)) {
          throw new ValidationError(
            `Evidence ${evidenceId} not in allowed set for this run. ` +
            `Allowed: ${allowedEvidenceIds.join(', ')}`
          );
        }
      }
    }
    
    return parsed;
  }
}
```

#### Validation Layers Explained

**Layer 1: Zod Schema Validation**
- Type checking (string, number, enum)
- Required fields present
- Array not empty
- Format valid (UUIDs, etc)

```typescript
const ClaimSchema = z.object({
  claimId: z.string(),           // ↔ kolom claim_id di DB
  statement: z.string().min(10),
  confidence: z.enum(['strong', 'moderate', 'weak']),
  reasoning: z.string().min(20),
  evidenceIds: z.array(z.string().uuid()).min(1) // NOT empty
});
```

**Konvensi penamaan (locked):** DB memakai **snake_case** (`claim_id`, `message_id`, `evidence_ids`), TypeScript/Zod memakai **camelCase** (`claimId`, `messageId`, `evidenceIds`). Pemetaannya eksplisit di Drizzle schema: `claimId: text('claim_id')` — satu tempat saja (packages/database) yang tahu tentang dua konvensi ini, jadi tidak ada mapping manual yang tersebar.

**Layer 2: Evidence Existence**
- Check if evidence IDs exist in database
- Catch hallucinated IDs
- Ensure data integrity

**Layer 3: Run Membership**
- Ensure evidence belongs to current run
- Prevent cross-run contamination
- Maintain audit trail integrity

#### Error Messages

```typescript
// Layer 1 failure
throw new ValidationError(
  'Claim validation failed: evidenceIds must not be empty'
);

// Layer 2 failure
throw new ValidationError(
  'Evidence evidence_999 does not exist in database'
);

// Layer 3 failure
throw new ValidationError(
  'Evidence evidence_003 not in allowed set for this run. ' +
  'Allowed: evidence_001, evidence_002'
);
```

---

### 17. LLM Integration

#### Vercel AI SDK Wrapper

```typescript
import { generateObject, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

class LLMClient {
  private model: ReturnType<typeof openai> | ReturnType<typeof anthropic>;
  
  constructor(config: {
    provider: 'openai' | 'anthropic';
    model: string;
  }) {
    if (config.provider === 'openai') {
      this.model = openai(config.model);
    } else {
      this.model = anthropic(config.model);
    }
  }
  
  async generateObject<T>({
    schema,
    prompt,
    system,
  }: {
    schema: z.ZodSchema<T>;
    prompt: string;
    system?: string;
  }): Promise<T> {
    try {
      const { object } = await generateObject({
        model: this.model,
        schema,
        prompt,
        system,
        temperature: 0.2, // Low for consistency
      });
      
      return object;
    } catch (error) {
      // Retry logic
      if (isRetryableError(error)) {
        await sleep(1000);
        return this.generateObject({ schema, prompt, system });
      }
      throw error;
    }
  }
  
  async generateText({
    prompt,
    system,
  }: {
    prompt: string;
    system?: string;
  }): Promise<string> {
    const { text } = await generateText({
      model: this.model,
      prompt,
      system,
      temperature: 0.2,
    });
    
    return text;
  }
}
```

#### Model Configuration (Dua-Tier, Locked)

**Tier 1 — Agent berat** (Bull, Judge; Bear di Phase 1): model flagship untuk reasoning + structured output.
**Tier 2 — Router ringan** (Intent Router): model kecil, murah, cepat untuk klasifikasi. Keduanya eksplisit di config dengan `maxTokens` untuk kontrol biaya.

```typescript
// Dari config.json atau env — dua tier eksplisit
const config = {
  agent: {                                    // Tier 1: Bull / Judge
    provider: process.env.LLM_PROVIDER || 'openai',
    model: process.env.LLM_MODEL || 'gpt-4o',
    temperature: 0.2,
    maxTokens: 2000,                          // kontrol biaya per panggilan agent
  },
  router: {                                   // Tier 2: Intent Router
    provider: process.env.LLM_ROUTER_PROVIDER || process.env.LLM_PROVIDER || 'openai',
    model: process.env.LLM_ROUTER_MODEL || 'gpt-4o-mini',
    temperature: 0.0,
    maxTokens: 256,                           // output router kecil
  },
};

const agentLLM = new LLMClient(config.agent);
const routerLLM = new LLMClient(config.router);
```

`LLMClient.generateObject()`/`generateText()` menerima `maxTokens` dari config dan meneruskannya ke provider (Vercel AI SDK: parameter `maxTokens`).

**Recommended models:**

| Komponen | Tier | Model | Justification |
|-------|------|-------|---------------|
| Bull | 1 | GPT-4o or Claude 3.5 Sonnet | Strong reasoning, structured output |
| Judge | 1 | GPT-4o or Claude 3.5 Sonnet | Critical evaluation, balanced judgment |
| Intent Router | 2 | GPT-4o-mini or Claude 3 Haiku | Fast classification, cost-effective |
| Bear (Phase 1) | 1 | GPT-4o or Claude 3.5 Sonnet | Sama tier dengan Bull |

#### Token & Cache Strategy (Phase 0)

Payload evidence (Company Report + Quarterly Financials) bisa 10–30k+ token, dan tanpa strategi akan dikirim ulang penuh setiap panggilan yang mengonsumsinya. Aturan di bawah membuat panggilan berikutnya mendapat diskon cache provider — **tanpa komponen baru dan tanpa mengurangi fidelity evidence** (raw payload tetap dikirim).

**Aturan urutan prompt (untuk cache hit):**

```
[1] System: preamble umum + evidence block   ← identik antar agent dalam satu run
[2] Persona & instruksi agent + schema Zod    ← spesifik per agent
```

- Blok **[1] harus byte-identical** untuk semua panggilan agent yang mengonsumsi evidence. Dengan begitu, prefix [1] yang sudah ada di cache provider membuat panggilan berikutnya jauh lebih murah. Dampaknya per skenario:
  - **Retry** (retry logic di atas): panggilan ulang Bull → cache hit penuh di [1].
  - **Re-run** `/judge BBCA` dalam window TTL provider (skenario umum saat development) → cache hit.
  - **Phase 1 (Debate ronde):** Bear & Bull rebuttal juga mengonsumsi evidence yang sama → panggilan ke-2/3/4 dalam satu run mendapat diskon di [1].
  - Di Phase 0 Judge tidak mengonsumsi raw evidence (input-nya claims + conversation, kecil) — jadi penghematan Phase 0 datang dari retry/re-run; per-run multi-call baru terasa di Phase 1.

**Perilaku cache provider:**

| Provider | Mekanisme | Diskon | Catatan |
|---|---|---|---|
| OpenAI | Automatic prompt caching (prefix ≥ 1.024 token) | ±50% pada cached input | Aktif otomatis, TTL ±5–10 menit |
| Anthropic | Explicit `cache_control` breakpoint di akhir blok [1] | Cache write +25%, cache read −90% | TTL 5 menit, refresh saat hit; dikirim via AI SDK `providerOptions` |

**Helper deterministik (satu untuk semua agent):**

```typescript
// shared/prompt.ts — dipakai semua prompt builder (Bull sekarang; Bear & rebuttal Phase 1)
function renderEvidenceBlock(evidence: Evidence[]): string {
  // sortKeys dari §13 → urutan key deterministik → blok byte-identical
  return evidence.map(e =>
    `- Evidence ID: ${e.id}\n  Source: ${e.source}\n` +
    `  Data: ${JSON.stringify(sortKeys(e.data), null, 2)}`
  ).join('\n');
}
```

Dilarang menyuntik data yang berubah per panggilan (timestamp, `Date.now()`, ID acak) **sebelum atau di dalam** blok [1] — itu memutus cache prefix.

**Aturan pendukung:**
- **Schema ringkas:** AI SDK men-serialize schema Zod ke dalam prompt. Schema berbeda per agent sehingga posisinya di zona [2] — jaga tetap ramping (deskripsi pendek, tanpa enum besar).
- **Lintas-run:** dedup storage (§13) sudah menghemat API call; cache API lintas-run untuk evidence identik hanyalah bonus dalam window TTL provider — jangan dijadikan dependensi.
- **Backlog eksplisit (Phase 1+):** compact "evidence pack" per sumber (proyeksi metrik ringkas, potensi hemat 3–10× token input) hanya boleh dibuat jika **deterministik dan versioned provenance**-nya jelas, supaya audit trail evidence-first tetap utuh.
- Penghematan yang sudah ter-lock di dokumen ini: model routing dua-tier + `maxTokens` (§17), file cache TTL 24h (§13), dan mock mode untuk development (§12).

---

## Part V: User Experience

### 18. REPL Commands

#### Core Commands (Phase 0)

**`/judge [TICKER]`**
- Full analysis: Researcher → Bull → Judge (3-agent flow, Phase 0)
- Evidence-first flow
- Conversational output

```bash
> /judge BBCA

🔍 RESEARCHER
  Starting with Company Report and Quarterly Financials...
  
🐂 BULL
  ROE 23.1% shows strong profitability...
  
⚖️ JUDGE
  Score: 72/100 · BULLISH
```

**`/screen [CRITERIA]`**
- Screen stocks by criteria
- Historical pattern analysis (not predictions)
- Ranking by criteria match

```bash
> /screen profitable growing

Screening stocks: profitable + growing

Results:
1. BBCA (80/100) - ROE 23.1%, Growth 8.7%
2. BBRI (75/100) - ROE 20.3%, Growth 7.2%
3. BMRI (70/100) - ROE 18.5%, Growth 6.1%

[View details: /judge BBCA]
```

**`/help`**
- Show available commands
- Usage examples

```bash
> /help

Financial Agent Harness Commands

Core:
  /judge [TICKER]      Full analysis (Researcher → Bull → Judge)
  /screen [CRITERIA]   Screen stocks by criteria
  /help                Show this help
  /exit                Exit harness

Roadmap (coming soon):
  /challenge [CLAIM]   Test specific claim
  /compare [TICKERS]   Compare multiple stocks
  /research [TICKER]   Raw research without judgment

Natural Language:
  You can also ask questions naturally:
  > "Saham apa yang konsisten tumbuh?"
  > "Apakah BBCA layak dibeli?"

Tips:
  - Press Tab for autocomplete
  - Press Ctrl+C to cancel current task
  - Use /history to see past sessions
```

**`/exit`**
- Exit harness gracefully
- Save session (optional)

```bash
> /exit

Goodbye! 👋
```

#### Roadmap Commands (Stubs)

**`/challenge [CLAIM]`**
```bash
> /challenge "BBCA overvalued?"

⚠️  /challenge is in active development.

For now, you can:
- Use /judge BBCA to see full analysis
- Ask natural language: "Is BBCA overvalued?"

See roadmap: https://github.com/finharness/roadmap
```

**`/compare [TICKERS]`**
**`/research [TICKER]`**
**`/investigate [TICKER]`**

Similar stub behavior dengan roadmap link.

---

### 19. CLI Output: Conversational

#### Rich Text Output

```bash
> /judge BBCA

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FINANCIAL AGENT HARNESS
  BBCA · Multi-Agent Analysis
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔍 RESEARCHER
  I'm starting with Company Report and Quarterly Financials
  to understand BBCA's fundamentals.

  ✓ Company Report retrieved
  ✓ Quarterly Financials retrieved

  Evidence: evidence_a1b2c3d4, evidence_e5f6g7h8

────────────────────────────────────────────────────────

🐂 BULL AGENT
  I see several positive signals from this data.

  ROE is at 23.1% and ROA at 3.4%. This shows BBCA still
  generates strong returns relative to its asset and equity
  base.

  Additionally, the bank maintains healthy margins across
  core business segments, and Quarterly Financials show
  net income growing 8.7% YoY — profitability pairs with
  positive earnings growth.

  → Claim #1 (Strong)
    "Profitability remains strong."
    Evidence: evidence_a1b2c3d4

  → Claim #2 (Moderate)
    "Earnings growth remains positive."
    Evidence: evidence_e5f6g7h8

────────────────────────────────────────────────────────

⚖️ JUDGE
  I see two evidence-backed claims:

  Bull:
    • ROE 23.1%, ROA 3.4% (strong profitability)
    • Earnings growth 8.7% YoY (moderate growth)

  No counterargument was presented in this run — Phase 0
  does not include the Bear agent (Debate ronde → Phase 1).
  I weigh each claim directly against the evidence, and I
  note that Market Momentum and Risk are not evaluated
  in this phase.

  → Decision: BULLISH

────────────────────────────────────────────────────────

             BBCA · FINAL JUDGMENT

  Score       72 / 100
  Stance      BULLISH
  Confidence  MODERATE

  Breakdown:
    Financial Health    80 / 100
    Growth              65 / 100
    Valuation           70 / 100
    Market Momentum     --       (not evaluated in Phase 0)
    Risk                --       (not evaluated in Phase 0)

  Summary:
  BBCA demonstrates strong profitability with ROE 23.1%
  and positive earnings growth of 8.7% YoY. While valuation
  is reasonable relative to peers, the overall financial
  health and growth trajectory support a bullish stance
  with moderate confidence.

  Run ID      run_2024_001
  Time        12.3s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[View evidence: /evidence run_2024_001]
[Export: /export run_2024_001 --json]

> 
```

#### Color Scheme

| Element | Color | Icon |
|---------|-------|------|
| Researcher | Blue | 🔍 |
| Bull | Green | 🐂 |
| Judge | Yellow | ⚖️ |
| Evidence ID | Dim Gray | `evidence_xxx` |
| Strong Claim | Bold Green | ✓ |
| Weak Claim | Dim Yellow | ~ |
| Error | Red | ✗ |
| Bear *(Phase 1, reserved)* | Red | 🐻 |

---

### 20. Natural Language Input

#### Intent Router (L1)

```typescript
class IntentRouter {
  constructor(private llmClient: LLMClient) {}
  
  async route(input: string): Promise<RoutedIntent> {
    const result = await this.llmClient.generateObject({
      schema: IntentSchema,
      prompt: input,
      system: INTENT_ROUTER_SYSTEM_PROMPT
    });
    
    if (result.confidence < 0.7) {
      // Fallback: ask for clarification
      return {
        type: 'clarification',
        question: `Do you mean:
a) /judge ${result.ticker || 'TICKER'}
b) /screen ${result.criteria || 'CRITERIA'}
c) Something else?`
      };
    }
    
    return result;
  }
}
```

**Intent Schema:**

```typescript
const IntentSchema = z.object({
  type: z.enum(['judge', 'screen', 'challenge', 'compare', 'clarification']),
  confidence: z.number().min(0).max(1),
  
  // Extracted parameters
  ticker: z.string().optional(),
  criteria: z.string().optional(),
  claim: z.string().optional(),
  
  // Clarification question (if confidence < threshold)
  question: z.string().optional()
});
```

**System Prompt:**

```
You are Intent Router for Financial Agent Harness.

Your job: Classify user input into one of these commands:
- judge: Evaluate a specific ticker (Bull + Judge analysis)
- screen: Find stocks matching criteria
- challenge: Test a specific claim
- compare: Compare multiple tickers
- clarification: Ask for clarification if ambiguous

Examples:
"Apakah BBCA layak dibeli?" → judge (ticker=BBCA)
"Saham apa yang konsisten tumbuh?" → screen (criteria="growing")
"Is BBCA overvalued?" → challenge (claim="BBCA overvalued")
"BBCA vs BBRI" → compare (tickers=["BBCA", "BBRI"])

Output confidence (0-1). If <0.7, set type='clarification' with question.
```

#### Natural Language Examples

```bash
> Apakah BBCA layak dibeli?
  ↳ Routing to /judge BBCA...

> Saham apa yang konsisten tumbuh?
  ↳ Routing to /screen "consistent growth"...

> Is BBCA really growing?
  ↳ Routing to /challenge "BBCA growing"... (stub)

> BBCA dibandingkan BBRI
  ↳ Routing to /compare BBCA BBRI... (stub)

> Ambiguous input...
  ⚠️  Not sure what you mean. Did you mean:
  a) /judge TICKER
  b) /screen CRITERIA
  c) Something else?
  
  > a
  Which ticker?
  > BBCA
  ↳ Routing to /judge BBCA...
```

---

### 21. Error Handling & Recovery

#### User-Friendly Error Messages

```typescript
class UserFriendlyError extends Error {
  constructor(
    public code: string,
    public message: string,
    public suggestion: string
  ) {
    super(message);
  }
}

// Examples:

throw new UserFriendlyError(
  'INVALID_TICKER',
  'Ticker "XYZ" not found',
  'Try: /judge BBCA (or other valid ticker)'
);

throw new UserFriendlyError(
  'API_TIMEOUT',
  'Sectors API timed out after 30s',
  'Try again or use --mock-sectors for development'
);

throw new UserFriendlyError(
  'EVIDENCE_HALLUCINATION',
  'Agent referenced non-existent evidence: evidence_999',
  'This is a bug. Please report with run_id: run_001'
);
```

#### Error Rendering

```bash
> /judge XYZ

✗ Error: INVALID_TICKER

Ticker "XYZ" not found in Sectors API.

Suggestion:
Try: /judge BBCA (or other valid ticker)

> 
```

#### Graceful Degradation

```typescript
async function judgeWorkflow(ticker: string) {
  const runId = await createRun(ticker, 'judge');
  
  try {
    // Fetch evidence
    const evidence = await fetchEvidence(ticker);
    const evidenceIds = evidence.map(e => e.id);
    
    // Run agents (Phase 0: 3-agent flow — tanpa Bear)
    const bull = await bullAgent.analyze({ evidenceIds });
    const judge = await judgeAgent.evaluate({
      claims: bull.claims,
      conversation: await conversationStore.getByRun(runId)
    });
    
    // Complete run
    await completeRun(runId);
    
    return { runId, judgment: judge };
    
  } catch (error) {
    // Mark run as failed
    await failRun(runId, error.message);
    
    // User-friendly error
    throw new UserFriendlyError(
      error.code || 'UNKNOWN_ERROR',
      error.message,
      'Check logs or retry'
    );
  }
}
```

#### Retry Logic (LLM)

```typescript
async function generateWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      if (isRetryableError(error)) {
        const delay = Math.pow(2, i) * 1000; // Exponential backoff
        console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
        await sleep(delay);
      } else {
        throw error; // Non-retryable error
      }
    }
  }
}

function isRetryableError(error: any): boolean {
  return (
    error.code === 'RATE_LIMIT' ||
    error.code === 'TIMEOUT' ||
    error.code === 'SERVER_ERROR'
  );
}
```

---

## Part VI: Implementation

### 22. Tech Stack (Final)

| Layer | Technology | Version | Justification |
|-------|-----------|---------|---------------|
| **Runtime** | Node.js | 22+ | Modern, better-sqlite3 compatible |
| **Language** | TypeScript | 5+ | Type safety, developer experience |
| **Entry Point** | Custom REPL | - | Full control over UX |
| **Database** | SQLite (better-sqlite3) | 12+ | Zero-setup, embedded, file-based |
| **Storage** | ~/.finharness/ | - | User data directory (DSH-inspired) |
| **Monorepo** | pnpm workspace | 8+ | Fast, efficient, single lockfile |
| **LLM** | Vercel AI SDK | 4+ | Provider abstraction, structured output |
| **Validation** | Zod | 3+ | Type-safe schemas, runtime validation |
| **Testing** | Vitest | 2+ | Fast, Vite-compatible |
| **ORM** | Drizzle ORM | 0.36+ | Type-safe, lightweight, SQLite support |

### 23. Monorepo Structure

```
finharness-sectors.app/
├── apps/
│   └── cli/                          # Interactive REPL
│       ├── src/
│       │   ├── index.ts              # Entry point (pnpm finharness)
│       │   ├── repl/
│       │   │   ├── loop.ts           # REPL loop
│       │   │   ├── parser.ts         # Input parsing
│       │   │   └── renderer.ts       # Output rendering
│       │   ├── commands/
│       │   │   ├── judge.ts          # /judge command
│       │   │   ├── screen.ts         # /screen command
│       │   │   ├── help.ts           # /help command
│       │   │   └── index.ts
│       │   ├── workflows/
│       │   │   ├── judgeWorkflow.ts  # Judge orchestration
│       │   │   └── screenWorkflow.ts # Screen orchestration
│       │   └── config.ts             # Load config.json
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── schemas/                      # Zod schemas (shared)
│   │   ├── src/
│   │   │   ├── evidence.ts
│   │   │   ├── claim.ts
│   │   │   ├── judgment.ts
│   │   │   ├── message.ts
│   │   │   ├── intent.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── sectors-api/                  # Type-safe Sectors API client
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── endpoints/
│   │   │   │   ├── companyReport.ts
│   │   │   │   ├── quarterlyFinancials.ts
│   │   │   │   └── companyScreener.ts
│   │   │   ├── cache.ts
│   │   │   ├── mock.ts               # Mock data for --mock-sectors
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── database/                     # SQLite database layer
│   │   ├── src/
│   │   │   ├── client.ts             # better-sqlite3 setup
│   │   │   ├── schema.ts             # Drizzle schema
│   │   │   ├── migrations/
│   │   │   │   ├── 0001_initial.sql
│   │   │   │   └── migrate.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── evidence/                     # Evidence Store
│   │   ├── src/
│   │   │   ├── store.ts              # EvidenceStore class
│   │   │   ├── hash.ts               # Canonical hashing
│   │   │   ├── validator.ts          # Evidence validation
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── conversation/                 # Conversation Store
│   │   ├── src/
│   │   │   ├── store.ts              # ConversationStore class
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── llm/                          # LLM client abstraction
│   │   ├── src/
│   │   │   ├── client.ts             # Vercel AI SDK wrapper
│   │   │   ├── config.ts             # Provider config
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── agent/                        # Agents (pure functions)
│   │   ├── src/
│   │   │   ├── bull.ts               # Bull Agent
│   │   │   ├── judge.ts              # Judge Agent
│   │   │   ├── bear.ts               # Bear Agent (Phase 1 — file stub, tidak dieksekusi Phase 0)
│   │   │   ├── router.ts             # Intent Router
│   │   │   ├── prompts/
│   │   │   │   ├── bull.ts
│   │   │   │   ├── judge.ts
│   │   │   │   ├── bear.ts           # (Phase 1)
│   │   │   │   └── router.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── execution/                    # Execution & persistence
│   │   ├── src/
│   │   │   ├── executionStore.ts     # ExecutionRun CRUD
│   │   │   ├── claimStore.ts         # Claim persistence
│   │   │   ├── judgmentStore.ts      # Judgment persistence
│   │   │   ├── claimValidator.ts     # Multi-layer validation
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── shared/                       # Utils & types
│       ├── src/
│       │   ├── logger.ts
│       │   ├── errors.ts
│       │   ├── constants.ts
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
│
├── planning/                         # Design docs
│   ├── addendum_v1.md
│   ├── addendum_v1.1.md
│   ├── addendum_v1.2.md
│   ├── addendum_v2.0.md
│   └── addendum_v3.0.md              # This document (v3.1 revisi konsistensi)
│
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

---

### 24. Phase 0 Scope

#### What's IN Scope (MVP)

✅ **Interactive REPL**
- Entry point: `pnpm finharness`
- Command parsing (`/command args`)
- Tab completion
- History (up/down arrows)
- Ctrl+C handling
- Graceful exit

✅ **Core Commands**
- `/judge [TICKER]` - Full 3-agent analysis (Researcher → Bull → Judge)
- `/screen [CRITERIA]` - Screen stocks by criteria
- `/help` - Show available commands
- `/exit` - Exit harness

✅ **Natural Language**
- Intent Router L1 (LLM classification)
- Route NL → `/judge` or `/screen`
- Fallback clarification

✅ **Evidence-First Architecture**
- Evidence Store (SQLite)
- Canonical hash dedup
- Run-scoped validation
- Content-addressed storage

✅ **Multi-Agent System (3 agent, locked)**
- Researcher (fetch & store evidence — bagian dari workflow)
- Bull Agent (analyze)
- Judge Agent (evaluate, rubrik 5 kategori — momentum/risk null)
- Pure functions (no DB writes)

✅ **Conversation Layer**
- Agent messages stored
- Natural language reasoning
- Sequence ordering
- Linked to evidence

✅ **SQLite Database**
- Embedded (zero-setup)
- WAL mode
- ~/.finharness/ data dir
- Drizzle ORM

✅ **Sectors API Integration**
- Company Report
- Quarterly Financials
- Company Screener
- Cache + dedup
- `--mock-sectors` flag

✅ **CLI Output**
- Conversational (🔍 🐂 ⚖️)
- Color-coded
- Progress indicators
- Evidence references visible

#### What's OUT of Scope (Post-MVP)

❌ **Bear Agent + Bull rebuttal** (Debate ronde) → Phase 1  
❌ **Market Researcher** (Daily Transaction, Foreign Flow) → Phase 1 *(spec §24-A)*  
❌ **News Researcher** (News, Filings, Sentiment) → Phase 1 *(spec §24-A)*  
❌ **Debate ronde 2** (conditional continuation) → Phase 1  
❌ **GUI (Tauri)** → Phase 4  
❌ **Workflow abstraction** (LangGraph) → Phase 3  
❌ **pgvector / semantic search** → Future  
❌ **Normalized financial tables** → Future  
❌ **Agent Configurator** (custom composition) → Phase 2+  
❌ **Session save/resume** → Phase 2  
❌ **Streaming output** (real-time messages) → Phase 2  
❌ **Export formats** (PDF, HTML) → Phase 2  

---

### 24-A. Phase 1 · Market & News Researcher — Kontrak Data & Desain

> **Status:** Spesifikasi siap-eksekusi (lock-in kontrak data & desain). Bagian
> ini adalah pelengkap Phase 1 yang mengonversi domain data yang hanya disebut
> namanya di §27 menjadi keputusan desain yang dapat dieksekusi. Implementasinya
> berjalan langsung di atas kode Phase 0 + Debate ronde — **tanpa migrasi schema
> DB** (evidence memakai kolom `data` JSON yang sudah ada).

#### 24-A.1 Tujuan & Batas

Menambahkan dua kelompok **Researcher non-LLM** (pola sama dengan Researcher
fundamental, §06) yang menyediakan **evidence** Market & News bagi agent LLM:

- **Market Researcher** → evidence yang memungkinkan kategori rubrik **`marketMomentum`** (20%).
- **News Researcher** → evidence yang memungkinkan kategori rubrik **`risk`** (15%).

**Mekanisme jembatan (penting, lihat §24-A.5):** rubrik dinilai oleh Judge dari
**klaim yang masuk debat**, bukan dari evidence mentah langsung (pola Phase 0:
Judge hanya terima `claims` + `conversation`). Jadi evidence Market/News
**mengaktifkan** momentum & risk **melalui klaim Bull/Bear yang merujuk evidence
tersebut** — bukan dengan mengubah kontrak Judge.

**Prinsip yang TIDAK berubah (non-negotiable):**

- Bobot rubrik tetap `financialHealth 25 · growth 20 · valuation 20 ·
  marketMomentum 20 · risk 15` (`packages/shared/src/rubric.ts`). Data Market/News
  **hanya mengaktifkan** kategori `marketMomentum` & `risk` (sebelumnya selalu `null`
  karena data belum di-fetch), sehingga renormalisasi `normalizeJudgmentScore`
  bergeser dari "atas 65" (3 kategori) ke "atas 100" (5 kategori) — rumus tetap,
  tidak ada perubahan kode rubric.
- Researcher = **bukan LLM** (prinsip 6, §04): pure fetch → simpan evidence.
  Agent LLM (Bull/Bear/Judge) tetap konsumen evidence via `evidenceIds`.
- Evidence-first (§04.1): Bull/Bear/Judge hanya boleh menerima `evidenceIds[]`,
  tidak pernah `data` mentah langsung.
- Prompt cache zone §17 tetap: evidence block Market/News ikut zona [1] (byte-identical),
  dipertahankan di span terpisah setelah evidence fundamental.

#### 24-A.2 Kontrak Endpoint Sectors API

Ditambahkan ke interface murni `SectorsApi` (`packages/sectors-api/src/types.ts`)
dan implementasi `SectorsClient`/`MockSectorsApi` (`client.ts`, `mock.ts`). Kontrak
HTTP riil (path, query, field) **diverifikasi terhadap dokumentasi API saat
implementasi** — pola sama dengan Deviasi #3 (endpoint fundamental dikunci di
client.ts, satu tempat yang disentuh bila API berubah). Nama & struktur di bawah
adalah kontrak logis yang menjadi dasar tipe & mock.

```ts
interface SectorsApi {
  // …existing…
  getCompanyReport(ticker: string): Promise<CompanyReport>;
  getQuarterlyFinancials(ticker: string): Promise<QuarterlyFinancials>;
  screen(criteria: string[]): Promise<ScreenerResult[]>;

  // —— Market Researcher (Phase 1) ——
  getDailyTransaction(ticker: string): Promise<DailyTransaction>;
  getForeignFlow(ticker: string): Promise<ForeignFlow>;

  // —— News Researcher (Phase 1) ——
  getNews(ticker: string): Promise<NewsArticle[]>;
  getFilings(ticker: string): Promise<Filing[]>;
  getSentiment(ticker: string): Promise<Sentiment>;
}
```

Semua endpoint baru **di-cache file** (TTL 24 jam, §13) — kecuali **`getNews`** yang
sifatnya semi-volatil dan diberi TTL lebih pendek (default **1 jam**) agar artikel
tidak basi; TTL per-source diatur lewat `cache_ttl_hours` config (lihat 24-A.6).

#### 24-A.3 Skema Evidence Market

Definisi tipe di `packages/sectors-api/src/types.ts`. Nama `source` evidence =
`sectors.daily_transaction` / `sectors.foreign_flow` (ditambah ke `SECTORS_SOURCES`).

```ts
/** Daily Transaction — likuiditas & aktivitas perdagangan (addendum §27 "Daily Transaction"). */
export interface DailyTransaction {
  ticker: string;
  /** UTC ISO. */
  asOf: string;
  /** Rentang agregasi, mis. "30d". */
  window: string;
  /** Rata-rata nilai transaksi harian, dalam miliar (IDR). */
  avgValueBillion?: number;
  /** Volume relatif vs rata-rata 3 bulan (>1 = di atas normal), tanpa satuan. */
  volumeRatio?: number;
  /** Persentase hari tutup di atas harga pembukaan dalam window, 0–100. */
  upDaysPct?: number;
  /** Rata-rata pergerakan harga absolut harian, %. */
  avgIntradayVolatilityPct?: number;
  /** NULL bila tidak tersedia — menghindari ramalan kosong. */
  liquidityBand?: 'high' | 'moderate' | 'low';
}

/** Foreign Flow — arah aliran dana asing (addendum §27 "Foreign Flow"). */
export interface ForeignFlow {
  ticker: string;
  asOf: string;
  window: string;
  /** Flow kumulatif asing relatif terhadap kapitalisasi, %. */
  netForeignPctOfCap?: number;
  /** Sinyal bersih: net beli / net jual / netral. */
  netFlow?: 'buy' | 'sell' | 'neutral';
  /** Proporsi jumlah hari net buy asing dalam window, 0–100. */
  netBuyDaysPct?: number;
}
```

#### 24-A.4 Skema Evidence News

Tipe di `packages/sectors-api/src/types.ts`. Sources: `sectors.news`,
`sectors.filings`, `sectors.sentiment`.

```ts
/** Satu artikel/laporan berita. */
export interface NewsArticle {
  /** ID unik sumber (untuk dedup content-hash cross-run). */
  id: string;
  ticker: string;
  headline: string;
  /** URL sumber. */
  url?: string;
  publishedAt: string; // ISO
  /** Ringkas — untuk zona [1], baca lanjutan di evidence `data`. */
  snippet: string;
  /** Klasifikasi sentimen isi berita. */
  sentiment?: 'positive' | 'negative' | 'neutral';
  /** Sumber berita (mis. "Reuters"). */
  source?: string;
}

/** Filing regulator (annual report, disclosure dst.). */
export interface Filing {
  id: string;
  ticker: string;
  /** Jenis filing, mis. "annual_report", "disclosure", "related_party". */
  type: string;
  title: string;
  filedAt: string; // ISO
  url?: string;
}

/** Skor sentimen agregat suatu ticker pada periode tertentu. */
export interface Sentiment {
  ticker: string;
  asOf: string;
  window: string;
  /** Skor agregat -1..1 (negatif = bearish, positif = bullish). */
  aggregate?: number;
  /** Proporsi artikel positif / negatif / netral, masing-masing 0..1. */
  distribution?: { positive: number; negative: number; neutral: number };
  /** Jumlah artikel yang diproses. */
  articleCount?: number;
}
```

Catatan dedup: `NewsArticle`/`Filing` diberi `id` sumber agar **content-hash
(material dari `data` canonical JSON)** tetap unik per artikel — dua run yang
menarik artikel sama akan men-dedup ke evidence yang sama (keunggulan content-
addressed, §13).

#### 24-A.5 Jembatan evidence → breakdown (keputusan terkunci)

Rubrik hanya berbicara skor 0–100 per kategori; Judge menilai breakdown dari
**`claims` + `conversation`** (kontrak Judge TIDAK berubah — Phase 0). Data
Market/News masuk ke breakdown lewat rantai berikut:

1. Workflow menambahkan evidence Market & News ke `allowedEvidenceIds` run.
2. **Bull** melihat evidence Market (momentum) & News (sentimen/risk) di zona [1]
   dan menyusun klaim yang mencakup momentum & risk (mis. "likuiditas tinggi +
   `netFlow: buy` mendukung momentum"). **Bear** menantang tesis dengan data yang
   sama (mis. "distribusi sentimen negatif tinggi merisiko"). Klaim ini **wajib
   merujuk evidence Market/News** — ditegakkan `ClaimValidator` (allowed set kini
   mencakup market/news; klaim tidak boleh merujuk evidence asing, §16).
3. **Judge** menilai breakdown **5 kategori penuh** dari seluruh klaim (Bull +
   rebuttal) + conversation debat. Saat klaim momentum/risk hadir & tervalidasi,
   `marketMomentum` & `risk` bisa `non-null`. Kode tetap memaksa
   `normalizeJudgmentScore` (renorm ke 100 bila kelima kategori non-null) dan
   `stanceForScore` — deterministik di luar LLM (§4 ARCHITECTURE).

**Degradasi bertingkat:** bila salah satu sumber Market/News gagal (timeout,
`NOT_FOUND`) saat eksekusi, kategori yang bergantung padanya tetap `null` (renorm
ke bobot tersisa), run **tetap `completed`** dengan catatan di summary Judge
("market/news data unavailable") — bukan `failed` (selaras §21 graceful
degradation). Hanya kegagalan **researcher fundamental** yang membuat run `failed`.

#### 24-A.6 Konfigurasi

`config.json` (dibaca `apps/cli/src/config.ts`) — ekstensi **baru** terhadap bentuk
existing (§12): `sectors_api.cache_ttl_hours` sudah ada; `news_cache_ttl_hours`,
`features.market_researcher`, dan `features.news_researcher` adalah field tambahan
(hanya dibaca bila ada):

```json
{
  "sectors_api": {
    "cache_ttl_hours": 24,
    "news_cache_ttl_hours": 1
  },
  "features": { "market_researcher": true, "news_researcher": false }
}
```

Default: **keduanya aktif** untuk `/judge`. `news_researcher: false` mematikan
News & Sentiment (hemat titik API untuk pengguna tanpa kuota news). TTL news
(`news_cache_ttl_hours`) meneruskan ke `SectorsClient` sebagai TTL khusus
endpoint `sectors.news`.

#### 24-A.7 Task Breakdown (lanjutan Phase 1)

> Memakai konvensi penomoran lanjutan (tidak menyentuh Task 1–20 yang selesai).

**Task 21: Gate & Kontrak Endpoint**
Setup interface `SectorsApi` + tipe Market/News (§24-A.2–4), `SECTORS_SOURCES`,
perluasan `MockSectorsApi` dengan fixture deterministik (BBCA likuid & sentimen
positif; BJTM likuiditas rendah — supaya rubrik momentum/risk bisa dibuktikan).
Demo: fetch mock DailyTransaction/ForeignFlow/News/Sentiment untuk BBCA.

**Task 22: Client HTTP + Cache**
Implementasi endpoint di `SectorsClient` memakai `cached()` existing (TTL khusus
news). Test: mock 404/rate-limit menyentuh alur error baru, cache hit mengurangi
panggilan, news TTL lebih pendek.

**Task 23: Flow /judge diperluas**
Di `apps/cli/src/workflows/judgeWorkflow.ts`, setelah researcher fundamental:
  1. Researcher market → simpan evidence (source `sectors.daily_transaction`,
     `sectors.foreign_flow`).
  2. Researcher news (bila aktif) → simpan evidence (`sectors.news`,
     `sectors.filings`, `sectors.sentiment`).
  3. `allowedEvidenceIds` = gabungan fundamental + market + news.
  4. Bull → Bear → Bull rebuttal → Judge melihat seluruh evidence.
Test: E2E memverifikasi breakdown momentum/risk non-null saat mock menyediakan
kedua grup.

**Task 24: Prompt Agent & Mock LLM**
- `buildEvidenceZone` perlu menerima kelompok evidence (fundamental/market/news)
  tetap dalam satu zona [1] byte-identical (span dipisah label, tanpa data volatil).
- `MockLLMClient`: pembacaan evidence Market → breakdown momentum/risk riil dari
  fixture (mis. netFlow buy → momentum tinggi; negative distribution besar → risk
  tinggi), konsisten & Zod-valid. Update test mock LLM.

**Task 25: Rubrik & degradasi**
Pastikan `normalizeJudgmentScore` bekerja pada breakdown 5 kategori penuh (renorm
atas 100) dan degradasi parsial (3/4 kategori). Test: breakdown penuh → skor =
Σ wᵢsᵢ/100; satu sumber gagal → kategori tetap null, run completed.

**Task 26: Renderer & error**
`renderer.ts`: tampilkan baris momentum & risk (hapus label "not evaluated"),
tambahkan catatan "market/news unavailable" bila null. `UserFriendlyError` untuk
kegagalan news (code `NEWS_UNAVAILABLE`) vs fundamental (`NOT_FOUND`) agar pesan
ramah & tepat.

#### 24-A.8 Success Criteria (Phase 1 · Researcher)

- `/judge BBCA` offline (mock) menghasilkan breakdown **5 kategori non-null**.
- Evidence Market/News tersimpan di `evidence` dengan `source` benar & dedup
  content-hash (dua run artikel sama → satu baris evidence).
- TTL news (1 jam) ≠ TTL fundamental (24 jam), dibuktikan test cache.
- Kegagalan News tidak menggagalkan run; hanya fundamental yang gagal → `failed`.
- `pnpm check` lulus (typecheck + seluruh unit/E2E).

---

### 24-B. Pola Disiplin (Adaptasi DeepSeek Harness)

> Asal: review pola `deepseek-harness/`. **Bukan** menyalin kode — diambil **tiga
> pola disiplin** (invariant logging, replay fixture, fail-closed) dan diadaptasi
> ke data model & filosofi FinHarness. Tanpa dependency baru. Bentuk DSH
> (web bundle, Cordis, arsitektur plugin) tidak cocok diadopsi; skill-registry &
> worker-thread hanya **dicatat sebagai referensi roadmap** (§24-B.4), bukan
> fitur Phase 0/1 (belum ada consumer nyata — lihat prinsip "membuang doubt, bukan
> fitur", AGENTS.md).

#### 24-B.1 Invariant runtime "yang dilihat = yang dicatat" (§04.1 / §16)

**Masalah yang ditutup:** di implementasi saat ini, `agent_messages.evidence_ids`
mencatat **`bull.evidenceIds` / `bear.evidenceIds`** — yaitu ID yang *diklaim* LLM
dipakai (keluaran `generateObject`). Yang **benar-benar dilihat** LLM adalah evidence
block di zona [1], yang di-render dari **`params.evidenceIds`** (allowed set run).
Dua hal itu **bukan** jaminan sama: LLM bisa mereferensikan subset evidence klaimnya,
atau (bug) merender evidence yang tidak konsisten dengan yang dilihat. Audit trail
kita mencatat "yang diklaim", bukan "yang dilihat" — celah terhadap klaim
auditability kita sendiri (§07).

**Keputusan terkunci (invariant runtime, bukan konvensi):**

1. **`agent_messages.metadata.seenEvidenceIds`** = mutlak *byte-identical* dengan
   evidence block yang dikirim ke LLM (yaitu `params.evidenceIds` yang di-fetch &
   di-render untuk pesan itu), disimpan **oleh workflow** (bukan agent) saat persist
   pesan Bull/Bear (sequence 1–3). Bukan `evidence_ids` (kolom yang merekam klaim
   LLM) — keduanya dipertahankan, yang pertama untuk audit "dilihat", yang kedua
   untuk "diklaim".
2. **Assertion di `JudgeAgent`/`BullAgent`** (di lapisan workflow, setelah persist):
   buktikan bahwa **setiap `claim.evidenceIds` ⊆ `seenEvidenceIds`** pesan yang
   menghasilkan klaim itu, serta untuk Bear: **`bear.evidenceIds ⊆ seenEvidenceIds`**.
   Bila melanggar → **lempar error** (`EVIDENCE_HALLUCINATION`, §21), **bukan** log
   warning. `ClaimValidator` Layer 3 sudah memaksa klaim ⊆ allowed set run; assertion
   ini memaksa klaim ⊆ *evidence yang benar-benar dikirim pesan itu* — lapisan lebih
   ketat (allowed set bisa punya evidence yang tidak dirender untuk pesan tertentu).
3. Catatan: assertion ini tidak menuntut `claim.evidenceIds == seenEvidenceIds`
   (LLM boleh pakai subset); hanya menuntut **inklusi**. Kemudahan penyebaran ke
   `MockLLMClient` (harus selalu subset-valid) agar mock tidak melanggar invariant.

**Dampak implementasi:** `JudgeArtifacts`/workflow menambah simpan `seenEvidenceIds`;
satu helper deterministik (mis. `assertSeenEvidence(claims, seen)` di
`packages/execution`) yang dipakai validator & test. Tanpa migrasi DB (`metadata`
sudah JSON TEXT).

#### 24-B.2 Replay fixture "keyless" untuk integration/E2E (Task 19 · §24-A.7)

**Prinsip:** satu fixture nyata dipakai **ganda** — sebagai input mock **dan** sebagai
expected snapshot. Drift logika langsung terlihat sebagai diff, tanpa API key di CI.

**Sinkron dengan desain kita:** `MockLLMClient` saat ini **generatif** (membangun
klaim dari angka evidence riil zona [1]) — ini *lebih kuat* daripada replay naif
karena menguji konten, bukan sekadar mereplay. Maka:

- **Mock generatif dipertahankan** sebagai perilaku `MockLLMClient` (unit test).
- **Replay fixture ditambahkan di lapisan integration/E2E** (Task 19): rekam **satu
  run `/judge BBCA` offline** (evidence + conversation 5 pesan + judgment) menjadi
  satu file fixture yang berperan ganda:
  - *driver* mock (bila mode `--replay` dipakai), dan
  - *expected snapshot* yang dibandingkan setelah run.
  Drift apa pun (urutan pesan, evidenceIds, skor renormalisasi) muncul sebagai diff,
  tanpa API key di CI.
- **Mode `record` / `replay` / `refresh`** sebagai satu flag:
  - `record` → jalankan dan tulis fixture;
  - `replay` → jalankan mock dari fixture + bandingkan hasil ke snapshot fixture;
  - `refresh` → tulis ulang snapshot (re-baseline sadar, bukan silent).
  Default CI memakai `replay` sehingga deterministik.

**Batasan (jangan over-engineer):** fixture ini **pelengkap**, bukan pengganti mock
generatif maupun E2E mock-mode yang sudah ada. Menambahnya di scope Task 19 (Catatan
Implementasi), tidak memerlukan tahap baru.

#### 24-B.3 Fail-closed untuk jaminan integritas, silent-degrade untuk enrichment (§16 / §21)

**Garis pemisah (keputusan terkunci):**

- **Enrichment opsional** (Market/News Researcher, §24-A.5): bila sumber gagal →
  kategori rubrik terkait `null`, run **tetap `completed`** dengan catatan. Ini
  benar: data tsb memperkaya, bukan penjamin integritas.
- **Jaminan integritas (fail-closed):** kalau **eksekusi** validasi gagal menjalankan
  cek (bukan "data tidak lolos", tapi "pengecekan tidak bisa dilakukan" — mis. `Catch`
  DB error / timeout saat `evidenceStore.getManyByIds` di Layer 2, atau pembacaan
  status store gagal), maka **run harus `failed`** — **tidak pernah** lanjut tanpa
  validasi, tidak pernah beralih ke "asumsikan lolos".

**Catatan §16/§21 yang dipertegas:**

- `ClaimValidator` Layer 2/3 **tidak menelan error eksekusi**: kegagalan DB/network
  saat cek eksistensi/keanggotaan di-map ke `UserFriendlyError` (mis. code
  `VALIDATION_UNAVAILABLE`) dan **membuat run `failed`** (via `failRun`, §21).
- Bedakan dua makna "validasi" di seluruh kode & dokumentasi:
  - **gagal validasi** (claim tidak lolos) → `EVIDENCE_HALLUCINATION`; dan
  - **gagal mengeksekusi validasi** (infra/DB) → fail run, jangan diterjemahkan
    diam-diam menjadi "lolos".
- Aturan ini berlaku untuk `validate` dan `validateChallenge` (§24-A) pun.

#### 24-B.4 Catatan roadmap (referensi pola DSH — bukan fitur sekarang)

Dua pola DSH lain yang disebut pada review **tidak** diadopsi di Phase 0/1 karena
belum ada consumer nyata (`AGENTS.md` · "membuang doubt, bukan fitur"):

| Pola DSH | Untuk apa | Status |
|---|---|---|
| Skill-registry ringan (registri kemampuan agent, bukan plugin penuh) | **Agent Configurator** (Phase 2+, §27) — memilih & merekam kemampuan agent | Dicatat sebagai referensi desain Phase 2; tidak diadopsi sekarang |
| Worker-thread untuk cancellation REPL | **Streaming / cancel-asli** (Phase 2, §27) — Node tidak bisa mem-batalkan fetch/AI call berjalan (Deviasi #8) | Dicatat sebagai referensi desain; fase saat ini memakai batas-fase best-effort |

Keduanya hanya **referensi desain** yang ditarik saat fase tsb dimulai, bukan
spesifikasi kontrak di dokumen ini.

---

### 25. Task Breakdown

#### Task 1: Project Scaffolding
**Objective:** Setup monorepo with pnpm workspace

**Implementation:**
- Create `pnpm-workspace.yaml`
- Initialize all packages with `package.json`
- Setup TypeScript configs (root + per-package extends)
- Configure .env.example
- Add root scripts (build, test, cli, db:migrate)

**Demo:** `pnpm install` succeeds, `pnpm --filter @harness/cli dev` shows structure

---

#### Task 2: SQLite Database Layer
**Objective:** Setup embedded database with Drizzle ORM

**Implementation:**
- Install better-sqlite3
- Create database client (WAL mode)
- Write Drizzle schema (executions, evidence, messages, claims, judgments)
- Create migration scripts
- Setup `~/.finharness/` directory

**Test:**
- DB created automatically on first run
- WAL mode enabled
- Foreign keys enforced

**Demo:** `pnpm db:migrate` creates tables, queries work

---

#### Task 3: Evidence Store
**Objective:** Implement content-addressed evidence storage

**Implementation:**
- `canonicalHash()` function (recursive key sorting)
- `EvidenceStore` class (save, getManyByIds, getByTicker, getByRun)
- Deduplication logic (UNIQUE constraint on content_hash)
- Tests (dedup, retrieval, run linkage)

**Test:**
- Save same data twice → single evidence row
- Both runs reference same evidence
- Canonical hash identical for key-reordered JSON

**Demo:** Save evidence, verify dedup works

---

#### Task 4: Conversation Store
**Objective:** Store agent messages with sequence ordering

**Implementation:**
- `ConversationStore` class (addMessage, getByRun, getByAgent)
- Schema enforcement (agent, message_type enums)
- Sequence ordering

**Test:**
- Add messages out of order → retrieve ordered by sequence
- Filter by agent works

**Demo:** Seed conversation, query shows correct flow

---

#### Task 5: Execution Store
**Objective:** Track run lifecycle

**Implementation:**
- `ExecutionStore` class (createRun, completeRun, failRun, getRun)
- Status state machine (running → completed/failed)

**Test:**
- Create run → status = 'running'
- Complete run → status + completed_at
- Fail run → error stored

**Demo:** Create/complete/fail runs, verify states

---

#### Task 6: Sectors API Client
**Objective:** Type-safe API client with cache

**Implementation:**
- Base client with fetch wrapper
- Endpoints: getCompanyReport, getQuarterlyFinancials, companyScreener
- Cache layer (file-based, TTL 24h)
- `--mock-sectors` flag (fixture JSON)
- Error handling (rate limit, timeout, 404)

**Test:**
- Mock successful response
- Mock 404, rate limit errors
- Cache hit reduces API calls

**Demo:** Fetch BBCA data (or mock), log to console

---

#### Task 7: Zod Schemas
**Objective:** Type-safe schemas for all data structures

**Implementation:**
- `EvidenceSchema`, `ClaimSchema`, `JudgmentSchema`, `AgentMessageSchema`, `IntentSchema`
- Export from `@harness/schemas`

**Test:**
- Valid data passes
- Invalid data throws Zod error

**Demo:** Validate sample data, show errors

---

#### Task 8: Claim Validator
**Objective:** Multi-layer claim validation

**Implementation:**
- `ClaimValidator` class
  - Layer 1: Zod structural
  - Layer 2: Evidence existence (DB)
  - Layer 3: Run membership (allowedEvidenceIds)
- Tests for each layer

**Test:**
- Valid claim → passes
- Hallucinated evidence → Layer 2 error
- Out-of-scope evidence → Layer 3 error

**Demo:** Validate claim with `evidence_999` → error message

---

#### Task 9: LLM Client
**Objective:** Wrap Vercel AI SDK with structured output

**Implementation:**
- `LLMClient` class
  - `generateObject<T>()` with Zod schema
  - `generateText()`
  - Provider config (OpenAI/Anthropic from env)
  - Retry logic (exponential backoff)

**Test:**
- Generate object matching schema
- Retry on transient error

**Demo:** Generate claim from prompt, verify type-safe

---

#### Task 10: Bull Agent
**Objective:** Pure agent generating bullish thesis

**Implementation:**
- `BullAgent` class
  - `analyze({ ticker, evidenceIds })` → BullAnalysisResponse
  - (rebuttal — Phase 1, interface mengikuti pola yang sama)
- System prompt (optimistic, evidence-based)
- Tests with mocked LLM + evidence

**Test:**
- Analyze with 2 evidence → 3 claims
- All claims reference valid evidence
- Reasoning is natural language

**Demo:** Run Bull on sample evidence, print output

---

#### Task 11: Bear Agent — **DEFERRED → Phase 1**

> Tidak dieksekusi di Phase 0 (keputusan terkunci: 3-agent flow). Desain lengkap ada di §15 sebagai spesifikasi siap-eksekusi Phase 1. Yang tetap divalidasi di Phase 0: schema `agent_messages` sudah reserved untuk tipe `challenge`/`response` dan agent `bear`, sehingga Phase 1 tidak butuh migrasi.

**Spec referensi (Phase 1):**
- `BearAgent` class
  - `challenge({ bullClaims, evidenceIds })` → BearChallengeResponse
- System prompt (skeptical, evidence-based)
- Tests with mocked LLM

---

#### Task 12: Judge Agent
**Objective:** Pure agent producing final judgment

**Implementation:**
- `JudgeAgent` class
  - `evaluate({ claims, conversation })` → Judgment
- Scoring rubrik 5 kategori (25% financial health, 20% growth, 20% valuation, 20% momentum, 15% risk) — Phase 0: `marketMomentum` & `risk` = null, overall score dinormalisasi ulang dari 3 kategori tersisa
- System prompt (neutral, balanced)
- Tests with sample claims

**Test:**
- Evaluate claims → judgment with score breakdown
- Score 0-100, stance aligns with score

**Demo:** Run Judge on conversation, print judgment

---

#### Task 13: Intent Router
**Objective:** Route natural language to commands

**Implementation:**
- `IntentRouter` class
  - `route(input)` → RoutedIntent
  - LLM classification (L1)
  - Confidence threshold (0.7)
  - Fallback clarification
- Tests with sample inputs

**Test:**
- "Apakah BBCA layak dibeli?" → judge (BBCA)
- "Saham konsisten tumbuh?" → screen
- Ambiguous input → clarification

**Demo:** Route various NL inputs, verify accuracy

---

#### Task 14: Judge Workflow
**Objective:** Orchestrate full /judge execution

**Implementation:**
- `judgeWorkflow(ticker)` function
  1. Create run
  2. Fetch evidence (Company Report, Quarterly Financials)
  3. Save evidence
  4. Bull analyze
  5. Judge evaluate
  6. Complete run
- Error handling (mark run as failed)
- Tests with mocks

**Test:**
- Full workflow → all artifacts persisted
- Error handling → run marked failed

**Demo:** Run workflow for BBCA, verify DB state

---

#### Task 15: Screen Workflow
**Objective:** Implement /screen command

**Implementation:**
- `screenWorkflow(criteria)` function
  1. Parse criteria (profitable, growing, etc)
  2. Call Company Screener API
  3. Rank results
  4. Save to DB (optional)
- Reframing output (historical patterns, not predictions)
- Tests with mocks

**Test:**
- Screen "profitable" → filtered tickers
- Ranking by criteria match

**Demo:** Screen command, verify output

---

#### Task 16: REPL Core
**Objective:** Interactive loop with command parsing

**Implementation:**
- `replLoop()` function
  - Readline interface
  - Tab completion (slash commands)
  - History (up/down arrows)
  - Ctrl+C handling (cancel task, not exit)
- `parseInput()` function (command vs NL)
- `executeCommand()` dispatcher
- `handleNaturalLanguage()` via Intent Router

**Test:**
- Parse slash command → structured
- Parse NL → calls Intent Router
- Tab completion works
- Ctrl+C cancels task

**Demo:** Interactive session, test all inputs

---

#### Task 17: Command Implementations
**Objective:** Wire commands to workflows

**Implementation:**
- `/judge [TICKER]` → judgeWorkflow → render conversational output
- `/screen [CRITERIA]` → screenWorkflow → render list
- `/help` → print help text
- `/exit` → graceful exit
- Command stubs (`/challenge`, `/compare`, etc) → roadmap message

**Test:**
- Each command executes correctly
- Stubs show roadmap link

**Demo:** Run each command, verify output

---

#### Task 18: CLI Rendering
**Objective:** Conversational output with colors

**Implementation:**
- `renderConversation()` function
  - Agent icons (🔍 🐂 ⚖️ — 🐻 reserved untuk Phase 1)
  - Color-coded sections
  - Evidence IDs visible
  - Formatted judgment
- Progress indicators during execution
- Error rendering (user-friendly)

**Test:**
- Render full conversation → matches design
- Colors correct per agent

**Demo:** Full `/judge` output, visually appealing

---

#### Task 19: Integration Testing
**Objective:** End-to-end tests with real DB

**Implementation:**
- E2E test: full REPL session
  - Start REPL
  - Execute `/judge BBCA`
  - Verify DB state
  - Check output
- Error scenarios (API timeout, invalid ticker, hallucinated evidence)
- Performance test (execution time <30s target)

**Test:**
- All E2E tests pass
- Error handling works

**Demo:** Run test suite, show coverage

---

#### Task 20: Documentation & Polish
**Objective:** Complete docs and final touches

**Implementation:**
- README.md (setup, usage, architecture)
- ARCHITECTURE.md (detailed design)
- Code comments (JSDoc for public APIs)
- Error messages polished
- Config.json documentation
- .env.example complete

**Test:**
- Docs accurate and complete

**Demo:** Walk through README, verify commands work

---

### 26. Success Criteria

Phase 0 is **COMPLETE** when:

✅ **REPL Functional**
- `pnpm finharness` opens interactive session
- Prompt displays correctly
- Tab completion works for slash commands
- History (up/down arrows) works
- Ctrl+C cancels task without exiting

✅ **Core Commands Work**
- `/judge BBCA` executes full workflow
- Conversational output with agent personas (🔍 🐂 ⚖️)
- Evidence IDs visible and traceable
- `/screen "profitable"` returns filtered tickers
- `/help` shows available commands
- `/exit` exits gracefully

✅ **Natural Language Input**
- "Apakah BBCA layak dibeli?" routes to `/judge BBCA`
- "Saham apa yang konsisten tumbuh?" routes to `/screen`
- Ambiguous input asks for clarification

✅ **Evidence-First Architecture**
- All claims reference valid evidence IDs
- Evidence stored with canonical hash dedup
- Run-scoped validation enforces membership
- Content-addressed storage works

✅ **Multi-Agent System (3 agent)**
- Researcher fetches & stores evidence
- Bull generates bullish thesis + claims
- Judge evaluates with 5-category scoring rubrik (momentum/risk = null di Phase 0)
- All agents are pure functions (no DB writes)

✅ **Conversation Layer**
- Agent messages stored with sequence order
- Natural language reasoning captured
- Full conversation retrievable by run_id

✅ **Database**
- SQLite DB created automatically in `~/.finharness/`
- WAL mode enabled
- All artifacts linked to run_id
- Foreign keys enforced

✅ **Validation**
- Claim validation rejects hallucinated evidence
- Claim validation rejects out-of-scope evidence
- Zod structural validation works

✅ **Error Handling**
- User-friendly error messages
- Run marked 'failed' on error
- Graceful degradation (no crashes)

✅ **Testing**
- All unit tests pass
- Integration tests pass
- E2E test passes

✅ **Documentation**
- README complete with setup instructions
- ARCHITECTURE.md explains design
- Code comments for public APIs
- .env.example documented

✅ **Code Quality**
- Zero TypeScript errors (strict mode)
- No console.error in production code
- Consistent code style

---

## Part VII: Roadmap & Vision

### 27. Phase Roadmap

| Phase | Focus | Key Deliverables | Status |
|-------|-------|------------------|--------|
| **Phase 0** | Interactive REPL + Evidence-First | `/judge`, `/screen`, NL input, SQLite embedded | **READY** |
| **Phase 1** | Expand Researchers + Debate | Bear Agent + Bull rebuttal (built), Market Researcher, News Researcher | Spec'd (§24-A) |
| **Phase 2** | Advanced Features | Session save/resume, streaming output, export formats | Designed |
| **Phase 3** | Orchestration Upgrade | Evaluate LangGraph, conditional workflows | TBD |
| **Phase 4** | GUI (Tauri) | Desktop app with live reasoning arena | Designed |
| **Future** | Vector Search & Semantic | pgvector, semantic evidence retrieval, normalized tables | Concept |

---

### 28. GUI Vision

#### Desktop App (Tauri - Phase 4)

```
┌─────────────────────────────────────────────────────────┐
│ BBCA                              RUN #8F31     ● LIVE  │
├───────────────┬───────────────────────────┬─────────────┤
│               │                           │             │
│ AGENTS        │      AGENT DEBATE         │  EVIDENCE   │
│               │                           │             │
│ 🧑 Researcher │ 🐂 BULL                   │ E-001       │
│ ✓ Completed   │                           │ Company     │
│               │ ROE 23.1% looks strong... │ Report      │
│ 🐂 Bull       │                           │ [View]      │
│ ✓ Completed   │ 🐻 BEAR                   │             │
│               │                           │ E-002       │
│ 🐻 Bear       │ I disagree because...     │ Quarterly   │
│ ✓ Completed   │                           │ Financials  │
│               │ 🐂 BULL                   │ [View]      │
│ ⚖ Judge       │                           │             │
│ ● Thinking    │ Fair point. I checked...  │             │
│               │                           │             │
│               │ ⚖ JUDGE                  │             │
│               │ ● Evaluating...           │             │
│               │                           │             │
└───────────────┴───────────────────────────┴─────────────┘
```

**Features:**
- **Left Panel**: Agent status (real-time state transitions)
- **Center Panel**: Conversation stream (live updates)
- **Right Panel**: Evidence browser (clickable, show raw data)
- **Replay Mode**: Load saved session, replay with timing
- **Export**: PDF, HTML, JSON

**Technical:**
- Tauri shell (Rust for native)
- React/Svelte frontend
- WebSocket/SSE for live updates
- Read SQLite DB directly (no backend needed)

---

### 29. Deployment Strategy

#### For Developers (Current)

```bash
# Clone repo
git clone https://github.com/finharness/finharness.git
cd finharness

# Install dependencies
pnpm install

# Setup config
cp .env.example .env
# Edit .env with API keys

# Run migrations
pnpm db:migrate

# Start REPL
pnpm finharness
```

**Distribution:**
- GitHub repo (open source)
- npm package (`npm install -g finharness`)
- Homebrew formula (`brew install finharness`)

#### For End Users (Future)

**Desktop App (Tauri):**
- macOS: `.dmg` installer
- Windows: `.exe` installer
- Linux: `.AppImage`

**Setup wizard:**
1. Welcome screen
2. API key input (Sectors, OpenAI/Anthropic)
3. Default preferences
4. Ready to use

**No technical knowledge required:**
- No CLI
- No database setup
- No configuration files
- Just install & run

---

### 30. Conclusion

**Financial Agent Harness v3.0** adalah interactive REPL system untuk riset dan evaluasi saham dengan arsitektur yang:

1. **Evidence-First**: Setiap klaim tertaut ke ground truth yang dapat ditelusuri
2. **Conversation Layer**: User memahami proses reasoning, bukan hanya hasil
3. **Local-First**: Zero-setup dengan embedded SQLite
4. **Multi-Agent**: Bull thesis dievaluasi Judge dengan rubrik eksplisit; Bear debate menyusul di Phase 1
5. **Developer-Friendly**: Pure functions, type-safe, well-tested

**Diferensiasi:**
- Bukan chatbot → reasoning arena
- Bukan dashboard → dialog reasoning yang dapat diaudit
- Bukan web app → CLI developer-tool

**Ready for Implementation:**
- Architecture locked
- Tech stack finalized
- Task breakdown complete
- Success criteria clear

**Next Step:**
Switch to execution agent untuk implementasi Phase 0.

---

**END OF ADDENDUM V3.1 FINAL**

Dokumen ini adalah spesifikasi lengkap dan final untuk Financial Agent Harness — mengkonsolidasikan seluruh keputusan arsitektur dari diskusi intensif, termasuk revisi konsistensi v3.1 (3-agent flow Phase 0, breakdown 5 kategori dengan momentum/risk nullable, model routing dua-tier + maxTokens, normalisasi penamaan DB ↔ TS, kebijakan referensi DSH). Ready for execution.