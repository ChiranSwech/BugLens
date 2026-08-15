import React, { useEffect, useState, useRef, useCallback } from 'react';
import { BugLensLogo } from '../components/BugLensLogo';
import './sidepanel.css';

// ── Types ────────────────────────────────────────────────────────────────────

interface CapturedEvent {
  actionType: string;
  elementLabel: string;
  timestamp: string;
  valueMasked?: string;
  cssSelector?: string;
  pageUrl?: string;
  pageTitle?: string;
  fromUrl?: string;
  toUrl?: string;
  scrollY?: number;
}

interface NetworkLog {
  id: string;
  method: string;
  url: string;
  status: number | null;
  type: string;
  duration: number | null;
  startTime: number;
  failed: boolean;
  errorText?: string;
  responseBody?: string;
}

type TabId = 'steps' | 'replay' | 'annotator' | 'network' | 'report';
type Tool = 'arrow' | 'rect' | 'text' | 'blur';
const COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#ffffff'];
const ACTION_ICONS: Record<string, string> = {
  CLICK: '🖱️', INPUT: '⌨️', NAVIGATE: '🔗', SCROLL: '📜', HOVER: '👆',
};
const SEV_COLORS: Record<string, string> = {
  P0: '#ef4444', P1: '#f97316', P2: '#f59e0b', P3: '#3b82f6', P4: '#6b7280',
};

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Re-encodes a data URL as JPEG at reduced quality so screenshots don't
 * cause HTTP 413 when sent as inline base64 in the bug payload.
 *
 * Raw PNG from captureVisibleTab: ~600 KB – 2 MB
 * After compression at q=0.72: typically 80–200 KB
 */
async function compressScreenshot(
  dataUrl: string,
  maxBytes = 800_000,
  quality = 0.72
): Promise<string | null> {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(dataUrl), 2000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0);
        const compressed = canvas.toDataURL('image/jpeg', quality);
        const approxBytes = Math.round((compressed.length * 3) / 4);
        if (approxBytes > maxBytes) {
          console.warn(`[BugLens] Screenshot too large after compression (${approxBytes} bytes), skipping`);
          resolve(null);
          return;
        }
        resolve(compressed);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = dataUrl;
  });
}

const formatStepsOnSeparateLines = (text: string): string => {
  if (!text) return '';
  // Replace spaces followed by a number and a dot with a newline and the number
  const formatted = text.replace(/\s+(\d+\.)/g, '\n$1');
  return formatted
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
};

// ── Main Component ────────────────────────────────────────────────────────────

export const SidePanel: React.FC = () => {
  const [tab, setTab] = useState<TabId>('steps');
  const [events, setEvents] = useState<CapturedEvent[]>([]);
  const [screenshots, setScreenshots] = useState<Record<number, string>>({});
  const [networkLogs, setNetworkLogs] = useState<NetworkLog[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<any[]>([]);
  const [storageSnapshot, setStorageSnapshot] = useState<Record<string, any>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Report form
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('P2');
  const [expectedResult, setExpectedResult] = useState('');
  const [actualResult, setActualResult] = useState('');
  const [bugUrl, setBugUrl] = useState('');
  const [testData, setTestData] = useState('');
  const [testSummary, setTestSummary] = useState('');
  const [mainImageIndex, setMainImageIndex] = useState<number | null>(null);
  const [attachNetwork, setAttachNetwork] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedSteps, setCopiedSteps] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [customApiUrl, setCustomApiUrl] = useState('');

  useEffect(() => {
    chrome.storage.local.get(['customApiBase', 'customApiUrl'], (res) => {
      if (res?.customApiBase) setCustomApiUrl(res.customApiBase);
      else if (res?.customApiUrl) setCustomApiUrl(res.customApiUrl);
    });
  }, []);

  const handleSaveSettings = useCallback(() => {
    const cleanUrl = customApiUrl.trim();
    chrome.storage.local.set({ customApiBase: cleanUrl, customApiUrl: cleanUrl }, () => {
      setShowSettings(false);
    });
  }, [customApiUrl]);
  // Integration toggles
  const [jiraChecked, setJiraChecked] = useState(false);
  const [jiraIssueType, setJiraIssueType] = useState<'Bug' | 'Task' | 'Story' | 'Improvement'>('Bug');
  const [slackChecked, setSlackChecked] = useState(false);
  const [slackChannel, setSlackChannel] = useState('#bugs');
  const [azureChecked, setAzureChecked] = useState(false);
  const [azureWorkItemType, setAzureWorkItemType] = useState<'Bug' | 'Task' | 'User Story' | 'Feature'>('Bug');
  const [integrationResults, setIntegrationResults] = useState<string[]>([]);

  // Integration direct states
  const [jiraSubmitting, setJiraSubmitting] = useState(false);
  const [jiraResult, setJiraResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [slackSubmitting, setSlackSubmitting] = useState(false);
  const [slackResult, setSlackResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [azureSubmitting, setAzureSubmitting] = useState(false);
  const [azureResult, setAzureResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // AI Triage State
  const [triageResult, setTriageResult] = useState<{
    rootCause: string;
    technicalSummary: string;
    suggestedFix: string;
    affectedComponent: 'FRONTEND' | 'BACKEND' | 'EXTERNAL_API';
    confidenceScore: number;
  } | null>(null);
  const [isTriaging, setIsTriaging] = useState(false);

  // Session Replay State
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replaySpeed, setReplaySpeed] = useState<0.5 | 1 | 2 | 4>(1);
  const [isExportingVideo, setIsExportingVideo] = useState(false);

  // Annotator
  const [annotatorImage, setAnnotatorImage] = useState<string | null>(null);
  const [annotatorStep, setAnnotatorStep] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>('rect');
  const [activeColor, setActiveColor] = useState<string>(COLORS[0] ?? '#ef4444');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const snapshot = useRef<ImageData | null>(null);
  const history = useRef<ImageData[]>([]);

  // ── Replay playback timer ────────────────────────────────────────────────
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (isReplaying && events.length > 0) {
      const intervalMs = Math.max(200, 1500 / replaySpeed);
      timer = setInterval(() => {
        setReplayIndex((prev) => {
          if (prev >= events.length - 1) {
            setIsReplaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, intervalMs);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isReplaying, replaySpeed, events.length]);

  // ── AI Root Cause Triage Handler ──────────────────────────────────────────
  const runTriage = async () => {
    setIsTriaging(true);
    setError(null);
    try {
      const payload = {
        steps: events,
        networkLogs: networkLogs.filter(n => n.failed || (n.status && n.status >= 400)),
        consoleLogs: consoleLogs.filter(c => c.type === 'error' || c.type === 'exception'),
        bugUrl,
        testData,
      };
      const res = await chrome.runtime.sendMessage({
        type: 'API_REQUEST',
        payload: { url: '/v1/ai/triage', options: { method: 'POST', body: JSON.stringify(payload) } },
      });

      if (res?.data) {
        setTriageResult(res.data);
      } else if (res?.error) {
        setError(res.error);
      }
    } catch (err: any) {
      setError(err.message || 'Triage analysis failed');
    } finally {
      setIsTriaging(false);
    }
  };

  // ── Export Session Video Handler ─────────────────────────────────────────
  const exportSessionVideo = async () => {
    if (events.length === 0) return;
    setIsExportingVideo(true);
    try {
      const width = 800;
      const height = 450;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;

      const stream = canvas.captureStream(30);
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: Blob[] = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const filename = `session-recording-${Date.now()}.webm`;
        await chrome.downloads.download({ url, filename, saveAs: true });
        URL.revokeObjectURL(url);
        setIsExportingVideo(false);
      };

      mediaRecorder.start();

      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        const shotUrl = screenshots[i];

        ctx.fillStyle = '#090d16';
        ctx.fillRect(0, 0, width, height);

        if (shotUrl) {
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              const scale = Math.min(width / img.width, (height - 60) / img.height);
              const x = (width - img.width * scale) / 2;
              const y = 50 + (height - 60 - img.height * scale) / 2;
              ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = shotUrl;
          });
        }

        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, width, 46);
        ctx.strokeStyle = '#374151';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, 46);
        ctx.lineTo(width, 46);
        ctx.stroke();

        ctx.fillStyle = '#6366f1';
        ctx.beginPath();
        ctx.arc(24, 23, 13, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${i + 1}`, 24, 27);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#f9fafb';
        ctx.font = 'bold 13px sans-serif';
        const actionStr = (ev.actionType || 'CLICK').toUpperCase();
        const labelStr = ev.elementLabel ? ` — ${ev.elementLabel.slice(0, 45)}` : '';
        ctx.fillText(`${actionStr}${labelStr}`, 46, 27);

        if (ev.pageUrl) {
          ctx.fillStyle = '#9ca3af';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(ev.pageUrl.slice(0, 40), width - 16, 27);
        }

        await new Promise((r) => setTimeout(r, 1200));
      }

      mediaRecorder.stop();
    } catch (err) {
      console.error('[BugLens] Export video error:', err);
      setIsExportingVideo(false);
    }
  };

  // Network filter
  const [netSearch, setNetSearch] = useState('');
  const [showFailedOnly, setShowFailedOnly] = useState(false);

  // Load data
  const loadData = useCallback(async () => {
    const evRes = await chrome.runtime.sendMessage({ type: 'GET_SESSION_EVENTS' });
    if (evRes?.events) {
      setEvents(evRes.events);
      setSessionId(evRes.sessionId);
      
      // Auto-extract test data from INPUT events if testData is empty
      // Keep only the LAST input event for each unique field (grouped by elementLabel or cssSelector)
      const inputEventsMap = new Map<string, any>();
      evRes.events.forEach((e: any) => {
        if (e.actionType === 'INPUT' && e.valueMasked) {
          const key = e.elementLabel || e.cssSelector || 'Unknown Input';
          inputEventsMap.set(key, e);
        }
      });
      const uniqueInputEvents = Array.from(inputEventsMap.values());
      if (uniqueInputEvents.length > 0) {
        setTestData(prev => {
          if (prev) return prev;
          return uniqueInputEvents.map((e: any) => `${e.elementLabel || 'Input'}: ${e.valueMasked}`).join('\n');
        });
      }

      // Prefill testSummary (Test Summary) with fallback tester-formatted steps if empty
      setTestSummary(prev => {
        if (prev) return prev;
        return evRes.events.map((ev: any, i: number) => {
          const target = ev.elementLabel || 'element';
          const action = (ev.actionType || 'CLICK').toUpperCase();
          if (action === 'CLICK') return `${i + 1}. Click on the "${target}".`;
          if (action === 'INPUT') {
            const val = ev.valueMasked && ev.valueMasked !== '[REDACTED]' ? ` "${ev.valueMasked}"` : '';
            return `${i + 1}. Enter${val} in the "${target}" field.`;
          }
          if (action === 'NAVIGATE') return `${i + 1}. Navigate to the next page.`;
          if (action === 'SCROLL') return `${i + 1}. Scroll the page.`;
          if (action === 'HOVER') return `${i + 1}. Hover over "${target}".`;
          return `${i + 1}. Perform ${ev.actionType || 'action'} on "${target}".`;
        }).join('\n');
      });
    }
    const ssRes = await chrome.runtime.sendMessage({ type: 'GET_SCREENSHOTS' });
    if (ssRes?.screenshots) setScreenshots(ssRes.screenshots);
    const netRes = await chrome.runtime.sendMessage({ type: 'GET_NETWORK_LOGS' });
    if (netRes?.logs) setNetworkLogs(netRes.logs);
    const consoleRes = await chrome.runtime.sendMessage({ type: 'GET_CONSOLE_LOGS' });
    if (consoleRes?.logs) setConsoleLogs(consoleRes.logs);

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        const snap = await chrome.tabs.sendMessage(tabs[0].id, { type: 'CAPTURE_STORAGE' });
        if (snap) setStorageSnapshot(snap);
      }
      if (tabs[0]?.url) {
        const activeUrl = tabs[0].url;
        setBugUrl(prev => prev || activeUrl);
      }
    } catch (e) { /* ignore */ }
  }, []);

  useEffect(() => {
    loadData();

    // Listen for live updates
    const handler = (msg: any) => {
      if (msg.type === 'SCREENSHOT_TAKEN') {
        setScreenshots(prev => ({ ...prev, [msg.payload.stepIndex]: msg.payload.dataUrl }));
      }
      if (msg.type === 'STEP_COUNT_UPDATED') loadData();
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [loadData]);

  // ── Delete step ──────────────────────────────────────────────────────────
  const deleteStep = (idx: number) => {
    // Send to background to handle persistence, re-indexing, and syncing
    chrome.runtime.sendMessage({ type: 'DELETE_STEP', payload: { stepIndex: idx } }).catch(() => {});

    // Optimistic local update
    setEvents(prev => prev.filter((_, i) => i !== idx));
    setScreenshots(prev => {
      const rebuilt: Record<number, string> = {};
      Object.entries(prev).forEach(([keyStr, dataUrl]) => {
        const key = Number(keyStr);
        if (key === idx) return; // drop it
        rebuilt[key < idx ? key : key - 1] = dataUrl;
      });
      return rebuilt;
    });

    setMainImageIndex(prev => {
      if (prev === null) return null;
      if (prev === idx) return null;
      if (prev > idx) return prev - 1;
      return prev;
    });
  };



  // ── Capture screenshot for a step ────────────────────────────────────────
  const captureForStep = async (stepIndex: number) => {
    const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', payload: { stepIndex } });
    if (res?.dataUrl) {
      setScreenshots(prev => ({ ...prev, [res.stepIndex]: res.dataUrl }));
    }
  };

  // ── Open annotator ───────────────────────────────────────────────────────
  const openAnnotator = (stepIdx: number) => {
    const img = screenshots[stepIdx];
    if (!img) return;
    setAnnotatorStep(stepIdx);
    setAnnotatorImage(img);
    setTab('annotator');
    history.current = [];
  };

  // ── Canvas setup ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'annotator' || !annotatorImage || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      history.current = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
    };
    img.src = annotatorImage;
  }, [tab, annotatorImage]);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / r.width;
    const scaleY = canvasRef.current!.height / r.height;
    return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isDrawing.current = true;
    const pos = getPos(e);
    startPos.current = pos;
    const ctx = canvasRef.current!.getContext('2d')!;
    snapshot.current = ctx.getImageData(0, 0, canvasRef.current!.width, canvasRef.current!.height);
    if (activeTool === 'text') {
      const text = prompt('Enter label text:');
      if (text) {
        ctx.font = 'bold 18px Inter, sans-serif';
        ctx.fillStyle = activeColor;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 3;
        ctx.strokeText(text, pos.x, pos.y);
        ctx.fillText(text, pos.x, pos.y);
        const c = canvasRef.current!;
        history.current.push(ctx.getImageData(0, 0, c.width, c.height));
      }
      isDrawing.current = false;
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current || activeTool === 'text') return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const pos = getPos(e);
    if (snapshot.current) ctx.putImageData(snapshot.current, 0, 0);

    ctx.strokeStyle = activeColor;
    ctx.fillStyle = activeColor;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    if (activeTool === 'rect') {
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(startPos.current.x, startPos.current.y, pos.x - startPos.current.x, pos.y - startPos.current.y);
      // fill with translucent color
      ctx.fillStyle = hexToRgba(activeColor, 0.1);
      ctx.fillRect(startPos.current.x, startPos.current.y, pos.x - startPos.current.x, pos.y - startPos.current.y);
    }

    if (activeTool === 'arrow') {
      // Draw line
      ctx.beginPath();
      ctx.moveTo(startPos.current.x, startPos.current.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.lineWidth = 3;
      ctx.stroke();
      // Arrow head
      const angle = Math.atan2(pos.y - startPos.current.y, pos.x - startPos.current.x);
      const headLen = 14;
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(pos.x - headLen * Math.cos(angle - Math.PI / 6), pos.y - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(pos.x - headLen * Math.cos(angle + Math.PI / 6), pos.y - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = activeColor;
      ctx.fill();
    }

    if (activeTool === 'blur') {
      const w = Math.abs(pos.x - startPos.current.x);
      const h = Math.abs(pos.y - startPos.current.y);
      const x = Math.min(pos.x, startPos.current.x);
      const y = Math.min(pos.y, startPos.current.y);
      ctx.filter = 'blur(10px)';
      ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
      ctx.filter = 'none';
      // Overlay pattern
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x, y, w, h);
    }
  };

  const onMouseUp = () => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    history.current.push(ctx.getImageData(0, 0, c.width, c.height));
  };

  const undoAnnotation = () => {
    if (history.current.length <= 1) return;
    history.current.pop();
    const prev = history.current[history.current.length - 1];
    if (!prev) return;
    canvasRef.current!.getContext('2d')!.putImageData(prev, 0, 0);
  };

  const saveAnnotation = () => {
    if (annotatorStep === null || !canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/jpeg', 0.92);
    setScreenshots(prev => ({ ...prev, [annotatorStep]: dataUrl }));
    chrome.storage.local.get('sessionScreenshots', (r) => {
      const existing = r.sessionScreenshots ?? {};
      existing[annotatorStep] = dataUrl;
      chrome.storage.local.set({ sessionScreenshots: existing });
    });
    setTab('steps');
  };

  // ── AI Generation ─────────────────────────────────────────────────────────
  const generateAI = async () => {
    if (events.length === 0) return;
    setIsGenerating(true);
    setError(null);
    // Send only steps to the backend AI route.
    // The OpenAI key lives in the backend .env — no key is needed in the extension.
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_AI_CONTENT',
      payload: { steps: events },
    });
    setIsGenerating(false);
    if (res?.error) {
      setError(res.error);
      return;
    }
    if (res?.title) setTitle(res.title);
    if (res?.description) setDescription(res.description);
    if (res?.suggestedSeverity) setSeverity(res.suggestedSeverity);
    if (res?.stepsSummary) setTestSummary(res.stepsSummary);
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      try {
        const stored = await chrome.storage.local.get(['currentSessionId', 'lastSessionId']);
        activeSessionId = stored.currentSessionId || stored.lastSessionId || crypto.randomUUID();
        setSessionId(activeSessionId);
      } catch {
        activeSessionId = crypto.randomUUID();
        setSessionId(activeSessionId);
      }
    }
    setIsSubmitting(true); setError(null);
    try {
      // Compress each screenshot to JPEG before embedding.
      const screenshotEntries = await Promise.all(
        Object.entries(screenshots || {}).map(async ([idx, dataUrl]) => {
          const compressed = await compressScreenshot(dataUrl);
          if (!compressed) return null;
          return { stepIndex: Number(idx), dataUrl: compressed };
        })
      );
      const screenshotUrls = screenshotEntries.filter(
        (x): x is { stepIndex: number; dataUrl: string } => x !== null
      );

      const integrations = [];
      if (jiraChecked) integrations.push('jira');
      if (slackChecked) integrations.push('slack');
      if (azureChecked) integrations.push('azure-devops');

      const payload = {
        sessionId: activeSessionId,
        title: title || 'Untitled Bug',
        description,
        severity,
        reproductionConfidence: 90,
        steps: (events || []).map((ev, i) => ({
          order: i + 1,
          actionType: (ev.actionType || 'CLICK').toUpperCase(),
          elementLabel: (ev.elementLabel || 'Element').slice(0, 499),
          timestamp: ev.timestamp || new Date().toISOString(),
          valueMasked: ev.valueMasked || undefined,
          cssSelector: (ev.cssSelector || '').slice(0, 1999) || undefined,
          pageUrl: (ev.pageUrl || '').slice(0, 1999) || undefined,
          pageTitle: (ev.pageTitle || '').slice(0, 999) || undefined,
        })),
        attachments: screenshotUrls,
        networkLogs: attachNetwork ? (networkLogs || []).filter(l => l && l.failed).slice(0, 50).map(l => ({ ...l, url: (l.url || '').slice(0, 19999) })) : [],
        integrations,
        expectedResult: expectedResult.trim() || undefined,
        actualResult: actualResult.trim() || undefined,
        consoleLogs: (consoleLogs || []).slice(-100),
        storageSnapshot: storageSnapshot || {},
        bugUrl: bugUrl.trim() || undefined,
        testData: testData.trim() || undefined,
        mainImageIndex,
      };
      const res = await chrome.runtime.sendMessage({
        type: 'API_REQUEST',
        payload: { url: '/v1/bugs', options: { method: 'POST', body: JSON.stringify(payload) } },
      });
      
      if (res.error) {
        if (res.details?.errors && Array.isArray(res.details.errors)) {
          const msgs = res.details.errors.map((e: any) => `${e.path?.join('.') || 'body'}: ${e.message}`).join(', ');
          throw new Error(`Validation Error: ${msgs}`);
        }
        throw new Error(res.details?.message || res.error);
      }

      // ── Dispatch integrations ────────────────────────────────────────────
      const integrationMessages: string[] = [];
      const selectedScreenshot = mainImageIndex !== null && screenshots[mainImageIndex]
        ? screenshots[mainImageIndex]
        : (Object.values(screenshots)[0] || null);

      const deviceFingerprint = {
        os: navigator.platform || 'Unknown OS',
        browser: 'Chrome Extension',
        resolution: `${window.screen.width}x${window.screen.height}`,
        userAgent: navigator.userAgent,
      };

      const integrationPayload = {
        title,
        description,
        severity,
        stepCount: events.length,
        url: bugUrl,
        expectedResult,
        actualResult,
        testSummary,
        steps: events,
        networkLogs: attachNetwork ? networkLogs.filter(l => l.failed) : [],
        consoleLogs,
        storageSnapshot,
        deviceFingerprint,
        screenshot: selectedScreenshot,
        triageResult,
      };

      if (jiraChecked) {
        const jiraRes = await chrome.runtime.sendMessage({
          type: 'CREATE_JIRA_ISSUE',
          payload: { ...integrationPayload, issueType: jiraIssueType },
        });
        if (jiraRes?.issueKey) {
          integrationMessages.push(`✅ Jira: ${jiraRes.issueKey}`);
        } else {
          integrationMessages.push(`⚠️ Jira: ${jiraRes?.detail || 'Failed — check backend .env'}`);
        }
      }

      if (slackChecked) {
        const slackRes = await chrome.runtime.sendMessage({
          type: 'SEND_SLACK_NOTIFICATION',
          payload: { ...integrationPayload, channel: slackChannel },
        });
        if (slackRes?.success) {
          integrationMessages.push(`✅ Slack: Notification sent to ${slackChannel}`);
        } else {
          integrationMessages.push(`⚠️ Slack: ${slackRes?.detail || 'Failed — check SLACK_WEBHOOK_URL in .env'}`);
        }
      }

      if (azureChecked) {
        const azureRes = await chrome.runtime.sendMessage({
          type: 'CREATE_AZURE_WORK_ITEM',
          payload: { ...integrationPayload, workItemType: azureWorkItemType },
        });
        if (azureRes?.workItemId) {
          integrationMessages.push(`✅ Azure DevOps: #${azureRes.workItemId}`);
        } else {
          integrationMessages.push(`⚠️ Azure: ${azureRes?.detail || 'Failed — check AZURE_* vars in .env'}`);
        }
      }

      if (integrationMessages.length > 0) {
        setIntegrationResults(integrationMessages);
      }

      setSuccess(true);
      await chrome.storage.local.remove(['sessionEvents', 'currentSessionId', 'stepCount', 'lastSessionId', 'sessionScreenshots', 'networkLogs']);
    } catch (err: any) {
      setError(err.message || 'Submission failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const buildFullDescription = (limit: number) => {
    let full = description || '';
    if (testSummary) {
      full += `\n\nDetailed Steps:\n${testSummary}`;
    }
    if (actualResult) {
      full += `\n\nActual Result:\n${actualResult}`;
    }
    if (expectedResult) {
      full += `\n\nExpected Result:\n${expectedResult}`;
    }
    if (bugUrl) {
      full += `\n\nURL:\n${bugUrl}`;
    }
    if (testData) {
      full += `\n\nTest Data:\n${testData}`;
    }
    return full.slice(0, limit);
  };

  const dispatchToJira = async () => {
    if (!title) {
      setJiraResult({ type: 'error', message: 'Title is required to dispatch.' });
      return;
    }
    setJiraSubmitting(true);
    setJiraResult(null);
    try {
      const selectedScreenshot = mainImageIndex !== null && screenshots[mainImageIndex]
        ? screenshots[mainImageIndex]
        : (Object.values(screenshots)[0] || null);

      const deviceFingerprint = {
        os: navigator.platform || 'Unknown OS',
        browser: 'Chrome Extension',
        resolution: `${window.screen.width}x${window.screen.height}`,
        userAgent: navigator.userAgent,
      };

      const jiraPayload = {
        title,
        description,
        severity,
        issueType: jiraIssueType,
        url: bugUrl,
        expectedResult,
        actualResult,
        testSummary,
        steps: events,
        networkLogs: attachNetwork ? networkLogs.filter(l => l.failed) : [],
        consoleLogs,
        storageSnapshot,
        deviceFingerprint,
        screenshot: selectedScreenshot,
        triageResult,
      };

      const res = await chrome.runtime.sendMessage({
        type: 'CREATE_JIRA_ISSUE',
        payload: jiraPayload,
      });
      if (res?.issueKey) {
        setJiraResult({ type: 'success', message: `Successfully created issue: ${res.issueKey}` });
      } else {
        const errMsg = res?.detail || res?.error || 'Failed to dispatch to Jira. Check backend configuration.';
        setJiraResult({ type: 'error', message: errMsg });
      }
    } catch (err: any) {
      setJiraResult({ type: 'error', message: err.message || 'Failed to dispatch to Jira.' });
    } finally {
      setJiraSubmitting(false);
    }
  };

  const sendToSlack = async () => {
    if (!title) {
      setSlackResult({ type: 'error', message: 'Title is required to send notification.' });
      return;
    }
    setSlackSubmitting(true);
    setSlackResult(null);
    try {
      const fullDesc = buildFullDescription(1950);
      const integrationBase = { title, description: fullDesc, severity, stepCount: events.length };
      const res = await chrome.runtime.sendMessage({
        type: 'SEND_SLACK_NOTIFICATION',
        payload: { ...integrationBase, channel: slackChannel },
      });
      if (res?.success) {
        setSlackResult({ type: 'success', message: `Notification successfully sent to ${slackChannel}!` });
      } else {
        setSlackResult({ type: 'error', message: res?.detail || 'Failed to send to Slack. Check backend webhook.' });
      }
    } catch (err: any) {
      setSlackResult({ type: 'error', message: err.message || 'Failed to send to Slack.' });
    } finally {
      setSlackSubmitting(false);
    }
  };

  const dispatchToAzure = async () => {
    if (!title) {
      setAzureResult({ type: 'error', message: 'Title is required to dispatch.' });
      return;
    }
    setAzureSubmitting(true);
    setAzureResult(null);
    try {
      const fullDesc = buildFullDescription(31950);
      const integrationBase = { title, description: fullDesc, severity, stepCount: events.length };
      const res = await chrome.runtime.sendMessage({
        type: 'CREATE_AZURE_WORK_ITEM',
        payload: { ...integrationBase, workItemType: azureWorkItemType },
      });
      if (res?.workItemId) {
        setAzureResult({ type: 'success', message: `Successfully created work item: #${res.workItemId}` });
      } else {
        setAzureResult({ type: 'error', message: res?.detail || 'Failed to dispatch to Azure. Check backend configuration.' });
      }
    } catch (err: any) {
      setAzureResult({ type: 'error', message: err.message || 'Failed to dispatch to Azure.' });
    } finally {
      setAzureSubmitting(false);
    }
  };
  
  const copyLocalStepsToClipboard = () => {
    const text = testSummary || events.map((ev, i) => {
      const target = ev.elementLabel || 'element';
      const action = ev.actionType.toUpperCase();
      if (action === 'CLICK') return `${i + 1}. Click on the "${target}".`;
      if (action === 'INPUT') {
        const val = ev.valueMasked && ev.valueMasked !== '[REDACTED]' ? ` "${ev.valueMasked}"` : '';
        return `${i + 1}. Enter${val} in the "${target}" field.`;
      }
      if (action === 'NAVIGATE') return `${i + 1}. Navigate to the next page.`;
      if (action === 'SCROLL') return `${i + 1}. Scroll the page.`;
      if (action === 'HOVER') return `${i + 1}. Hover over "${target}".`;
      return `${i + 1}. Perform ${ev.actionType} on "${target}".`;
    }).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopiedSteps(true);
      setTimeout(() => setCopiedSteps(false), 2000);
    }).catch(() => {});
  };

  const exportAsHTML = () => {
    const stepsHtml = events.map((ev, i) => `
      <div class="step-card">
        <div class="step-header">
          <div class="step-num">${i + 1}</div>
          <div class="step-body">
            <div class="step-action">
              <span class="action-icon">${ACTION_ICONS[ev.actionType.toUpperCase()] ?? '▶'}</span>
              <span class="action-type">${ev.actionType}</span>
            </div>
            <div class="step-label">${ev.actionType} on <strong>${ev.elementLabel || 'element'}</strong></div>
            <div class="step-meta">
              ${ev.pageUrl ? `<span class="step-url">${ev.pageUrl}</span>` : ''}
              <span class="step-time">${new Date(ev.timestamp).toLocaleTimeString()}</span>
            </div>
          </div>
        </div>
        ${screenshots[i] ? `
        <div class="step-screenshot lightbox-trigger" data-src="${screenshots[i]}" data-caption="Step ${i + 1} screenshot">
          <img src="${screenshots[i]}" alt="Step ${i + 1}" style="cursor: zoom-in;" />
        </div>` : ''}
      </div>
    `).join('');
    const stepsSummaryText = formatStepsOnSeparateLines(testSummary || events.map((ev, i) => {
      const target = ev.elementLabel || 'element';
      const action = ev.actionType.toUpperCase();
      if (action === 'CLICK') return `${i + 1}. Click on the "${target}".`;
      if (action === 'INPUT') {
        const val = ev.valueMasked && ev.valueMasked !== '[REDACTED]' ? ` "${ev.valueMasked}"` : '';
        return `${i + 1}. Enter${val} in the "${target}" field.`;
      }
      if (action === 'NAVIGATE') return `${i + 1}. Navigate to the next page.`;
      if (action === 'SCROLL') return `${i + 1}. Scroll the page.`;
      if (action === 'HOVER') return `${i + 1}. Hover over "${target}".`;
      return `${i + 1}. Perform ${ev.actionType} on "${target}".`;
    }).join('\n'));

    const logsHtml = networkLogs.filter(l => l.failed).map(l => `
      <details class="log-details failed">
        <summary class="log-summary">
          <div class="log-method">${l.method}</div>
          <div class="log-url">${l.url}</div>
          <div class="log-status">${l.status ?? 'Failed'}</div>
        </summary>
        ${l.responseBody ? `<div class="log-body"><strong>Response Body:</strong><pre>${l.responseBody}</pre></div>` : '<div class="log-body">No response body captured.</div>'}
      </details>
    `).join('') || '<p class="empty-state">No failed network logs captured.</p>';

    const cLogsHtml = (consoleLogs || []).map((l: any) => `
      <div class="console-card ${l.type === 'error' || l.type === 'exception' ? 'failed' : ''}">
        <div class="console-type badge-${l.type}">${l.type.toUpperCase()}</div>
        <div class="console-text">${l.text}</div>
      </div>
    `).join('') || '<p class="empty-state">No console logs captured.</p>';

    const ua = navigator.userAgent;
    let browserName = 'Unknown Browser';
    if (ua.includes('Firefox')) browserName = 'Firefox';
    else if (ua.includes('Edg')) browserName = 'Edge';
    else if (ua.includes('Chrome')) browserName = 'Chrome';
    else if (ua.includes('Safari')) browserName = 'Safari';

    let osName = 'Unknown OS';
    if (ua.includes('Win')) osName = 'Windows';
    else if (ua.includes('Mac')) osName = 'MacOS';
    else if (ua.includes('Linux')) osName = 'Linux';
    else if (ua.includes('X11')) osName = 'UNIX';

    const resolution = `${window.screen.width}x${window.screen.height}`;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bug Report: ${title || 'Unnamed Bug'}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --panel: #111827;
      --card: #1f2937;
      --border: #374151;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --text: #f9fafb;
      --text2: #d1d5db;
      --text3: #9ca3af;
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.12);
      --orange: #f97316;
      --green: #10b981;
      --blue: #3b82f6;
    }
    
    * { box-sizing: border-box; outline: none; }
    
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      overflow-x: hidden;
      line-height: 1.5;
    }
    
    .page-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 16px;
      display: flex;
      flex-direction: column;
      gap: 32px;
    }

    /* Main Section: Test Details */
    .details-section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--text);
    }
    
    .brand-logo-svg {
      width: 36px;
      height: 36px;
      min-width: 36px;
      min-height: 36px;
      flex-shrink: 0;
      overflow: visible;
      vertical-align: middle;
    }

    .brand-title {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      line-height: 1;
    }

    .brand-text-mono {
      color: var(--text, #f9fafb);
      transition: color 0.2s ease;
    }

    .brand-text-gradient {
      color: #818cf8;
      background: linear-gradient(135deg, #818cf8 0%, #c084fc 50%, #f43f5e 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-left: 3px;
    }

    .brand-report-badge {
      background: rgba(129, 140, 248, 0.15);
      color: #818cf8;
      border: 1px solid rgba(129, 140, 248, 0.3);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-left: 10px;
    }

    .header-info {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
    }

    .title-area {
      flex: 1;
      min-width: 300px;
    }

    h1 {
      margin: 4px 0 12px 0;
      font-size: 28px;
      font-weight: 700;
      color: #fff;
      line-height: 1.2;
    }

    .meta-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .severity-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 11px;
      background: var(--red-bg);
      color: var(--red);
      border: 1px solid rgba(239, 68, 68, 0.2);
      text-transform: uppercase;
    }

    .url-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 500;
      font-size: 11px;
      background: rgba(99, 102, 241, 0.12);
      color: var(--primary);
      border: 1px solid rgba(99, 102, 241, 0.2);
      text-decoration: none;
      word-break: break-all;
    }

    .url-badge:hover {
      background: var(--primary);
      color: #fff;
    }

    .details-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 24px;
    }

    @media (max-width: 900px) {
      .details-grid {
        grid-template-columns: 1fr;
      }
    }

    .grid-left {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .grid-right {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .section-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }

    .card-label {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text3);
      font-weight: 700;
      letter-spacing: 0.05em;
      display: block;
      margin-bottom: 8px;
    }

    .card-content {
      font-size: 14px;
      color: var(--text2);
    }

    .results-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    @media (max-width: 600px) {
      .results-row {
        grid-template-columns: 1fr;
      }
    }

    /* Device details */
    .device-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
    }

    .device-item {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .device-value {
      font-size: 13px;
      color: var(--text);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Main screenshot card */
    .main-screenshot-card {
      position: relative;
      cursor: zoom-in;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .main-screenshot-card img {
      width: 100%;
      height: auto;
      border-radius: 8px;
      border: 1px solid var(--border);
      transition: transform 0.2s ease;
      display: block;
    }

    .main-screenshot-card:hover img {
      transform: scale(1.02);
    }

    /* Test Summary formatting */
    .steps-plain-block {
      font-family: monospace;
      font-size: 13px;
      color: var(--text2);
      white-space: pre-wrap;
      line-height: 1.5;
      margin: 0;
      position: relative;
    }

    .steps-copy-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text2);
      cursor: pointer;
      z-index: 10;
      transition: all 0.2s ease;
    }
    
    .steps-copy-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      color: var(--text);
    }

    /* Tabular module */
    .tabs-section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }

    .tab-btn-bar {
      display: flex;
      border-bottom: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.01);
      overflow-x: auto;
    }

    .tab-btn {
      padding: 18px 24px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text3);
      background: transparent;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 2px solid transparent;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .tab-btn:hover {
      color: var(--text2);
      background: rgba(255, 255, 255, 0.02);
    }

    .tab-btn.active {
      color: var(--primary);
      border-bottom-color: var(--primary);
      background: rgba(99, 102, 241, 0.03);
    }

    .tab-icon {
      width: 16px;
      height: 16px;
    }

    .tab-content {
      padding: 32px;
    }

    .tab-panel {
      display: none;
      animation: fadeIn 0.2s ease-in-out forwards;
    }

    .tab-panel.active {
      display: block;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Detailed Steps Timeline */
    .step-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    
    .step-header {
      display: flex;
      gap: 16px;
    }
    
    .step-num {
      width: 28px;
      height: 28px;
      background: var(--primary);
      color: white;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 13px;
      flex-shrink: 0;
    }
    
    .step-body { flex: 1; min-width: 0; }
    
    .step-action {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
    }
    
    .action-type {
      font-weight: 700;
      text-transform: uppercase;
      font-size: 11px;
      color: var(--primary);
      letter-spacing: 0.05em;
    }
    
    .step-label { font-weight: 500; font-size: 14px; word-break: break-word; color: #fff; }
    
    .step-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 11px;
      color: var(--text3);
      margin-top: 8px;
    }
    
    .step-url {
      background: var(--bg);
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .step-screenshot {
      max-width: 100%;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    
    .step-screenshot img {
      width: 100%;
      max-height: 450px;
      object-fit: contain;
      display: block;
    }

    /* Expandable Logs (Network & Console) */
    .log-details {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    
    .log-details.failed {
      border-left: 4px solid var(--red);
    }
    
    .log-summary {
      display: flex;
      padding: 16px;
      cursor: pointer;
      align-items: center;
      font-family: monospace;
      font-size: 13px;
      user-select: none;
    }
    
    .log-summary:hover { background: rgba(255, 255, 255, 0.02); }
    
    .log-method {
      font-weight: 700;
      color: var(--red);
      width: 60px;
    }
    
    .log-url {
      color: var(--text2);
      flex: 1;
      margin: 0 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .log-status { color: var(--red); font-weight: 600; }
    
    .log-body {
      padding: 16px;
      border-top: 1px solid var(--border);
      background: var(--bg);
      font-family: monospace;
      font-size: 12px;
      color: var(--text2);
      overflow-x: auto;
    }
    
    .log-body pre { margin: 8px 0 0 0; white-space: pre-wrap; }
    
    /* Console Logs */
    .console-card {
      display: flex;
      gap: 16px;
      padding: 12px 16px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 8px;
      font-family: monospace;
      font-size: 13px;
    }
    
    .console-card.failed { border-left: 4px solid var(--red); }
    
    .console-type {
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 10px;
      text-transform: uppercase;
      align-self: flex-start;
    }
    
    .badge-error, .badge-exception { background: var(--red-bg); color: var(--red); }
    .badge-warn { background: rgba(249, 115, 22, 0.12); color: var(--orange); }
    .badge-info, .badge-log { background: rgba(59, 130, 246, 0.12); color: var(--blue); }
    
    .console-text {
      color: var(--text2);
      white-space: pre-wrap;
      word-break: break-all;
    }
    
    /* Code/JSON Block */
    .code-block {
      background: #0d1117;
      padding: 20px;
      border-radius: 8px;
      border: 1px solid var(--border);
      overflow-x: auto;
      font-family: monospace;
      font-size: 13px;
      color: #c9d1d9;
      line-height: 1.5;
    }
    
    .json-key { color: #79c0ff; }
    .json-string { color: #a5d6ff; }
    .json-number { color: #f2cc60; }
    .json-boolean { color: #ff7b72; }

    /* Lightbox Modal */
    .lightbox {
      display: none;
      position: fixed;
      z-index: 1000;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(9, 13, 22, 0.95);
      backdrop-filter: blur(8px);
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.25s ease;
    }

    .lightbox.open {
      display: flex;
      opacity: 1;
    }

    .lightbox-content {
      max-width: 90%;
      max-height: 85%;
      border-radius: 8px;
      border: 1px solid var(--border);
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      object-fit: contain;
    }

    .lightbox-caption {
      position: absolute;
      bottom: 24px;
      color: var(--text2);
      font-weight: 500;
      background: rgba(0, 0, 0, 0.6);
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
    }

    .lightbox-close {
      position: absolute;
      top: 24px;
      right: 24px;
      color: var(--text3);
      font-size: 32px;
      font-weight: bold;
      cursor: pointer;
      transition: color 0.15s;
    }

    .lightbox-close:hover {
      color: #fff;
    }
    
    /* Print Styles */
    @media print {
      body {
        background: white !important;
        color: #0f172a !important;
      }
      .page-container {
        padding: 0 !important;
        gap: 20px !important;
      }
      .details-section, .tabs-section, .section-card, .device-item {
        border-color: #e2e8f0 !important;
        background: white !important;
        box-shadow: none !important;
      }
      /* Ensure brand header and logo render with 100% full colors & visibility in PDF print */
      .brand-logo-svg {
        width: 36px !important;
        height: 36px !important;
        min-width: 36px !important;
        min-height: 36px !important;
        overflow: visible !important;
      }
      .brand-text-mono {
        color: #0f172a !important;
        -webkit-text-fill-color: #0f172a !important;
      }
      .brand-text-gradient {
        background: none !important;
        -webkit-background-clip: unset !important;
        background-clip: unset !important;
        -webkit-text-fill-color: #818cf8 !important;
        color: #818cf8 !important;
      }
      .brand-report-badge {
        background: #f1f5f9 !important;
        color: #6366f1 !important;
        border: 1px solid #c7d2fe !important;
        -webkit-text-fill-color: #6366f1 !important;
      }
      .tab-btn-bar { display: none !important; }
      .tab-content { padding: 0 !important; }
      .tab-panel {
        display: block !important;
        opacity: 1 !important;
        visibility: visible !important;
      }
      .tab-panel::before {
        content: attr(data-title);
        display: block;
        font-size: 18px;
        font-weight: 700;
        margin-top: 30px;
        margin-bottom: 12px;
        border-bottom: 2px solid #555 !important;
        padding-bottom: 4px;
      }
      .step-card, .log-details, .console-card, .code-block {
        page-break-inside: avoid;
        border: 1px solid #ccc !important;
        background: white !important;
      }
      details { display: block !important; }
      details summary ~ * { display: block !important; }
      .lightbox { display: none !important; }
    }
  </style>
</head>
<body>
  
  <div class="page-container">
    
    <!-- Test Details Main Section -->
    <section class="details-section">
      <div class="brand">
        <svg class="brand-logo-svg" width="36" height="36" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="rpt-buglens-ring-grad" x1="10" y1="10" x2="85" y2="85" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#f43f5e" />
              <stop offset="40%" stop-color="#ec4899" />
              <stop offset="75%" stop-color="#a855f7" />
              <stop offset="100%" stop-color="#6366f1" />
            </linearGradient>
            <linearGradient id="rpt-buglens-bug-right-grad" x1="45" y1="25" x2="65" y2="65" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#ec4899" />
              <stop offset="100%" stop-color="#f43f5e" />
            </linearGradient>
          </defs>
          <path d="M 45 12 A 32 32 0 1 0 72 61 L 88 77 A 5 5 0 0 0 95 70 L 79 54 A 32 32 0 0 0 45 12 Z M 45 20 A 24 24 0 1 1 21 44 A 24 24 0 0 1 45 20 Z" fill="url(#rpt-buglens-ring-grad)" />
          <path d="M 68 58 L 74 64 L 70 68 L 64 62 Z" fill="#a855f7" opacity="0.8" />
          <path d="M 39 30 Q 36 24 33 22" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" />
          <path d="M 51 30 Q 54 24 57 22" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" />
          <path d="M 33 38 H 27 M 31 44 H 25 M 34 50 H 28" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" />
          <path d="M 57 38 H 63 M 59 44 H 65 M 56 50 H 62" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" />
          <path d="M 45 29 C 37 29 34 35 34 44 C 34 53 37 59 45 59 Z" fill="currentColor" />
          <path d="M 45 29 C 53 29 56 35 56 44 C 56 53 53 59 45 59 Z" fill="url(#rpt-buglens-bug-right-grad)" />
          <path d="M 40 31 C 40 28 50 28 50 31 Z" fill="currentColor" />
        </svg>
        <div class="brand-title">
          <span class="brand-text-mono">Bug</span>
          <span class="brand-text-gradient">Lens</span>
          <span class="brand-report-badge">Report</span>
        </div>
      </div>

      <div class="header-info">
        <div class="title-area">
          <span class="severity-badge" style="background-color: ${severity === 'P0' ? 'rgba(239, 68, 68, 0.15)' : severity === 'P1' ? 'rgba(249, 115, 22, 0.15)' : 'rgba(59, 130, 246, 0.15)'}; color: ${severity === 'P0' ? 'var(--red)' : severity === 'P1' ? 'var(--orange)' : 'var(--blue)'}; border-color: ${severity === 'P0' ? 'var(--red)' : severity === 'P1' ? 'var(--orange)' : 'var(--blue)'}">${severity}</span>
          <h1>${title || 'Unnamed Bug'}</h1>
          <div class="meta-pills">
            ${bugUrl ? `<a href="${bugUrl}" target="_blank" class="url-badge">
              <svg style="width:12px;height:12px;margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              ${bugUrl}
            </a>` : ''}
          </div>
        </div>
      </div>

      <div class="details-grid">
        <div class="grid-left">
          
          <div class="section-card">
            <span class="card-label">Description</span>
            <div class="card-content">${description || 'No description provided.'}</div>
          </div>

          <div class="results-row">
            ${expectedResult ? `
            <div class="section-card">
              <span class="card-label">Expected Result</span>
              <div class="card-content">${expectedResult}</div>
            </div>
            ` : ''}

            ${actualResult ? `
            <div class="section-card">
              <span class="card-label">Actual Result</span>
              <div class="card-content">${actualResult}</div>
            </div>
            ` : ''}
          </div>

          ${testData ? `
          <div class="section-card">
            <span class="card-label">Test Data</span>
            <div class="card-content" style="font-family: monospace; white-space: pre-wrap; font-size: 13px; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border);">${testData}</div>
          </div>
          ` : ''}

          <div class="section-card">
            <span class="card-label">Device Details</span>
            <div class="device-grid">
              <div class="device-item">
                <span class="card-label" style="font-size:9px; margin-bottom: 2px;">OS</span>
                <span class="device-value" title="${osName}">${osName}</span>
              </div>
              <div class="device-item">
                <span class="card-label" style="font-size:9px; margin-bottom: 2px;">Browser</span>
                <span class="device-value" title="${browserName}">${browserName}</span>
              </div>
              <div class="device-item">
                <span class="card-label" style="font-size:9px; margin-bottom: 2px;">Resolution</span>
                <span class="device-value" title="${resolution}">${resolution}</span>
              </div>
              <div class="device-item" style="grid-column: span 2;">
                <span class="card-label" style="font-size:9px; margin-bottom: 2px;">User Agent</span>
                <span class="device-value" style="font-size:11px;" title="${ua}">${ua}</span>
              </div>
            </div>
          </div>

        </div>
        
        <div class="grid-right">
          
          <div class="section-card" style="position: relative;">
            <span class="card-label">Test Summary</span>
            <button id="copy-steps-btn" class="steps-copy-btn" title="Copy summary steps">
              <svg style="width: 14px; height: 14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
            </button>
            <pre id="steps-summary-text" class="steps-plain-block">${stepsSummaryText || 'No steps captured.'}</pre>
          </div>

          ${mainImageIndex !== null && screenshots[mainImageIndex] ? `
          <div class="section-card">
            <span class="card-label">Main Screenshot</span>
            <div class="main-screenshot-card lightbox-trigger" data-src="${screenshots[mainImageIndex]}" data-caption="Main Screenshot">
              <img src="${screenshots[mainImageIndex]}" alt="Main Screenshot" />
            </div>
          </div>
          ` : ''}

        </div>
      </div>
    </section>

    <!-- Tabular Module Section -->
    <section class="tabs-section">
      <div class="tab-btn-bar">
        <button class="tab-btn active" data-tab="timeline">
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
          Detailed Steps
        </button>
        <button class="tab-btn" data-tab="network">
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"></path><path d="M1.42 9a16 16 0 0 1 21.16 0"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>
          Failed Network Logs
        </button>
        <button class="tab-btn" data-tab="console">
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
          Console Logs
        </button>
        <button class="tab-btn" data-tab="storage">
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"></path></svg>
          App Storage
        </button>
      </div>

      <div class="tab-content">
        
        <!-- Tab 1: Detailed Steps Timeline -->
        <div id="timeline" class="tab-panel active" data-title="Detailed Steps">
          ${stepsHtml || '<p class="empty-state">No steps captured during session.</p>'}
        </div>

        <!-- Tab 2: Failed Network Logs -->
        <div id="network" class="tab-panel" data-title="Failed Network Logs">
          ${logsHtml}
        </div>

        <!-- Tab 3: Console Logs -->
        <div id="console" class="tab-panel" data-title="Console Logs">
          ${cLogsHtml}
        </div>

        <!-- Tab 4: App Storage -->
        <div id="storage" class="tab-panel" data-title="Application Storage">
          <pre class="code-block">${
            JSON.stringify(storageSnapshot, null, 2)
              .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
              .replace(/: "([^"]+)"/g, ': <span class="json-string">"$1"</span>')
              .replace(/: ([0-9]+)/g, ': <span class="json-number">$1</span>')
              .replace(/: (true|false)/g, ': <span class="json-boolean">$1</span>')
          }</pre>
        </div>

      </div>
    </section>

  </div>

  <!-- Lightbox Modal -->
  <div id="lightbox" class="lightbox">
    <span class="lightbox-close">&times;</span>
    <img class="lightbox-content" id="lightbox-img">
    <div id="lightbox-caption" class="lightbox-caption"></div>
  </div>
  
  <script>
    // Tab Switching Logic
    function switchTab(tabId) {
      var buttons = document.querySelectorAll('.tab-btn');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.remove('active');
      }
      var panels = document.querySelectorAll('.tab-panel');
      for (var i = 0; i < panels.length; i++) {
        panels[i].classList.remove('active');
      }
      var targetBtn = document.querySelector('[data-tab="' + tabId + '"]');
      if (targetBtn) targetBtn.classList.add('active');
      
      var targetPanel = document.getElementById(tabId);
      if (targetPanel) targetPanel.classList.add('active');
    }

    // Lightbox Logic
    function openLightbox(src, caption) {
      var lightbox = document.getElementById('lightbox');
      var img = document.getElementById('lightbox-img');
      var cap = document.getElementById('lightbox-caption');
      if (lightbox && img && cap) {
        img.src = src;
        cap.innerText = caption || 'Screenshot Preview';
        lightbox.classList.add('open');
      }
    }

    // Close Lightbox Logic
    function closeLightbox() {
      var lightbox = document.getElementById('lightbox');
      if (lightbox) {
        lightbox.classList.remove('open');
      }
    }

    // Copy Steps Logic
    function copyStepsToClipboard() {
      var textEl = document.getElementById('steps-summary-text');
      if (!textEl) return;
      var text = textEl.innerText;
      
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showCopySuccess).catch(function(err) {
          console.error('Failed to copy steps:', err);
          fallbackCopyText(text);
        });
      } else {
        fallbackCopyText(text);
      }
    }

    function showCopySuccess() {
      var btn = document.getElementById('copy-steps-btn');
      if (!btn) return;
      var origIcon = btn.innerHTML;
      btn.innerHTML = '<svg style="width: 16px; height: 16px; color: #10b981;" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>';
      btn.style.borderColor = '#10b981';
      btn.style.background = 'rgba(16, 185, 129, 0.1)';
      setTimeout(function() {
        btn.innerHTML = origIcon;
        btn.style.borderColor = '';
        btn.style.background = '';
      }, 2000);
    }

    function fallbackCopyText(text) {
      var textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";  // avoid scrolling to bottom
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        var successful = document.execCommand('copy');
        if (successful) {
          showCopySuccess();
        } else {
          console.error('Fallback copy was unsuccessful');
        }
      } catch (err) {
        console.error('Fallback copy failed:', err);
      }
      document.body.removeChild(textArea);
    }

    // Setup and initialization
    function init() {
      // Tab switcher event listeners
      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var tabId = btn.getAttribute('data-tab');
          switchTab(tabId);
        });
      });

      // Lightbox triggers
      document.addEventListener('click', function(e) {
        var trigger = e.target.closest('.lightbox-trigger');
        if (trigger) {
          var src = trigger.getAttribute('data-src');
          var caption = trigger.getAttribute('data-caption');
          openLightbox(src, caption);
        }
      });

      // Lightbox close trigger (background click)
      var lightbox = document.getElementById('lightbox');
      if (lightbox) {
        lightbox.addEventListener('click', function() {
          closeLightbox();
        });
      }

      // Close button trigger
      var lightboxClose = document.querySelector('.lightbox-close');
      if (lightboxClose) {
        lightboxClose.addEventListener('click', function(e) {
          e.stopPropagation();
          closeLightbox();
        });
      }

      // Prevent click inside lightbox image from closing it
      var lightboxImg = document.getElementById('lightbox-img');
      if (lightboxImg) {
        lightboxImg.addEventListener('click', function(e) {
          e.stopPropagation();
        });
      }

      // Copy steps button
      var copyBtn = document.getElementById('copy-steps-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', function() {
          copyStepsToClipboard();
        });
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }

    // Keydown handler (Escape key)
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        closeLightbox();
      }
    });
  </script>
</body>
</html>
    `;
  };

  const failedNet = networkLogs.filter(l => l.failed).length;
  const filteredLogs = networkLogs.filter(l => showFailedOnly ? l.failed : true);
  
  const statusClass = (status?: number | null) => {
    if (!status) return 'unknown';
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    if (status >= 300) return 'info';
    return 'success';
  };
  
  const renderLabel = (ev: any) => {
    if (ev.elementLabel) return ev.elementLabel;
    if (ev.text) return `"${ev.text.substring(0, 20)}..."`;
    if (ev.tagName) return ev.tagName.toLowerCase();
    return ev.actionType;
  };
  
  const handleExportHTML = () => {
    const html = exportAsHTML();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `bug-report-${Date.now()}.html` });
  };
  
  const handleExportPDF = () => {
    const html = exportAsHTML();
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => {
        w.print();
        w.close();
      }, 500);
    }
  };

  return (
    <div className="panel">
      {/* Header */}
      <div className="panel-header">
        <div className="header-top">
          <BugLensLogo size={22} showText={true} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {sessionId && <div className="session-chip">#{sessionId.slice(-6).toUpperCase()}</div>}
            <button
              onClick={() => setShowSettings(!showSettings)}
              style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', display: 'flex', padding: 0 }}
              title="Settings"
              id="sidepanel-settings-btn"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'color 0.2s' }} onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text2)')} onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text3)')}>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>
        <div className="tabs">
          {(['steps', 'replay', 'annotator', 'network', 'report'] as TabId[]).map(t => (
            <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'steps' && <><span>Steps</span>{events.length > 0 && <span className="tab-badge">{events.length}</span>}</>}
              {t === 'replay' && <><span>▶ Replay</span>{events.length > 0 && <span className="tab-badge">{events.length}</span>}</>}
              {t === 'annotator' && <><span>Annotate</span>{Object.keys(screenshots).length > 0 && <span className="tab-badge">{Object.keys(screenshots).length}</span>}</>}
              {t === 'network' && <><span>Network</span>{failedNet > 0 && <span className="tab-badge red">{failedNet}</span>}</>}
              {t === 'report' && <span>Report</span>}
            </button>
          ))}
        </div>
      </div>
      {showSettings && (
        <div style={{
          background: 'var(--bg2)',
          borderBottom: '1px solid var(--border)',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text2)' }}>Settings</span>
            <button
              onClick={() => setShowSettings(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: '16px', display: 'flex', padding: 0 }}
            >
              ×
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '10px', color: 'var(--text3)', fontWeight: 500 }}>BugLens API Server URL</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={customApiUrl}
                onChange={(e) => setCustomApiUrl(e.target.value)}
                placeholder="e.g. http://localhost:8080"
                style={{
                  flex: 1,
                  background: 'var(--bg3)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  color: 'var(--text)',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  outline: 'none'
                }}
              />
              <button
                onClick={handleSaveSettings}
                style={{
                  background: 'linear-gradient(135deg, var(--accent) 0%, #818cf8 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontWeight: 600,
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="tab-content">
        {/* ── Steps Tab ── */}
        {tab === 'steps' && (
          <div className="steps-list">
            {events.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">📋</span>
                No steps recorded yet.<br />
                <small>Start recording and interact with the page.<br />Press <kbd style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3, border: '1px solid var(--border)' }}>Ctrl+I</kbd> to capture a screenshot.</small>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, padding: '0 4px' }}>
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>{events.length} steps recorded</span>
                  <button
                    onClick={copyLocalStepsToClipboard}
                    style={{
                      background: copiedSteps ? '#10b981' : 'var(--bg3)',
                      color: copiedSteps ? '#fff' : 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '4px 10px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      transition: 'all 0.2s'
                    }}
                  >
                    {copiedSteps ? (
                      <>
                        <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path>
                        </svg>
                        <span>Copy Steps Summary</span>
                      </>
                    )}
                  </button>
                </div>
                {events.map((ev, i) => (
                  <div key={i} className="step-card">
                    <div className="step-num">{i + 1}</div>
                    <div className="step-body">
                      <div className="step-action">
                        <span className="action-icon">{ACTION_ICONS[(ev.actionType || 'CLICK').toUpperCase()] ?? '▶'}</span>
                        <span className="action-type">{ev.actionType || 'CLICK'}</span>
                      </div>
                      <div className="step-label">{renderLabel(ev)}</div>
                      <div className="step-meta">
                        {(ev.pageUrl || ev.toUrl) && (
                          <span className="step-url" title={ev.toUrl || ev.pageUrl}>
                            {(ev.toUrl || ev.pageUrl || '').replace(/^https?:\/\//, '').slice(0, 40)}
                          </span>
                        )}
                        <span className="step-time">{ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ''}</span>
                      </div>
                    </div>
                    <div
                      className="step-thumb"
                      onClick={() => screenshots[i] ? openAnnotator(i) : undefined}
                      title={screenshots[i] ? 'Click to annotate' : 'No screenshot yet'}
                      style={!screenshots[i] ? { border: '1px dashed var(--border)', background: 'transparent' } : {}}
                    >
                      {screenshots[i]
                        ? <img src={screenshots[i]} alt={`step ${i + 1}`} />
                        : <div className="no-shot" style={{ fontSize: 10, color: 'var(--text3)' }}>No image</div>
                      }
                      {screenshots[i] && <div className="thumb-badge">Edit</div>}
                    </div>
                    <div className="step-actions">
                      <button
                        className={`btn-icon main-image-toggle${mainImageIndex === i ? ' active' : ''}`}
                        title={mainImageIndex === i ? 'Remove as Main Screenshot' : 'Set as Main Screenshot'}
                        onClick={() => setMainImageIndex(mainImageIndex === i ? null : i)}
                        disabled={!screenshots[i]}
                        style={!screenshots[i] ? { cursor: 'not-allowed', opacity: 0.3 } : {}}
                      >
                        {mainImageIndex === i ? '★' : '☆'}
                      </button>
                      <button className="btn-icon capture" title="Capture screenshot now" onClick={() => captureForStep(i)}>📷</button>
                      <button className="btn-icon delete" title="Delete step" onClick={() => deleteStep(i)}>✕</button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* ── Replay Tab ── */}
        {tab === 'replay' && (
          <div className="replay-container" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {events.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">▶</span>
                No session steps recorded to replay.<br />
                <small>Record a test session first to playback visual step timelines.</small>
              </div>
            ) : (
              <>
                {/* Replay Controls Top Bar */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg2)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setIsReplaying(!isReplaying)}
                      style={{
                        background: isReplaying ? '#f59e0b' : 'linear-gradient(135deg, var(--accent) 0%, #818cf8 100%)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        padding: '6px 14px',
                        fontWeight: 700,
                        fontSize: 12,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6
                      }}
                    >
                      {isReplaying ? '⏸ Pause' : '▶ Play Replay'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setReplayIndex(prev => Math.max(0, prev - 1))}
                      disabled={replayIndex === 0}
                      style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: replayIndex === 0 ? 'not-allowed' : 'pointer', opacity: replayIndex === 0 ? 0.4 : 1 }}
                    >
                      ⏮ Prev
                    </button>

                    <button
                      type="button"
                      onClick={() => setReplayIndex(prev => Math.min(events.length - 1, prev + 1))}
                      disabled={replayIndex === events.length - 1}
                      style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: replayIndex === events.length - 1 ? 'not-allowed' : 'pointer', opacity: replayIndex === events.length - 1 ? 0.4 : 1 }}
                    >
                      Next ⏭
                    </button>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>Speed:</span>
                      {[0.5, 1, 2, 4].map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setReplaySpeed(s as any)}
                          style={{
                            background: replaySpeed === s ? 'var(--accent)' : 'var(--bg3)',
                            color: replaySpeed === s ? '#fff' : 'var(--text2)',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                            padding: '2px 6px',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer'
                          }}
                        >
                          {s}x
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={exportSessionVideo}
                      disabled={isExportingVideo}
                      style={{
                        background: 'rgba(16, 185, 129, 0.15)',
                        color: '#10b981',
                        border: '1px solid rgba(16, 185, 129, 0.4)',
                        borderRadius: 6,
                        padding: '6px 10px',
                        fontWeight: 600,
                        fontSize: 11,
                        cursor: isExportingVideo ? 'wait' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4
                      }}
                    >
                      {isExportingVideo ? '⏳ Exporting...' : '🎥 Export WebM Video'}
                    </button>
                  </div>
                </div>

                {/* Scrubber Range Slider */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <input
                    type="range"
                    min={0}
                    max={events.length - 1}
                    value={replayIndex}
                    onChange={(e) => setReplayIndex(Number(e.target.value))}
                    style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)' }}>
                    <span>Step {replayIndex + 1} of {events.length}</span>
                    <span>{events[replayIndex]?.timestamp ? new Date(events[replayIndex]!.timestamp).toLocaleTimeString() : ''}</span>
                  </div>
                </div>

                {/* Active Replay Step Visual Display Card */}
                {events[replayIndex] && (
                  <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ background: 'var(--accent)', color: '#fff', padding: '3px 8px', borderRadius: 4, fontWeight: 700, fontSize: 12 }}>
                          Step #{replayIndex + 1}
                        </span>
                        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                          {(events[replayIndex]?.actionType || 'CLICK').toUpperCase()} on "{renderLabel(events[replayIndex])}"
                        </span>
                      </div>
                      {events[replayIndex]?.pageUrl && (
                        <span style={{ fontSize: 11, color: 'var(--text3)', background: 'var(--bg3)', padding: '2px 8px', borderRadius: 4, wordBreak: 'break-all' }}>
                          {events[replayIndex]!.pageUrl}
                        </span>
                      )}
                    </div>

                    {/* Screenshot Visual Preview */}
                    <div style={{ position: 'relative', width: '100%', background: '#090d16', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', display: 'flex', justifyContent: 'center' }}>
                      {screenshots[replayIndex] ? (
                        <img
                          src={screenshots[replayIndex]}
                          alt={`Step ${replayIndex + 1}`}
                          style={{ width: '100%', maxHeight: 360, objectFit: 'contain', display: 'block' }}
                        />
                      ) : (
                        <div style={{ padding: 40, color: 'var(--text3)', fontSize: 12 }}>No screenshot captured for this step</div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Annotator Tab ── */}
        {tab === 'annotator' && (
          <div className="annotator-wrap">
            {!annotatorImage ? (
              <div className="annotator-placeholder">
                <div style={{ fontSize: 32, marginBottom: 8 }}>🖼️</div>
                Click a step's screenshot thumbnail to open it here for annotation.
              </div>
            ) : (
              <div className="annotator-container">
                <div className="annotator-toolbar">
                  {(['arrow', 'rect', 'text', 'blur'] as Tool[]).map(t => (
                    <button key={t} className={`tool-btn${activeTool === t ? ' active' : ''}`} onClick={() => setActiveTool(t)}>
                      {t === 'arrow' && '↗ Arrow'}{t === 'rect' && '▭ Highlight'}{t === 'text' && 'T Label'}{t === 'blur' && '◻ Redact'}
                    </button>
                  ))}
                  <div className="tool-sep" />
                  {COLORS.map(c => (
                    <div key={c} className={`color-btn${activeColor === c ? ' active' : ''}`}
                      style={{ background: c }} onClick={() => setActiveColor(c)} title={c} />
                  ))}
                  <div className="tool-sep" />
                  <button className="tool-btn" onClick={undoAnnotation}>↩ Undo</button>
                </div>
                <div className="annotator-canvas-wrap">
                  <canvas
                    ref={canvasRef}
                    id="annotator-canvas"
                    onMouseDown={onMouseDown}
                    onMouseMove={onMouseMove}
                    onMouseUp={onMouseUp}
                    onMouseLeave={onMouseUp}
                  />
                </div>
                <div className="annotator-footer">
                  <button className="tool-btn" onClick={() => setTab('steps')}>← Back</button>
                  <button className="tool-btn active" onClick={saveAnnotation}>💾 Save Annotation</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Network Tab ── */}
        {tab === 'network' && (
          <div>
            <div className="net-toolbar">
              <input className="net-search" placeholder="Filter by URL…" value={netSearch} onChange={e => setNetSearch(e.target.value)} />
              <button className={`net-filter${showFailedOnly ? ' active' : ''}`} onClick={() => setShowFailedOnly(!showFailedOnly)}>
                {showFailedOnly ? '✕ Errors only' : '⚠ Errors only'}
              </button>
              <span className="net-count">{filteredLogs.length} req</span>
            </div>
            {filteredLogs.length === 0 ? (
              <div className="empty-state"><span className="empty-icon">🌐</span>No network requests captured yet.</div>
            ) : (
              <table className="net-table">
                <thead>
                  <tr><th>Method</th><th>URL</th><th>Status</th><th>Duration</th></tr>
                </thead>
                <tbody>
                  {filteredLogs.map(log => (
                    <tr key={log.id} className={`net-row${log.failed ? ' failed' : ''}`}>
                      <td><span className={`net-method ${log.method}`}>{log.method}</span></td>
                      <td><span className="net-url" title={log.url}>{log.url.replace(/^https?:\/\/[^/]+/, '')}</span></td>
                      <td>
                        <span className={`net-status ${statusClass(log.status)}`}>
                          {log.failed ? `✕ ${log.errorText ?? 'Failed'}` : (log.status ?? '…')}
                        </span>
                      </td>
                      <td className="net-duration">{log.duration ? `${Math.round(log.duration)}ms` : '…'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Report Tab ── */}
        {tab === 'report' && (
          <div className="report-section">
            {/* AI Root Cause Triage Section */}
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent)' }}>
                  🧠 AI Root Cause Triage
                </span>
                <button
                  type="button"
                  onClick={runTriage}
                  disabled={isTriaging}
                  style={{
                    background: 'linear-gradient(135deg, var(--accent) 0%, #818cf8 100%)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '5px 12px',
                    fontWeight: 600,
                    fontSize: 11,
                    cursor: isTriaging ? 'wait' : 'pointer'
                  }}
                >
                  {isTriaging ? '⏳ Analyzing Stacktrace...' : '⚡ Run Root Cause Triage'}
                </button>
              </div>

              {triageResult && (
                <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ background: triageResult.affectedComponent === 'BACKEND' ? '#ef4444' : triageResult.affectedComponent === 'EXTERNAL_API' ? '#f59e0b' : '#3b82f6', color: '#fff', padding: '2px 6px', borderRadius: 4, fontWeight: 700, fontSize: 10 }}>
                      {triageResult.affectedComponent}
                    </span>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>
                      {triageResult.rootCause}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--text2)', lineHeight: 1.4 }}>
                    {triageResult.technicalSummary}
                  </p>
                  <div style={{ background: 'rgba(99, 102, 241, 0.1)', borderLeft: '3px solid var(--accent)', padding: '6px 10px', borderRadius: 4, marginTop: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', display: 'block' }}>💡 Recommended Fix:</span>
                    <span style={{ fontSize: 12, color: 'var(--text)' }}>{triageResult.suggestedFix}</span>
                  </div>
                </div>
              )}
            </div>

            {/* AI generate */}
            <button type="button" className={`ai-btn${isGenerating ? ' loading' : ''}`} onClick={generateAI} disabled={isGenerating || events.length === 0}>
              {isGenerating ? '⏳ Generating…' : '✨ Generate Title & Description with AI'}
            </button>
            <div className="settings-hint" style={{ marginTop: -6 }}>AI runs server-side — no key needed here. Requires OPENAI_API_KEY in backend .env.</div>

            <div className="form-group">
              <label className="form-label">Title</label>
              <input className="form-input" placeholder="e.g. Unable to submit checkout form" value={title} onChange={e => setTitle(e.target.value)} required />
            </div>

            <div className="form-group">
                <label>Description</label>
                <textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} />
              </div>

              <div className="form-group" style={{ position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ margin: 0 }}>Test Summary</label>
                  <button
                    type="button"
                    onClick={copyLocalStepsToClipboard}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: copiedSteps ? '#10b981' : 'var(--text3)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: 0,
                      transition: 'all 0.2s'
                    }}
                    title="Copy steps to clipboard"
                  >
                    {copiedSteps ? (
                      <>
                        <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7"></path>
                        </svg>
                        <span style={{ fontSize: 11, color: '#10b981' }}>Copied</span>
                      </>
                    ) : (
                      <>
                        <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path>
                        </svg>
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>Copy</span>
                      </>
                    )}
                  </button>
                </div>
                <textarea rows={4} value={testSummary} onChange={e => setTestSummary(e.target.value)} placeholder="Steps for reproduction..." />
              </div>

              <div className="form-group">
                <label>Expected Result</label>
                <textarea rows={3} value={expectedResult} onChange={e => setExpectedResult(e.target.value)} placeholder="What should have happened?" />
              </div>

              <div className="form-group">
                <label>Actual Result</label>
                <textarea rows={3} value={actualResult} onChange={e => setActualResult(e.target.value)} placeholder="What actually happened?" />
              </div>

              <div className="form-group">
                <label className="form-label">URL</label>
                <input className="form-input" placeholder="e.g. https://example.com/checkout" value={bugUrl} onChange={e => setBugUrl(e.target.value)} />
              </div>

              <div className="form-group">
                <label className="form-label">Test Data Details</label>
                <textarea rows={2} className="form-textarea" placeholder="e.g. Username: test@test.com" value={testData} onChange={e => setTestData(e.target.value)} />
              </div>

            <div className="form-group">
              <label className="form-label">Severity</label>
              <div className="severity-row">
                {Object.entries(SEV_COLORS).map(([s, c]) => (
                  <button key={s} type="button"
                    className={`sev-btn${severity === s ? ' active' : ''}`}
                    style={{ '--sev-color': c } as any}
                    onClick={() => setSeverity(s)}
                  >{s}</button>
                ))}
              </div>
            </div>

            {/* Screenshots grid */}
            {Object.keys(screenshots).length > 0 && (
              <div className="form-group">
                <label className="form-label">Screenshots ({Object.keys(screenshots).length}) — Click star to set main image</label>
                <div className="screenshots-grid">
                  {Object.entries(screenshots).map(([idxStr, url]) => {
                    const idx = Number(idxStr);
                    const isMain = mainImageIndex === idx;
                    return (
                      <div key={idx} className={`report-thumb${isMain ? ' main-selected' : ''}`} onClick={() => setMainImageIndex(isMain ? null : idx)}>
                        <img src={url} alt={`step ${idx}`} />
                        <div className="del-thumb" onClick={(e) => {
                          e.stopPropagation();
                          deleteStep(idx);
                        }}>✕</div>
                        <div 
                          className="main-badge"
                          title={isMain ? "Remove Main Image" : "Set as Main Image"}
                        >
                          {isMain ? '⭐' : '☆'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Network attach toggle */}
            {failedNet > 0 && (
              <div className="net-attach">
                <span className="net-attach-label">⚠ Attach {failedNet} failed network requests</span>
                <button type="button" className={`toggle${attachNetwork ? ' on' : ''}`} onClick={() => setAttachNetwork(!attachNetwork)} />
              </div>
            )}

            {/* Integrations */}
            <div className="integrations-group">
              <label className="form-label">Export Bug to Integrations</label>
              <div className="integrations-grid">

                {/* Jira */}
                <div className={`integration-item${jiraChecked ? ' active' : ''}`}>
                  <button type="button" className="integration-checkbox-label" onClick={() => setJiraChecked(v => !v)}>
                    <span>🎯 Jira</span>
                    <span>{jiraChecked ? '▼' : '▶'}</span>
                  </button>
                  {jiraChecked && (
                    <div className="integration-subform">
                      <label className="form-label" style={{ fontSize: 11, marginBottom: 4 }}>Issue Type</label>
                      <select className="form-input" style={{ fontSize: 12, padding: '4px 8px' }}
                        value={jiraIssueType} onChange={e => setJiraIssueType(e.target.value as any)}>
                        <option>Bug</option>
                        <option>Task</option>
                        <option>Story</option>
                        <option>Improvement</option>
                      </select>
                      <button 
                        type="button" 
                        className="dispatch-btn" 
                        disabled={jiraSubmitting || events.length === 0 || !title} 
                        onClick={dispatchToJira}
                      >
                        {jiraSubmitting ? '⏳ Dispatching...' : '🎯 Dispatch to Jira'}
                      </button>
                      {jiraResult && (
                        <div className={`integration-status ${jiraResult.type}`}>
                          {jiraResult.message}
                        </div>
                      )}
                      <div className="integration-hint">Uses JIRA_* vars in backend .env</div>
                    </div>
                  )}
                </div>

                {/* Azure DevOps */}
                <div className={`integration-item${azureChecked ? ' active' : ''}`}>
                  <button type="button" className="integration-checkbox-label" onClick={() => setAzureChecked(v => !v)}>
                    <span>⚡ Azure DevOps</span>
                    <span>{azureChecked ? '▼' : '▶'}</span>
                  </button>
                  {azureChecked && (
                    <div className="integration-subform">
                      <label className="form-label" style={{ fontSize: 11, marginBottom: 4 }}>Work Item Type</label>
                      <select className="form-input" style={{ fontSize: 12, padding: '4px 8px' }}
                        value={azureWorkItemType} onChange={e => setAzureWorkItemType(e.target.value as any)}>
                        <option>Bug</option>
                        <option>Task</option>
                        <option>User Story</option>
                        <option>Feature</option>
                      </select>
                      <button 
                        type="button" 
                        className="dispatch-btn" 
                        disabled={azureSubmitting || events.length === 0 || !title} 
                        onClick={dispatchToAzure}
                      >
                        {azureSubmitting ? '⏳ Dispatching...' : '⚡ Dispatch to Azure DevOps'}
                      </button>
                      {azureResult && (
                        <div className={`integration-status ${azureResult.type}`}>
                          {azureResult.message}
                        </div>
                      )}
                      <div className="integration-hint">Uses AZURE_* vars in backend .env</div>
                    </div>
                  )}
                </div>

                {/* Slack */}
                <div className={`integration-item${slackChecked ? ' active' : ''}`}>
                  <button type="button" className="integration-checkbox-label" onClick={() => setSlackChecked(v => !v)}>
                    <span>💬 Slack</span>
                    <span>{slackChecked ? '▼' : '▶'}</span>
                  </button>
                  {slackChecked && (
                    <div className="integration-subform">
                      <label className="form-label" style={{ fontSize: 11, marginBottom: 4 }}>Channel</label>
                      <select className="form-input" style={{ fontSize: 12, padding: '4px 8px' }}
                        value={slackChannel} onChange={e => setSlackChannel(e.target.value)}>
                        <option>#bugs</option>
                        <option>#engineering</option>
                        <option>#support</option>
                        <option>#general</option>
                      </select>
                      <button 
                        type="button" 
                        className="dispatch-btn" 
                        disabled={slackSubmitting || events.length === 0 || !title} 
                        onClick={sendToSlack}
                      >
                        {slackSubmitting ? '⏳ Sending...' : '💬 Send to Slack'}
                      </button>
                      {slackResult && (
                        <div className={`integration-status ${slackResult.type}`}>
                          {slackResult.message}
                        </div>
                      )}
                      <div className="integration-hint">Uses SLACK_WEBHOOK_URL in backend .env</div>
                    </div>
                  )}
                </div>

              </div>
            </div>

            {/* Export options */}
            <div className="form-group">
              <label className="form-label">Local Export Options</label>
              <div className="export-actions-row">
                <button type="button" className="export-btn" onClick={handleExportHTML} disabled={events.length === 0}>
                  📄 Export HTML
                </button>
                <button type="button" className="export-btn" onClick={handleExportPDF} disabled={events.length === 0}>
                  📕 Export PDF
                </button>
              </div>
            </div>

            {/* Submit Bug Button */}
            <button
              type="button"
              className="submit-btn"
              onClick={handleSubmit as any}
              disabled={isSubmitting || !title || events.length === 0}
            >
              {isSubmitting ? (
                <><span style={{ opacity: 0.8 }}>⏳</span> Submitting…</>
              ) : (
                <><span>🐛</span> Submit Bug Report</>
              )}
            </button>

            {error && <div className="error-box">⚠ {error}</div>}
          </div>
        )}
      </div>
    </div>
  );
};
