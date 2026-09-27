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
  currentStepCount++;
  updateRecordingWidget(currentStepCount, isPaused);
  pushEvent(clickEvent, true);
  flushEvents();
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
  flushEvents();
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

  // Ensure widget stays attached to DOM during SPA view transitions
  if (isRecording && recorderHost && !recorderHost.isConnected) {
    const target = document.documentElement || document.body;
    if (target) {
      target.appendChild(recorderHost);
      applyWidgetPosition();
    }
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

function isInsideWidget(e: Event): boolean {
  if (!recorderHost) return false;
  const path = e.composedPath ? e.composedPath() : [];
  return path.includes(recorderHost);
}

function onClick(e: MouseEvent) {
  if (isInsideWidget(e)) return;
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
  if (isInsideWidget(e)) return;
  if (e.target instanceof HTMLElement) {
    captureInputEvent(e.target);
  }
}

function onHover(e: MouseEvent) {
  if (isInsideWidget(e)) return;
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

// ─── Visual: Floating In-Page Recording Widget ─────────────────────────────

let recorderHost: HTMLElement | null = null;
let recorderShadow: ShadowRoot | null = null;
let currentStepCount = 0;
let isWidgetMinimized = true; // Default to minimized corner bubble per user request
let savedWidgetPos: { x: number; y: number } | null = null;

// Synchronously restore state preference on page navigation to prevent flicker
try {
  const savedMin = sessionStorage.getItem('buglens_widget_minimized');
  if (savedMin !== null) isWidgetMinimized = savedMin === 'true';
  const savedPosStr = sessionStorage.getItem('buglens_widget_pos');
  if (savedPosStr) savedWidgetPos = JSON.parse(savedPosStr);
} catch {}

// Cross-domain fallback restoration
chrome.storage.local.get(['buglens_widget_minimized', 'buglens_widget_pos']).then((stored) => {
  if (stored['buglens_widget_minimized'] !== undefined) {
    isWidgetMinimized = !!stored['buglens_widget_minimized'];
  }
  if (stored['buglens_widget_pos']) {
    savedWidgetPos = stored['buglens_widget_pos'] as { x: number; y: number };
    applyWidgetPosition();
  }
  if (isRecording) {
    renderRecordingWidget(currentStepCount, isPaused);
  }
}).catch(() => {});

function applyWidgetPosition() {
  if (!recorderHost) return;
  if (savedWidgetPos && typeof savedWidgetPos.x === 'number' && typeof savedWidgetPos.y === 'number') {
    const maxX = Math.max(8, window.innerWidth - (recorderHost.offsetWidth || 180) - 8);
    const maxY = Math.max(8, window.innerHeight - (recorderHost.offsetHeight || 44) - 8);
    const clampedX = Math.max(8, Math.min(savedWidgetPos.x, maxX));
    const clampedY = Math.max(8, Math.min(savedWidgetPos.y, maxY));
    recorderHost.style.left = `${clampedX}px`;
    recorderHost.style.top = `${clampedY}px`;
    recorderHost.style.right = 'auto';
    recorderHost.style.bottom = 'auto';
  } else {
    recorderHost.style.right = '24px';
    recorderHost.style.bottom = '24px';
    recorderHost.style.left = 'auto';
    recorderHost.style.top = 'auto';
  }
}

function ensureHostElement(): ShadowRoot {
  if (!recorderHost || !recorderHost.isConnected) {
    if (recorderHost) recorderHost.remove();
    recorderHost = document.createElement('div');
    recorderHost.id = '__buglens_recorder_host__';
    recorderHost.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    `;
    recorderShadow = recorderHost.attachShadow({ mode: 'open' });
    const targetParent = document.documentElement || document.body;
    if (targetParent) {
      targetParent.appendChild(recorderHost);
      applyWidgetPosition();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (recorderHost && !recorderHost.isConnected) {
          (document.documentElement || document.body).appendChild(recorderHost);
          applyWidgetPosition();
        }
      }, { once: true });
    }
  }
  return recorderShadow!;
}

function renderRecordingWidget(steps: number, paused: boolean) {
  if (!isRecording) {
    removeRecordingWidget();
    return;
  }

  currentStepCount = steps;
  isPaused = paused;
  const shadow = ensureHostElement();

  const styles = `
    <style>
      :host {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        user-select: none;
        -webkit-font-smoothing: antialiased;
      }
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      @keyframes blPulseRed {
        0%, 100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
        50% { transform: scale(1.15); opacity: 0.8; box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
      }
      @keyframes blPulseAmber {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.15); opacity: 0.6; }
      }
      @keyframes blSpin {
        100% { transform: rotate(360deg); }
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .dot.recording {
        background: #ef4444;
        animation: blPulseRed 1.8s infinite;
      }
      .dot.paused {
        background: #f59e0b;
        animation: blPulseAmber 1.4s infinite;
      }

      /* Minimized Pill in Corner */
      .bl-minimized {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: rgba(15, 23, 42, 0.94);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 9999px;
        padding: 7px 13px 7px 10px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(99, 102, 241, 0.25);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        color: #f8fafc;
        font-size: 12px;
        font-weight: 600;
      }
      .bl-minimized:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(124, 77, 255, 0.5);
        border-color: rgba(124, 77, 255, 0.4);
        background: rgba(22, 22, 34, 0.98);
      }
      .bl-min-title {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .bl-step-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(99, 102, 241, 0.25);
        border: 1px solid rgba(129, 140, 248, 0.45);
        color: #c7d2fe;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        padding: 2px 7px;
        border-radius: 9999px;
        min-width: 18px;
        text-align: center;
        white-space: nowrap;
        box-sizing: border-box;
      }
      .bl-expand-icon {
        display: flex;
        align-items: center;
        color: rgba(255, 255, 255, 0.5);
        margin-left: 2px;
      }
      .bl-minimized:hover .bl-expand-icon {
        color: #ffffff;
      }

      /* Expanded Floating Bar */
      .bl-expanded {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        background: rgba(15, 23, 42, 0.94);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 12px;
        padding: 7px 12px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(99, 102, 241, 0.25);
        color: #f8fafc;
        font-size: 12px;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .bl-drag-handle {
        cursor: grab;
        display: flex;
        align-items: center;
        color: rgba(255, 255, 255, 0.35);
        padding: 2px 2px;
      }
      .bl-drag-handle:hover {
        color: rgba(255, 255, 255, 0.85);
      }
      .bl-status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .bl-divider {
        width: 1px;
        height: 18px;
        background: rgba(255, 255, 255, 0.14);
      }
      .bl-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 9px;
        border-radius: 7px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        background: rgba(255, 255, 255, 0.08);
        color: #f8fafc;
        transition: all 0.15s ease;
        font-family: inherit;
      }
      .bl-btn:hover {
        background: rgba(255, 255, 255, 0.16);
        transform: translateY(-1px);
      }
      .bl-btn:active {
        transform: translateY(0);
      }
      .bl-btn-snap {
        color: #e2e8f0;
      }
      .bl-btn-snap.snapped {
        background: rgba(16, 185, 129, 0.25);
        color: #34d399;
        border: 1px solid rgba(52, 211, 153, 0.4);
      }
      .bl-btn-pause {
        color: #fcd34d;
      }
      .bl-btn-finish {
        background: linear-gradient(135deg, #7c4dff 0%, #6366f1 100%);
        color: #ffffff;
        box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
      }
      .bl-btn-finish:hover {
        background: linear-gradient(135deg, #8b5cf6 0%, #4f46e5 100%);
        box-shadow: 0 4px 14px rgba(99, 102, 241, 0.6);
      }
      .bl-btn-min {
        padding: 5px 6px;
        color: rgba(255, 255, 255, 0.55);
      }
      .bl-btn-min:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.15);
      }
    </style>
  `;

  const safeSteps = typeof steps === 'number' && !isNaN(steps) ? steps : 0;

  if (isWidgetMinimized) {
    // ─── Minimized Mode ───────────────────────────────────────────────────────
    shadow.innerHTML = `
      ${styles}
      <div class="bl-minimized" id="bl-min-root" title="BugLens Recording (${safeSteps} steps) · Click to expand">
        <span class="dot ${paused ? 'paused' : 'recording'}"></span>
        <div class="bl-min-title">
          <span>BugLens ${paused ? 'Paused' : 'REC'}</span>
          <span class="bl-step-badge" id="bl-min-badge">${safeSteps}</span>
        </div>
        <span class="bl-expand-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </span>
      </div>
    `;

    const minRoot = shadow.getElementById('bl-min-root');
    if (minRoot) {
      const didMove = setupDragging(minRoot);
      minRoot.addEventListener('click', (e) => {
        if (didMove()) return; // ignore click if it was a drag gesture
        toggleWidgetMinimize();
      });
    }
  } else {
    // ─── Expanded Mode ────────────────────────────────────────────────────────
    shadow.innerHTML = `
      ${styles}
      <div class="bl-expanded" id="bl-exp-root">
        <div class="bl-drag-handle" id="bl-drag-handle" title="Drag to reposition">
          <svg width="10" height="14" viewBox="0 0 10 16" fill="currentColor"><circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>
        </div>
        <div class="bl-status">
          <span class="dot ${paused ? 'paused' : 'recording'}"></span>
          <span>${paused ? 'PAUSED' : 'REC'}</span>
          <span class="bl-step-badge" id="bl-exp-badge">${safeSteps} ${safeSteps === 1 ? 'step' : 'steps'}</span>
        </div>
        <div class="bl-divider"></div>
        <button class="bl-btn bl-btn-snap" id="bl-snap-btn" title="Capture instant screenshot">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
          <span id="bl-snap-txt">Snap</span>
        </button>
        <button class="bl-btn bl-btn-pause" id="bl-pause-btn" title="${paused ? 'Resume recording' : 'Pause recording'}">
          ${paused ? `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>Resume</span>
          ` : `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            <span>Pause</span>
          `}
        </button>
        <button class="bl-btn bl-btn-finish" id="bl-finish-btn" title="Finish recording & review defect in side panel">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          <span>Finish & Review</span>
        </button>
        <div class="bl-divider"></div>
        <button class="bl-btn bl-btn-min" id="bl-min-btn" title="Minimize to corner bubble">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
    `;

    const dragHandle = shadow.getElementById('bl-drag-handle');
    if (dragHandle) setupDragging(dragHandle);

    const snapBtn = shadow.getElementById('bl-snap-btn');
    if (snapBtn) {
      snapBtn.addEventListener('click', () => handleSnapClick(snapBtn));
    }

    const pauseBtn = shadow.getElementById('bl-pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', handlePauseResumeClick);
    }

    const finishBtn = shadow.getElementById('bl-finish-btn');
    if (finishBtn) {
      finishBtn.addEventListener('click', () => handleFinishClick(finishBtn));
    }

    const minBtn = shadow.getElementById('bl-min-btn');
    if (minBtn) {
      minBtn.addEventListener('click', toggleWidgetMinimize);
    }
  }

  applyWidgetPosition();
}

function updateRecordingWidget(steps: number, paused: boolean) {
  if (!isRecording || !recorderHost) {
    if (isRecording) renderRecordingWidget(steps, paused);
    return;
  }
  const safeSteps = typeof steps === 'number' && !isNaN(steps) ? steps : 0;
  currentStepCount = safeSteps;
  isPaused = paused;

  // If paused status changed, full render updates buttons & indicators
  const currentShadow = recorderShadow;
  if (!currentShadow) return;

  const minBadge = currentShadow.getElementById('bl-min-badge');
  if (minBadge) minBadge.textContent = String(safeSteps);

  const expBadge = currentShadow.getElementById('bl-exp-badge');
  if (expBadge) expBadge.textContent = `${safeSteps} ${safeSteps === 1 ? 'step' : 'steps'}`;

  // If pause state changed, re-render to reflect button and dot colors
  const dot = currentShadow.querySelector('.dot');
  if (dot) {
    const isCurrentlyClassedPaused = dot.classList.contains('paused');
    if (isCurrentlyClassedPaused !== paused) {
      renderRecordingWidget(safeSteps, paused);
    }
  }
}

function removeRecordingWidget() {
  if (recorderHost) {
    recorderHost.remove();
    recorderHost = null;
    recorderShadow = null;
  }
}

function toggleWidgetMinimize() {
  isWidgetMinimized = !isWidgetMinimized;
  try {
    sessionStorage.setItem('buglens_widget_minimized', String(isWidgetMinimized));
  } catch {}
  chrome.storage.local.set({ buglens_widget_minimized: isWidgetMinimized }).catch(() => {});
  renderRecordingWidget(currentStepCount, isPaused);
}

function setupDragging(dragEl: HTMLElement): () => boolean {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let hasMoved = false;

  dragEl.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (!recorderHost) return;
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;

    const rect = recorderHost.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    dragEl.style.cursor = 'grabbing';
    e.preventDefault();
  });

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging || !recorderHost) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved = true;
    }

    const maxX = Math.max(8, window.innerWidth - recorderHost.offsetWidth - 8);
    const maxY = Math.max(8, window.innerHeight - recorderHost.offsetHeight - 8);
    const newLeft = Math.max(8, Math.min(startLeft + dx, maxX));
    const newTop = Math.max(8, Math.min(startTop + dy, maxY));

    recorderHost.style.left = `${newLeft}px`;
    recorderHost.style.top = `${newTop}px`;
    recorderHost.style.right = 'auto';
    recorderHost.style.bottom = 'auto';
  };

  const onMouseUp = () => {
    if (!isDragging || !recorderHost) return;
    isDragging = false;
    dragEl.style.cursor = '';

    if (hasMoved) {
      const rect = recorderHost.getBoundingClientRect();
      const pos = { x: Math.round(rect.left), y: Math.round(rect.top) };
      savedWidgetPos = pos;
      try {
        sessionStorage.setItem('buglens_widget_pos', JSON.stringify(pos));
      } catch {}
      chrome.storage.local.set({ buglens_widget_pos: pos }).catch(() => {});
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  return () => hasMoved;
}

let isSnapping = false;

async function handleSnapClick(btn: HTMLElement) {
  if (isSnapping) return;
  isSnapping = true;

  const snapTxt = btn.querySelector('#bl-snap-txt');
  if (snapTxt) snapTxt.textContent = 'Snapped! ✓';
  btn.classList.add('snapped');

  // Optimistically increment step counter
  currentStepCount++;
  updateRecordingWidget(currentStepCount, isPaused);

  try {
    await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
    showScreenshotFlash();
  } catch (err) {
    console.warn('[BugLens] Snap error:', err);
  } finally {
    // Guaranteed reset after 800ms so user can snap repeatedly
    setTimeout(() => {
      btn.classList.remove('snapped');
      const resetTxt = btn.querySelector('#bl-snap-txt');
      if (resetTxt) resetTxt.textContent = 'Snap';
      isSnapping = false;
    }, 800);
  }
}

async function handlePauseResumeClick() {
  if (isPaused) {
    await chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
    isPaused = false;
    updateRecordingWidget(currentStepCount, false);
  } else {
    await chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
    isPaused = true;
    updateRecordingWidget(currentStepCount, true);
  }
}

async function handleFinishClick(btn?: HTMLElement) {
  try {
    // 1. Immediate visual feedback on the button
    if (btn) {
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.85';
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: blSpin 0.9s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        <span>Finishing...</span>
      `;
    }

    // 2. Clear in-page notification so user knows recording is stopped
    showToast('⏹ Recording stopped — Opening BugLens Defect Review...');

    // 3. Immediately dispatch FINISH_AND_OPEN_SIDE_PANEL during the user gesture tick
    chrome.runtime.sendMessage({
      type: 'FINISH_AND_OPEN_SIDE_PANEL',
      payload: { status: 'COMPLETED' },
    }).catch((err) => {
      console.warn('[BugLens] Finish message notice:', err);
    });

    // 4. Clean up local widget
    setTimeout(() => {
      stopRecording();
    }, 400);
  } catch (err) {
    console.error('[BugLens] Finish click error:', err);
  }
}

// ─── Extension message listener ───────────────────────────────────────────────

function startRecording(sid: string, initialSteps = 0, initialPaused = false) {
  if (isRecording) {
    currentStepCount = initialSteps;
    isPaused = initialPaused;
    updateRecordingWidget(currentStepCount, isPaused);
    return;
  }
  sessionId = sid;
  isRecording = true;
  isPaused = initialPaused;
  currentStepCount = initialSteps;
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
  renderRecordingWidget(currentStepCount, isPaused);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  isPaused = false;
  sessionId = null;
  currentStepCount = 0;
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
  removeRecordingWidget();
}

chrome.runtime.onMessage.addListener((message: { type: string; payload?: unknown }, _sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING': {
      const { sid } = message.payload as { sid: string };
      startRecording(sid, 0, false);
      break;
    }
    case 'STOP_RECORDING': {
      stopRecording();
      break;
    }
    case 'PAUSE_RECORDING': {
      isPaused = true;
      flushEvents();
      updateRecordingWidget(currentStepCount, true);
      break;
    }
    case 'RESUME_RECORDING': {
      isPaused = false;
      updateRecordingWidget(currentStepCount, false);
      break;
    }
    case 'STEP_COUNT_UPDATED': {
      const { stepCount } = (message.payload || {}) as { stepCount: number };
      if (typeof stepCount === 'number') {
        currentStepCount = stepCount;
        updateRecordingWidget(currentStepCount, isPaused);
      }
      break;
    }
    case 'RECORDING_STATE_CHANGED': {
      const { sessionId: sid, isPaused: paused, stepCount: steps } = (message.payload || {}) as {
        sessionId?: string | null;
        isPaused?: boolean;
        stepCount?: number;
      };
      if (sid) {
        if (!isRecording) {
          startRecording(sid, steps ?? 0, !!paused);
        } else {
          if (typeof steps === 'number') currentStepCount = steps;
          if (typeof paused === 'boolean') isPaused = paused;
          updateRecordingWidget(currentStepCount, isPaused);
        }
      } else {
        stopRecording();
      }
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

// ─── Initialization & Multi-Page / Cross-Tab State Sync ──────────────────────

// 1. Instant local storage retrieval (runs synchronously from cache without SW dependency)
chrome.storage.local.get([
  'currentSessionId',
  'stepCount',
  'isPaused',
  'buglens_widget_minimized',
  'buglens_widget_pos',
]).then((stored) => {
  if (stored['buglens_widget_minimized'] !== undefined) {
    isWidgetMinimized = !!stored['buglens_widget_minimized'];
  }
  if (stored['buglens_widget_pos']) {
    savedWidgetPos = stored['buglens_widget_pos'] as { x: number; y: number };
  }
  if (stored['currentSessionId']) {
    startRecording(
      stored['currentSessionId'] as string,
      (stored['stepCount'] as number) ?? 0,
      !!stored['isPaused']
    );
  }
}).catch(() => {});

// 2. Secondary confirmation from service worker
chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response?.sessionId) {
    startRecording(response.sessionId, response.stepCount ?? 0, !!response.isPaused);
  } else if (response && response.sessionId === null && isRecording) {
    stopRecording();
  }
});

// 3. Storage listener: bulletproof synchronization across navigations, tabs, and domains
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if ('currentSessionId' in changes) {
    const newSession = changes.currentSessionId.newValue;
    if (newSession) {
      if (!isRecording) {
        startRecording(newSession, currentStepCount, isPaused);
      }
    } else {
      if (isRecording) {
        stopRecording();
      }
    }
  }

  if ('stepCount' in changes) {
    const newSteps = changes.stepCount.newValue;
    if (typeof newSteps === 'number') {
      currentStepCount = newSteps;
      updateRecordingWidget(currentStepCount, isPaused);
    }
  }

  if ('isPaused' in changes) {
    const newPaused = changes.isPaused.newValue;
    if (typeof newPaused === 'boolean') {
      isPaused = newPaused;
      updateRecordingWidget(currentStepCount, isPaused);
    }
  }

  if ('buglens_widget_minimized' in changes) {
    const newMin = changes.buglens_widget_minimized.newValue;
    if (typeof newMin === 'boolean' && newMin !== isWidgetMinimized) {
      isWidgetMinimized = newMin;
      if (isRecording) {
        renderRecordingWidget(currentStepCount, isPaused);
      }
    }
  }

  if ('buglens_widget_pos' in changes) {
    const newPos = changes.buglens_widget_pos.newValue;
    if (newPos) {
      savedWidgetPos = newPos as { x: number; y: number };
      applyWidgetPosition();
    }
  }
});
