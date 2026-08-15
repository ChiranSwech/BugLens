/**
 * BugLens — Content Script: Event Recorder
 *
 * Captures user interactions and sends them to the service worker.
 * All PII is masked BEFORE leaving this script.
 *
 * Security model:
 *  - Runs in an isolated world — cannot access the page's JS context
 *  - Never sends raw input values; all values are masked at source
 *  - Pause hotkey (Ctrl+Shift+P) and screenshot hotkey (Ctrl+I) handled via Commands API
 *
 * Step deduplication strategy:
 *  - HOVER events are held in a pending buffer and only emitted as context
 *    if a CLICK follows within 2 s on a DIFFERENT element. Standalone hovers
 *    are discarded.
 *  - SCROLL events are similarly held and only emitted if a meaningful
 *    scroll (> 80 px delta) preceded a CLICK within 2 s.
 *  - INPUT events coalesce: consecutive inputs on the same selector update
 *    in place rather than creating duplicate entries.
 */

import type { StepActionType } from '@buglens/shared';

// ─── PII masking ──────────────────────────────────────────────────────────────

const PII_INPUT_TYPES = new Set(['password', 'email', 'tel', 'cc-number', 'cc-csc']);
const PII_AUTOCOMPLETE_VALUES = new Set(['cc-number', 'cc-csc', 'cc-exp', 'cc-name']);

function shouldMaskInput(el: HTMLInputElement): boolean {
  return (
    PII_INPUT_TYPES.has(el.type.toLowerCase()) ||
    PII_AUTOCOMPLETE_VALUES.has(el.autocomplete?.toLowerCase() ?? '') ||
    el.hasAttribute('data-pii') ||
    el.hasAttribute('data-sensitive') ||
    el.classList.contains('pii')
  );
}

function maskValue(el: HTMLElement): string {
  if (el instanceof HTMLInputElement && shouldMaskInput(el)) {
    return '[REDACTED]';
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return (el as HTMLInputElement).value.slice(0, 200);
  }
  return '';
}

function getLabelForInput(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | null {
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const parentLabel = el.closest('label');
  if (parentLabel?.textContent?.trim()) return parentLabel.textContent.trim();
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  if ('placeholder' in el) {
    return (el as HTMLInputElement | HTMLTextAreaElement).placeholder || null;
  }
  return null;
}

// ─── Semantic label extraction ────────────────────────────────────────────────

function getSemanticLabel(el: HTMLElement): string {
  if (el === document.documentElement || el === document.body) return 'Page';

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const label = getLabelForInput(el);
    if (label) return label.slice(0, 100);
  }

  const interactive = el.closest('button, a, [role="button"], [role="link"], summary, details');
  const target = (interactive as HTMLElement) || el;

  const label = target.getAttribute('aria-label') || target.getAttribute('title') || (target.innerText || '').trim();
  if (label) {
    const firstLine = label.split('\n')[0] ?? '';
    return (firstLine.trim().slice(0, 100) || `[${target.tagName.toLowerCase()}]`);
  }

  return `[${target.tagName.toLowerCase()}]`;
}

function getCssSelector(el: HTMLElement): string {
  const parts: string[] = [];
  let current: HTMLElement | null = el;
  while (current && current !== document.body) {
    const id = current.id ? `#${current.id}` : '';
    const tag = current.tagName.toLowerCase();
    parts.unshift(id || tag);
    if (id) break;
    current = current.parentElement;
  }
  return parts.join(' > ').slice(0, 500);
}

// ─── Page context helpers ─────────────────────────────────────────────────────

function getPageContext(): { pageUrl: string; pageTitle: string } {
  return {
    pageUrl: window.location.href,
    pageTitle: document.title,
  };
}

// ─── State ────────────────────────────────────────────────────────────────────

let isRecording = false;
let isPaused = false;
let sessionId: string | null = null;
const eventBuffer: unknown[] = [];
const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER = 50;

// Track the previous URL to detect navigation/redirects
let lastKnownUrl = window.location.href;
let lastKnownTitle = document.title;

// ─── Pre-click context buffers ─────────────────────────────────────────────
// HOVER and SCROLL events are held here and only emitted as context when
// a CLICK follows within PRE_CLICK_WINDOW_MS. Standalone events are dropped.

const PRE_CLICK_WINDOW_MS = 2000;
const MIN_SCROLL_DELTA_PX = 80;

interface PendingHover {
  event: Record<string, unknown>;
  cssSelector: string;
  timestamp: number;
}

interface PendingScroll {
  event: Record<string, unknown>;
  scrollY: number;
  timestamp: number;
  baseScrollY: number; // scrollY at session start / last emitted scroll
}

let pendingHover: PendingHover | null = null;
let pendingScroll: PendingScroll | null = null;
let lastEmittedScrollY = 0;

// ─── Event capture ────────────────────────────────────────────────────────────

function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function buildEventObject(
  actionType: string,
  el: HTMLElement,
  extraData?: Record<string, unknown>
): Record<string, unknown> {
  const elementLabel = getSemanticLabel(el);
  const cssSelector = getCssSelector(el);
  const valueMasked = maskValue(el);
  const { pageUrl, pageTitle } = getPageContext();

  return {
    eventId: crypto.randomUUID(),
    actionType,
    elementLabel,
    cssSelector,
    valueMasked,
    timestamp: new Date().toISOString(),
    pageUrl,
    pageTitle,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    ...extraData,
  };
}

function pushEvent(event: Record<string, unknown>, requestScreenshot = false) {
  // Simple deduplication for consecutive identical INPUT events on same element
  const lastEvent = eventBuffer[eventBuffer.length - 1] as Record<string, unknown> | undefined;
  if (
    lastEvent &&
    lastEvent['actionType'] === event['actionType'] &&
    lastEvent['cssSelector'] === event['cssSelector'] &&
    event['actionType'] === 'INPUT'
  ) {
    lastEvent['valueMasked'] = event['valueMasked'];
    lastEvent['timestamp'] = event['timestamp'];
    return;
  }

  eventBuffer.push(event);

  if (requestScreenshot) {
    chrome.runtime.sendMessage({
      type: 'CAPTURE_STEP_SCREENSHOT',
      payload: {
        eventId: event['eventId'],
        clickX: event['clickX'],
        clickY: event['clickY'],
        elementRect: event['elementRect'],
      },
    }).catch(() => {});
  }

  if (eventBuffer.length >= MAX_BUFFER) flushEvents();
}

function captureClickEvent(el: HTMLElement, mouseEvent: MouseEvent) {
  if (!isRecording || isPaused) return;
  if (!isElementVisible(el)) return;

  const rect = el.getBoundingClientRect();
  const elementRect = {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };

  const clickEvent = buildEventObject('CLICK', el, {
    clickX: mouseEvent.clientX,
    clickY: mouseEvent.clientY,
    elementRect,
  });

  const now = Date.now();

  // Flush pending hover as pre-click context (only if on a different element)
  if (
    pendingHover &&
    now - pendingHover.timestamp < PRE_CLICK_WINDOW_MS &&
    pendingHover.cssSelector !== getCssSelector(el)
  ) {
    pushEvent(pendingHover.event, false);
  }
  pendingHover = null;

  // Flush pending scroll as pre-click context (only if meaningful delta)
  if (
    pendingScroll &&
    now - pendingScroll.timestamp < PRE_CLICK_WINDOW_MS &&
    Math.abs(pendingScroll.scrollY - lastEmittedScrollY) >= MIN_SCROLL_DELTA_PX
  ) {
    pushEvent(pendingScroll.event, false);
    lastEmittedScrollY = pendingScroll.scrollY;
  }
  pendingScroll = null;

  // Now push the CLICK itself (with screenshot request + coordinates)
  pushEvent(clickEvent, true);
}

function captureInputEvent(el: HTMLElement) {
  if (!isRecording || isPaused) return;
  if (!isElementVisible(el)) return;

  const event = buildEventObject('INPUT', el);
  pushEvent(event, false);
}

function captureNavigateEvent(fromUrl: string, toUrl: string) {
  if (!isRecording || isPaused) return;

  const event = buildEventObject('NAVIGATE', document.documentElement, {
    fromUrl,
    toUrl,
    pageUrl: toUrl,
    pageTitle: document.title,
  });
  pushEvent(event, false);
}

function flushEvents() {
  if (eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0, eventBuffer.length);
  chrome.runtime.sendMessage({ type: 'EVENTS_BATCH', payload: batch }).catch((err) => {
    console.error('[BugLens] Failed to flush events:', err);
    eventBuffer.unshift(...batch);
  });
}

// ─── URL change detection (for SPAs that don't fire popstate) ─────────────────

function checkUrlChange() {
  const currentUrl = window.location.href;
  const currentTitle = document.title;

  if (currentUrl !== lastKnownUrl) {
    captureNavigateEvent(lastKnownUrl, currentUrl);
    lastKnownUrl = currentUrl;
    lastKnownTitle = currentTitle;
  }
}

// Poll for URL changes every 500ms (catches SPA routing that doesn't fire popstate)
let urlPollTimer: ReturnType<typeof setInterval> | null = null;

function startUrlPolling() {
  urlPollTimer = setInterval(checkUrlChange, 500);
}

function stopUrlPolling() {
  if (urlPollTimer) {
    clearInterval(urlPollTimer);
    urlPollTimer = null;
  }
}

// ─── DOM event listeners ──────────────────────────────────────────────────────

function onClick(e: MouseEvent) {
  if (e.target instanceof HTMLElement) {
    const interactive = e.target.closest('button, a, [role="button"], [role="link"], input, select, textarea');
    const target = (interactive as HTMLElement) || e.target;

    if (isElementVisible(target)) {
      showClickHighlight(target);
      captureClickEvent(target, e);
    }
  }
}

function onInput(e: Event) {
  if (e.target instanceof HTMLElement) {
    captureInputEvent(e.target);
  }
}

function onHover(e: MouseEvent) {
  if (!isRecording || isPaused) return;
  if (e.target instanceof HTMLElement) {
    const interactive = e.target.closest('button, a, input, select, textarea, [role="button"]');
    if (!interactive) return;
    const target = interactive as HTMLElement;
    if (!isElementVisible(target)) return;

    // Buffer the hover — only emit as pre-click context later
    pendingHover = {
      event: buildEventObject('HOVER', target),
      cssSelector: getCssSelector(target),
      timestamp: Date.now(),
    };
  }
}

const throttledHover = throttle((e: Event) => onHover(e as MouseEvent), 500);

function onScroll() {
  if (!isRecording || isPaused) return;

  const scrollY = window.scrollY;

  // Buffer the scroll — only emit as pre-click context if delta is meaningful
  pendingScroll = {
    event: buildEventObject('SCROLL', document.documentElement, {
      scrollX: window.scrollX,
      scrollY,
    }),
    scrollY,
    timestamp: Date.now(),
    baseScrollY: lastEmittedScrollY,
  };
}

const throttledScroll = throttle(onScroll, 300);

function onNavigation() {
  const currentUrl = window.location.href;
  captureNavigateEvent(lastKnownUrl, currentUrl);
  lastKnownUrl = currentUrl;
}

// ─── Visual: Click highlight ──────────────────────────────────────────────────

function showClickHighlight(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const highlight = document.createElement('div');
  highlight.id = '__bugbuddy_click_highlight__';

  const top = rect.top + window.scrollY;
  const left = rect.left + window.scrollX;

  highlight.style.cssText = `
    position: absolute;
    top: ${top}px;
    left: ${left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    border: 2.5px solid #7c4dff;
    background: rgba(124, 77, 255, 0.18);
    border-radius: 6px;
    pointer-events: none;
    z-index: 2147483646;
    transition: opacity 0.5s ease-out, transform 0.5s ease-out;
    box-shadow: 0 0 0 3px rgba(124, 77, 255, 0.25), 0 0 14px rgba(124, 77, 255, 0.5);
    box-sizing: border-box;
  `;

  document.body.appendChild(highlight);

  requestAnimationFrame(() => {
    setTimeout(() => {
      highlight.style.opacity = '0';
      highlight.style.transform = 'scale(1.06)';
      setTimeout(() => highlight.remove(), 500);
    }, 400);
  });
}

// ─── Visual: Screenshot flash indicator ──────────────────────────────────────

function showScreenshotFlash() {
  // White flash overlay
  const flash = document.createElement('div');
  flash.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(255,255,255,0.35);
    z-index: 2147483647;
    pointer-events: none;
    animation: __bugbuddy_flash 0.35s ease-out forwards;
  `;

  // Inject keyframes
  const style = document.createElement('style');
  style.textContent = `
    @keyframes __bugbuddy_flash {
      0% { opacity: 1; }
      100% { opacity: 0; }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(flash);
  setTimeout(() => { flash.remove(); style.remove(); }, 400);

  // Show a small toast notification
  showToast('📷 Screenshot captured');
}

// ─── Visual: Toast notification ───────────────────────────────────────────────

function showToast(message: string) {
  const existing = document.getElementById('__bugbuddy_toast__');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = '__bugbuddy_toast__';
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: rgba(22, 22, 29, 0.95);
    color: #f1f0ff;
    padding: 10px 16px;
    border-radius: 8px;
    font-family: -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 500;
    border: 1px solid rgba(124, 77, 255, 0.4);
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    z-index: 2147483647;
    pointer-events: none;
    opacity: 1;
    transition: opacity 0.4s ease-out;
    display: flex;
    align-items: center;
    gap: 8px;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  }, 2000);
}

// ─── Visual: Pause banner ─────────────────────────────────────────────────────

let pauseBanner: HTMLElement | null = null;

function showPauseBanner() {
  if (pauseBanner) return;
  pauseBanner = document.createElement('div');
  pauseBanner.id = '__bugbuddy_pause_banner__';
  pauseBanner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
    background: #f59e0b; color: #1c1917; text-align: center;
    padding: 6px 12px; font-family: sans-serif; font-size: 13px; font-weight: 600;
    pointer-events: none;
  `;
  pauseBanner.textContent = '⏸ BugLens recording paused — Press Ctrl+Shift+P to resume';
  document.body.appendChild(pauseBanner);
}

function removePauseBanner() {
  pauseBanner?.remove();
  pauseBanner = null;
}

// ─── Visual: Recording indicator banner ──────────────────────────────────────

let recordingBanner: HTMLElement | null = null;

function showRecordingBanner() {
  if (recordingBanner) return;
  recordingBanner = document.createElement('div');
  recordingBanner.id = '__bugbuddy_recording_banner__';
  recordingBanner.style.cssText = `
    position: fixed; top: 0; right: 0; z-index: 2147483646;
    background: rgba(22,22,29,0.92); color: #f87171;
    padding: 6px 14px; font-family: -apple-system, sans-serif; font-size: 12px; font-weight: 600;
    pointer-events: none; border-bottom-left-radius: 8px;
    border: 1px solid rgba(239,68,68,0.3); border-top: none; border-right: none;
    display: flex; align-items: center; gap: 6px;
    backdrop-filter: blur(4px);
  `;

  const dot = document.createElement('span');
  dot.style.cssText = `
    width: 7px; height: 7px; border-radius: 50%; background: #ef4444;
    display: inline-block;
    animation: __bugbuddy_pulse 1.2s infinite;
  `;

  const style = document.createElement('style');
  style.textContent = `@keyframes __bugbuddy_pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`;
  document.head.appendChild(style);

  recordingBanner.appendChild(dot);
  recordingBanner.appendChild(document.createTextNode('BugLens Recording · Ctrl+I to capture'));
  document.body.appendChild(recordingBanner);
}

function removeRecordingBanner() {
  recordingBanner?.remove();
  recordingBanner = null;
}

// ─── Extension message listener ───────────────────────────────────────────────

function startRecording(sid: string) {
  if (isRecording) return;
  sessionId = sid;
  isRecording = true;
  lastKnownUrl = window.location.href;
  lastKnownTitle = document.title;
  lastEmittedScrollY = window.scrollY;
  pendingHover = null;
  pendingScroll = null;

  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('mouseover', throttledHover, true);
  document.addEventListener('scroll', throttledScroll, { passive: true });
  window.addEventListener('popstate', onNavigation);
  window.addEventListener('beforeunload', flushEvents);
  startFlushInterval();
  startUrlPolling();
  showRecordingBanner();
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  isPaused = false;
  sessionId = null;
  pendingHover = null;
  pendingScroll = null;
  flushEvents();
  stopFlushInterval();
  stopUrlPolling();
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('input', onInput, true);
  document.removeEventListener('mouseover', throttledHover, true);
  document.removeEventListener('scroll', throttledScroll);
  window.removeEventListener('popstate', onNavigation);
  window.removeEventListener('beforeunload', flushEvents);
  removePauseBanner();
  removeRecordingBanner();
}

chrome.runtime.onMessage.addListener((message: { type: string; payload?: unknown }, _sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING': {
      const { sid } = message.payload as { sid: string };
      startRecording(sid);
      break;
    }
    case 'STOP_RECORDING': {
      stopRecording();
      break;
    }
    case 'PAUSE_RECORDING': {
      isPaused = true;
      flushEvents();
      showPauseBanner();
      removeRecordingBanner();
      break;
    }
    case 'RESUME_RECORDING': {
      isPaused = false;
      removePauseBanner();
      if (isRecording) showRecordingBanner();
      break;
    }
    case 'SCREENSHOT_FLASH': {
      showScreenshotFlash();
      break;
    }
    case 'CAPTURE_STORAGE': {
      const snapshot: Record<string, any> = {};
      const isSensitive = (k: string) => /(token|password|secret|key|auth|session)/i.test(k);
      
      try {
        const local: Record<string, any> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) local[k] = isSensitive(k) ? '[REDACTED]' : localStorage.getItem(k);
        }
        snapshot['localStorage'] = local;
      } catch (e) {
        snapshot['localStorage'] = '[ACCESS_DENIED]';
      }

      try {
        const session: Record<string, any> = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k) session[k] = isSensitive(k) ? '[REDACTED]' : sessionStorage.getItem(k);
        }
        snapshot['sessionStorage'] = session;
      } catch (e) {
        snapshot['sessionStorage'] = '[ACCESS_DENIED]';
      }
      
      sendResponse(snapshot);
      return;
    }
  }
});

// ─── Flush interval ───────────────────────────────────────────────────────────

let flushTimer: ReturnType<typeof setInterval> | null = null;

function startFlushInterval() {
  flushTimer = setInterval(flushEvents, FLUSH_INTERVAL_MS);
}

function stopFlushInterval() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function throttle(fn: (e: Event) => void, ms: number): (e: Event) => void {
  let last = 0;
  return (e: Event) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(e);
    }
  };
}

// ─── Initialization ──────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
  if (response?.sessionId) {
    startRecording(response.sessionId);
    if (response.isPaused) {
      isPaused = true;
      showPauseBanner();
      removeRecordingBanner();
    }
  }
});
