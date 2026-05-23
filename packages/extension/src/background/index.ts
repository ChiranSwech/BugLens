/**
 * BugBuddy — Service Worker (Background Script)
 *
 * Responsibilities:
 *  - Google OAuth login via chrome.identity
 *  - Token lifecycle management (access + refresh)
 *  - Message routing between content script, popup, sidepanel
 *  - Screenshot capture via chrome.tabs.captureVisibleTab
 *  - Network log capture via chrome.debugger
 *  - AI title/description generation via OpenAI
 *  - Offline event queue with reconnect flushing
 */

import type { CreateSession } from '@bugbuddy/shared';

const DEFAULT_API_BASE = 'http://localhost:8080';
let API_BASE = DEFAULT_API_BASE;

// Load stored API base on startup
chrome.storage.local.get(['customApiBase'], (result) => {
  if (result.customApiBase) {
    API_BASE = result.customApiBase;
    console.log('[BugBuddy] Configured API Base URL:', API_BASE);
  }
});

// Watch for changes to the API URL configuration
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.customApiBase) {
    API_BASE = changes.customApiBase.newValue || DEFAULT_API_BASE;
    console.log('[BugBuddy] API Base URL updated to:', API_BASE);
  }
});

// ─── Message types ────────────────────────────────────────────────────────────
interface Message {
  type:
  | 'LOGIN'
  | 'LOGOUT'
  | 'GET_AUTH'
  | 'START_SESSION'
  | 'END_SESSION'
  | 'SUBMIT_BUG'
  | 'EVENTS_BATCH'
  | 'PAUSE_RECORDING'
  | 'RESUME_RECORDING'
  | 'GET_RECORDING_STATE'
  | 'GET_SESSION_EVENTS'
  | 'API_REQUEST'
  | 'STEP_COUNT_UPDATED'
  | 'CAPTURE_SCREENSHOT'
  | 'GET_SCREENSHOTS'
  | 'CLEAR_SCREENSHOTS'
  | 'DELETE_STEP'
  | 'GENERATE_AI_CONTENT'
  | 'GET_NETWORK_LOGS'
  | 'GET_CONSOLE_LOGS'
  | 'AUTO_CAPTURE_SCREENSHOT'
  | 'DOWNLOAD_REPORT'
  | 'CREATE_JIRA_ISSUE'
  | 'CREATE_AZURE_WORK_ITEM'
  | 'SEND_SLACK_NOTIFICATION'
  | 'CAPTURE_STEP_SCREENSHOT'
  | 'OPEN_SIDE_PANEL';
  payload?: unknown;
}

// ─── State ────────────────────────────────────────────────────────────────────
let accessToken: string | null = null;
let currentSessionId: string | null = null;
let lastSessionId: string | null = null;
let isPaused = false;
let stepCount = 0;
let sessionEvents: unknown[] = [];

// Screenshots stored as: { stepIndex: dataUrl }
let sessionScreenshots: Record<number, string> = {};
let pendingScreenshots: Record<string, string> = {};

interface ScreenshotQueueItem {
  eventId: string;
  windowId: number;
  clickX?: number;
  clickY?: number;
  elementRect?: { x: number; y: number; width: number; height: number };
}
let screenshotQueue: Array<ScreenshotQueueItem> = [];
let isProcessingQueue = false;

// Network logs captured via debugger
let networkLogs: NetworkLogEntry[] = [];
let debuggerTabId: number | null = null;

interface NetworkLogEntry {
  id: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  type: string;
  duration: number | null;
  startTime: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  failed: boolean;
  errorText?: string;
  requestBody?: string;
  responseBody?: string;
}

interface ConsoleLogEntry {
  type: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'exception';
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp: number;
}
let consoleLogs: ConsoleLogEntry[] = [];

// Track in-flight network requests
const pendingRequests = new Map<string, NetworkLogEntry>();

// ─── Persistence ──────────────────────────────────────────────────────────────

async function loadState(): Promise<void> {
  const session = await chrome.storage.session.get('accessToken');
  accessToken = (session['accessToken'] as string) ?? null;

  const local = await chrome.storage.local.get([
    'currentSessionId', 'lastSessionId', 'isPaused', 'stepCount',
    'sessionEvents', 'sessionScreenshots', 'networkLogs',
  ]);
  currentSessionId = (local['currentSessionId'] as string) ?? null;
  lastSessionId = (local['lastSessionId'] as string) ?? null;
  isPaused = (local['isPaused'] as boolean) ?? false;
  stepCount = (local['stepCount'] as number) ?? 0;
  sessionEvents = (local['sessionEvents'] as unknown[]) ?? [];
  sessionScreenshots = (local['sessionScreenshots'] as Record<number, string>) ?? {};
  networkLogs = (local['networkLogs'] as NetworkLogEntry[]) ?? [];
}

async function saveSessionId(id: string | null): Promise<void> {
  if (id) {
    currentSessionId = id;
    lastSessionId = id;
    stepCount = 0;
    sessionEvents = [];
    sessionScreenshots = {};
    networkLogs = [];
    await chrome.storage.local.set({
      currentSessionId: id,
      lastSessionId: id,
      stepCount,
      sessionEvents,
      sessionScreenshots,
      networkLogs,
    });
  } else {
    currentSessionId = null;
    await chrome.storage.local.set({ currentSessionId: null });
  }
}

async function savePausedState(paused: boolean): Promise<void> {
  isPaused = paused;
  await chrome.storage.local.set({ isPaused: paused });
}

async function incrementStepCount(count: number): Promise<void> {
  stepCount += count;
  await chrome.storage.local.set({ stepCount });
  chrome.runtime.sendMessage({ type: 'STEP_COUNT_UPDATED', payload: { stepCount } }).catch(() => { });
}

// ─── Token management ─────────────────────────────────────────────────────────

async function saveToken(token: string): Promise<void> {
  accessToken = token;
  await chrome.storage.session.set({ accessToken: token });
}

async function clearTokens(): Promise<void> {
  accessToken = null;
  await saveSessionId(null);
  await savePausedState(false);
  await chrome.storage.session.clear();
  await chrome.storage.local.remove('refreshToken');
}

async function refreshAccessToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get('refreshToken');
  const refreshToken = stored['refreshToken'] as string | undefined;
  if (!refreshToken) return null;

  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      await clearTokens();
      return null;
    }

    const { accessToken: newToken } = (await response.json()) as { accessToken: string };
    await saveToken(newToken);
    return newToken;
  } catch {
    return null;
  }
}

// ─── Google OAuth login ───────────────────────────────────────────────────────

async function login(): Promise<{ success: boolean; error?: string }> {
  try {
    const authUrl = `${API_BASE}/auth/google`;
    const redirectUrl = chrome.identity.getRedirectURL();

    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl + '?redirect_uri=' + encodeURIComponent(redirectUrl),
      interactive: true,
    });

    if (!responseUrl) {
      return { success: false, error: 'No response URL from OAuth flow' };
    }

    const url = new URL(responseUrl);
    const token = url.searchParams.get('access_token');

    if (!token) {
      return { success: false, error: 'No access token in response' };
    }

    await saveToken(token);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── API call helper with auto-refresh ───────────────────────────────────────

async function apiCall<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T; ok: true } | { ok: false; status: number; data?: unknown }> {
  let token = accessToken;

  if (!token) {
    token = await refreshAccessToken();
    if (!token) return { ok: false, status: 401 };
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Request-ID': crypto.randomUUID(),
    },
  });

  if (response.status === 401) {
    const newToken = await refreshAccessToken();
    if (!newToken) return { ok: false, status: 401 };

    const retry = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${newToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!retry.ok) return { ok: false, status: retry.status };
    return { data: await retry.json() as T, ok: true };
  }

  if (!response.ok) {
    let errorData;
    try { errorData = await response.json(); } catch { errorData = null; }
    return { ok: false, status: response.status, data: errorData };
  }
  return { data: await response.json() as T, ok: true };
}

// ─── Offline queue ────────────────────────────────────────────────────────────

const QUEUE_KEY = 'offlineEventQueue';

interface QueuedRequest {
  id: string;
  endpoint: string;
  method: string;
  body: string;
  timestamp: number;
}

async function enqueue(endpoint: string, method: string, body: unknown): Promise<void> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue: QueuedRequest[] = (stored[QUEUE_KEY] as QueuedRequest[]) ?? [];
  queue.push({ id: crypto.randomUUID(), endpoint, method, body: JSON.stringify(body), timestamp: Date.now() });
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function flushQueue(): Promise<void> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue: QueuedRequest[] = (stored[QUEUE_KEY] as QueuedRequest[]) ?? [];
  if (queue.length === 0) return;

  const remaining: QueuedRequest[] = [];
  for (const req of queue) {
    const result = await apiCall(req.endpoint, { method: req.method, body: req.body });
    if (!result.ok) remaining.push(req);
  }

  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
}

// ─── Screenshot Capture ───────────────────────────────────────────────────────

async function captureScreenshot(tabId?: number, overrideStepIndex?: number): Promise<{ dataUrl: string; stepIndex: number } | { error: string }> {
  try {
    // Get the active tab if not specified
    let targetTabId = tabId;
    if (!targetTabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = tabs[0]?.id;
    }
    if (!targetTabId) return { error: 'No active tab found' };

    const tab = await chrome.tabs.get(targetTabId);
    const windowId = tab.windowId;

    // Capture the visible tab as JPEG (smaller than PNG)
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 85,
    });

    const stepIndex = overrideStepIndex ?? (sessionEvents.length > 0 ? sessionEvents.length - 1 : 0);
    sessionScreenshots[stepIndex] = dataUrl;
    await chrome.storage.local.set({ sessionScreenshots });

    // Notify side panel of new screenshot
    chrome.runtime.sendMessage({
      type: 'SCREENSHOT_TAKEN',
      payload: { stepIndex, dataUrl },
    }).catch(() => { });

    return { dataUrl, stepIndex };
  } catch (err) {
    console.error('[BugBuddy] Screenshot capture failed:', err);
    return { error: (err as Error).message };
  }
}

/**
 * Draw a click-indicator annotation (ring + dot) on a screenshot dataUrl.
 * Uses OffscreenCanvas so we don't need a visible DOM element.
 */
async function annotateClickOnScreenshot(
  dataUrl: string,
  clickX: number,
  clickY: number,
  elementRect?: { x: number; y: number; width: number; height: number }
): Promise<string> {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);

    // Draw element highlight box if we have the rect
    if (elementRect && elementRect.width > 0 && elementRect.height > 0) {
      const ex = elementRect.x - elementRect.x; // already absolute
      ctx.strokeStyle = 'rgba(124, 77, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      ctx.strokeRect(
        elementRect.x,
        elementRect.y,
        elementRect.width,
        elementRect.height
      );
      ctx.fillStyle = 'rgba(124, 77, 255, 0.12)';
      ctx.fillRect(elementRect.x, elementRect.y, elementRect.width, elementRect.height);
      void ex;
    }

    // Draw click ripple rings at the click point
    const cx = clickX;
    const cy = clickY;

    // Outer pulsing ring
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(124, 77, 255, 0.5)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Middle ring
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(124, 77, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner filled dot
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#7c4dff';
    ctx.fill();

    const annotatedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(annotatedBlob);
    });
  } catch (err) {
    console.warn('[BugBuddy] Click annotation failed, using raw screenshot:', err);
    return dataUrl;
  }
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue || screenshotQueue.length === 0) return;
  isProcessingQueue = true;

  const item = screenshotQueue.shift()!;
  const { eventId, windowId, clickX, clickY, elementRect } = item;

  try {
    // Capture step screenshot
    let dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: 50,
    });

    // Annotate click position on the screenshot if coordinates are available
    if (clickX !== undefined && clickY !== undefined) {
      dataUrl = await annotateClickOnScreenshot(dataUrl, clickX, clickY, elementRect);
    }

    const index = sessionEvents.findIndex((ev: any) => ev.eventId === eventId);
    if (index !== -1) {
      sessionScreenshots[index] = dataUrl;
      await chrome.storage.local.set({ sessionScreenshots });
      chrome.runtime.sendMessage({
        type: 'SCREENSHOT_TAKEN',
        payload: { stepIndex: index, dataUrl },
      }).catch(() => { });
    } else {
      pendingScreenshots[eventId] = dataUrl;
    }
  } catch (err) {
    console.error('[BugBuddy] Failed to capture queued screenshot:', err);
  }

  // Wait 400ms to avoid Chrome screenshot rate limiting
  setTimeout(() => {
    isProcessingQueue = false;
    processQueue().catch(console.error);
  }, 400);
}

// ─── Network Log Capture (chrome.debugger) ───────────────────────────────────

async function attachDebugger(tabId: number): Promise<void> {
  if (debuggerTabId === tabId) return;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerTabId = tabId;

    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});

    console.log(`[BugBuddy] Debugger attached to tab ${tabId} for network/console capture`);
  } catch (err) {
    console.warn('[BugBuddy] Could not attach debugger (network logs disabled):', err);
    debuggerTabId = null;
  }
}

async function detachDebugger(): Promise<void> {
  if (debuggerTabId === null) return;
  try {
    await chrome.debugger.detach({ tabId: debuggerTabId });
  } catch { /* ignore */ }
  debuggerTabId = null;
  pendingRequests.clear();
}

// Listen for debugger network and runtime events
chrome.debugger.onEvent.addListener((_source, method, params: any) => {
  if (!currentSessionId) return;

  if (method === 'Runtime.consoleAPICalled') {
    const text = params.args?.map((a: any) => a.value || a.description || '').join(' ');
    const stack = params.stackTrace?.callFrames?.[0];
    consoleLogs.push({
      type: params.type as ConsoleLogEntry['type'],
      text,
      url: stack?.url,
      line: stack?.lineNumber,
      column: stack?.columnNumber,
      timestamp: params.timestamp,
    });
    if (consoleLogs.length % 5 === 0) {
      chrome.storage.local.set({ consoleLogs }).catch(() => {});
    }
  }

  if (method === 'Runtime.exceptionThrown') {
    const text = params.exceptionDetails.exception?.description || params.exceptionDetails.text;
    consoleLogs.push({
      type: 'exception',
      text,
      url: params.exceptionDetails.url,
      line: params.exceptionDetails.lineNumber,
      column: params.exceptionDetails.columnNumber,
      timestamp: params.timestamp,
    });
    if (consoleLogs.length % 5 === 0) {
      chrome.storage.local.set({ consoleLogs }).catch(() => {});
    }
  }

  if (method === 'Network.requestWillBeSent') {
    const entry: NetworkLogEntry = {
      id: params.requestId,
      method: params.request?.method ?? 'GET',
      url: params.request?.url ?? '',
      status: null,
      statusText: null,
      type: params.type ?? 'Other',
      duration: null,
      startTime: params.timestamp * 1000,
      requestHeaders: params.request?.headers ?? {},
      responseHeaders: {},
      failed: false,
      requestBody: params.request?.postData,
    };
    pendingRequests.set(params.requestId, entry);
  }

  if (method === 'Network.responseReceived') {
    const entry = pendingRequests.get(params.requestId);
    if (entry) {
      entry.status = params.response?.status ?? null;
      entry.statusText = params.response?.statusText ?? null;
      entry.responseHeaders = params.response?.headers ?? {};
    }
  }

  if (method === 'Network.loadingFinished') {
    const entry = pendingRequests.get(params.requestId);
    if (entry) {
      entry.duration = params.timestamp * 1000 - entry.startTime;
      
      const finalizeNetworkLog = () => {
        networkLogs.push(entry);
        pendingRequests.delete(params.requestId);
        if (networkLogs.length % 5 === 0) {
          chrome.storage.local.set({ networkLogs }).catch(() => { });
        }
      };

      if (debuggerTabId) {
        chrome.debugger.sendCommand({ tabId: debuggerTabId }, 'Network.getResponseBody', { requestId: params.requestId })
          .then((res: any) => {
            if (res?.body) {
              entry.responseBody = res.body.length > 50000 ? res.body.substring(0, 50000) + '... [TRUNCATED]' : res.body;
            }
            finalizeNetworkLog();
          })
          .catch(() => finalizeNetworkLog());
      } else {
        finalizeNetworkLog();
      }
    }
  }

  if (method === 'Network.loadingFailed') {
    const entry = pendingRequests.get(params.requestId);
    if (entry) {
      entry.failed = true;
      entry.errorText = params.errorText;
      entry.duration = params.timestamp * 1000 - entry.startTime;
      networkLogs.push(entry);
      pendingRequests.delete(params.requestId);
      chrome.storage.local.set({ networkLogs }).catch(() => { });
    }
  }
});



// ─── Commands (keyboard shortcuts) ───────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-screenshot') {
    if (!currentSessionId || isPaused) return;

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (!tabId) return;

    const result = await captureScreenshot(tabId);
    if ('error' in result) {
      console.error('[BugBuddy] Shortcut screenshot failed:', result.error);
    } else {
      // Notify content script to show visual flash
      chrome.tabs.sendMessage(tabId, { type: 'SCREENSHOT_FLASH' }).catch(() => { });
    }
  }

  if (command === 'pause-resume-recording') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      if (isPaused) {
        await savePausedState(false);
        chrome.tabs.sendMessage(tabs[0].id, { type: 'RESUME_RECORDING' }).catch(() => { });
      } else {
        await savePausedState(true);
        chrome.tabs.sendMessage(tabs[0].id, { type: 'PAUSE_RECORDING' }).catch(() => { });
      }
      chrome.runtime.sendMessage({
        type: 'STEP_COUNT_UPDATED',
        payload: { stepCount, isPaused },
      }).catch(() => { });
    }
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err: Error) => {
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message: Message): Promise<unknown> {
  switch (message.type) {
    case 'LOGIN':
      return login();

    case 'LOGOUT': {
      await detachDebugger();
      await apiCall('/auth/logout', { method: 'POST' });
      await clearTokens();
      return { success: true };
    }

    case 'GET_AUTH':
      return { isAuthenticated: !!accessToken };

    case 'START_SESSION': {
      const payload = message.payload as CreateSession;
      const result = await apiCall<{ id: string; expires_at: string }>('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.ok) {
        await saveSessionId(result.data.id);

        // Attach debugger for network capture
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          await attachDebugger(tabs[0].id);
        }

        return { sessionId: currentSessionId };
      }
      return { error: 'Failed to start session', status: result.status };
    }

    case 'END_SESSION': {
      if (!currentSessionId) return { error: 'No active session' };
      const status = (message.payload as { status: string }).status;
      await apiCall(`/v1/sessions/${currentSessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });

      // Persist final network logs
      await chrome.storage.local.set({ networkLogs });

      // Broadcast STOP_RECORDING to ALL tabs so recording banners are removed
      // even if the user navigated to a different page during the session.
      const allTabs = await chrome.tabs.query({});
      for (const tab of allTabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECORDING' }).catch(() => {});
        }
      }

      await detachDebugger();
      await saveSessionId(null);
      return { success: true };
    }

    case 'PAUSE_RECORDING': {
      await savePausedState(true);
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'PAUSE_RECORDING' }).catch(() => { });
      }
      return { paused: true };
    }

    case 'RESUME_RECORDING': {
      await savePausedState(false);
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'RESUME_RECORDING' }).catch(() => { });
      }
      flushQueue().catch(console.error);
      return { paused: false };
    }

    case 'GET_RECORDING_STATE':
      return {
        sessionId: currentSessionId,
        isPaused,
        stepCount,
        isAuthenticated: !!accessToken,
      };

    case 'GET_SESSION_EVENTS':
      return {
        sessionId: currentSessionId || lastSessionId,
        events: sessionEvents,
      };

    case 'EVENTS_BATCH': {
      if (isPaused || !currentSessionId) return { queued: 0 };
      const events = message.payload as unknown[];

      sessionEvents.push(...events);

      // Assign pending screenshots to newly received events
      for (let i = 0; i < events.length; i++) {
        const ev = events[i] as any;
        const globalIndex = stepCount + i;
        if (ev.eventId && pendingScreenshots[ev.eventId]) {
          sessionScreenshots[globalIndex] = pendingScreenshots[ev.eventId]!;
          delete pendingScreenshots[ev.eventId];
        }
      }
      await chrome.storage.local.set({ sessionEvents, sessionScreenshots });

      try {
        const result = await apiCall(`/v1/sessions/${currentSessionId}/events`, {
          method: 'POST',
          body: JSON.stringify({ events }),
        });
        if (!result.ok) {
          await enqueue(`/v1/sessions/${currentSessionId}/events`, 'POST', { events });
          await incrementStepCount(events.length);
          return { queued: events.length };
        }
        await incrementStepCount(events.length);
        return { sent: events.length };
      } catch {
        await enqueue(`/v1/sessions/${currentSessionId}/events`, 'POST', { events });
        await incrementStepCount(events.length);
        return { queued: events.length };
      }
    }

    case 'CAPTURE_STEP_SCREENSHOT': {
      if (!currentSessionId || isPaused) return { error: 'No active session or recording is paused' };
      const { eventId, clickX, clickY, elementRect } = message.payload as {
        eventId: string;
        clickX?: number;
        clickY?: number;
        elementRect?: { x: number; y: number; width: number; height: number };
      };
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const targetTabId = tabs[0]?.id;
        if (!targetTabId) return { error: 'No active tab found' };
        const tab = await chrome.tabs.get(targetTabId);
        const windowId = tab.windowId;

        const item: ScreenshotQueueItem = { eventId, windowId };
        if (clickX !== undefined) item.clickX = clickX;
        if (clickY !== undefined) item.clickY = clickY;
        if (elementRect !== undefined) item.elementRect = elementRect;
        screenshotQueue.push(item);
        processQueue().catch(console.error);
        return { success: true };
      } catch (err) {
        return { error: (err as Error).message };
      }
    }

    case 'CAPTURE_SCREENSHOT': {
      if (!currentSessionId || isPaused) return { error: 'No active session or recording is paused' };
      const { tabId, stepIndex } = (message.payload as { tabId?: number, stepIndex?: number }) ?? {};
      return captureScreenshot(tabId, stepIndex);
    }

    case 'GET_SCREENSHOTS': {
      return {
        screenshots: sessionScreenshots,
        sessionId: currentSessionId || lastSessionId,
      };
    }

    case 'CLEAR_SCREENSHOTS': {
      sessionScreenshots = {};
      await chrome.storage.local.set({ sessionScreenshots });
      return { success: true };
    }

    case 'GET_NETWORK_LOGS': {
      // Flush any pending requests before returning
      const allLogs = [
        ...networkLogs,
        ...Array.from(pendingRequests.values()),
      ];
      return { logs: allLogs, sessionId: currentSessionId || lastSessionId };
    }

    case 'GET_CONSOLE_LOGS': {
      return { logs: consoleLogs, sessionId: currentSessionId || lastSessionId };
    }

    case 'AUTO_CAPTURE_SCREENSHOT': {
      if (!currentSessionId || isPaused) return { error: 'No active session or recording is paused' };
      const { elementRect, elementLabel } = message.payload as {
        elementRect: { x: number; y: number; width: number; height: number; scrollX: number; scrollY: number };
        elementLabel: string;
      };
      const result = await captureScreenshot();
      if ('error' in result) return result;
      // Notify content script to show flash
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SCREENSHOT_FLASH' }).catch(() => { });
      }
      return { ...result, elementRect, elementLabel };
    }

    case 'DOWNLOAD_REPORT': {
      const { reportData, filename } = message.payload as { reportData: unknown; filename: string };
      const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true,
      });
      URL.revokeObjectURL(url);
      return { success: true };
    }

    case 'CREATE_JIRA_ISSUE': {
      const payload = message.payload;
      return apiCall('/v1/integrations/jira', { method: 'POST', body: JSON.stringify(payload) });
    }

    case 'CREATE_AZURE_WORK_ITEM': {
      const payload = message.payload;
      return apiCall('/v1/integrations/azure-devops', { method: 'POST', body: JSON.stringify(payload) });
    }

    case 'SEND_SLACK_NOTIFICATION': {
      const payload = message.payload;
      return apiCall('/v1/integrations/slack', { method: 'POST', body: JSON.stringify(payload) });
    }

    case 'GENERATE_AI_CONTENT': {
      const { steps } = message.payload as { steps: unknown[] };
      // AI generation is handled server-side; the OpenAI key is in the backend .env.
      const result = await apiCall<{ title: string; description: string; suggestedSeverity: string }>(
        '/v1/ai/generate',
        { method: 'POST', body: JSON.stringify({ steps }) }
      );
      if (!result.ok) {
        // Surface the real backend error detail so the user knows the actual cause.
        const detail = (result.data as any)?.detail ?? (result.data as any)?.title ?? 'Unknown error';
        return { error: `AI generation failed (HTTP ${result.status}): ${detail}` };
      }
      return result.data;
    }

    case 'API_REQUEST': {
      const { url, options } = message.payload as { url: string; options: RequestInit };
      try {
        const result = await apiCall<any>(url, options);
        if (!result.ok) {
          return {
            error: `API Error (${result.status})`,
            status: result.status,
            details: (result as any).data,
          };
        }
        return { data: result.data };
      } catch (err: any) {
        return { error: err.message };
      }
    }

    case 'SUBMIT_BUG': {
      const bug = message.payload;
      return apiCall('/v1/bugs', { method: 'POST', body: JSON.stringify(bug) });
    }

    case 'DELETE_STEP': {
      const { stepIndex } = message.payload as { stepIndex: number };
      if (typeof stepIndex !== 'number' || stepIndex < 0 || stepIndex >= sessionEvents.length) {
        return { success: false, error: 'Invalid step index' };
      }

      // Remove event
      sessionEvents.splice(stepIndex, 1);
      stepCount = sessionEvents.length;

      // Rebuild screenshots map (shift indices down after stepIndex)
      const rebuilt: Record<number, string> = {};
      Object.entries(sessionScreenshots).forEach(([keyStr, dataUrl]) => {
        const key = Number(keyStr);
        if (key === stepIndex) return; // drop deleted screenshot
        rebuilt[key < stepIndex ? key : key - 1] = dataUrl;
      });
      sessionScreenshots = rebuilt;

      // Persist state
      chrome.storage.local.set({
        sessionEvents,
        sessionScreenshots,
        stepCount
      }).catch(() => {});

      // Notify UI
      chrome.runtime.sendMessage({ type: 'STEP_COUNT_UPDATED', payload: { stepCount } }).catch(() => {});
      return { success: true };
    }

    case 'OPEN_SIDE_PANEL': {
      const win = await chrome.windows.getCurrent();
      if (win.id) {
        await chrome.sidePanel.open({ windowId: win.id });
      }
      return { success: true };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
loadState().catch(console.error);

self.addEventListener('online', () => {
  flushQueue().catch(console.error);
});
