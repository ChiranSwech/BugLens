/**
 * BugLens — Service Worker (Background Script)
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

import type { CreateSession } from '@buglens/shared';

const DEFAULT_API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || 'https://buglens-j6v1.onrender.com';
let API_BASE = DEFAULT_API_BASE;

// Load stored API base on startup
chrome.storage.local.get(['customApiBase'], (result) => {
  if (result.customApiBase) {
    API_BASE = result.customApiBase;
    console.log('[BugLens] Configured API Base URL:', API_BASE);
  }
});

// Watch for changes to the API URL configuration
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.customApiBase) {
    API_BASE = changes.customApiBase.newValue || DEFAULT_API_BASE;
    console.log('[BugLens] API Base URL updated to:', API_BASE);
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

let stateLoadedPromise: Promise<void> | null = null;

async function loadState(): Promise<void> {
  const local = await chrome.storage.local.get([
    'accessToken', 'refreshToken', 'currentSessionId', 'lastSessionId', 'isPaused', 'stepCount',
    'sessionEvents', 'sessionScreenshots', 'networkLogs',
  ]);
  accessToken = (local['accessToken'] as string) ?? null;
  currentSessionId = (local['currentSessionId'] as string) ?? null;
  lastSessionId = (local['lastSessionId'] as string) ?? null;
  isPaused = (local['isPaused'] as boolean) ?? false;
  stepCount = (local['stepCount'] as number) ?? 0;
  sessionEvents = (local['sessionEvents'] as unknown[]) ?? [];
  sessionScreenshots = (local['sessionScreenshots'] as Record<number, string>) ?? {};
  networkLogs = (local['networkLogs'] as NetworkLogEntry[]) ?? [];

  // Backward compatibility check for chrome.storage.session
  if (!accessToken) {
    const session = await chrome.storage.session.get('accessToken');
    if (session['accessToken']) {
      accessToken = session['accessToken'] as string;
      await chrome.storage.local.set({ accessToken });
    }
  }

  // Auto-refresh token if accessToken is missing but refreshToken exists
  const refreshToken = local['refreshToken'] as string | undefined;
  if (!accessToken && refreshToken) {
    await refreshAccessToken();
  }
}

function ensureStateLoaded(): Promise<void> {
  if (!stateLoadedPromise) {
    stateLoadedPromise = loadState();
  }
  return stateLoadedPromise;
}

async function broadcastStateChange(): Promise<void> {
  chrome.runtime.sendMessage({
    type: 'RECORDING_STATE_CHANGED',
    payload: {
      sessionId: currentSessionId,
      isPaused,
      stepCount,
      isAuthenticated: !!accessToken,
    },
  }).catch(() => {});

  // Broadcast to all tabs so in-page recording widget stays in sync across pages
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'RECORDING_STATE_CHANGED',
          payload: {
            sessionId: currentSessionId,
            isPaused,
            stepCount,
          },
        }).catch(() => {});
      }
    }
  } catch {}
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
  broadcastStateChange();
}

async function savePausedState(paused: boolean): Promise<void> {
  isPaused = paused;
  await chrome.storage.local.set({ isPaused: paused });
  broadcastStateChange();
}

async function incrementStepCount(count: number): Promise<void> {
  stepCount += count;
  await chrome.storage.local.set({ stepCount });
  chrome.runtime.sendMessage({ type: 'STEP_COUNT_UPDATED', payload: { stepCount } }).catch(() => { });
  broadcastStateChange();
}

// ─── Token management ─────────────────────────────────────────────────────────

async function saveToken(token: string, refreshToken?: string): Promise<void> {
  accessToken = token;
  const updates: Record<string, string> = { accessToken: token };
  if (refreshToken) {
    updates['refreshToken'] = refreshToken;
  }
  await chrome.storage.local.set(updates);
  await chrome.storage.session.set({ accessToken: token });
}

async function clearTokens(): Promise<void> {
  accessToken = null;
  await chrome.storage.session.clear();
  await chrome.storage.local.remove(['accessToken', 'refreshToken', 'user']);
  broadcastStateChange();
}

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get('refreshToken');
      const refreshToken = stored['refreshToken'] as string | undefined;
      if (!refreshToken) return null;

      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.warn('[Background] Refresh token expired (HTTP ' + response.status + '). Clearing session.');
          await clearTokens();
        }
        return null;
      }

      const { accessToken: newToken, refreshToken: newRefreshToken } = (await response.json()) as { accessToken: string; refreshToken?: string };
      await saveToken(newToken, newRefreshToken);
      return newToken;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ─── Google OAuth login ───────────────────────────────────────────────────────

// Tab navigation listener for fallback login flow
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url) {
    const urlStr = changeInfo.url;
    if (urlStr.includes('access_token=') && (urlStr.includes('chromiumapp.org') || urlStr.includes('chrome-extension://'))) {
      try {
        const url = new URL(urlStr);
        const token = url.searchParams.get('access_token');
        const refreshToken = url.searchParams.get('refresh_token');
        if (token) {
          await saveToken(token, refreshToken ?? undefined);
          console.log('[Background] Tokens captured from tab callback successfully');
          chrome.tabs.remove(tabId).catch(() => {});
        }
      } catch (e) {
        console.error('[Background] Failed to parse token from tab callback:', e);
      }
    }
  }
});

async function login(): Promise<{ success: boolean; error?: string }> {
  const cleanBase = API_BASE.replace(/\/+$/, '');
  const authUrl = `${cleanBase}/auth/google`;
  const redirectUrl = chrome.identity.getRedirectURL();
  const fullAuthUrl = `${authUrl}?redirect_uri=${encodeURIComponent(redirectUrl)}`;

  console.log('[Background] login: authUrl =', authUrl, 'redirectUrl =', redirectUrl);

  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: fullAuthUrl,
      interactive: true,
    });
  } catch (err: any) {
    console.warn('[Background] launchWebAuthFlow warning, launching tab fallback:', err?.message);
    await chrome.tabs.create({ url: fullAuthUrl });
    return { success: true };
  }

  if (!responseUrl) {
    console.warn('[Background] No response URL from launchWebAuthFlow, launching tab fallback');
    await chrome.tabs.create({ url: fullAuthUrl });
    return { success: true };
  }

  const url = new URL(responseUrl);
  const errorParam = url.searchParams.get('error');
  if (errorParam) {
    return { success: false, error: `Google OAuth error: ${errorParam}` };
  }

  const token = url.searchParams.get('access_token');
  const refreshToken = url.searchParams.get('refresh_token');

  if (!token) {
    console.warn('[Background] login: No access_token in response URL:', responseUrl);
    return { success: false, error: 'No access token returned from backend' };
  }

  await saveToken(token, refreshToken ?? undefined);
  console.log('[Background] login: Tokens saved successfully');
  return { success: true };
}

// ─── API call helper with auto-refresh ───────────────────────────────────────

async function apiCall<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T; ok: true } | { ok: false; status: number; data?: unknown }> {
  await ensureStateLoaded();
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
    if (!newToken) {
      await clearTokens();
      return { ok: false, status: 401 };
    }

    const retry = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${newToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!retry.ok) {
      if (retry.status === 401 || retry.status === 403) {
        await clearTokens();
      }
      return { ok: false, status: retry.status };
    }
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

    let stepIndex = overrideStepIndex;
    if (stepIndex === undefined) {
      // Manual capture: create a new manual screenshot step so it is counted and preserved!
      const manualEvent = {
        eventId: crypto.randomUUID(),
        actionType: 'SCREENSHOT',
        elementLabel: 'Manual Screenshot',
        cssSelector: '',
        valueMasked: '',
        timestamp: new Date().toISOString(),
        pageUrl: tab.url || '',
        pageTitle: tab.title || '',
      };
      sessionEvents.push(manualEvent);
      stepIndex = sessionEvents.length - 1;
      sessionScreenshots[stepIndex] = dataUrl;
      await chrome.storage.local.set({ sessionEvents, sessionScreenshots });
      await incrementStepCount(1);
    } else {
      // Recapture for existing step
      sessionScreenshots[stepIndex] = dataUrl;
      await chrome.storage.local.set({ sessionScreenshots });
    }

    // Notify side panel of new screenshot
    chrome.runtime.sendMessage({
      type: 'SCREENSHOT_TAKEN',
      payload: { stepIndex, dataUrl },
    }).catch(() => { });

    return { dataUrl, stepIndex };
  } catch (err) {
    console.error('[BugLens] Screenshot capture failed:', err);
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
    console.warn('[BugLens] Click annotation failed, using raw screenshot:', err);
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
    console.error('[BugLens] Failed to capture queued screenshot:', err);
  }

  // Wait 400ms to avoid Chrome screenshot rate limiting
  setTimeout(() => {
    isProcessingQueue = false;
    processQueue().catch(console.error);
  }, 400);
}

// ─── Network Log Capture (chrome.debugger) ───────────────────────────────────

async function attachDebugger(tabId: number): Promise<void> {
  if (debuggerTabId === tabId) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
      return;
    } catch {
      debuggerTabId = null;
    }
  }

  // Detach from previous tab if any
  if (debuggerTabId !== null && debuggerTabId !== tabId) {
    try {
      await chrome.debugger.detach({ tabId: debuggerTabId });
    } catch {}
    debuggerTabId = null;
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerTabId = tabId;

    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});

    console.log(`[BugLens] Debugger attached to tab ${tabId} for network/console capture`);
  } catch (err) {
    console.warn('[BugLens] Could not attach debugger (network logs disabled):', err);
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
chrome.debugger.onEvent.addListener((source, method, params: any) => {
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
    chrome.storage.local.set({ consoleLogs }).catch(() => {});
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
    chrome.storage.local.set({ consoleLogs }).catch(() => {});
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
      if (entry.status !== null && entry.status >= 400) {
        entry.failed = true;
      }
    }
  }

  if (method === 'Network.loadingFinished') {
    const entry = pendingRequests.get(params.requestId);
    if (entry) {
      entry.duration = params.timestamp * 1000 - entry.startTime;
      if (entry.status !== null && entry.status >= 400) {
        entry.failed = true;
      }

      const finalizeNetworkLog = () => {
        networkLogs.push(entry);
        pendingRequests.delete(params.requestId);
        chrome.storage.local.set({ networkLogs }).catch(() => { });
      };

      const targetTabId = (source && 'tabId' in source && source.tabId) ? source.tabId : debuggerTabId;
      if (targetTabId) {
        chrome.debugger.sendCommand({ tabId: targetTabId }, 'Network.getResponseBody', { requestId: params.requestId })
          .then((res: any) => {
            if (res?.body) {
              let bodyContent = res.body;
              if (res.base64Encoded) {
                try {
                  bodyContent = atob(res.body);
                } catch {
                  // Fall back to original body if atob fails
                }
              }
              entry.responseBody = bodyContent.length > 50000 ? bodyContent.substring(0, 50000) + '... [TRUNCATED]' : bodyContent;
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
      entry.errorText = params.errorText || 'Connection or transport failure';
      entry.duration = params.timestamp * 1000 - entry.startTime;
      networkLogs.push(entry);
      pendingRequests.delete(params.requestId);
      chrome.storage.local.set({ networkLogs }).catch(() => { });
    }
  }
});

// Listen for debugger detach events (e.g. cross-origin navigation, devtools opened)
chrome.debugger.onDetach.addListener((source, reason) => {
  console.warn(`[BugLens] Debugger detached from tab ${source.tabId}: ${reason}`);
  if (debuggerTabId === source.tabId) {
    debuggerTabId = null;
    if (currentSessionId && source.tabId) {
      attachDebugger(source.tabId).catch(() => {});
    }
  }
});

// Auto-attach debugger when user switches active tabs or navigates to a new URL while recording
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (currentSessionId) {
    await attachDebugger(activeInfo.tabId);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!currentSessionId) return;

  // On page navigation or reload:
  if (tab.active && (changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
    await attachDebugger(tabId);
  }

  if (changeInfo.status === 'complete' && tab.url) {
    // Sync state to newly loaded page
    if (!tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('edge://')) {
      chrome.tabs.sendMessage(tabId, {
        type: 'RECORDING_STATE_CHANGED',
        payload: {
          sessionId: currentSessionId,
          isPaused,
          stepCount,
        },
      }).catch(async () => {
        // Fallback dynamic injection if content script didn't start
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js'],
          });
          chrome.tabs.sendMessage(tabId, {
            type: 'RECORDING_STATE_CHANGED',
            payload: {
              sessionId: currentSessionId,
              isPaused,
              stepCount,
            },
          }).catch(() => {});
        } catch {}
      });
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
      console.error('[BugLens] Shortcut screenshot failed:', result.error);
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

// ─── Direct BYOK AI Generators ─────────────────────────────────────────────

async function generateDefectWithOpenAI(
  apiKey: string,
  payload: {
    steps: any[];
    networkLogs?: any[];
    consoleLogs?: any[];
    screenshots?: Array<{ stepIndex: number; dataUrl: string }>;
    bugUrl?: string;
    testData?: string;
  }
): Promise<{
  title: string;
  description: string;
  expectedResult: string;
  actualResult: string;
  suggestedSeverity: string;
  stepsSummary: string;
  recommendedMainImageIndex: number | null;
}> {
  const steps = payload.steps || [];
  const failedNetwork = (payload.networkLogs || []).filter(
    (n: any) => n.failed || (n.status !== null && n.status !== undefined && n.status >= 400) || n.errorText
  );
  const errorConsole = (payload.consoleLogs || []).filter(
    (c: any) => c.type === 'error' || c.type === 'exception'
  );
  const screenshots = payload.screenshots || [];

  const stepsText = steps.map((s: any, i: number) => {
    const action = s.actionType?.toUpperCase() ?? 'ACTION';
    const label = s.elementLabel ?? 'Unknown';
    const url = s.pageUrl ? ` (on ${s.pageUrl})` : '';
    const value = s.valueMasked && s.valueMasked !== '[REDACTED]' ? ` = "${s.valueMasked}"` : '';
    return `${i + 1}. ${action} on "${label}"${value}${url}`;
  }).join('\n');

  const netText = failedNetwork.slice(0, 5).map((n: any) => {
    const respSnippet = n.responseBody ? ` | Response: ${n.responseBody.slice(0, 300)}` : '';
    return `${n.method || 'GET'} ${n.url} -> Status: ${n.status ?? 'Failed'} (${n.errorText || 'Error'})${respSnippet}`;
  }).join('\n');

  const consoleText = errorConsole.slice(0, 5).map((c: any) => `[${(c.type || 'ERROR').toUpperCase()}] ${c.text || ''}`).join('\n');

  const promptText = `You are a Principal QA and Software Reliability Engineer doing automated bug defect synthesis.
Based on the recorded user actions, captured visual screenshots, and runtime logs, produce a complete and precise bug report.

CONTEXT:
Application URL: ${payload.bugUrl || 'N/A'}
Test Data: ${payload.testData || 'None'}

USER ACTIONS (${steps.length} total events):
${stepsText}

FAILED NETWORK REQUESTS:
${netText || 'None recorded'}

CONSOLE ERRORS & EXCEPTIONS:
${consoleText || 'None recorded'}

SCREENSHOTS ATTACHED:
${screenshots.length > 0 ? `${screenshots.length} visual frame(s) provided below.` : 'No images attached.'}

SYNTHESIS GOALS:
1. TITLE: Short, specific, actionable bug title starting with a verb or clear issue statement (max 80 chars, e.g. "Unable to submit checkout form due to 400 Bad Request").
2. DESCRIPTION: Concise 2-3 sentence overview explaining what the user was doing, what broke, and the impact.
3. EXPECTED RESULT: Clear statement of what a normal user or specification expects to happen (e.g., "The order should be submitted successfully and redirect to the order confirmation page.").
4. ACTUAL RESULT: Clear statement of what actually happened, referencing visual error states, banners, disabled components, or underlying 4xx/5xx network/console errors (e.g., "The submit button became disabled, a toast error 'Payment Failed' appeared, and network request to /api/checkout returned HTTP 400.").
5. SUGGESTED SEVERITY: One of "P0", "P1", "P2", "P3", "P4" based on severity.
6. STEPS SUMMARY: A clean, human-readable numbered list of 4 to 8 reproduction steps.
7. RECOMMENDED MAIN IMAGE INDEX: The stepIndex integer of the screenshot that best illustrates the defect (or null if none).

Output a single JSON object with exactly these fields:
{
  "title": string,
  "description": string,
  "expectedResult": string,
  "actualResult": string,
  "suggestedSeverity": "P0" | "P1" | "P2" | "P3" | "P4",
  "stepsSummary": string,
  "recommendedMainImageIndex": number | null
}

Return ONLY valid JSON, no markdown formatting.`;

  const userMessageContent: any[] = [{ type: 'text', text: promptText }];

  if (screenshots.length > 0) {
    for (const shot of screenshots.slice(0, 2)) {
      if (shot.dataUrl && shot.dataUrl.startsWith('data:image/')) {
        userMessageContent.push({
          type: 'image_url',
          image_url: {
            url: shot.dataUrl,
            detail: 'low',
          },
        });
      }
    }
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: userMessageContent }],
      temperature: 0.3,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    let errMessage = `OpenAI API Error (HTTP ${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson?.error?.message) errMessage = errJson.error.message;
    } catch {}
    throw new Error(errMessage);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('OpenAI response did not contain valid JSON.');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    title: parsed.title ?? '',
    description: parsed.description ?? '',
    expectedResult: parsed.expectedResult ?? '',
    actualResult: parsed.actualResult ?? '',
    suggestedSeverity: parsed.suggestedSeverity ?? 'P2',
    stepsSummary: parsed.stepsSummary ?? '',
    recommendedMainImageIndex: typeof parsed.recommendedMainImageIndex === 'number'
      ? parsed.recommendedMainImageIndex
      : (screenshots.length > 0 ? screenshots[screenshots.length - 1]?.stepIndex ?? null : null),
  };
}

async function generateDefectWithClaude(
  apiKey: string,
  payload: {
    steps: any[];
    networkLogs?: any[];
    consoleLogs?: any[];
    screenshots?: Array<{ stepIndex: number; dataUrl: string }>;
    bugUrl?: string;
    testData?: string;
  }
): Promise<{
  title: string;
  description: string;
  expectedResult: string;
  actualResult: string;
  suggestedSeverity: string;
  stepsSummary: string;
  recommendedMainImageIndex: number | null;
}> {
  const steps = payload.steps || [];
  const failedNetwork = (payload.networkLogs || []).filter(
    (n: any) => n.failed || (n.status !== null && n.status !== undefined && n.status >= 400) || n.errorText
  );
  const errorConsole = (payload.consoleLogs || []).filter(
    (c: any) => c.type === 'error' || c.type === 'exception'
  );
  const screenshots = payload.screenshots || [];

  const stepsText = steps.map((s: any, i: number) => {
    const action = s.actionType?.toUpperCase() ?? 'ACTION';
    const label = s.elementLabel ?? 'Unknown';
    const url = s.pageUrl ? ` (on ${s.pageUrl})` : '';
    const value = s.valueMasked && s.valueMasked !== '[REDACTED]' ? ` = "${s.valueMasked}"` : '';
    return `${i + 1}. ${action} on "${label}"${value}${url}`;
  }).join('\n');

  const netText = failedNetwork.slice(0, 5).map((n: any) => {
    const respSnippet = n.responseBody ? ` | Response: ${n.responseBody.slice(0, 300)}` : '';
    return `${n.method || 'GET'} ${n.url} -> Status: ${n.status ?? 'Failed'} (${n.errorText || 'Error'})${respSnippet}`;
  }).join('\n');

  const consoleText = errorConsole.slice(0, 5).map((c: any) => `[${(c.type || 'ERROR').toUpperCase()}] ${c.text || ''}`).join('\n');

  const promptText = `You are a Principal QA and Software Reliability Engineer doing automated bug defect synthesis.
Based on the recorded user actions, captured visual screenshots, and runtime logs, produce a complete and precise bug report.

CONTEXT:
Application URL: ${payload.bugUrl || 'N/A'}
Test Data: ${payload.testData || 'None'}

USER ACTIONS (${steps.length} total events):
${stepsText}

FAILED NETWORK REQUESTS:
${netText || 'None recorded'}

CONSOLE ERRORS & EXCEPTIONS:
${consoleText || 'None recorded'}

SCREENSHOTS ATTACHED:
${screenshots.length > 0 ? `${screenshots.length} visual frame(s) provided below.` : 'No images attached.'}

SYNTHESIS GOALS:
1. TITLE: Short, specific, actionable bug title starting with a verb or clear issue statement (max 80 chars, e.g. "Unable to submit checkout form due to 400 Bad Request").
2. DESCRIPTION: Concise 2-3 sentence overview explaining what the user was doing, what broke, and the impact.
3. EXPECTED RESULT: Clear statement of what a normal user or specification expects to happen (e.g., "The order should be submitted successfully and redirect to the order confirmation page.").
4. ACTUAL RESULT: Clear statement of what actually happened, referencing visual error states, banners, disabled components, or underlying 4xx/5xx network/console errors (e.g., "The submit button became disabled, a toast error 'Payment Failed' appeared, and network request to /api/checkout returned HTTP 400.").
5. SUGGESTED SEVERITY: One of "P0", "P1", "P2", "P3", "P4" based on severity.
6. STEPS SUMMARY: A clean, human-readable numbered list of 4 to 8 reproduction steps.
7. RECOMMENDED MAIN IMAGE INDEX: The stepIndex integer of the screenshot that best illustrates the defect (or null if none).

Output a single JSON object with exactly these fields:
{
  "title": string,
  "description": string,
  "expectedResult": string,
  "actualResult": string,
  "suggestedSeverity": "P0" | "P1" | "P2" | "P3" | "P4",
  "stepsSummary": string,
  "recommendedMainImageIndex": number | null
}

Return ONLY valid JSON, no markdown formatting.`;

  const content: any[] = [{ type: 'text', text: promptText }];

  if (screenshots.length > 0) {
    for (const shot of screenshots.slice(0, 2)) {
      if (shot.dataUrl && shot.dataUrl.startsWith('data:image/')) {
        const matches = shot.dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (matches) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: matches[1] || 'image/jpeg',
              data: matches[2],
            },
          });
        }
      }
    }
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1000,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    let errMessage = `Claude API Error (HTTP ${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson?.error?.message) errMessage = errJson.error.message;
    } catch {}
    throw new Error(errMessage);
  }

  const data = await response.json();
  const textContent = data.content?.[0]?.text ?? '';
  const jsonMatch = textContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Claude response did not contain valid JSON.');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    title: parsed.title ?? '',
    description: parsed.description ?? '',
    expectedResult: parsed.expectedResult ?? '',
    actualResult: parsed.actualResult ?? '',
    suggestedSeverity: parsed.suggestedSeverity ?? 'P2',
    stepsSummary: parsed.stepsSummary ?? '',
    recommendedMainImageIndex: typeof parsed.recommendedMainImageIndex === 'number'
      ? parsed.recommendedMainImageIndex
      : (screenshots.length > 0 ? screenshots[screenshots.length - 1]?.stepIndex ?? null : null),
  };
}

// ─── Message handler ──────────────────────────────────────────────────────────

function isJwtExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return true;
    const payload = JSON.parse(atob(parts[1]));
    if (!payload.exp) return false;
    return payload.exp * 1000 < Date.now() + 30000;
  } catch {
    return false;
  }
}

async function isUserAuthenticated(): Promise<boolean> {
  await ensureStateLoaded();
  const stored = await chrome.storage.local.get(['accessToken', 'refreshToken']);
  const token = accessToken || (stored['accessToken'] as string | undefined);
  const refreshToken = stored['refreshToken'] as string | undefined;

  if (!token && !refreshToken) {
    return false;
  }

  // If access token is valid and not expired
  if (token && !isJwtExpired(token)) {
    return true;
  }

  // Token is missing or expired, attempt refresh using refreshToken
  if (refreshToken) {
    const refreshed = await refreshAccessToken();
    return !!refreshed;
  }

  return false;
}

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  if (message.type === 'OPEN_SIDE_PANEL' || message.type === 'FINISH_AND_OPEN_SIDE_PANEL') {
    const tabId = sender?.tab?.id;
    const windowId = sender?.tab?.windowId;

    const openFallbackTab = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/index.html') }).catch(() => {});
    };

    if (tabId !== undefined) {
      chrome.sidePanel.open({ tabId }).catch((tabErr) => {
        console.warn('[Background] sidePanel.open({ tabId }) failed:', tabErr?.message);
        if (windowId !== undefined) {
          chrome.sidePanel.open({ windowId }).catch((winErr) => {
            console.warn('[Background] sidePanel.open({ windowId }) failed:', winErr?.message);
            openFallbackTab();
          });
        } else {
          openFallbackTab();
        }
      });
    } else if (windowId !== undefined) {
      chrome.sidePanel.open({ windowId }).catch((winErr) => {
        console.warn('[Background] sidePanel.open({ windowId }) failed:', winErr?.message);
        openFallbackTab();
      });
    } else {
      openFallbackTab();
    }
  }

  handleMessage(message, sender).then(sendResponse).catch((err: Error) => {
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message: Message, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  await ensureStateLoaded();
  switch (message.type) {
    case 'LOGIN':
      return login();

    case 'LOGOUT': {
      await detachDebugger();
      await apiCall('/auth/logout', { method: 'POST' });
      await clearTokens();
      return { success: true };
    }

    case 'GET_AUTH': {
      const auth = await isUserAuthenticated();
      return { isAuthenticated: auth };
    }

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

      if (result.status === 401 || result.status === 403) {
        await clearTokens();
        return {
          error: 'Your session has expired. Please sign in again.',
          status: result.status,
          authExpired: true,
        };
      }

      return { error: 'Failed to start session', status: result.status };
    }

    case 'FINISH_AND_OPEN_SIDE_PANEL':
    case 'END_SESSION': {
      if (currentSessionId) {
        const status = (message.payload as { status?: string })?.status ?? 'COMPLETED';
        await apiCall(`/v1/sessions/${currentSessionId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        }).catch(() => {});
      }

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

    case 'GET_RECORDING_STATE': {
      const auth = await isUserAuthenticated();
      return {
        sessionId: currentSessionId,
        isPaused,
        stepCount,
        isAuthenticated: auth,
      };
    }

    case 'GET_SESSION_EVENTS':
      return {
        sessionId: currentSessionId || lastSessionId,
        events: sessionEvents,
      };

    case 'EVENTS_BATCH': {
      if (isPaused || !currentSessionId) return { queued: 0 };
      const events = message.payload as unknown[];
      if (!Array.isArray(events) || events.length === 0) return { queued: 0 };

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
      await incrementStepCount(events.length); // Immediately increment stepCount and broadcast to all tabs!

      // Non-blocking background sync with backend server
      apiCall(`/v1/sessions/${currentSessionId}/events`, {
        method: 'POST',
        body: JSON.stringify({ events }),
      }).then((result) => {
        if (!result.ok) {
          enqueue(`/v1/sessions/${currentSessionId}/events`, 'POST', { events }).catch(() => {});
        }
      }).catch(() => {
        enqueue(`/v1/sessions/${currentSessionId}/events`, 'POST', { events }).catch(() => {});
      });

      return { sent: events.length };
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
      const userKeys = await chrome.storage.local.get(['userJiraUrl', 'userJiraEmail', 'userJiraToken', 'userJiraProject']);
      const payload = {
        ...(message.payload as object),
        ...(userKeys.userJiraUrl ? { userJiraUrl: userKeys.userJiraUrl } : {}),
        ...(userKeys.userJiraEmail ? { userJiraEmail: userKeys.userJiraEmail } : {}),
        ...(userKeys.userJiraToken ? { userJiraToken: userKeys.userJiraToken } : {}),
        ...(userKeys.userJiraProject ? { userJiraProject: userKeys.userJiraProject } : {}),
      };
      const result = await apiCall<{ issueKey?: string; issueUrl?: string }>('/v1/integrations/jira', { method: 'POST', body: JSON.stringify(payload) });
      if (!result.ok) {
        const detail = (result.data as any)?.detail ?? (result.data as any)?.title ?? `HTTP ${result.status}`;
        return { error: detail, detail };
      }
      return result.data;
    }

    case 'CREATE_AZURE_WORK_ITEM': {
      const userKeys = await chrome.storage.local.get(['userAzureOrg', 'userAzureProject', 'userAzurePat']);
      const payload = {
        ...(message.payload as object),
        ...(userKeys.userAzureOrg ? { userAzureOrg: userKeys.userAzureOrg } : {}),
        ...(userKeys.userAzureProject ? { userAzureProject: userKeys.userAzureProject } : {}),
        ...(userKeys.userAzurePat ? { userAzurePat: userKeys.userAzurePat } : {}),
      };
      const result = await apiCall<{ workItemId?: number; workItemUrl?: string }>('/v1/integrations/azure-devops', { method: 'POST', body: JSON.stringify(payload) });
      if (!result.ok) {
        const detail = (result.data as any)?.detail ?? (result.data as any)?.title ?? `HTTP ${result.status}`;
        return { error: detail, detail };
      }
      return result.data;
    }

    case 'SEND_SLACK_NOTIFICATION': {
      const userKeys = await chrome.storage.local.get(['userSlackWebhook']);
      const payload = {
        ...(message.payload as object),
        ...(userKeys.userSlackWebhook ? { userSlackWebhook: userKeys.userSlackWebhook } : {}),
      };
      const result = await apiCall<{ success: boolean }>('/v1/integrations/slack', { method: 'POST', body: JSON.stringify(payload) });
      if (!result.ok) {
        const detail = (result.data as any)?.detail ?? (result.data as any)?.title ?? `HTTP ${result.status}`;
        return { error: detail, detail };
      }
      return result.data;
    }

    case 'GENERATE_AI_CONTENT': {
      const { steps, networkLogs, consoleLogs, screenshots, bugUrl, testData } = (message.payload || {}) as {
        steps?: unknown[];
        networkLogs?: unknown[];
        consoleLogs?: unknown[];
        screenshots?: Array<{ stepIndex: number; dataUrl: string }>;
        bugUrl?: string;
        testData?: string;
      };
      const userKeys = await chrome.storage.local.get(['userOpenAiKey', 'userClaudeKey']);
      const openAiKey = (userKeys.userOpenAiKey as string)?.trim();
      const claudeKey = (userKeys.userClaudeKey as string)?.trim();

      // 1. Direct BYOK with OpenAI (Runs immediately from extension without backend delay/auth requirements)
      if (openAiKey) {
        try {
          const result = await generateDefectWithOpenAI(openAiKey, {
            steps: (steps as any[]) || [],
            networkLogs: (networkLogs as any[]) || [],
            consoleLogs: (consoleLogs as any[]) || [],
            screenshots: screenshots || [],
            bugUrl,
            testData,
          });
          return result;
        } catch (err: any) {
          console.warn('[BYOK OpenAI] Direct API call error:', err?.message);
          return { error: `OpenAI BYOK Error: ${err.message}` };
        }
      }

      // 2. Direct BYOK with Claude
      if (claudeKey) {
        try {
          const result = await generateDefectWithClaude(claudeKey, {
            steps: (steps as any[]) || [],
            networkLogs: (networkLogs as any[]) || [],
            consoleLogs: (consoleLogs as any[]) || [],
            screenshots: screenshots || [],
            bugUrl,
            testData,
          });
          return result;
        } catch (err: any) {
          console.warn('[BYOK Claude] Direct API call error:', err?.message);
          return { error: `Claude BYOK Error: ${err.message}` };
        }
      }

      // 3. Fallback: Call backend AI route when no personal BYOK key is configured
      const payload = {
        steps: steps || [],
        networkLogs: networkLogs || [],
        consoleLogs: consoleLogs || [],
        screenshots: screenshots || [],
        bugUrl,
        testData,
      };
      const result = await apiCall<{
        title: string;
        description: string;
        expectedResult?: string;
        actualResult?: string;
        suggestedSeverity?: string;
        stepsSummary?: string;
        recommendedMainImageIndex?: number | null;
      }>(
        '/v1/ai/generate',
        { method: 'POST', body: JSON.stringify(payload) }
      );
      if (!result.ok) {
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
      try {
        let winId = sender?.tab?.windowId;
        if (!winId) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          winId = tab?.windowId;
        }
        if (!winId) {
          const win = await chrome.windows.getCurrent();
          winId = win?.id;
        }
        if (winId) {
          await chrome.sidePanel.open({ windowId: winId });
        }
      } catch (err: any) {
        console.warn('[Background] OPEN_SIDE_PANEL error:', err?.message);
      }
      return { success: true };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
ensureStateLoaded().catch(console.error);

self.addEventListener('online', () => {
  flushQueue().catch(console.error);
});
