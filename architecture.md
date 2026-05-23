# BugBuddy — Comprehensive System Architecture & Data Flow

BugBuddy utilizes a highly distributed, decoupled architecture spanning a **Chrome Extension (Content Script, Background Service Worker, SidePanel)**, a **Fastify Backend API Server**, a **PostgreSQL Database**, and **External Enterprise Integrations (Jira, Slack, Azure DevOps)**.

Below is the structured architectural blueprint detailing the end-to-end data transmission lifecycle from user event capture to developer triage.

---

## 1. High-Level Architecture Diagram

```mermaid
graph TD
    classDef client fill:#1e293b,stroke:#475569,stroke-width:2px,color:#f8fafc;
    classDef extension fill:#312e81,stroke:#6366f1,stroke-width:2px,color:#f8fafc;
    classDef backend fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#f8fafc;
    classDef database fill:#7c2d12,stroke:#f97316,stroke-width:2px,color:#f8fafc;
    classDef external fill:#581c87,stroke:#a855f7,stroke-width:2px,color:#f8fafc;

    subgraph Client Browser ["Target Webpage Context"]
        A["User Actions (Click, Keystroke, Navigate)"]:::client
        B["Content Script (content/index.ts)"]:::client
        C["Chrome Debugger Protocol (CDP)"]:::client
    end

    subgraph Chrome Extension Workspace ["BugBuddy Extension Context"]
        E["Background Worker (background/index.ts)"]:::extension
        D["SidePanel UI (sidepanel/SidePanel.tsx)"]:::extension
        F["Interactive HTML / PDF Export"]:::extension
    end

    subgraph BugBuddy Backend ["Server Infrastructure"]
        G["Fastify API Ingestion Server"]:::backend
        J["Integrations Hub"]:::backend
        N["Web Dashboard (React/Next.js)"]:::backend
    end

    subgraph Storage ["Persistence Layer"]
        I[("PostgreSQL Database")]:::database
    end

    subgraph Integrations ["External Ticketing & Alerts"]
        K["Jira Service Desk"]:::external
        L["Azure DevOps Boards"]:::external
        M["Slack Workspace"]:::external
    end

    %% Data flow mapping
    A -->|1. Event Triggers & Screen Captures| B
    B -->|2. Local / Session Storage Snapshot [PII Redacted]| D
    A -->|3. DOM User Interactions| E
    C -->|4a. Console Logs & Unhandled Rejections| E
    C -->|4b. Network Payloads [50KB Response Cap]| E
    E -->|5. In-Memory Session Buffer BufferData| D
    
    D -->|6a. Self-contained Offline Triage Package| F
    D -->|6b. Structured JSON Payload| G
    
    G -->|7. Schema Verification [Zod Validate]| I
    G -->|8. Sync Pipeline Triggers| J
    
    J -->|9a. Create Issue ticket| K
    J -->|9b. Log Work Item| L
    J -->|9c. Send Alerts to #bugs channel| M
    
    I -->|10. Query Bug Log Logs & Snapshots| N
    N -->|11. Triage & Replicate| O["Developer Workspace"]:::client
```

---

## 2. End-to-End Data Pipeline Lifecycle

### Phase 1: Real-Time Event & Diagnostic Capture
When a QA or developer triggers a recording session, BugBuddy activates multiple synchronous ingestion lanes:
1. **User Interaction Hooks:** The extension captures interactions (clicks, keyboard strokes, input state transitions) and automatically takes screenshot crops.
2. **Tab Debugger Attachment:** The **Background Service Worker** registers with the `chrome.debugger` API, binding to two key domains:
   - **`Runtime`:** Captures `console.log`, `console.error`, and uncaught promise exceptions immediately.
   - **`Network`:** Captures request metadata and streams response bodies via `getResponseBody`. Payloads are capped at `50KB` to prevent system latency.
3. **Storage Snapshot Extraction:** When a user stops the recording and prepares to submit a report, the content script extracts the tab's `localStorage` and `sessionStorage`. It sweeps all keys against a security pattern list (redacting potential authorization tokens, keys, and credentials) client-side before transport.

### Phase 2: Client-Side Assembly & Submission
In the **SidePanel React App**:
1. The user inputs **Expected Result**, **Actual Result**, **Description**, and **Severity**.
2. All logs (Buffer arrays from background, sanitized storage string, and user inputs) are packed into a single comprehensive diagnostic object.
3. The user selects an export mechanism:
   - **Offline Mode:** Generates a standalone, double-pane responsive HTML dashboard with an embedded sidebar using CSS grid, anchors, and client-side user-agent parsing (OS, browser, resolution), allowing immediate download.
   - **Online Mode:** Dispatches a structured HTTPS POST request containing the diagnostic payload to the backend service.

### Phase 3: Server Ingestion & Synchronization
Upon reaching the **Fastify API Server**:
1. **Zod Validation:** The server parses the request against `CreateBugSchema`, enforcing strong type constraints.
2. **Database Persistence:** The structured payload is unpacked and stored in the PostgreSQL database.
3. **Third-Party Dispatches:** If configured, the integrations controller transforms the schema:
   - **Jira:** Dispatches a ticket request, establishing priority and attaching reference metadata.
   - **Azure DevOps:** Provisions work items inside specified projects.
   - **Slack:** Broadcasts a warning block to channels like `#bugs` detailing the issue with immediate links to the triage dashboard.

### Phase 4: Developer Triage
1. The developer opens the **BugBuddy Web Dashboard**.
2. The UI queries the PostgreSQL backend for the recorded logs.
3. The timeline, storage states, network flows, and console parameters are reconstructed, enabling developers to pinpoint root causes without diagnostic uncertainty.
