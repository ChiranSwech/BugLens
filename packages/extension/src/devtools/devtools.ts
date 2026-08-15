/**
 * BugLens — DevTools Panel Script
 *
 * Creates a "BugLens" panel inside Chrome DevTools.
 * When the panel is shown, it bridges the DevTools tab context
 * to the background service worker so network logs captured
 * via chrome.debugger are surfaced in a real panel UI.
 */

// Create the devtools panel
chrome.devtools.panels.create(
  'BugLens',
  '', // no icon path — use text label
  'src/devtools/panel.html',
  (panel) => {
    let panelWindow: Window | null = null;

    panel.onShown.addListener((win) => {
      panelWindow = win;
      // Send a "panel ready" message to the background so it can push updates
      chrome.runtime.sendMessage({ type: 'DEVTOOLS_PANEL_OPENED', payload: { tabId: chrome.devtools.inspectedWindow.tabId } });
    });

    panel.onHidden.addListener(() => {
      panelWindow = null;
    });

    // Relay messages from background → panel window
    chrome.runtime.onMessage.addListener((message) => {
      if (panelWindow && message.type === 'STEP_COUNT_UPDATED') {
        try {
          (panelWindow as Window & { __buglensUpdate?: (m: unknown) => void; __bugbuddyUpdate?: (m: unknown) => void }).__buglensUpdate?.(message) ?? (panelWindow as Window & { __bugbuddyUpdate?: (m: unknown) => void }).__bugbuddyUpdate?.(message);
        } catch { /* panel may not be ready */ }
      }
    });
  }
);
