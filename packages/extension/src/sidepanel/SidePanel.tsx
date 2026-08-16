import React, { useEffect, useState, useRef, useCallback } from 'react';
import { BugLensLogo } from '../components/BugLensLogo';
import { LOGO_DATA_URI } from '../assets/logoData';
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

  // Settings & Personal Keys (BYOK, Jira, Slack, Azure)
  const [userOpenAiKey, setUserOpenAiKey] = useState('');
  const [userClaudeKey, setUserClaudeKey] = useState('');
  const [userJiraUrl, setUserJiraUrl] = useState('');
  const [userJiraEmail, setUserJiraEmail] = useState('');
  const [userJiraToken, setUserJiraToken] = useState('');
  const [userJiraProject, setUserJiraProject] = useState('');
  const [userSlackWebhook, setUserSlackWebhook] = useState('');
  const [userSlackChannel, setUserSlackChannel] = useState('');
  const [userAzureOrg, setUserAzureOrg] = useState('');
  const [userAzureProject, setUserAzureProject] = useState('');
  const [userAzurePat, setUserAzurePat] = useState('');

  useEffect(() => {
    const loadSettings = () => {
      chrome.storage.local.get([
        'userOpenAiKey', 'userClaudeKey',
        'userJiraUrl', 'userJiraEmail', 'userJiraToken', 'userJiraProject',
        'userSlackWebhook', 'userSlackChannel',
        'userAzureOrg', 'userAzureProject', 'userAzurePat'
      ], (res) => {
        if (res.userOpenAiKey) setUserOpenAiKey(res.userOpenAiKey);
        if (res.userClaudeKey) setUserClaudeKey(res.userClaudeKey);
        if (res.userJiraUrl) setUserJiraUrl(res.userJiraUrl);
        if (res.userJiraEmail) setUserJiraEmail(res.userJiraEmail);
        if (res.userJiraToken) setUserJiraToken(res.userJiraToken);
        if (res.userJiraProject) setUserJiraProject(res.userJiraProject);
        if (res.userSlackWebhook) setUserSlackWebhook(res.userSlackWebhook);
        if (res.userSlackChannel) setUserSlackChannel(res.userSlackChannel);
        if (res.userAzureOrg) setUserAzureOrg(res.userAzureOrg);
        if (res.userAzureProject) setUserAzureProject(res.userAzureProject);
        if (res.userAzurePat) setUserAzurePat(res.userAzurePat);
      });
    };

    loadSettings();

    const storageListener = (_changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local') {
        loadSettings();
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
    return () => {
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, []);

  const handleSaveSettings = useCallback(() => {
    chrome.storage.local.set({
      userOpenAiKey: userOpenAiKey.trim(),
      userClaudeKey: userClaudeKey.trim(),
      userJiraUrl: userJiraUrl.trim(),
      userJiraEmail: userJiraEmail.trim(),
      userJiraToken: userJiraToken.trim(),
      userJiraProject: userJiraProject.trim().toUpperCase(),
      userSlackWebhook: userSlackWebhook.trim(),
      userSlackChannel: userSlackChannel.trim(),
      userAzureOrg: userAzureOrg.trim(),
      userAzureProject: userAzureProject.trim(),
      userAzurePat: userAzurePat.trim(),
    }, () => {
      setShowSettings(false);
    });
  }, [
    userOpenAiKey, userClaudeKey,
    userJiraUrl, userJiraEmail, userJiraToken, userJiraProject,
    userSlackWebhook, userSlackChannel,
    userAzureOrg, userAzureProject, userAzurePat
  ]);
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
    if (triageResult) {
      full += `\n\n🧠 AI ROOT CAUSE TRIAGE:
• Component: ${triageResult.affectedComponent}
• Root Cause: ${triageResult.rootCause}
• Technical Summary: ${triageResult.technicalSummary}
• Recommended Fix: ${triageResult.suggestedFix}`;
    }
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

      const allScreenshots = Object.values(screenshots).filter(s => typeof s === 'string' && s.length > 0);
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
        networkLogs: attachNetwork ? networkLogs.filter(l => l.failed || (l.status && l.status >= 400) || l.errorText) : networkLogs,
        consoleLogs,
        storageSnapshot,
        deviceFingerprint,
        screenshot: selectedScreenshot,
        screenshots: allScreenshots,
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
      const selectedScreenshot = mainImageIndex !== null && screenshots[mainImageIndex]
        ? screenshots[mainImageIndex]
        : (Object.values(screenshots)[0] || null);

      const deviceFingerprint = {
        os: navigator.platform || 'Unknown OS',
        browser: 'Chrome Extension',
        resolution: `${window.screen.width}x${window.screen.height}`,
        userAgent: navigator.userAgent,
      };

      const fullDesc = buildFullDescription(31950);
      const azurePayload = {
        title,
        description: fullDesc,
        severity,
        workItemType: azureWorkItemType,
        url: bugUrl,
        expectedResult,
        actualResult,
        testSummary,
        steps: events,
        networkLogs: attachNetwork ? networkLogs.filter(l => l.failed || (l.status && l.status >= 400) || l.errorText) : networkLogs,
        consoleLogs,
        storageSnapshot,
        deviceFingerprint,
        screenshot: selectedScreenshot,
        screenshots: Object.values(screenshots).filter(s => typeof s === 'string' && s.length > 0),
        triageResult,
      };
      const res = await chrome.runtime.sendMessage({
        type: 'CREATE_AZURE_WORK_ITEM',
        payload: azurePayload,
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
        ${screenshots[i] && typeof screenshots[i] === 'string' && (screenshots[i].startsWith('data:') || screenshots[i].startsWith('http')) ? `
        <div class="step-screenshot lightbox-trigger" data-src="${screenshots[i]}" data-caption="Step ${i + 1} screenshot">
          <img src="${screenshots[i]}" alt="Step ${i + 1}" style="cursor: zoom-in;" onerror="this.onerror=null;this.parentElement.style.display='none';" />
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
        -webkit-text-fill-color: #818cf8;
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
      .lightbox, .lightbox-content { display: none !important; visibility: hidden !important; opacity: 0 !important; }
    }
  </style>
</head>
<body>
  
  <div class="page-container">
    
    <!-- Test Details Main Section -->
      <div class="brand" style="display: flex; align-items: center; gap: 10px;">
        <img class="brand-logo-img" width="36" height="36" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAAtGVYSWZJSSoACAAAAAYAEgEDAAEAAAABAAAAGgEFAAEAAABWAAAAGwEFAAEAAABeAAAAKAEDAAEAAAACAAAAEwIDAAEAAAABAAAAaYcEAAEAAABmAAAAAAAAAGAAAAABAAAAYAAAAAEAAAAGAACQBwAEAAAAMDIxMAGRBwAEAAAAAQIDAACgBwAEAAAAMDEwMAGgAwABAAAA//8AAAKgBAABAAAAAAIAAAOgBAABAAAAAAIAAAAAAAADoLWNAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAFZGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSfvu78nIGlkPSdXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQnPz4KPHg6eG1wbWV0YSB4bWxuczp4PSdhZG9iZTpuczptZXRhLyc+CjxyZGY6UkRGIHhtbG5zOnJkZj0naHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyc+CgogPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9JycKICB4bWxuczpBdHRyaWI9J2h0dHA6Ly9ucy5hdHRyaWJ1dGlvbi5jb20vYWRzLzEuMC8nPgogIDxBdHRyaWI6QWRzPgogICA8cmRmOlNlcT4KICAgIDxyZGY6bGkgcmRmOnBhcnNlVHlwZT0nUmVzb3VyY2UnPgogICAgIDxBdHRyaWI6Q3JlYXRlZD4yMDI2LTA4LTE1PC9BdHRyaWI6Q3JlYXRlZD4KICAgICA8QXR0cmliOkRhdGE+eyZxdW90O2RvYyZxdW90OzomcXVvdDtEQUhTWTdjM3FQNCZxdW90OywmcXVvdDt1c2VyJnF1b3Q7OiZxdW90O1VBRUxjQzY3NnVVJnF1b3Q7LCZxdW90O2JyYW5kJnF1b3Q7OiZxdW90O0plc3NpZSBTLiBGb3JkJiMzOTtzIFRlYW0mcXVvdDt9PC9BdHRyaWI6RGF0YT4KICAgICA8QXR0cmliOkV4dElkPmNkNjQyNDQwLTE3N2EtNDVmNC05NTk5LTk1MTNhYTI5NDE0NjwvQXR0cmliOkV4dElkPgogICAgIDxBdHRyaWI6RmJJZD41MjUyNjU5MTQxNzk1ODA8L0F0dHJpYjpGYklkPgogICAgIDxBdHRyaWI6VG91Y2hUeXBlPjI8L0F0dHJpYjpUb3VjaFR5cGU+CiAgICA8L3JkZjpsaT4KICAgPC9yZGY6U2VxPgogIDwvQXR0cmliOkFkcz4KIDwvcmRmOkRlc2NyaXB0aW9uPgoKIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PScnCiAgeG1sbnM6ZGM9J2h0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvJz4KICA8ZGM6dGl0bGU+CiAgIDxyZGY6QWx0PgogICAgPHJkZjpsaSB4bWw6bGFuZz0neC1kZWZhdWx0Jz5Db3B5IG9mIEJ1Z0xlbnM1MTIgLSAxPC9yZGY6bGk+CiAgIDwvcmRmOkFsdD4KICA8L2RjOnRpdGxlPgogPC9yZGY6RGVzY3JpcHRpb24+CgogPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9JycKICB4bWxuczpwZGY9J2h0dHA6Ly9ucy5hZG9iZS5jb20vcGRmLzEuMy8nPgogIDxwZGY6QXV0aG9yPklkZWFzIFRvIFRyYWRlPC9wZGY6QXV0aG9yPgogPC9yZGY6RGVzY3JpcHRpb24+CgogPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9JycKICB4bWxuczp4bXA9J2h0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8nPgogIDx4bXA6Q3JlYXRvclRvb2w+Q2FudmEgZG9jPURBSFNZN2MzcVA0IHVzZXI9VUFFTGNDNjc2dVUgYnJhbmQ9SmVzc2llIFMuIEZvcmQmIzM5O3MgVGVhbTwveG1wOkNyZWF0b3JUb29sPgogPC9yZGY6RGVzY3JpcHRpb24+CjwvcmRmOlJERj4KPC94OnhtcG1ldGE+Cjw/eHBhY2tldCBlbmQ9J3InPz6JN6tIAAAgAElEQVR4nOydB3hTZfv/+//Zpq8itE1c5KS7iCBtTigOlL2XOHGwBEQBlSVDGUKZIkPZICqoICoCIoiKgAou9p7dLXvPJmmLPv/nOUnatE3SjJNzn5zcn+t6ruj1vsKT+5zk/p7vufM9ISEIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiDBztXkflHGpN46c81+NQtqvVbXdH/vhuaafdoYH3j1WdMDr71srvXq68ZavYeZavcaa679yjRT7Vfmmx7s9bm5Ts9VdP1sqtPzV3NKz3WmlB5fm5J7fGpOeXmWiX95sonvNsrMdxtEX1818t07mw1dO5oMXZob63Z5tDC1S7K5XueEm4+8dC9J6VYFugYIgiAIojjIvUOrFCS9UdeY+OYLBYlvjDYlvf65Men1v401+l0wJvUlpvv7EWMN+lqzLzHe34e+9iHGmq8R2vwJFQHEVOtVQgUAMdVm6xViepCtXsRUh732JOZk9s89CBUBxJT8Mn3tQUwp9FX/MjHpuxMz351QEUDMhm7EZOhKzHXZ6kLMqWx1JlQI0NeXSOFDndPN9V5ab37opZnmei++YX7khVamhzvFQ9cPQRAEQWQL0Q2+/WbcIN4YM7DTzbgBIwriBiw2xg/4wxjf/6wx/k1iTGDrDWJMtK6k1y2rRr/SdT8TAxVFgMkqAkwVRABddXpZF2v+bPUQliMRYLaKALMjESAIgZdK10MvCqvw4ReIma7CR144an70+bVFj3aaQV/7muo/19z4eKcY6LojCIIgiKTciBn8YIFuSO+C6MGLjTGDjxZEDyLG2EGkIGYgMcYNJAWxA+jrAFIQ159QEUAKyogA+ppoFQBJ/YipBnt1zwmwiQCjnRNgtjoBJuYEUBHglRNQ1+oE1BOcAPpKm/9DTAjQ5v8wFQMPP89EADE/Ql8ffZ6YH+1ECuuz9dyNosee21z42HMTzI8/15Y0aB8FfWwQBEEQRBTO3512503t0BYF3NB3C3RDfyrghlwp0L1FhBXN1mDLirGKgFgqAmJLRYDRKgJKnYA3rU7A66VOQJLFBRBEgOAClIoAkxMRUMYJeNDeBfDBCahXKgSYCLA5AeZSJ4CuCiKAUAFA17Ok8HG6HnvmSOFjT39a9PgzrxQ2eroW9PFDEARBELe4Gj0s8Ro3vNsN7u35N7jh+25yw8kNbhi5KawhhAoBupgAoP+sG0yMVhFgjGFCwBsn4A07J6CfRzMBjpwAEWcCHDgBLzh0AswVRQApbEDX40+TogZPXy5s8NSPhY2eGm1q+FRz0qTTndDHGEEQBEFCLlcf0fCqbtTwa7qRa65xI85d494h14X1Nm38bA0X1s0SEcAEwBDLKu8ExFidgBh3nIDKZwIcOQEymQkoEQGFjpwAQQg8Y11PUzFgXQ2fElZRoyf3FjXuOL+wSceu5gbtE6DPAQRBECQIYJb+5eqjulzRjf7uMjfadJUbTa5wI8k1uq5yI2jjH0HKi4DrggCwOAEFZZyAIcRodQIKRHUCRJoJqCP2TMCLlc0ECCLAXN/qBFABUNTAXgTQ5t+QCYEnqQigYqARfW38JCls/ER2YeOO7xc1fuIh6PMDQRAEURCX1GnVLnJjul3mxn5/mRtDLnPvCuuK0PxH08Y/ii6LCLgmCICKIuCGVQTYXACLEzDUsROg0JmAQm9mAso7AQ1tTgATAU9aRUBHKgI6kqIm9LXJE7lFTTpML2ra7hHo8wZBEAQJQC4nTIm4yI17+RI37oeLXBq5JKyxtPGPpa9MBLDFBAATAkwAjC4RAVcrEQHSzQTIKifA7V8HVDIT4MAJ6GhzAmwigBQ1fYK+dsgvatb+g+LmHepDn08IgiCIjLka817Uee34Xue5iT9e4MYTyxpHLgqrVARYhIBzJ+BqJU4A1EyAjHMCXM8E2DsBDRzOBFRwAoqsIqCoaQdS1KwDKWza/kRRs3Yzi5u2fRz6PEMQBEFkwAndB+qz1Sf1PqebvOEcN5Gc5yaRc9wE2vgn0H8eTxt/RRFw0c4JuOLACZDHTEDg5wSYvZ8JKO8ECCKgqFl7UtS8PSls1vZUUYu2s4ubt24Iff4hCIIgEsKa/mluSp+z3Hsb6SJnucnCOic0/0m08TMhYBEBrpyAy5U4ATgT4IecANe/DqjUCRBEgLDaUTHQjhQ3b3umqGWbucUt2zaGPi8RBEEQP3FGN7XxaW7qitPc++SMsKbQxj+Fvr5HGz8TAkwAMCEwsYwIcOYEXHLpBIyS4UyAInMC3J8JsImAphYnwCYCipq3JcUt2pLClm1OUCEwkjR54i7ocxVBEATxkZy4tP+d4Ka/dpKbtv8UN42c4qaS08IqKwIqOgETRXMC5DoToOCcAPedgOalIqCoBVttSFFLulq1/ryoZUse+vxFEARBPOR09emx+dyMGSd1My5TAUAb/3RCRQBt/BVFwGmh+Zd3AmwiQCkzAUGdE+ByJqC8E8BEQDETAS1bk+JWrbcVtmrVBfp8RhAEQSrhhG5WmxPchz/kcx+QE9Z1kptBl0UEWFwAT5wAnAlQUk5AZTMBFhfAXgQIbgAVAq3OFbduPZ60a3cf9DmOIAiC2JGvnfNCHjfrYD43i+RxH9LGP5OUioAZZUSAMyegdCZgslUIOJ8JcCUCMCcgQHICKpkJKOsEMCHQilARQF9bfkJatMDHGSMIgkCSq53TOZebcySXm00bP1uzaOOfaV0fCsuRCHDlBJypZCbgfCVOAOYEBF5OQKUzAVYnQHADWrciRWy1abnE1KpVPPRnAEEQJKjI5uZ2o+t4LjeX5HBzSK6wLCIgV2j+zp0AnAnAnADvZwLsnAAqAorbMDHQ4gtz69ZJ0J8JBEEQRZOlnd8zi5ufkc3No42frbnWZS8CZlmdgFl2TgDOBATaTIAccgKczQRYRIB1tWnJ3ABS1LbFl+Y2TWtCf0YQBEEURaZuwdOZ3MLjWdwCQgUAyRaWRQRkUwHgyAnIq8QJcH8mAHMCMCfAlRPQ0uIEUBFQ3FYQAotJx+b3Qn9mEARBApp0bhGfwX20LZP7iFABQBcTABVFgGMnYLYDJ8DzmQDMCcCcgIozAa3LzATYnIBiqwgobtuioLht83GkVasq0J8hBEGQgCJTuzg6XfvxlxncxyRDaP6L6OtC2vg/cioCnDkBOBOAOQESzwTYRAC51a7FmaJ2zXpDf54QBEFkz7G7Pq2arvvk/ePcJ6Z07hOSLgiARcKyuADeOAE4E6CEmQA55wQ4mgmwiQC2qAg4WNyueRvozxeCIIgsOaZb3PU4t/jcMe5T2vg/JccFAWATAb47AeLNBGBOAOYEeDAT0IaKgHZUBLRtTorbN/+ZtGoUDf1ZQxAEkQUZ0Z8lHtV+tuUYt4Qc4xbTxs/Wp9ZlLwJ8dQIwJwBzAqTLCSg3E2BZ7ZqzVVDcrukw6M8dgiAIKEe4z8cf4T4jR4XFBMAS+moRAc6cgPRKnIAsnAnAnAA55QS0KZ0JKHECqBAoatfsWFGHZg9DfwYRBEEk5TD3RbMj3Bc5dBEqAkh5EeBfJwBnApQwExBoOQFlnACrCChu34zc6tDsY/JUk0jozySCIIhfORS34r5D3LKvD3PLyGGh+S+lr5/Txv+FUxEg/5kAzAnAnAAvZwKEWwKCCLhQ1L7Jy9CfTwRBEL9wWLes80HuyyuHuC/JIUEALBWWxQWAcAIwJwBzAsByAuxnAgQnQFgdmm4i7ZrgEwcRBFEGe+OWRB7UfbXqALecNv7l5KAgAGwiwOYEfAHmBOBMAOYEQOUEVHACBCHQ9Mqtjk2fgf7cIgiC+MR+7qvmB7RfnznAfUUbP1vLrcteBEA7ATgToISZgEDOCbCfCbCspuTWE02X42wAgiABR07ckv/t034zdz/3DdnPfU0OCMsiAlw7AbaZAOciQP4zAZgTgDkBvs0ElIiADk3PFHdo2hz684wgCOIW+7QrDfu4b9P3cSvIPkEAVBQB8nQCMCcAcwJkkRNQxgmgAoC5AbNJkyb/g/5sIwiCOGUft/Ktvdy3tPF/S/ZSAbDfhQjwdiYAcwLkMBOAOQH+zgmwmwkQREBxhyZHSIdGNaA/4wiCIGX4867vq+7hVn+/h1tFG/9KYhMBlhVoTgDOBChhJkApOQHFZURA05u32jftCP15RxAEEdhdfXWtPbrvsndzq8keYTEBsIqI4wRgTgDmBGBOwK3SmQDmBJDiJ5p+AP25RxAkyNmlXdN5F7fGuJv7jliWTQTYnICVAewEYE4A5gTILCeg9HYAFQGNt2NmAIIgIOzkvv9oF/c9oQKANv419PU72viZCFhlJwLEcgIwJ0DeMwGYEyBhTkCJCLj1RJPzxU80bQz9XYAgSJCwS7s2Zge3ds9Obi3ZKQiAUhHg3AnAmQCcCcCcAPFnApgTILgBI6G/FxAEUTi7dOsf2c6tu7yTW0d2CAKgoggodQL8OROAOQGYE4A5AbdKnQAmAlbhTwURBPEL27Q/vbid+4E2frbWWZdjEVD5TMCKAHQCAjsn4Do3/AoVAafoyqAC4MBNbui2m9qhWwu4IbuoCDhCX3MLdG+dM+oG38CcgMDKCbBzAnaQtg3vhv6uQBBEQWzjfn53G7eebOd+JDYRsJ0KAPecAGlnAoIhJ+ASN+Ymbf57LuvGLL+iHTXmqnbUC5e1oxpcrf5u6sXqo2tdqT4q9sa9Q+85f3fanb4c9ytxgyILot/UmnWDk27qBicb4wY+cjNmQPOCuP79qACYYYrv/zMVAbmYEyCLnADBCSjq0Di38OlGtcT67CMIEsTQ5v/5P9xPZJuwmABYT3x3AnAmwM2ZgDwqAn65qB03m643qBBoTkWADvqccMTN+IEpVAx0MiW++a4x4fVlVATsMiX1uy7XmQBl5gRYnYAOTa4Wd2zcFPqcQBAkQNmVsDHiH27Dr39zP9PG/zP5hzZ/iwjw1gnAnACXOQHaSdnnuMlfnOMm9r0QPbFeTlyaIu7n0obPmWu80bIgqd84KgI2G2v0LcCcAP/mBFhnAthrD+jjjyBIgPGHdmPMX9wvx//mNtDGz9bP1mVxAcRzAoI3J+A0N2XPGe2U2VQIPH/23mn3QB9zKSmo2aeesWa/QVQErDLW7HMOcwL8kRNgEQHFTzaeBH28EQQJELbet6n2X9zGc1QAkL+FZREB4jkBQZkTYDzJTfvtNDd9wunqU1r7em9eaZhr9alhqvlqLyoCFhsfeDUDcwJEywmwOAEdmyyDPsYIgsicP6r/mvont+nKn9xG8pewyooAmwuAMwFuzQRcP6GdseyU9oMnoY9roGGs/VqMsVbvYXTtxJwAUXICmAhYA31cEQSRKX9W39TwD27zzT+4TbTxbyLOREBgzATA5ATk6WZdo69L87Hpi4YgBmq/OtRYu9cOzAnwKSeA3HqyySbo44kgiMzYyv3a/A/uV0IFAG38bG2yLldOgD9nAgIoJ0A352ouN4s2/Tn4lDY/Y0zprTPW7j2ECoHtspkJCKycAFLcsfFW0qpVFehjiSCIDNiq/fXJrdzvZKsgAH4rEQHSOQEBmBOgm3c1m5v7RZ523hPQxy9YYWLAXKfXEOODPbdhToBnMwFUDOwiTzWJhD6GCIIAsoXb0n0Lbf5bBAHwm7A8dwKCaiZgRTY2fdlhEQM9h5rq9MjDnAD3ZgLoOkiefiyofn2CIIiV37nfX9vCbSW/c1to499CRQATAJBOgDxzAqgIMGVxH81Pj5mfAH3MkMoxPtjzJVNyzx2YE1B5TkBxx8bp5JmG1aGPGYIgEvI790c3umjz30q2CGsL8d0JUFpOwMfnM7SLxuTFzI+CPl6I5xj1vRqYU17+HnMCKp0JOI5OAIIECb9ptz71G/cn+U0QAKUiQD5OAHROwMfHqQjoA32cEHEw1+6aRJv/R1QEmDAnwMlMQMcmh3AmAEEUzq+6P9v9yv1FfhUEQEURII4TELAzAX8c0y7Gn+8plBuGnnfT5j+eCoGLmBPg0AnYQZ5IvQP6OCEI4gc2V/+r0a/c32QzFQC/uRAB8nECJMsJWHks+tN60McHkQZSv9PttPm/buK7Z2JOQPlnBzT+jTRpoohnUCAIYmUjt+3RTdw/BZupAPhVWH8R/zsBss8J+P24dskD0McGgcPMd3uDCoGLmBNglxj4ROMN0McFQRCR2KTblrKJ23aDCgB69b+N2ERA4DgB4s4EHOKWZh3RLXsa+rgg8oCkvhZhNnSfjTkBZRIDV0IfFwRBfGRz9T2xm7gdFzZy2wkVAcLaLAgBKZ0AucwELLt+SLfsHehjgsiTwtQeD1AhsAlzAkqcgMXQxwRBEC/5Ub2t2i/czoxfuB208e8gGwUBwITAP2VEQOA4Ab7MBHy5ZP+9X+BPnZBKMad0e4IKgXTMCWhM/u3YeBj08UAQxAt+0e7cQgUAbfxsMQGwncA6ASA5AdsOcV/roY8FEniY+a5DzYau14I9J+DWE02fhT4WCIJ4wAZu99cbuF3kF2HtKBEBpU7ANlJ+JuDXgHEC3JkJWHHigParztDHAQlsrqe+dJfJ0PXjYM8JKOrYBH8lgyCBwAbt7rE/c7vJBmHZRICcnAD/zQTQV+M+3YpxOXFL8KdMiGgUGbrqzYaufwZxTsAF8lSTOOjjgCCICzZo973wE7eHNv49xJkIUOpMAH39ej+3Sgd9DBDlUli36/Omul1ygzQnIJ20b4Cx2AgiR9ZHH2j0E7eXNn629liXnJ0A0WYCLu/TftsKuv5IcEBSX7vDVLfrN0GaE/A3dP0RBCnHWu2hmB+5fVd/4vYRmwhw7gTscOAEVJwJCAQngL7+syt2FT7NDJEcU2qXlwtTu9wMtpwAuhZC1x5BEDvWcwcO/MjtJ2zZi4DAcAK8mwnYpVszBbruSHBjrte1pjm1y7Fgywm41bFJV+jaIwhC+YE78NGP3EGy3ioAfhQEgDtOQMDOBFygIqApdN0RhEGa9PgfFQGLgi0noLBjwxTo2iNIULNOe7jzeu4Qbf5MABwQliMREBhOQOUzAVQA/LHtnu/vha47gpSHDQia63a+ESw5AVQE5OIjhBEEiPW6A8k/6A6TH4TmbxEBrpyAnyuZCZB7TsAObu146JojiCtM/Itx5rov7QuenICm+OAgBJGajQm7ItZxh/LoogLAsso6ATYRoIiZgLPbtGsbQNccQdzFXLfz3KDJCejQZDR0vREkqFjHHd64ljZ8+kpKRYDFCfhBuA2gmJmAX3dp190FXW8E8RRz6ovtC+t1vhoMOQF0NYGuN4IEBd9zh961NP+yy7ETENAzAfOha40gvmBOfSHRXK/zCcXnBDzR9CLp0IyDrjeCKJq13JFHqQAga3WHiSACbK82J6DMTIC3TgB8TgBdI6BrjSBicPOhTvcV1ut8SPk5AU3/gq41giiWDffur0Kbf/73tNkLIoCzNP/ybkCgzwT8o9vQBbrWCCIm5PFeVc31Ov+u/JyApsOha40giuQ77tBH39Mr/DW0sbNXl05AYM4EFPyj3dQCus4I4i+oAFij9JyAwo7NMR8AQcTku+iDrdYIzf+wtfnbVqkTEOAzAZfo1T8PXWcE8Tfm1M7zFZ4TcBS6xgiiGH6IORD1ne7I+e9oo19j5wCssToAjp2AQw5mAmSaE6DdnPtX9OZE6DojiFQUpnZ+W9E5AU80w5huBBED2vjXsub/nc6yKnMCAmkmgAqAvVvv23o3dI0RRGoK63buouicgPbNHoOuMYIENLThd10tNP8jZLVNBDhwAgJ0JuD3Xdpdd0DXGEGgoAKghTm1c4EScwKK2jfNI61aVYGuMYIEJKu5o5pVusNXVtNmvlpX2vzLioDAnAmgryug6+szEXUSw9Qpj4bcVbMq9FaCC93tYRr9w+FVU2pC70QMih7qzBfWe+mSInMCOjSdBV1fBAlIaPNftppe+a/imACwOQDOnQCbAxAAOQGBG/ATyUeGqfXTVWrDtXCNgdgW/fd9qih+ImtM0FtUIqqo5GSVhh9F6/xPmbprDMZwDT8/5I5a1aH36AtmvnMN2vzzlZgTUNS+aSp0fREkoPhWd7TJKtb8acO2LUEE2NyAAJ0JoAIgcK/8q9S+jzahY/YNyOFS8ydoU5oXquZbQm85kAmNNDQKUxtm0JpmVlpzjeG0SpP8APSefcFcr2vNwnqdrygwJ+AAdG0RJKBYGX0ke6XQ+I+UNH93nQAZzwRshq6r11RNvYs29pNuNKJyYsBwgV25MucA+i0EBrrbw9X6wayhe1prldpwNSQiOQH6HfhCUb3OD1MBYFJaTkBR+2aDoGuLIAHBt9yR8d/SBr9SWKUioFQMOJgJcMMJgJwJoCJgz4Z7NwTsQJAqyvCOx82/jFXNX1ep+WmBblX7jYjkKFqfsbSJX/SlzuFRhtnQb8VXzA+91EaBOQFG8mSjaOjaIoisWaE9VnMFbeBMAAgiILqsCPDUCZBJTkDmJm67Brq2vhCu4c/61JjKugKfhFermwT9nmTBXQZtmJqfSQXSTTFqq9IYCkJCUgP+lyWFD3XpqsCcgB+h64ogsmaF7sjftuZfIgIqOAEBNRNwdqP2jxjouvpEREq8aM3fvllF8ZOg3xokVAgN8Udd2ewA9HsTg8LUl95RWk7ArXZNn4SuK4LIkq+jD/dcQa/4V7DGb31dKYiAw2VEwMoAmQnYpN12fUP0zjrQdfUVNoHuj0YliAC14YBKU7cW9HuUFI2eo81/i79qGh5laAv9FsWCCoC5zp8dEHg5AbfaNc8nnerfDl1XBJEV67S77vgm+sjlb3SWxr+inAvg8UyAHHICtNsaQNdVDELVhvp+a1YW29oUruYHQr9PKQjT8D3K/4TSD6LqWej3KSbm1M4rfJoJkFtOQPvmQe18IUgFvok+Oklo/tFHieXV3gkoNxPAeTcTIGVOwC/anR2hayoabEBN+L25/5qWpXHxgfsTSTegImeRv2vIVkgkHwf9XsWGioDNFWcCAjMnoLhtcxPp0IyDrimCyIKvoo9pv6aN+xtr87ctR07AygCYCdig3fkKdE3FhoX/SNG8wtUGRQ5K0avyr6Son0rDfwn9Xv0BSelWpbBe5z32MwGBnBNQ1K75EuiaIogs+Cr66JKvafO3FwGOnQDHMwGyygnQ7R4LXU//kFKF3a+XSARsZX8f9DsWC9qU10lSN43hVEiVOvdCv19/cf3h7hpzvS55zmcCAisnoLB9q4CfD0IQn1gWc6j2V0Lzp6ucCHDlBMgyJ0C75yfoevoV2ly8CgPy6krWsCuk6gMB/dNJJmJovf6U6Mr/ulKeDeAK2vAfNNfrbFJETkC75r9C1xNBQKHN//fltHGz5v+V9bVyJ0B+OQF0nfwtbq/y0+7USdXoFfpb4e7F0/ra1NLZ7+Sh37JXRPKRdP97pLjqV6kNY0LuTLkH+i1LhSn1pd62WwEBnxPQtmUr6HoiCAhfRh9tvZw1fqH5W16/jhbDCQCYCYje+xB0PaWGPQmQpfvRq9xsv4kANX8Q+n16g19/5ifEBPPzQiNSmkG/TyjMqV1WW0RAwOcEBOT5jSA+82X0kcNMACzX2USAp06APHIC6OsI6FpCExaRUlelMUyhV703xG54LCkP+v15gipK/7Z/Gj9t+lH849DvTw6Qx3tVNdftnCMIgEDPCWjXoid0PRFEUmjjf+lL2tTZWm5d9k7AV/6eCRAtJ2D/n9C1lBVRqRGWTHv+spjNL1RjaAH91twhLFJvENUB0fA32S8wlDzc5y1FD3XmzalMAHQmAZ0T0KblaehaIoik0MafYWn+x8iXOqsIsDZ/n2cCJMoJoK8Xv7/nIH4xOySlCnsKoHi3AgwX5d8EU6rQvWaI53zQxl+tthr6XckZc2rXoea6pbcCAjUnoKhti17QtUQQSaAN/5ll1qt/++XICfB0JkDKnAC6mkLXUu6wyXQ20S9KU1TzG6HfjytUan6xSM0/IywiORX6/QQK5rpdNllcgLIzAYGVE9AiF7qOCCIJS6OPHl5Gr/wtIuAYEc8JkC4nYL3u0PvQdQwkVBp+pDhOgP556PfiiDCN/mFxrvoNM0JC4v4H/X4CieupL91lTu16pkQEBGhOQGGbll2ha4kgfmVZzNEOS63N37bccgLklROwD7qOgQibWhdy/328OoZ+H46g+9okwm2O56DfR6BiTH2pgTm1CxFlJgAoJ4AKgXToOiKIX1kac3zPUqHxHyPCa4w/nAA/5gRwh69/d9/ROOg6BipiiABVlOEl6PdhD3v8LjZ/eEx1u0wURIDTmQD55wTcatOyE3QdEcQvLI050vILofFbm783TgB0ToD2MD7P20dEEAGycgFUan47Nn95YDJ02V7iBARgTgAVAYega4ggfuHz6KP/fEGv+L+gjXtpTKkIsBcDrpwAGeQEfARdQ6UQpjF09+leeaS+G/R7YIRG6pv61Pw1fNBnSIiJMaWLzly3y5UyIiDAcgJutW6NFxmIsvgs+kijz6NZ8y9dNifAm5kAqXMC6D+fXqfddQd0HZUEe/xvoLsAPl39qw1boPevREyGbq9QEUBEmwmQPCeg9W7oGiKIqHwWc2ytIADolf/ntGE7dQLYTIDOvvnLJicAJ3TFxvJcgXyvG2gU3w5y+6qoOine2/785ZAqte+D3L+SMRu67i0RAYGYE9C2ZWPoGiKIKCzWZkZ/Rhv550LzL0HRu9YAACAASURBVF3lnQApZgK8yQmgawd0DZUKe56AD010MeTeVWrDBB/ES3vIvSsdY2q3R8x1u5IyTkAA5QQUt2r1LXQNEUQU6NX/+5/FHCf2IqBSJ0BGOQHf6w6mQNdQydBG+qmX98+vQ+473NvUP7XhZ8h9BwsmQ9flDkVAgOQEkHbt0CFCAp8lMccuseZPhQBxxwmQWU7AEuj6KZ3wqvr7vb2SDlWntIHYsyoqpY7Xe440oL0rAQWpXaubDUwAlBMBAZITUNyy9TjoGiKITyyOOf7yEqH5Hye2V4+cANicgIJ12uN3QdcwGPB2IJC5BzD71Y/zzrUw4ICXhBQauo0xlRcBAZITUNyqzRno+iGIT1ABsGeJffOPcd8JgM4J+E53ZDh0/YIFb6+ooW4DeG3/471/yTEZup126AQEQE5AYatWL0DXD0G8Ykn08YeoACCLaSO3FwFeOQHS5wTkQ9cv2KDNfIc3TZXl8Eu6UY2e89L+xys6AIx8t05mQzdSwQkIhJyAVm22QtcPQbyCNv/PBAEgrLIiwNlMgGxyAqIPdYSuX7ChitK/7Z0A4N+QdJ8a/invrv4Ns6XcJ1KKie+6hYkAv8wE+DknoLB16weh64cgHrEsKaPap9bm/ylt4KI5ARLkBHzLHf4Fun5BSSQf590cAO/uoOb/CwmpfWdIlTr3hkQkJ4TcWatOeESdROH3+HfVrEr/9/9z5w9RRfGTvNknDv/BUVi3e4qJZwLAgRMg+5yA1vOh64cgHkGbf3cmAGyLOQA2N2AJcwNkOhMguADa4w9A1y9YUakN+70QAI7y0/8fa/KhmpTmYWp+YJhGv4D+/9aHa/hfwtSGLfQqfqdKrT+g0hh20X/fGq7mN6ru4n8MU+s/CY3ih4er9a3ZrxPonxNa/g+m/99fvNjjJf9XD3GF2dB9odkqAtyZCZBLTgAVAXjuIIHFp7HHf/ykjAAQ2QnwX07ATOjaBTO0Gc/w5uo6JER3O/3PbwtV84/RJj6LNuk/adPdRxv+Oc//PF5o2HQdpOuvsCj9wtuiktta/w4mUq55LgAMXwOXNui5mtw5ysx3v+7UCZB1TkCb1tD1QxC3mB9zIIo1f9uyFwGezgRInRPwJd07dP2CGfaoX6/mAGjTF67qNfwNr+7PV9bANQYT/bP3hEXqP/Dqz1DzQ6Fri7BZgO5pVAQQl06ALHMC2mEeCRIYfBxz/DXW+D8WGn86FQHH/OcEiJgTQF8/hq5dsBNerW6SB7Z6yfJH0xfz78X7//LgZp3e95r0TAB0J57PBMDlBBQ3bweaeokgbrMo9vivH9s5AOWdgIozATLJCdAeqwldO0QIBbribhOWsvH7sgdh+BCRBSa++8c2EeDJTAB0TsCtlu3xl0mIvPk4PvveRezqPzadWESA7dVeBBwDmQlwnRNw5Efo2iEWXA3ZCU1XA9v4PRUC9H87DF1TpJTCOt1qmfUvk0qdAJnlBBQ2a7ccunYI4pKPYtIHLKJNf5H1FoArJ8CbmQB/5QR8xR1uDl07xIKjp+zZGj/0VX9lIsDR/jz4mSIiEeaUl3+0FwF+nQkQLyfASOp3uh26dgjiFHrl//dHtIEvirWKgNhyDgD990+i/TwT4HlOwDHouiGlhEUkp3prtUMvR3tVafRPQ9cUKYs5uVcLU8rLxC0nQEY5AYXN2neCrh2COGSeNjP6I3r1/5HVAXDXCQDPCYg50h26dkhZwtWG/EBr/mVEgNWtYL9KgK4l4hhzystHyosAuecEFDdrvwq6bgjikAUx6cM/imUCwOIAOHYCHM0EwOUEUCFwDrpuiAPuTO4TaI2/wlIbyP9FpEyGLiXiGFNKz5fNKT2I206ATHICyOMdq0LXDkEqsDA2fc9C5gDE2lwAz5wAiJyA5TFHR0DXDSlLaERKM9r808EbuDhuwInbovjO0DVFHGNK7nHWkQiQc05AYfP2XaHrhiBlmKfLTLI1/4W0YVfuBMgiJ8CIwT/yIlSd0kalNuRBN25xF38uTK3vCV1bpCKFKT1GmpJp8/fECYDOCWja/gfouiFIGRbGZIxZyJq/bdk5Ab7PBPgnJ4CuudB1Q0q5TW14jl4x58A3bL+IgLPhkfr+0DVGynKt9itqc3LPAlNyD4ciQK45AaR1azV07RCkhAWxGRkLYizNf4FHTgBcTsAXscfioeuGWLgtMvkplYY/Bd+o/bfY8wXCovR9oWuNlMVYp8c8c0pP4rETAJkT0OSJV6DrhiAC8+OPpcxnjd/a/G0OQHknQIqZAPdzAo6sga4bYkFo/lGGi9ANWhoRoL9CRUAf6JojpZiTeyWYkpkA6EG8cgJAcgI6bISuG4IIzI/JmDw/NoPMj2EiIKOMCPBkJkDKnIClsUfaQ9cNCQkJrZpcn175K2Lgz20RoOFP3RbJPwVde6QUU3KvjUwEeOUEAOUE3GzS7j7ouiFICL3638ccACYCFpR3AvwyE+BzTgD+NlsORNaKtTyyF74pSy8CDJlhkXoD9CFALJjq9HrF4gL44ARInRPQ+Ilu0HVDgpx5dx+6c561+c+zOgC+OQES5ATojuFT/8CJ+x+9Ev4buhEDOwE7Q6rUxqs4GcCGAU0P9iTm5F7EVKeHd06AxDkB5sYdF0HXDQly5sYebzePNX+rCLA4AZYlh5kAh05AzHHM/QeGNr/voRuwHJZKzf9Fy3Eb9PFAQkLMdXqtM9VhAsBHJ0CinIDCxh2PQtcMCXLmxWW8N5c2cHsRwJwAMWYC/JQTcBm6ZsGOSqMfTRtfEXTzlcsK0/DzoY8JEhJiqt2ri7nOK4Q5AaZkixAQdyZA/JwA0vxpDXTdkCBmbmzGn3SRubH2IsC2Mio6AcA5AUujj86BrlkwExqpb0qbv8KCfnxb7OeBqqhkTAsEhtTsVdX0IBMA9i6AeDMBfskJaPwkPmgKgWFJXM7/7Jt/WRHgfCYAMidgWcyxx6HrJjZsmEylqVsLeh+VclfNquy+N3TDlefij4Wo60RDH6LKCK9WNykswlAPeh/+wvzgKystAsDiBPh3JkCEnIDGT34AXTMkSJkbn95ojtD47VdZESCnmQAqApTz4B91ii48yjCHNtSbJVeSGv5GmFo/nTVa6O05gu5vCXyjle+i9VkHfYycoYoyvBOuNlwos1+14dPwqvr7ofcmJsbavZ+zuAB0CfMAMpgJcJUT0OjJndA1Q4KUObGZo+bEZZA5tIHbBMA8+u/+mgkQISdgGnTNxCBMwz+k0hgKnDYSNb8tJKT2ndD7tOc2tf4Fuq8b0E1WzosKAGO4Wj8E+liVh55rrgc2o/QdoPcoFkQ3+HZTrd5G262AMjMBMs0JwKcDIiDQ5v8zcwBsy7kTUDoTAJkTsDT2SF3omvkKu+KiV15XK20oasMW6L2WcHuSjjb/I9ANNhAWPbb5IVXqpEAfMhv0uC13Z9+hakN96L2Khal27y9Nta0ugB9nAsTKCTA3froldM2QIGR2bIaJOQCzmQCIsxcBns0ESJQTkAVdLzGgX8hL3G4oUbws0g7D1fwi6MYaSIteca+FPmYMlVr/oAf73gy9X7EoeOCVJ6gIIMbapQLALMlMgJc5AQ2fGg9dMyTI+DA2oy5r/LblnhMANxNAXwP/QxKVGuFRM1EbtkJvOaxayiP0qjYocv5FEwBq/pocooJVGv5LT/YdEpGcAL1nsTDV6n2diYAyToBcZgLK5QRQEfAbdL2QIGNWXNbAWaz5x2WSWVYHoNQJSC/rBMggJ2CxLv0R6Jr5Cpv297SZhFRNvQtyz+zKELqhBuKiImAvLV8o5LFTaQxGj/atoFkAc63eK6gIIM6cAJnlBJig64UEGTNjM1bOsjZ/z50AyXMCFPEBCa+aUtPTRhKm5l+F2i9tYp3oVaTTYUVcLgXAv+Fq/WCoYxceZWjr6Z5DI1KaQe1XbApq9X7DVOtVYhMBUswE+JITUPzY04qZwUACgJlxGZeoCCAlIoC+zq7MCQDLCTj+C3S9ROGumlU9biRgPy1LvYNeQe6GbqSBvfhjIXfVqg5x9Lya21DQTwILH3gt2fgAEwCvEmMFESDDnICGzwyHrhkSJMxIyLp/ZmwmmUmbfhkR4MQNAJ8JiE4fBV0zsaBN4VdPv5hZM5Z6n6GalBEqteEWfBOtfOnrP0O2/LmrZG3esp2sXf8bWb5iPVm05Fsyc95SkjZ5PunRdxRp2Ko7uTuuoWR7C43UgwS9eDy3oeZzIPbpT0wPvHbdZBUBDp0AucwECCLgWdlmSCAK48PYjN72zb+8E+B8JgAoJyDmeAPomokFs4W9aCT9Jd1ktdpqlSZwfvbHmrqnXL5yjfyzYz+ZNX8pea7bYHJPvH9EgYo11og6iVIePtr8n/V0n2Fqwwwp9ygFxpqvfUdFADGWEwFOZwIAcwKKHn/2OnS9kCDhw9isuVQEWB0A106ADHICFHH/v4SIlHjPm4jhInv8rlRbDI9MGUAbF3hj96cAcMT+g8fJnIVfkiZte4i6vzA1P1OqY8eg4u2Yp3sMjeSbSLlHKTDe33ewqeZrxJEIkGNOgKlRp3jomiFBwAdxGRs+pM2+VAS46wRInxOwODZdcT+RUWkMRz0WARp+pDS7090eaPf+xRIA9uSdOE0mTVtEahrai7BH/ljIHdLMAoRp+B4en1tqwzUp9iY1BUmv1TXV7EOM5USA0YUTAJkTYH7suVbQNUOCgA/iMrMEASCIgEwRnQC/zASMg66X2NCr62meCwBDAXuQi//3JkT+FkI3dWgBYM9f2/aSzr2Ge70/Ws//wu/ih/n72IVUqXOvN5kNLC/A73sDwnR/n+tMBNicADnPBFAB8Dp0vZAg4INYS/O3vXruBEiXE7A49phifppkg01be9lIDvt5IPD/0WbwF3RD93Q1aNnNrwLARmZ2Puk/dBKJ4B71/Nhp+D0hkXykH48dm/z/05v6sUc8+3NfkJju77veeD8TABWdALnlBJjrP4dPBkT8C/sFwAes+dscgPJOQJy4MwG+5gSwRxZD18wf0Cu1VV6KgG/8tafbopLbBuIDf/ztAJTnzNkLpGe/0R4eN8Mtf2Y60D9/glfnk8aw2197kgPGGn2HG+/vS2wiAHImwI2cAPwlAOJfZsRmtZthFQCeOgEAOQF/QdfLX7Bnsnvf9Pj5/tiTKkr/HXQzF1sAZI9NJ39xG8juBzeSgy1/Jxnd/yb5b+8m5+cdJabDl30SAtt27if1Gr3g9j6pAPiDlvk2Pxy3t72un4LS/xxhTOr3KBUBtPGXigBnMwHwOQHPHYWuF6JwpsdlDWQCoEQElHcD3JwJkCIngK7J0PXyJ+Fqw8/efnGrNPwaMfei0tSt5c30uByWKwGQNTaDCoCN5B/uZ7Kd+4Hs4taQPdwqsp/7hhzklpNj+hXk9MCt5MYP2eQ/Y7FXQuDz5d8T7v6mbuyVPxeqrvOYmMeNiUGvzyE1f0jMvcgVU42+JuYCmO6vKALkNhMAXStE4cyIz5wzPdYiACwiIMtjJ0CynIDoo62h6+VPQqNSGvrS+FRqw9/sAUOi7EVteEsYVpNBQ/d0uZoByBybSf7gNpO/uV/INu5HspNbR3Zzq8k+7ltygPuKHOaWkSPcZ+Q49ynJTPyEnHtjIzFuzvFYBFy6fJV0fP7NSvcaFqWfLcbxYjAR6Nv5o39BrL3ImYIafX8x3d+PVOYEyCEnwPToi3HQ9UIUzLS4zJ+m0yY+Pc5eBDiaCYDPCViQmHkPdL38Dbun72MDPB0WZejn2y6SwlUaw9/Qjdzb5coByBybRbZyv5E/XbgAh7kvyDFuMUnnPiZZ3AKSw80lJ+osJFcnbCH/nr3hkRCYNnOx66ar0e9i0/o+nTNRfBf6Z2X61vwN//h2zgQOxhqvv2+s0Y8IIkBwAeQxE+AoJ8D86PMtoOuFKJjpcVmZluafRWyvFZ2ADC+dAHFzAqBrJQnqpGrhav6kz41QbcgPZ4mBVWrf5+kWWAgM+y04dCP3drlyADLGZpMt3O9UAGwWZgG2cz+SHdxaspv7juwVXICvySFuGTnKfU6Oc5+QTO4jks3NI3ncbJLPfUBOcdPIlddWk6Id+W6LgL+37yPxD7ZyJgBMqgjDcx6fJxHJUWyIkB4nnxMaVRr+ekhU7RiP9xCgFCT1622q8ToxJllFgJszARA5AeZHX/BRzCOIC6YJV/+W5u/MCfBmJkDsnAAqBnZB10oq2FPYRG2Kav6PcMHSN9R25++nDWEJdBP3lwBIH5tDfuf+EFwA2yzADjsXYF8ZF2BJGRcgn5tJTnLTyWnufXKOm0SuvrSM/Hviilsi4PyFy+Shxo4HBFVqfr1bJ0ZEnUTW9Ol/s0nMejEHwacTNsAwJfVrbEyiAqBGv9LlxAmQwUyA4iKZEZkwNSGrxrT4LGIvAgQnwG8zAT7kBMRkfA1dLymhX/Qf+qM50mZzWaUxrKVNfkSoxtAiLCI5VXjqm5BMV/vOEI2eo//bQegm7j8BkEt+5f4kW7gtdrMA6+1mAVaS/XazAOncpyRDcAHmk1xuNjnBfUhOcVPJWe49cp6bQC4lTiSm+X+4JQIKCkyk7dN9HBwTQ75FnKXewRyb8Gp8jbCIlLrs9/hUuA2x/ESUP++n82EF9LkuNbTRc8akNywOgOAE9HXLCYDJCXhhLXS9EIVCG33baXFMAJQVAe7NBEicExCbPgG6XlIjhr3r6QrT6M2BlPvvqQA4PjaPbOb+Jr9zW8u4AJZZgO/tZgG+pAKgdBYg0+oC5AkuwAyrCzCZXODGk8vcGHKjzVzy3yn33ICX+4x00Ij1JoBanWK3EqDPcwiMiazx25bFBZDbTICQE/Dwi0ega4UolKnxmf2ZAzCVNm6HTkCZmQDYnICFMce7Q9dLctR1osN9HO7ydFHRAd7AfV2uhgCPjc0nm7h/yG/cX27MAiy1mwVYRLLKzQKcEVyAieQil0aucO+Saw+MJbd+POiWCBj33vyydddILbr4c1R0PAh9ikNhTHxjv0UEeO4ESJ0TAF0rRKFMjc+ePbXEAXDsBMxw4ARA5AQsis0U9ffSAcOdKfewyF+JmgIJ9Kt/tlw5AEfHniAbuR1WF+APBy6Ao18EuJ4FYC7AJW4MucqNIte5t0nhOysJMRdVKgLenTCnVABIWXe1IT8kko+DPrUhMSa8sZKKACIsmxNQbiZALjkBJkPnWOh6IQrk/bisH6faOQAOnYB4f84EuJ8TMDsp427oeoERyUfSBrHd342BNSHlC4CTZAO3k2zitjmYBXCdC1A6CzDLbhZgChUBE6gASCOXudFUAIwgN7hhxPTELEKuGSsVAX0GjJO09izcKeQugxb6lIbGmNB/ChUBVAC8SUpvB4g8EyBSToDpoRebQ9cLUSDvx2dlUBFAplqXKycANCcgJv0GdK3gSalCr9w+8bcAgG7e/hYAR8aeogJgN9nIbacCoHQW4E+HswArnOYClJ0FmFQyC2BzAQq4IcTUfAohF65XKgKe6TLIWn9/N3/D2pCqqXdBn8lyoCD+zVeMCbT5syU4ATKeCUh9sS90vRAFMiU+8wYVAUQQAZU5AYA5AQtiju+ErpVcYJP79Mv8lJ+uDsGbt78FwOGxp8lP3F7yC7fLg1kA17kAFWYBuHfITW44KdANJqYG48h/+RcrFQFN2/X0mwCjf+4lVZS+K/S5KydM8QMbURFgEQBlnAD7mQB55ASY6nVOg64XokBszb9EBHjpBEiQE/AVdK1khRAWJL4boBQHwNUQ4OGxZ8iP3H7ys+ACOJoF+MnrXIDyswDMBSiIHkSMqSPJf5lnXAqAq9dukMTktqIfAyrqvmNzJNCnrNwoiH5Ta4zvT4xlRIDrmQDAnIBp0PVCFEaa9vQdU4Tmn02m2IsAd5wAqXMCotPHQ9dLjojpBliu/pUhAFw5AIeoAPiBO0AFwF5hFmCzw1kAH3IBrLMA16yzAMbot0hBzABienQU+e/sVZciYMfug6IJAMtVf3AF/HhKQRwTAP1J5U4AcE5AaucF0LVCFMa0xMx7prDmTxv8FJGcAH/lBCyIyegGXS85Exap7yak/fnUMOAbt3QC4JDgAmwo4wKImwtwlRtJBYDVBYgZRFizMbUYR8i1ApciYNqsJb41fo1hd1iUoa8Q6oS4xBg3YJ/RKgJKnQD5zQQU1u2yFLpWiMJ4LyYv4b041vxtDoAXToBEOQFzY9JbQtcrEAivVjcpTM1/QJv5RS+uGMEbtxQC4CAVAGupAFjPHbSbBdjmxSxA2VyA0y5nAd4ixtiBwpWm+dn3K/2JYBsHaYGumz5/nQrAj8IiDPWgz8FAgoqyn6kIIGI7AeLnBHT+DrpWiMKYFJ+d8h5t+hYRkFWm+XviBEiREzA/LuNR6HoFGmGalEdoUxhKm8M62tyvoACwcEAQAIdLXADnswDi5QIUcEMtswC02bCmUjTwY5cC4PSZ80QT+7irhn+THttf6OvI0EhDI+hzLVAxxg74tiB2gOW4VHACKp8JkCwnwNBlI3StEIUxJTHzMZsD4JMTIEFOwILozDrQ9Qp0WLY8bR79aaP/VqUx7KINJIs9F8DW/INHAJwla2jzX0dFwHphFmCfJLkAzAUoiB1IG0t/4Yry1vLfXYqAOQu/ZLdlrtLjlEMb/R661jBBF6bRPwx9LimFgpiBS4xxA4lNBLh2AkBzAoLmUc2IRNCr/1aCAyCsrDIiwD8zAd7nBCyIOxoHXS8lo9Lov4Bu2lIJgP1jz5A1usPkeyoCys4CuMoFcOQCeJ4LYIwZbLnSZFeV9Orxv6OVPlI4BfrcUDLG2IFzBFEWWyoC5DkT0PUAdK0QhfFeYu7Tk2kDZwLA9iruTICIOQHcUQ10vRTM/9Gry23QTVs6AXCWrKZX/99TEVBxFsD/uQCs2bDmwq4kTc1GEHLT5EoA7IA+OZRMQfSgycbYQaQghh4Tt50AkJyAbOhaIQpjcnx2t8ms+du7ACLMBPgjJwC6VoomIjmBCoB06KYtlQDYxwSA7gj5jjvs9iyA6LkA8QOEq0p2D7no3S8qcwGegz5FlEpB9OCR7BcaRvYrjUqdALicABPf/Tx0rRCFMTkhq98kqwCwdwJ8ngnwQ04AdK2UTGhUSkOVmr8B3bQlEwBpZ8lK2vi/0x22zALoDoPkAghNhV1BPtCH/Hc0z5UAOAh9jigVo+6tAey2jCDKfHIC/J0T0M0IXStEYdDmP4wJgBIRYHMAys8EwOcEXIaulZIJi9K/Bt2wpRQAe8eeJd/qjpBVTABYbwNA5QLYZgHML0yuzAXoAH2eKJGb0YN7FkQzATBYOCaCCJDpTAB0rRCFMTEhZ9xEqwCYRBt7eSdA/JkAr3MC8qFrpWTCNPx86IYtpQDYk3aWrBAEwBERZgGWOs0FcGcWoECYBegnXCneWv2nKwGAz8LwA0burU6CI0MFgJROgDc5AeSRLtWg64UoiAnx2dMnlQgAeydA3JkAEXICDkPXSsmEa/gN0A1bSgGwe+xZ8k30kRIXwJNZAH/lArBZAFPjYZW5AC2gzxWlcVM3uI3w80yrCCiIsToBIs0EiJkTUJDatTp0vRAFMSkhZ6HNAZhIG7YjJ0AeOQEZ26FrpVxq3ylkAsigaUsmANLOkq9p8/+WioCVTADQfy6bC7AXJBeAzQJU4gJgGpzIGLVDGhh1QwRHpsBnJ8DPOQF8jxrQ9UIUxIT47GVMANhWRSfAyUyAxDkBs2MzN0PXSrEo8BcAlQmAXVQAfBV9lHyjYwKgdBbAs1wA2yzAChFzAfoQc9vRlbkAVaFPGSVxkxvGCzMZTIzZOwEynAko0Hc3QNcLURAT43PWTBCaf06JAJB2JsDtnIA10LVSKqHq5PoqNX8VumFLKwDOkeU6KgCoCBBvFsC3XIACay4Au0L899e9rgRAb+hzRklcjR6WKNyO4ZgAsDgB4s4EiJcTYErp0RC6XoiCGB+f/QMTABOcuAD+mgnwPCcgcxV0rZSKKorvDN2spRYAO9POki9p87e5AGwWwLNcgJ/EzwWwzgKwK8XCPrNcCYBfoc8ZJWHUvh1zUxAAQ4hDJ0DkmQBfcgKoEMAZEEQ8JsTnfCM0/4ScCiKgdCZADjkBWRuga6VUQiNT0qCbtfQC4BxZSpv/crosswBHrbMA8skFqCQd8F7o80Yp3Kg+vFYBPQY3BQFgEQLizQSImxNgTO5VH7peiIIYH5fzKRUBxOYC2IsAj2YC/J0TEJv5F3StlEqYWr8QullLLQB2CALgWAUXQE65ALdWuhwGxNsAIlEQPeShm4IAGEosTsBQx06ADGYCCpN7JEPXC1EQ4+NzZo1njT8hh4x35gTIIydgP3StlIpKw68O1yjnKYDuCYDz5HPa+JdREcBmAb52axZgmxezAGVzAU67nAV4q8wsgLnXTFcC4Avo80Yp3OCGN2X1vyGIAHsnwF8zAT7kBKT0joeuF6Ig0uKzJ1ERIDR/Z06APHICMrKga6VUwtWGLdDNWmoBsC3tHPk85lipCyAMBNpmAeSTC0DMRc7eQi70eaMUrmvffuKGIACGWwXAMCLlTIAnOQE3DD3vhq4XoiDGJeSMGEcb+HirAzDB5gC4nAkAyQk4B10rZZJSRWlPAXRPAJwnS2jz/4KKgGXW2wBsFmCFzlkuwD6QXIB/tx935QJooc8eJXBN+85L7DbMdUEAWJwA/80E+JYTQOoPvh26XoiCoM2//zih+duWcycAMifgg9iMm9C1UiRVat+nUvN7oZu11ALgHyYAYo6Tz6OPuZwF8CwXwJEL4FsuQPGcH1wJgC7Qp48SuK4b8Sqr/Q1hWUSAXGcCoGuFKIzxCbm90qwOgGsnAD4nALpWSiS8qv5+JYYAuSMAPqVX/58JIqB0FkBOuQCseRS+7PLngNOgzx8lQOs++DqtfXkRIN1MgHs5AXRdg64VojBo839+nND86bK+ymEmwJET19CBbwAAIABJREFUMK/2oTuh66U0wiKSU6kAOA3drKUWAH8LAuA4WUJFgGUW4KiPuQA/i58LEE8bSepwVwIAszFE4Jp2xJhrggAoKwKgZgJc5AScgq4VojDSEnLbpVmbP3MCxlXqBMDlBEyNy7kPul5KIzRK30Cl5i9DN2vJBcC48+RjKgAWMxFgnQWokAvAySMXgNxwmgewD/r8UQJXtSOnshmM8iJAmpkA938dQEXAcehaIQqDNv1Gaaz5J5Q6AO46AZLnBCRmJkHXS2mEalKaUwFwE7pZSy0A/ko7TxbR5v+J4AJUPgsAmQvw74E8Z2/DCH3+KAFa8/nXBAFQUQTIaSbA+MBru6FrhSiMtKTcumPjLQLA3glwNBMAnRPwYVw6D10vMVBF8k/Spjs1XM3/Eq7hf4dcKrX+AN3Lf9DNWnIBMO48+UgQAOnk0+iKswDu5QK4Owuw1GkugDuzALe+3+n0fcTWavmXdOeLYXOYmp9Jz5dOISE6xUyjX+FGfXGNCq+rlYgAGeQE/A5dK0RhpCVk3T+WNvXyIkBuMwHMAfgwJvNx6Hr5RJXa91m/SMGbo23RL3PwPUAIgD+pAFgYmy64AJ8KtwKOOc0FWAWcC1A862en74N/7Fmg88ZwILwar4hH017Vjlp9VRAAI4krJwA6J8D4QJ8foGuFKIy06HytpfnnVhAB3s8E+CcnYEZs1rPQ9fKW0EhDY/rFeQa6KaIAsAmAC2QBvfpfREVA+VmAZWVmAZzlAuyVLBegcPS3Tt8He49g546Gv06FwHPQny1fucqN/psuckUQABYnAG4mwGVOwNfQtUIUxtsJWRGCA2BbTpwAOeQE0H9/G7pe3kK/KL+GbogoAEr5gwqA+bT5L4xhAiC9ZBbgMwezACu9zgWwzQKs8CkXoPCt5U7fR+unXoOts5r/A/qz5StXuHfPXaECgNX8qlUEyHEmwHR/n0+ga4UokDHxrPmXOgDuzgRInRMwLTZzEXStvEEVlZwM3QxdCwBligBXAmArFQDzmACgy9UsgBxyAcx9PnP6Pp7pMgi8zuFRfHvoz5i3XEpKq3ZZuPp/l65RZUSAfGYCSnICZkLXC1EgYxJyTGPsXQDZzgRkBuRz0MOiDH3Bv6SdCQCFNn93BMDc2AyLC2A3CyBeLsBPouUCmLt97PR9dH9tBHidVRrDFOjPmLdc4dL4y7T5XxYEwGhi7wTIbSbAVKPvROh6IQpkTHxOzpiEXFLWCRBzJkC0nIA86Fp5Q7jaINvH7Sr5FkDDVt2dNs4t4y+QObTxz6MiwNksQIVcAB1MLoDx+YVO30ffgePA60zP75+hP2PeQuv8HBNbV+gq6wTIZSbAzglI7PsmdL0QBfJuQu4m5gDYlkMnQCY5AdC18gZ0AGCWKweACYDZtPnPpY3fNgsg11wAY/clTt9Hj76jwOscyA7ARe2Yty9zY4VaO3MC5DITUJDYry10vRAFMjohZyFzAN4VBIB7TgBUTsD0uJwHoOvlKWHqlEehv6Sdfnkr2AFwJQB+pwJgFhUAc+IyyLwYu1mAWF9yAbZ5MQtQNhfgtINZAGNf50OAz3UbDF5nVZThRejPmLdc0qV9fEkQAGOF2y6XHTgBcpkJMCf0UcTPLhGZMToxdxhr/u+WiAAXTgDwTMDUhKwO0PXygv+jX5SboL+oUQCU8hsVADOpoLS4ABVnAVzlAqyWOBfAOGS10/fR9uk+0OfP4ZCQ1DugP2DeQkXWr+x2yyVBALh2AqBnAqBrhSiUUYm5T7PmPzre4gB44gRInRNAhcBA6Hp5hRAChDkA8hEAF9kjpsksek7NEQSA81mAZdbbAGwWYIXOWS7APr/lAhSMWe/0fbA5B7BzR2MoUKkNtaE/Wr5wkRuXf1EQAGnkop0TILeZAFPSm9nQtUIUysj47JTRQuO3NH/2WulMAFBOwPuxmXOg6+U1UakR4Wr+IzlF7warAPh1/AXhCZMzaeOfHWfnApTLBahsFsCzXABHLkDluQCm2Vudvg/D488BNX/+y5A7alWH/kj5ygVuHG3844hNBNhuB8htJqAg4c2N0LVCFMpg3YnbmQAYbW3+oxNcOQGwOQHT4rJ+hK6XzzAhEMW3o1+iI2kDTgNdGv1S6EYNIwAuCuFSH9JVMgtQJheA3QqQRy5A4dpDTt9HrXodp0p3vhjepefL0yF3Gu6G/giJwcXqE2pdpALLmQhw7ATA5ASYEt5cAF0vRMFQAXDGIgIcOQG58pkJiM9Kh66VkgjVpDSjX+5F0M1aagGwWRAAWRYXwMUsgHi5AD97nQtQvP+0s7dxA/r8CWQucBM6XBAEgHMRIKOZgKHQ9UIUzOiEvD9G0QZexgmQbCbAs5wA6FopidCqdR6jAqAAullDCICp1qdMfhCbaZ0F8DAXgJMmF+C/62Znb2Mn9PkTyFzgJg6iIoCcpwLAkRMgp5mAgrg3n4KuF6JgRsXnfTaKNvVRVhfA45kACXMCpiRkJUPXSymERaTUDVcbLkA3a6kFwEZBAFgSJiu6ABmyyQU48+Asp++Bshz6/AlkznMTP2OhSxeE5b0TIMVMwM2EN/E7D/EfoxJzRwvNP5GJgLJOgM0BkEtOwPuxWa9D10sphFerm6RS89nQzRpCALDzieVLuJ4F8CUXwN1ZgKVOcwEuPv+NKwEwDvr8CWTOcZOy2IyFTQScr0QEQOYEQNcKUTgjE3NetDkArpwAWeQExGXhlY9YVKlzr0rDH4Ju1lILgF+YAGBiUnjSZOWzAK5yAVb5MRfg+od/uxIAaAt7yfm4qfex+YpzggCwiIDzlTgBgDkBp6HrhSicdxLyHxrJGn+itfk7cALkkxOQeQq6XspBd7tKY9gN3aylFwCXhPPrfWu+hGUWwP1cgNJZAGe5AHtFyQUw/3PSlQBQQ589gcoZbtLzZwUBYBMBk4TcBTnOBBhjBmyFrheicN6JyYtiAmBkORfA65kAP+cETI/PjoWumVIIV/N/QjdrqQXAhvEXhXPsPWvI1HTbLADLBYh1ngvwmYNZgJVe5wLYZgFWOMwFyE1Y4Kr5H4Y+bwKZs9rJs89ykwlb56xCwP52gJxmAuhaAl0vJAigzf/KyMQ8UqkTII+cgK7Q9VIKKo1hFXSzllwATLgknGfvWWdL7GcBmAhgLoA7swD+zAU4+7LzBEDKQujzJpA5y03Zy3IWztFlcQIml7kd4MoJAMgJGAVdLyQIGJGQt8PmAnjmBEifE0C/tPELUCTC1HrZPq7YXwLg5/GXhHNukvW8cncWQLxcgJ8qzQW4sSbDlQDoDH3eBCrn70678ww3RYhbPisIAHsnYKJoToBYMwHG6MEB+7AlJIAYkZD7FXMARjAB4I4TAJgT8F5CFlqgIhEalTICullLLgAmXLL8KsV6PrFfl9hmAT70NhdAJ14uQEaNz8l/pluuBEAU9HkTqJzWTW1zhnufnBaa/xRS1gmQ5UxAPeiaIUHAOwl5b9s3f1FnAvyQEzCZO6mBrpkSUEWlvAjdrKUWAD9RATDOet5NsjpLjnMB0ktmAaTMBTjdf4ur5r8e+pwJZE5zUyexlMUzwnLmBMhnJoDEpf0PumZIEDAiKbf+CDsHwF0nACwnID67I3TNlECYJuURlYa/Ct2wpRQAP064LJyP7PxzNgtQkgsQYzcLEOtLLsA2t2cBTPsuuhIAOP/iA6e072+hIoCUFwFnBAHgeiZA6pwAo27IP9D1QoKIdxJyTTYRMMILJ0DKnAC6pkHXSxFEpMSr1IYj0A1bWgFwSTgv7V0AsXIBVvuYC5D11EZXzd9E153Qp0wgwx60dEoQAGVFwJlKZgIgcgKoAHgful5IEPFOYu5v71ibv6dOgNQ5AZPislEdi0LqHSoNvx26YUspANZPuEzetZ6P7LybRF99yQX4yjoLsELnLBdgn9u5ANc3nnIlAL6GPlsCmVPaGY+dpALgtAMRIM+ZgLc6QNcMCSKoABj/Dm327yTklREBos8EiJQTkBaXg/fHRECl5tdDN2zJBQATpdbZlJJZAEe5AHHOcwEqmwXwLBdgDTncYIOr5s9oBH2uBDIntNPePsVNJxYXwLETIKeZgPN3v45uDyIdw+PzWr5NvxgtIsBLJ0DanACcAxCBMDU/E7phSykAfqACYJQgVHPdnwUokwvAbgWInwtwbfNZV83/L+jzJNA5pZux5aQgAKYTZ05A6UwAeE7AAeh6IUHG8JrHqr5Nm/zbCXkVRMCIxFwvnQA/5gTEZX0JXTMlEKZO6Q3dsKUUAOusAqDEBSj3iwDpcwF+Jse776js6r8t9HkSyGTfM/PeE9wM4SmLNhHguRMgaU7APOiaIUEIbf473xFEgI9OgAQzAZPjs40f6E7cDl2zQCe06oOPq9T8TeimLaUAGGEVrGMS7GYBHOQCfOBtLgDnWS5A4SmTq+Z/CPocCXTytDMGnOA+IDYRcKISJwB6JuCG9m0MAEKkhzb+DwQXoIwI8PNMgA85AZMTsp6BrlnAE2mIVWn4DOimLZUAWMsEgPU8duYCOM4FsAwEip0LkPd+ZmVX/89CnyKBzglu5l/5ggCwLN+cAP/PBNyMG3YfdM2QIGRoYu7T9s3fVyfA3zkBdH0DXTMlQAXAX9BNWzoBcEU4r9n5O8p6XrLzb4LHswC+5AJYZgF2NqnU+v8b+twIdE5pZ0TncR/Sxj+TlIqAsrcDKp8JkDAnQDciG7pmSJAy4oGTmuE2B6DECXA0EyCbnAC8DSACYWr9J9BNWyoB8P2Ey8J5/Y71XH3Xeh76IxdglYtcgN8StxFjtkvrn1ET+twIdHK5mUPyhebP1ofCciQCXDkBEucEfA5dMySIGZ6Ud2R4QtnmL+eZgIlxOS9A1ywQCK+aUjMsytBXpea/VWkMu8LVfBb958usYarUbPHgjVsSATDxChlmPa9HWM/XMrkA8b7lApTOAjjLBbDMApxd6zLxj0ybuZgdl6v0OOWoNPweutbQfx6oikpOhj6XAok83ewduULzn0WcOQGymgnQjXgFumZIEDM8Me8j5gJUdAIkmgnwNCcgIWc1dM1kiTpFR6/se9Fm/wVtHCcra5rBIgDWTLhChlrP7xHCbQDrLEC8G7kAsc5zAT5zMAuw0kkuwMGBOS6b/4lTZ0kE96iL98ifp8frm7Ao/Wvh1fga0KeaXMnUzovO5WbTxj9LWPnCsjkB8pwJuM6NuB+6bkgQMzQpr+sw6xdkqRMgzkyAv3IC3q95rCp03eQCvWp8Llxt2Opp0wwaATDxChkinN/5DmcBXOUCMBHAXAB3ZgGc5QL82T6T/Gv6z6UAaNT6Zc+OncawO0zDvwx97smNHN2cd3K5OcQiAthy7QTIICfgEnTNkCBnSHx2rM0BcOwEyC8ngF6xBfdDUiL5SFWU4R3aDE572zSDRQB8N+EKeYs2/6HW89nVLMB7HswCuJMLsLlhBim6+q/L5j8i7UOv3zcVfxfpGh9yZ8o90KekHMjh5u7NEQSAvQgo7wR4PhPgx5yAldA1Q5CQYYl5p1jjH2a9UgqAmYB10DWDgN3XD1fzi+gVoNHXphk0AmDiFTJYEAD5wvldMgtQLhdgooNcgA+9zQWgV/8/pR4npjPFLpv/L7/+LdpxUGn4L9nTHqHPUSgydfOSsrm5tPHPJeVFgGxnAnSjB0LXDUFChiXlfzmsnAsANhPgZk5AsN0GoI1imtiNUykioGGr7k6b7CoqAAYl5QsuwDAmbq2zAJ7nAqSXzAJUlgvwfcpxciOz0GXzzztxmtwd11D0Y0D/vCUhIbqg+6VMNjfv3RxuHm3+c63LXgTIcybgavWRdaHrhiAhQxNyOw+zXiENL3kVfyZAzJwA+toTum6SoNFz9EvdL0/wo1eN4M1bjOXKAWACYCA9p9+iIsDbWYCSXIAYu1mAWMezAD80yCQFJ4pcNv/rN24Sw+PP+U2ACY98DrJhwSzdgsPZggCYR5w5AeLNBIiQE6Abcwq6ZggiMFh34vah1lsAlTsBsskJ2A9dN38TqjG0oE3ikr8ap1IcAFcCYCUVAAOSTpBBifllZgFG+CEX4MfW2aTwyi2XzZ/RtF1PS/39KMDon31TFcV3hj6HpSA7emGjLG4+bfxsWUSAYyfANhMAnxNARcBM6LohSAlDk/K+tYiAfOF308PtxYBMZwLGJWQ1h66bvwjT8G/4u3EyAaCSQQP3rwC4SvpTATCQLmEWICnfdS5Agne5ABs65ZFbRtfT/oyXeg4rrb0EAowKgfehz2V/k8EtWJfFLSA2EZBViRMgh5kA+voodN0QpIRhCbnPDrVeIbnnBMgiJ+An6Lr5g7BIfTepmqcSXABXAuBbKgDepM1fcAHosrkAFXIBEtzIBYhznAuw670LlTZ+xjtjSyf+LXWXpvb070qDPqf9RRa36P5MbiHJFARAqQhw7QSAzwTkQ9cNQcrAbgMMScwzlooA/88EiJITEJ+tqPhUlVr/gpTNUwkCwNUQIBMAb9DGL7gATmcBcj2bBbDeBvhcn0lO/HbTreY/adoi2Lqr+aHQ57Y/yNAt+iSDCoAs7iOnIsD/MwEe5gRo06ZA1w1BKjA0KW8pa/6eOQGwOQFUAHwGXTexUGn0z0jdPMOi9AVUdPwH3cR9Wa4cgBVUALxe42SpC1BuFqA0F8DxLwKczQJsGniGGC9Ufr+f0X/opArNP0ytvyH9seZfhz7HxSTjvsV3Z3CLaOP/yLo8dQJgcgLOc2k8dO0QpAJDE3LbD7VeIZVxAsrMBMgvJ2Ci7gQHXTtfUWmSH/DHl75KbbgWrjb8TF/HhKr1rcIiDPXCq+rvD7mjVvWQkNp3htxpuFul4Q9DN3F/CYBvqADoSxv/G1QE9LfeBnAnF2CSg1yAD2IzyeIGueTUNqNbjZ/xbNdBFY+Jhj8eXq1uUkhI6h0hVWrfxyb2wyJS6oZGpDRTRfHDVRrDWhby449ahUalNIQ+18Uig/t4El0kQ2j+i4i3ToCUMwEXdOMzoOuGIE6hzf/6EGvzl+VMgKOcgIScgB90YvGuojV9+mfRJjNSFVUnxZ2/O0zDz4du4n4VALT5v04bf+ksgHe5AH9OvUSKK4n1tVFQYCItnnjF2fFZ5dY5oTbUpuLtLZVaxMc3q/mckJCUKr6drfCc0K24PZ375Hq6IAAWEd+cAAlnAnTj0qBrhyBOGZKU97HgADhyAmSaE0Cv2K4HcjAQuzr3venzN1jTD4mqHePp3x+mTnk0XMOfg27k/hAAX1MB8FrSSdLPKgJczwKU5gJMsJsF2DD6Arma7zrVz57M7HxS55GnnBwnvUkVyT/p8UnCnAK1frAozoCa/8jjv19mpOsWDzjOfULShcVEgO9OgBQ5Aed17yVB1w5BnPJWQl5z5gDYljgzARLkBCTkDIaunTewq3QRvtA3WCx9r/k/Ua8yJV6uhgC/YgKgximrC+DOLIDlPJtaN49snHyJ3HTzPr+NFat/JlHR9Z3ulT3qNyQiOcrrI0X/W+GJj77WLcrQ1ofzBZzj3Ken6CJlRYCvToDfcwIUn12CKAAqAi4NsTkAlc4EyCMnYHxCzknounkD/TI/6v0XOX9erLCXMPbseTUfkMOArhyAryZdI71p8+/DRAAVAGwW4E16DjvKBRjzYB5ZMfgCSf/N/Xv8NoxGE+k3aHyle6V1/lCM4xUaqW9Khd8JH86dcyHqpGpi7EVqjmg/efE4t5gcowIgvYII+Ji+unYCoHICznOTRkDXDkEq5a2k/Llv2bkAsp4JKDMLkBtQyWdhGv2bXn+Bqw25LCZYrL2woTRhOE0GDd3T5coBWD7xKhUAp8irtPGXdQHyhVmA2Z3OknXvXSGHfjGSYrN79/fLwx7q80DdDu4cswthGv4hsY5ZSLXaal9mR+h/+55oe5GQo9zig8eoADgurE+J+E6Af2YCLmknRkPXDkEqZUhCXoO3hEGpPOLSCZBfTkBAWWz0Ci5bDs3fBr06XQ7dzEUXAJOukV5UAAxrcIZ8+PIF8u2kq+TPb26S7D2uH9bjDqfPnCedew13e59U8P0q9jELiUqN8FYEUMF3XfglQgBxjPu86VFuCb36Z8siApw5AfKZCaAiQDd5O3TtEMRt3krMP/OW9T5pqQsg1kyAH3MCAiQe2Nvf/NMv+wLLT8jEJzQipbk/nz3gr+XqFoC/mDV/KYnUOb/X76DZmsMiU7r747iFVE29i/4dZ7ys3wC/7MlPHOE++/Eo9xkpLwL84wSImhMQkDNKSJAyOCl/OrtHOsQdJ0BeOQHboGvnDrQh7PBKAKj1z/tzX+Ea/nfohi5XAcDu8y/8dAWpoW/n+XGjV+n+vNoOjdI38Kp+av6Ev/YkNoeilz10lPuCHBEEQEUR4C8nQIyZgHP3TLoXun4I4jaDE/LrvWX9vXR5J0DWMwHMBYjLeRm6fq4IVRvqe/dlbVjo773dptE/o1LzkqfUyVkAXL5yjbw342NSPamJV/tTqQ23wiP9f6VNj9tYL/f3nL/3JgZHuC/2HxEEwOdORYAsZwK0U7ZA1w5BPGZwYt4RJgIGW383DT0T4EFOwBk55wKwRu7Fl/RFiQJcblNp+G3QTd2T5WoGwBc2/b6NvPL6u6Sa9hGf9keP3QE2sCfBsQuhf1+Gx/vT8Ouk2JsvHOaW9T0sNP+l5DAVAEddiADZzQToprwKXT8E8ZhBSfn9Spu/WE6AVDkB2dOh6+cM+qV7yuNGIuHDXMI0fA92zxq6sUMIgD37jpB3J8wh8Q+2EmVv7KeVKrX+XamOnSpK39WbfUq1P2/YG7ck8hC39MphofkvJRYXAMIJ8Dwn4LR26vXT2rSAGrREEIHXtKfvGJyUf80mArybCQDMCUjMlF3qlioqOdmLK0h69R/3P+l2WftOlcawC7qxu7t8uQWw78AxMnvBMvJct8Hk7riGou+NCqmD/vjFhivCvXABQtUpbaTcoycc5JbNO8R9SQ5xy6gAYMsiACxOQMWZgKOVOAHS5gRMle2FCIJUyqDEEzMHl7kNEFAzAb9A16889ArtbY8biZofKPU+b1PzvenV603o5u7O0td/hmz5c1fJ2rxlO1m7/jeyfMV6smjJt2TmvKVk/JQF5M0hk4RGzwSDN4N8Hjd/teFWqIRX/za8eqR0lGG21Pt0h4O65SkHueXkoCAAbCIA2glwfybgJPe+DrqGCOI1/ZPyE1ls6mBrcpqcZgLcyQkYl5Tjee66HwlXG7Z6+uUcEqK7HWCr/0f3ugW6uQfyYr/0kOref3lY6JBH+5XprwEO6r7acYAKgEMVRIDNCVjq1AmQwUzAWuj6IYjP0Ob/k0UEuHYCZJkTkJCTB12/EtRJ1TxuJGrDj1DbDY1IbhHIDwkCbv4F7H481LFTqfnFHu+bPSZaRuzXfv3iAe4r2vjZWk7k5wS4zgk4pZ3eErqGCOIzAxJOtBtkfYBKeScgEHIC0uKzR0PXkMGe++7pl3JYlP41yD2r1IavoZtpQC61AfSnX+GRho6e7jk0IqUZ5J7t2aVdd8c+7pvTB7iviU0EuHYCnM8EgOQE6D7Igq4hgogGbf75pSIg8GYCRsbm+vK0PFEIizToPf1SDqn6gAZyzypN3VoqjSETvKEG0KJX/ydDI5MbQR43y7EzFHi09yi+HfSebeznvplEF9kvCIBSESBPJ8DBTID2wzega4ggojE46eRg9hx1Z06AHGYCXOYEJOZ8A11Dj28BqPk/oLfMUGn076nU/L/QjTVQVpha/wn0MWN46t6EqOvI4mE1B2JWJuznVpB9ggCoKALcmwmAywmgIqDgtPYj/Okfohxer33+zkFJ+VcGJVqeouY/J8B/OQFp8dnwV2VqfonbV5J+jv11n9pqJkagG2sgLHp8D4b8LyUe+ogxQtX8Yx7sfRP0fm3s41au3ScIAOciQJ5OgNUN0M2cCl1DBBEdevWfxhwAV06AnHMC6Gv2tHvPSpGm5xQ2aEWvzK5W+oWsNuRD7rM87PnztLnlQDdYOS/2ICX2EzzoY2WPSmPY6c7eQ6P4x6H3ytijXf3iXu5b2vi/JXupAPDeCYDLCTitnX4XdB0RRHQGxeVEDkw6cWOg1QHwrxPgt5mAL6HryJ4J7/L+rJrPZvfeofdZHtrcxtMmVwTdaOW65GL9lyHSEEsF5z6Xe4/Sd4DeJmPvfd/F7eFWFezlVhKbCLCswHEC8rhZM6HriCB+gwqA92wOgNxnApzlBIyRw8OC1Ck62jCmqzSlYTv0n2/Q9T57xjv09pwQGohPC5Ri0eO2PaTq/bK98lNFGd6h4u1ymX2zZ1JU42tA783GHm71XrrIHkEArCLiOAES5wTEfgg+bIwgfmPI/afvoiLAKLgA1ubvrhMgl5yAMfG5N9MSsmTzm+ewSL1Bjlf8jrDslU+HbrhyWuzWSGg1fWvoY+MOrOGHRRjqQe+jPLu51R/s5r4juwUBwBYTACuFFThOwLwF0HVEEL8zICn/g4F2DoC4MwGS5QQchK5joBIWWac/FQFG6MYrh0Wbf7EqUj8G+pgEMjt1a9rt5taQXVQA7BFEwCo7ESCWE+D/nIAs7cwY6FoiiN8ZVCu3OhUBRBABwqttJiCwcgLS4nNlmX8eCISp+Y/xp4FC3j9YUqMS2BG3/r5d3PdXdlEBsFtY3xHHToC8ZwKyuLmLoWuJIJIxMOnkvAGJVhEQIDMBjnIC6Gt76FoGKuFqPqifFcCemMienAh9HAKZndzaP3Zy39Orf7YsIqDUCbCJAH/MBIibE5Cpmye7J48iiN/om3j2ngFJJ0z2ToCnMwGyyAmIz7k8KjFTFgEoAUdEcpRKow+YxwaLe+WvPxpSrS5+6fvADm7d6B3cWrJTWGVFgHMnYKWdCyATJ0C34FPoWiKI5PRPzJ/Amr8nToBMcwK2QdcyUFHdaait0vBBFRVMRc+Z0Mg6TaBrH8js1K17eDu3jjb+dcSZCIDLfjYjAAAgAElEQVSaCfA0JyDjvtl3Q9cTQSRnaMrZKgOSTlwawESAw5mAgMoJSIOuZ6ASWtVQXxVV7idmCl30yv+GKpJ/CrrmgczeuO8it3PrT+zgfqDNf511eeoEyGUmYOEE6HoiCBj9k072629t/oE2E1A+J0AOUcGBSqi6TkuVhj8N3aD92/z5q2FqfS/oWgcapFP92wvbNq9d3LFJm1sdG796qv7gY5n8FHKk9lyyP/EL4r4T4M+ZAK9+HXAZM/+RoKd/0onjFhfAsrydCQDPCYjPvTg6KT8Rup6BSmiEvhVtkiegG7VfltpwISzS0B26xoFCUZN29Yqbtx1X1LL13uLWrUhx2xakuF1zUtyhCaEigNx6qiG59fTj5Naz9cm/nR4lV9t0InkPj6SC4HMvZwIgnICP+0HXGUHAGZCU/6T9bQD/zgT4PScgb2R89r3QNQ1U2ANoqAjIBm/YYl75a/RnblOnPAtdW7lD6ne6vbDhMyMLGzx5sqjxk6SwSQdS1Lw9KWrRhhS3ak2KWrekIoAKgfZNya0nmpDijo2oCGhIip95jNx6rj651ekR8u+LD///9s48TIrqXsP5Q81mvBGSm2Sq1+keQFwYl7gkeo25MZF7YzSJGhNzTQRFmQEEBRQVGfZ9HZBNkB3ZBQERMCiKICiKzMZsPSu4S6LMDGiec885dU7Vqep1Nqq753ufp56SJCpTPZP6+C3vIV/+riepvHJk0swERKkElDn9vAFIGvoHa/epVYDU9gRUHR3ateR7Tj/TVOXc717cg4aAIqdf3G3y8u90efU5/5F9s9PPNNlp+umfc5qu+dOJ09feSU7/7I/k9PW/J2f+63Zy5he/I2duYkHgf8iZm28hZ379a/LVLTeLasBNNATcSL6+TVYDWBC4lvz7rqtpELiKnLrtFlLWY2JSzgSUZCy8zelnDkDSkBusv4LNArCXf6rOBKiegBGZVa87/UxTmm92D57XOfuw0y/w1v3JP7voGxd0v9rpR5nMNPS4V2vK/r/DTVf+lTRd9Wdy+uq7SdM1LATcQU7//A/kzA2/J6f/i4WAW8mZX7JqAAsCv6Eh4NfkTE8aAv73l3pb4LYbyVe3X0++/oNoC9x1Lfn6Tz8l//7zVeTTX99DDnvWJY0n4Jj27H6nnzsASUe/rJol/S1VAGslINU8AcMDoc1OP9NU55udshekmjaY6307Z9PP/jJHj45Odhq7PXBj4yW9Pm267O+ksce9pOlyGgKu/Atp+umfSdPVfyJmNeAP5PQNt5MzNyrVANEWMKoB/3sT+Yq1BW5jbQEWBPRqwNe8GvBTcur2X5OCrEVJ4Qkocj97idPPHoCko0+X4z+gAeDz/oEacvZmAtrdE5B8R7ymGOd+P/vv9IVa7/SLPZHr3M7ZH5zzg+whTj+zZKexS98nGrr2IY3dH6BXL9J06X2k8bK/0RBwL2m8/B7SdBULAnfTEPAn0nQtqwaItgCbDbiRVQNYEOhJQ4BoC/RkQeCX5OtbWRD4L2NI8N93sCBwDfn3n64mZ+68jpT3mODoTAC9T3P62QOQtPQL1vbuz9sA0SsBKecJ8Fc96fRzTXnOv+Qi+ifrfU6/4GP/yb/H0XM7X3aN048q2Tnl7zeqIZBLGrL6koYuD5LGbiwI3E8aL+lFGi/9O2kyqgH38LYAqwY0XWu2BVg14PSNalugJw0BelvgK9kWuJW1BVgQEG2BO1hbgAWBn5LQVSOcmQlwLTlR8MO1UD8DEAs2ENhfzAKk8kyA6gnI81f/1ennmg6ce2GPPvRlW+b0y95ydcquOu/C7KH0t3eO088n2WnwPHLnKc/DpME3gNAgQBqCLAg8RBq7PkgautEQcHFvGgTuI3pb4P9I0xV6W+A0bwvcRU5fp7cFzvC2wG1iSPB/zbbAb35DztzyK6Mt8PXvWFvgBtEW0FcGWVsgdGXeWfcEFLue+4PTzx+ApOfhrvVd+4kqQHglIHU9AXmB0C1OP9v0oPv553XKnnRe5+w6h1/8H3+z0+XzvnH+5VC5JsCX2pDsL7XB5JTrUXLKPYg0eGkQ8PcnDQEWBPqSxi4P0RAgqgEXs2rAfTQEsLYACwKiLcBnA1gQMKsBrC1w5hdmNYC3BaQ7QFQD+MogawuIagBbGVRDQHt7Agozlu1w+vkDkDLQF/8EIwSc1ZmAdvUENOb5KzEV3lZ8/yLvOZ16TGXT9mf3aOHscv044x4XO/0IUomT2hNl/9KGkS+0IeQUDwKPkAbPQHLKO4A0ZLIgkEMaZVvgIhYEepMm3hagISBbbQvcTU5fo7YF9JVBsy3wP+Srm3saK4N8W+C3LAjcyNsCfFtArAyGrhx5FmYCljcc0Va4nH7+AKQMg1y136YBoCZ6JSBlPQGfP+Wv7Or0800rvtet87mdL/sb/dP4XhoGTrZLf79z9pfs5MJzL8zO/cZ3LvqJ019yqvFJxsj+n2lPk8+1p8g/tSfIv7THyJc8COjVAN4W8LMgwKoBOXpboBsLAkpbgFUDspW2wNUsCIhqwM9YNYCtDIpqwE1yZZC1BVgQYNUA0x3A2wJiZTB0xch2nQkocC1/zOnnD0DK0S9Q25O9+M0QkNozAYon4MPhwarLnX6+6ch5F1566XmdLpt0XufL93+zRS2CbPV+nL74D5574eX553S65GdOf22pSrVn/IUfu8Z89rE2knyq5ZHPtOHkpPYkDQKPky94EBhMGnhbYCBp8D2szwawIUHWFujK2gIPGG2BpsvuEyuDLAjI2QC9LdB0nboyqJoEe8Y0CbKVwdAVo9prJqDE6ecPQMqSG6xd0c8SAtLEE+Cv+vLpQNVNTj/ftOb8y394zg+yf0HDwAR6bWGh4LxO2UfoS72A/nUxbx107sHuhfQ/P0rvB+h9+7mds2ec0yn75m98t/uPnf4S0oHjGRNnntDGkw+1seQjbTT5hAcBvRpwklcDHhdtARoCXIN4W4ANCfJqQCBH3xboyqoBD/C2AKsG8JXBbNUdoLcFrCZBsTIYyyQo2gJsSDB0+ag29wQc+cnyK5x+/gCkLP2Dn17QL1B73BIC0sgTkBcI3e30M+54XPkdPrj3/W6+b5x/2X9C2NN+1LqmfbtWm0rqtcnkuDaBfMCDwBjysTaKBoERRG8LsGrAMKUt8AhpYG0Br2wLsE2BHGNlsEG2BfjK4N9II2sLiJVBwyR4XWST4FfSJGgMCf63xSSohoDWzgQczViZ5/TzByDloS/+X8gA0LyZgNTwBAz3V/Vz+hkD0B6EMmbeVq3NJDXaNFKnTaEhYBI5wYMAqwaMEdUAFgSe4m0BvRowlAaBR/mQ4ClZDZBtAVENMNoCbEiwjUyCXwt3QCh7dBvMBDz/vtPPHoC0oV9W7axc8eJPl5mApyxnB4TGO/2MAWhrKrRnFldqs0m1Note02kIYEFgMg0BE+k1TrQFRtEQoLcFTvIgwDYFlLYAXxkcSE755Mpgjr4yyEyCrC1wsdUkyFYGT0uT4DVsNkCaBG/X2wK/UEyCN8uVQWES5EOC1hDQgpmAxiMZazHoC0Bb8Xdf6Fv0xV8evxKQup6Ap/2hJU4/ZwDaklJt/icV2jxSqT1DQlo+0asBLAjobQG9GjCOVwM+5kFghDIkOExUAwYb1QC+MsjdAbFMgn+zmARPG9WASCbB/1FMgjdbTIKhHmNa5glwrRng9HMHIO3oG6i+sl9WHcm1h4D08QSwSsDLbAXS6WcNQGsp+dEyv3763UJSrs0nFdpcGgLm0GsWDQEzSa02jYaAKfSaSEPABF4N+FgbTS+2KTDCWBn8J58NGMqrAQ3uR4g0CbIhwUaLSZBVA+43TYLZkU2CTWxl8Hq5Mvg7cjqaSfC3N1lCQEIzAa61rzr93AFIW3KCtSPUKkAaegLY9dawbnWdnX7WALSGgowVP2cefHYK3jHtWVLGg4CsBuhtAWs1YKKtGqCvDH5uVAPEkKBcGTRMgrmGSbBRMQk2RTQJ3h3RJHj6F9ZzBfjKoDAJJlYJoAHAte6fb3s3wBEBQHtCQ8DbshKQTjMBiieA3cueDJS7nX7WALSUI9rqO5gMhznxi3kQWExKeRBg1QAWBOaQKt4WmEFqeRCQQ4JsU2CcsjLIqgHDxcqg3hbQTYKD4poEGxWTYGNck6BYGbSZBFlbIHTZ2PgzAT9Zd4/TzxyAtCfXf9ybG6z7ormVgJTyBOgh4HieL9TN6ecNQEs44lo/gE3FH+VinBXciV/MqwGLaBCQbQG9GlDFqwEsCMiVwYnKyiALAnkkpknQa7YFuEmQVQP4kKBcGWRtAcUkKIYEm64RBwz9XG0LiGrAfysmwZ6/soSAsEpAxoaVTj9vADoMOcH6W/ksgOMzAe3rCXg6UPXFcH/lXU4/bwCaw1bP+xfu03aW6kNya/hq3FFeDVjOj8Y12wILaBCYqwwJzhIrgywITLK1BaKbBPmQYLNNgvdYTIKnr5OnDNpNgrcYJsGqyyLNBGzEyh8AZ5ucrLoxubYqQDp6Atg1wh9ampdx/DtOP3MA4vFSxnvXv6S9e/xV7XXxktQH5Y7wILBaHJLDqgFLRFtgoWgLzBVtgVmiLTDN1haIZxIcLM4VYCuDdpOgXBmMYxK8TjUJsiBgmgS/EtWA0KXj1ErAybcztnicfuYAdEhyg3V71EpAOs0EPGWdCWBBoHy4v7KH088cgGhs194ftV17j7xEr1e0N8lB7UVyiL4oD/MgsJ6vyh0RqtwCXg1YqrQFFtjaAjNtbYF4JsGhpknQM8hcGczMJY12k+AldpPgX60mwZ/FNgmGLh3PQ8DhjBd+5fQzB6DDktutrnNuVm1d4pWAFPYEGL6Aqkedfu4AqLyccdS9TXt/P73Idu0IYSFgl3aIHNC2k7e0bTQEbNFfmNpGPjUvqwGyLWBWA/S2gKwGSHeArAbUW0yCo0VbYIStLWB1B9hNgmxlsNEwCeorg00tMAmeuHLoVqefOwAdHuYHyJWzAI7PBLSvJ4CHAL/uC8jrcuwHTj97AF7MeP/2ba6jJ7dpR+mL/yjZxgPAEbJDe4e8qe2i10s0BGzn1YC3eRDYxKfmWTXgfR4EVtEQwNoCbFOABYFFfGWwjG8KsCAwW7QFTJPgcW4SHE9DgG4SZEOCqknQaAu4xAFDqkkw0Nc0CXZnQcBqEmy8/B5jSPD0tWxbQDEJ3igOGBImwTO/6fmA088fgA5P36y6h3KD1pd/GnsC5PUBThQETrHHF/rWixkFC7ZqBYRd2/jFAsD7RgjYq+0hb/AQ8DI5wIPANhEEzGqAHgTYbIAcElxqqQaUGyuDsxWTIJsNaJ5JkLUFLO6AqCbBey0mQVYNaIpqEuTuAIQAAJyGBoDF9kpAOs0EDLfPBPBKQBUZ4a+c7PSzBx2LLZ7Ci7doR0te1ArJiyIAbOUvf3Z/36gEvKIdECHgFbJP20n28yDAqgFbySFtMx+kO8yrAeuIvjK42rYyuFisDC4wTIJVNpPgcWES/ECYBD8RJsHPbCbBL20mQb4tYDEJ3m8MCXKTYI/IJkHWFtC3BRSTIEIAAM5DQ8DOllYCUs8TIDYE+L3y7aeCNQGnnz9Ifza7Cvpt0Qob2YtfvSJVAl7SDhO2DfCa9ip5XfsHDQK7yZs8CKjVgM18n96sBujuALMaoA8JttQkeNJiEhwsTIKDwkyCzB3QoJgEG8NMgurKoNUkqLsDfotTPQFwksGXffDdnGBNkRECHJ8JaGdPgKUSEDqVF6h6yunPAKQn+p/6C9/YTF/wW1yFZAt78cu7rATQX8tKwDZRCdit7Sd7tDdoEHiN7OVBgFUDWFtgh2gLbLUNCaorg601CY4SK4OqSXBIAibBB7hJsEkxCbK2wOmYJsHf0RBw60CnPycAOjT9g3WunGDtidbPBKSOJ0BWAkbozoDKpwNVv3f6cwDpwdrMiv94QSuYs5m+3Ddr8qIhQNNf/lviVAJ2aId5CPiHto8GAVYNYEHgH0pbgAWBbUpbYJOtLdAck+A0m0lwrFgZjGMSZG0Bv2ISzBLnClyktAV6KCZB1ha4Wj9umFcD2AFDNxgHDKESAICT9O1aexkNAQ3pPBMQ5gkwKwEkj/5nef7Qq1AJg9bwgrsoZ5NW+OkL9OVPQwDZrNxjVgJsMwE7tbfJLu0AeYUHgTdEW2CPaAvssrUFttjaAs0xCarHDSduEmyQBww1yyT4F4tJsOk6ZWUQIQAAZ6Ev/9/SEECaVwlIfU/ACGs1gIWBGRPon+Kc/jxA6rAho+DnG12FBfTlTza59EsPAYUkWiUg1kwA2wh4mYaAndpBspsHgTeVtsAeW1tgu9IWsJsEV9lMgouUtsBcW1uguSbBR422QEOYSdBsC8Q0CV6rmARvuB0hAAAnyQnWDeIhoMN5AmQlQL+PzAx9NNJfiUllEJMN2hHXRq1wzUZXEdnIX/7yTi9NhgCzErAlaiWgIGwmgMmBXtYO0+sQ2cWDAJsNYG2BvUZbYJ+2m14vG22BQ8Ik+I4wCR7hQcA0CRbzILC4jUyCj9lMgnpb4FQm2xSIZRI0VwbDTYIIAQA4Sk5W3YzmVwJS3xMQoRJARvpD743yha5x+jMBycd6V/HTG1yFp+hF2MVDAL/rL/9EKwGxZgJYJeAl7V0aAt7hpkBrNWCvrRrwsjEkeNA2JPieZUhQtgVUd4BaDZgpDhiS1QBpEhxjHDf8Ga8GJG4SNNoCbEiQrwxGNwme+fkfEQIAcBIaAp6LVAlIp5mA6J4AsxIgZgPIyMyqFWO9VT9x+nMBzrPeVfDHDe6i0Hr+4i8i68XLf4MmQkAClYDmzATo64FH+HCgPhvwFvcFvKLtU1YGWRDQVwZZW+At3hawmgTfbYZJsNpmEjzBg8A4wyT4qaUtwDYFlLaAWzEJiiHBxi7qAUOKSZC1Bdgpg1eZbYGm6+5ACADAaejLf31rKgGp7AmwVwJ4CPCHGuhfz80LlAed/mzA2Wedu+judVrR2+voy30df/HrL38WAjYod6MKoFYCtJbPBMhrOw8CejVgJ68GvCWqAftENUB3B+zjQcA0CR6ymQSPCJOgea6AvjJ4zGYSDB8SbJ5J8JRcGYxrEhTuAKMtoFcDmq5DCADAUXKyal+2hADHZwLOqicgQiWA3StZGHhhRGbF9U5/PqB9WfvDgvPXaEWD1rqKqtayF7+7iKylL3AjBNBfr9fUl3/ilQBZAUjEEyBDgZwN2MGDwNuiLcA2Bd4UK4N7m20SPGqsDC5RTILzDZNgyLIyyA4Y0k2CHwqT4MfCJPi5zSR4ymYSZG2BRtUkyKsB90c3CV5zFzlz3Z0IAQA4xd99oW/RF/6etpkJSFFPgL0SoM8GiHvlW/S60+nPCbQtq90lGc97iiatcRefXENf4uxaK651yrU+YiWgfWYCXhT//VajLfCeaAscEm0B3R2QuElwg2ISXMnbAi0xCX5oMwl+bjEJyrbAwDCTIDtgyHQHRDIJ/oU0sSFBhAAAnKNPxvHv5GTVHUz3mYB4noBIlYBRegggo/yhSnrvn0efldOfF2g5az0F3Ve7ipY97y4mz7MXP73zl79xFyFA3NfzIFAYFgLaayZgiwgLL4rKgLUtcFBpC8QzCb4oVgalSXBtG5kE9SFBq0lwaAImwT6kga8MirZANjtlUG4L3M2GBBECAHCKgb7Q92kAKIAnIFolIMRCAL0qPxudGRqX5wv92OnPDCTOKlfJLavcxbtWu4rJav7yp5ctBMSqBDR7JqAVnoAt4n+7xWgLHBVtgcOiLXAwiklwt2IS3N5GJsGpNpPgGOWAoRgmQa/NJMiqAV0Vk+ClNpMgrwYgBADgGLnd6jrnZtW9C09AhJkAWQnI5CGAjGb3zIrnxgWruzv9uYHorHSV9F7pLiqgL3+ySrz8V9EXN3v5rxb3+JUA20xAKyoBiXoCNovwIP93elvgiGgLvGNrC+grg2ZbQF8ZbJlJcKHNJDhLrAw2zyTIhwSbbRLkbQGEAACcon+w7AIaAN6GJ0CEgMyolQAymt5H83vlwTGZFY/kuWsynP78AH3payU3LXcVz1/pLv6EXkReq8S1mr/8RSXA3RaVgPaZCdgs/v7wasARfqqg7g6QJsF9vC3wms0kuL/ZJkF9SNBqEpzVKpMg3xbwWc8VMFYG7SZBvRqAEACAU/ATBLNq96b7TEDzPAG2mQC1EkDvYzL1MDAms/J1es/NC5T/p9OfY0diubf4Z8tcxbOWe0pOLKcv8hXuEnqxF3+JePnTu0uEAJcMAc2tBESeCWhPTwD7320Uf7+cDXiRbwoctZgEd9tMgnstbQG2KSAPGNJNgoeFSZANCZptgeW2tkBrTYJDI5gEmTsglzTGNAnytgBCAABOQgPAdngC4s4EqJUAPQSY1y76697jPdUXOv1ZpiNLPMVXLnWXTF7mLqmmF1nOr2J+X8FDQLEIAdYrUiVgdXvPBLTCE/CC8s/jbQElJKgmwZ0JmQS3244b3iDcAVaToKwGSHeArAZId4CsBtRbTIKjRVtAugOeSNgk2GiYBOXK4L0IAQA4DX3xvwBPQGIzAaPVSoC4xrK7r4Ldt9Lrr3ndC853+jNNZZa5iy5Z4i4Zs9RzrIy+/MkyTwlZSl/Y7L6Mvfw9eghYIcLACvrrFS715R9eCWj1TMBZ8AS8INoM7J+3Sfz9W4z/3moS3ClMgvrKIAsCuklQXxlkQeAlbhI8aJgEN0Y0CRbFNQnOMEyCbEiQtQWkSZANCbK2wElhEjTaAi5xwJA0CQZYENBXBnlboDsLAopJ8Ip7EQIAcBIaAFbAExC5EjAqsUoADwLyGueveGOcv3Is/eubp7lqv+3055vMLHGXBZ5zl/Ra7Cle+pynpGoJfaHzi77Il/KXv3ktE5esBKxoQSWguTMBZ9MTsEm0HjYqYWKzpRoQySRoDglGMwketJkE37OsDC4XQUA9V0CuDM5WTIJTwkyCn8QxCbK2gMUdENUkiBAAgKPQl//YdJ8JaJUnIGolIGRWAowQUEFDAA0Cvgoynt7H+yr3j8+smDDBW96zo1cIFvlLui72HOuz2Fu6crG7pI7+NaF38hy90yBAX/7mXQ0BcSsBCcwENL8ScPY9AZt49UH/92xU/jlbxGyAHBK0mgQPtMokaF0ZlCbBBYZJUF8Z1A8YqudDgrpJ8AObSfAzy8ogCwJWkyDfFlBNgt3EyiBrC/S4DyEAACfJDdb0gieg5TMBY8MqAfrFQ4BfhoEKMsFfcXCCv3LypMyK307sWvI9pz/39mSxp6z7QndJ32c9x56n1wl6kUXiWmy5rCFgiTvxSkBLZgKS2ROwUbQg1ot/vpwNkNsC4SbBt1toElyvmARXKdWA5pkEP7KZBE9aTIKD9baAW60G9DNMgg2yGqAfMIQQAICT9M2q/xUNAf+CJ6DVMwFmCBCVgHH85S9DQCWZQO8T6X2ir6KK3nfQX8+Y7Ct/cJKv7MYZ/sofOf290Bzm0Rf9PG/pHxZ6jz0x33Ns2QLPsYP0+tdCbylZSF/o7MW/kL/4S+lfl1hCwCL6Am+zSoCnPSoBZ98TsFGEEDmDsJHPBhQalYQXRcWgeSbBlxWToPW4YeuQYGtMgqPEyqBqEhwiTIKPxDQJspXBpkt7IwQA4CS5weqL6Uu/Fp6AhD0BcWYC+FyAqASIaoAMAX5eEWAhgIYB/T5JXJN9FZ9P8pXvn+KreI7+9WOTfWW3Tc2s6OLU98UznuoL53nLrpvrLes1z1M6aZ6vdAu9l9IXP6F3Mp/e53v0i7786aXfF4rrWdu1yFINKDGqAZZKQJLNBJxNT8AG5fexjv+79H++XBmU2wKJmwRfUUyC29rIJDjNZhIcK1YG45gEPTaTIGsLdHuQmwSbuiMEAOAoOb7Qj3OCtYfTeSagXTwBaiUgykyAORtgrQRMUEOAn4WAcjJZuU+mdxoG6FVOpvoqiqf4ynZO9Vesn+otWzTdVzF9mq/i6eneskemect6T/dX3jHdW/7LGb7Sa6Z7Sy/Kd5dkzPmhPn8wzVXYKd9b4p/lP9aDXjfM8pTdOsdbdk++tyxnjq/s8dne0tH013PofQX99ZbZnrI3nvGVfTSHvtDpy588I+5z6Z29/OeKl/88+sLWQwB9+St3HgKMSkCpJQzoAaCk7SsBaeIJYP/858XvZ60IARs02RYoiGMSPKAMCb5uMwnubKFJcIHNJKgeN5y4SbDB9WhMkyBCAAAOww8RCtZuhyeg3WcCLC//CJUA5TJDgB4EzGuack2Xl7eczKD3Gca9jMyk95n0Pst25YtrtuUqJTQM0KuUPMNe/vyuX3PFy19WAOyVgAXNrAS0ZCZgWYRKQLp5Ati/h/3+1ighZINSadjsMv/+rbYhwZ2GSVBtC+yxHTDUHJPgIqUtMNfWFmiZSbBBugNYNSCQo28LdH2QNHXrgxAAgNP0DdY9A09AW8wE2LcDIs8ENKsSQH89xauGgAoyzau//OV9On1xqy9/SwgQ93yfCAE+FgJKjQAwh/56tscaAlgl4JkIlYB5zaoEiJc//fWz7naeCUgDTwB76a8SIWWNEUDMf0+4SfB9i0lwl80kKNsC+4RJULYFDgmT4DvCJHiEB4HVhkmwmAeBxYZJsKJVJsHHTJOg5YAhtimgmwQRAgBIAuhL/356NcIT0BaegBgzAb6YMwFRKwFTIlQCplsqAWUJVQLyE6oEyKtMrwKolQBveCWg9TMBJUk7E3A2PQHs3yd/v8+LUBJpW8CcDYhtEnwtIZOgPiT4ns0kWGScK6C2BWQ1YKY4YEhWA6RJcIxx3PBnvBrwpKgG6CuD0UyCDd0eHOz0//8B0OHpl1l7ab9gXXW6zgQ45Qloo5kA4x5eCShrYSXA+vK3twOizQQ0rxIQaSagHSoBaeIJWOMuKlzpNmcY1ojZgPXGbECRpS1grgzqBwyZK4P6AUPmbAALAnJlcAc3Cb5lmAQ3RczS+QkAAB1PSURBVDQJFsY1CU43TIInuElwnGgLsE2BkRaT4BdqW8BtMwnyIcEchAAAnKZPZsV/6HMB8AQk40xApEpAS2YCEqsEJN9MQLp6AuiL/Et6v4P9DK7wFC9YofyeI7UF5D9/s1JFiGwSVM8VkCuDVpPgIWESlEOCR4RJ8KjNJGieKzAvypCg1ST4cRyT4Cm5MmiYBBECAEgK+mXVDk2OmYD09wQ0uxLQbjMBohLQTjMB8AREnQkofdFVlKX+/C2jIWC5+DpWKb/PdfQe2yRYIFYGVZPg/jYyCS7hJsFjxsqgbhIMCZNgrTAJ1guT4Ic2k6BcGfynMAmespkE9SHBfggBACQDOYH6n9GX/wl4AhzzBLRiJkBUAHxtOxMQVglol5mAjuMJoPd1L//oyHcj/fwt8xxbsNxobZiVC/l7CzMJhrUFWmsS3KCYBFcqBwzJlcGWmQQ/t5gExQFDbGXQNAkiBACQDOR2q+ucG6zZko4zASnuCbDNBJQ3uxIwK14lIMGZAHgCWjAToBX+64WMwvvi/fwtpSFgmVLZWKXMBoS1BVSToNguaJ5JcIfNJLhJMQmubSOToD4kaDUJDhUmwUGmSdCPEABA0sDOEaAh4At4ApJrJgCegNTzBNAAsG/DT4q8if7ssRCwVHx9K5SvwTobYDcJmnMGiZsEdysmwe1tZBKcajMJjuFtgbgmQX1lECEAgGShb1Z1Zv+s2oPwBMATAE9ASz0BBY+35GePPocFS8TXK2cDzLaAuTJoNQkWxjEJWo8bbh+T4CyxMtg8kyAfEuRtgYEIAQAkE7nBuifgCYAnAJ6AxD0BNAQUveAqvrQ1P3c8BHjMr3WF0d6wrgzatwXCqwH6yiBrC+wyTIL7hDvAahLcH9ckuNpmEtSPG7aaBGe10CQ4WK4MIgQAkEz0D9ZfTl/+pek0EwBPADwB7eEJ2KAVTG+rnzv6bBYs5l/3Mf51L1dmA+Tvf434/cU2CR61mAR320yCe20mwQPGAUO6SfCwMAmyIUHVJMiGBM22wAJbW6C5JsGhikkQIQCApKNfoG4UPAHJMxMAT0DyeALoy7dkk6vg6rb+meMhQFRGlhpfq/m1GG0Bl/WUQbtJcGsck+CrUU2C22wmwfVGNUC2BYptJkFZDZDuAFkNqLeYBEeLtsAIW1tAdwc0uB9BCAAg2cjJqrqof1btXngC4AmAJ4BXBBrp/cn2/Jmjz2vBImVlcqn4etnXt1LZcrCYBF3SJFhgrgzybQHdJChXBncKk6BcGXxVmAT1lUEWBF7iJsGDNpPge80wCVbZTILHuUlwPA0BukmQDQmqJkHZFkAIACBJ6R+s6UUDwKfwBMAT0FE9AfRF+9omX7HvbPy8sRDwrHwmRggwtwUimwSLDE+B3BaIbRLcbzMJyiFB0yR4UJgEDxtDgmtt5wostZ0rIFcGZysmQTYbkKBJMGMIQgAAycijXY7/gL78l6XDTAA8AfAEJFwJcBV/uN5V+Nez/fNGn92ChTIkiecgZwNMk6AZYvRtgVgmwaM2k6A+JNg2JsHnuElQXxlcYJgEq2wmwePCJPiBMAl+IkyCn6kmwYzHEAIASFYGBOpu6hesrYAnAJ6AdPcE0GvhJt+733fqZ02GAPmsnhPPY5kSdtSVwTXuKCZBra1NgusVk+AqpRqgDwm21CQoqwH/QggAILkZkFUzuH+g5nN4AuAJSDdPAL0fWKsVZDv9M8aY7y3LZ8/vWfG8zLbAMf71y4qHfWVQegzCTIJaW5gEX1BMgmvayCQ4SqwMCpOgexhCAADJTF9P9YX9A7Uz4QmAJyAtPAGuotI1ruI/Ov1zZYeFgPlKC8WoBojnEM0kaN8WkCuDclsgcZPgK4pJcFsbmQSn2UyCY8XKoGkSPJmBEABA0tM/WBMYkFW7MVVnAuAJ6PCegE+e95Q87PTPUSzoc86fJ56jnA1YJJ5PmEnQpawM8opAoWVb4AXl1MLIJsEDikmQBYE97WASVI8bjmESzHgSIQCAVODhrNprBgRr34UnAJ6AFPIETFkRLLvA6Z+dRNBDgP5cFyjPzL4tYDUJhp8yKLcF5Mqgvi2gmwTlkOBOwySotgX22NoCsUyCq2wmwUVKW2CurS0Q2yR4MmM4QgAAqUL/zJo/DwjWVcETAE9AsnoC6P351RlH3U7/rDQX+vzz5xrhij27UiJXBheLcBRuErSvDEY3CbIhQdUkuMtmEnzNZhKUbYFDwiT4jjAJHuFBwDQJFvMgsLjFJsFPEQIASC0GBGr7DAjWVMITAE9A0ngCXMXrVrTS3e80LAQ8I56vrLAsVJ6XXBmMZxI03AE2k+A2m0lwV0ImQX1I8KBtSPA9y5CgbAuo7gC1GjBTHDAkqwHSJDhGrwZk5CEEAJBqPByovpeGgOJUmQmAJyANPQGekuXLM0q6Ov2z0FawEDDHqz/vecrzfDbCbMAy28pgmElQkyZBsy1grgwesa0M6gcMmSuDLAjoK4OsLfAWbwtYTYLvNsMkWG0zCZ7gQWCcYRJECAAgRXk4WHcnffG/B08APAFnzRPgKV6wNKPA4/T3fnuQz0OAqL4oswHyWcpNiiWRTIJR2gKblG2B2CbBN3lbQDUJ7uNBwDQJHrKZBI8Ik6B5roC+MnjMZhIMHxK0mQQzRiEEAJCq9A9W30pDwFvwBMAT0E6egIZlnmOzlnuLfuL093p7w0LAbK/53OfJ2QBlW2Cx8nysJkHTf7CO3mObBAtsJsFDYmWw5SbBo8bK4BLFJDjfMAmGLCuD7IAh3STIVwbdYxACAEhlBgaqf05DwGp4AuAJaCNPQIgGgMeedRV2cvp7+2xCP598+bnMEc99njIbEGYS9FjdAYZJ0BXFJBjWFpAmwUMtNAluUEyCK3lboCUmwQ8zEAIASHkGB8r/c2BWzXAaAuqScSYAnoCk9wS8TF9sv3P6+9hJZnnL89nnM9unfx7yuasrg+EHDEU2CYa1BVSToKu1JsEXxcqgNAmubZ1JMGMcQgAA6cLAYPUdg4I1r8ITAE9ArJkAej+52FMyY7GnNNPp79lkgX52+TOVz0ZWYoy2gFgZNLcF4psE14eZBE13QOImwd2KSXB7G5kEpxomwRMZ40c4/ewBAG3Io8Hq7oMC1TMGBWs/gicAngDFE7BvkbvkobWu2m87/T2ajLAQMEN8Xvnic9FXBs1tgbgmQXVl0G3qhPVtAbEyGNMk+JZiEtyrtAX0lcGWmQQX2kyCs8TKoDAJuiZNdvrZAwDagUcCdTcNCtTOpy//T1JmJgCegLb0BBxa6D32KH1hZTj9vZgKTGMhQPnMZiufRySToHquQLhJ0FwZNNsCehAIrwawIHBYuAOkSXAfbwu8ZjMJ7m+2SVAfErSaBGdZTIL1CAEApDc0CNxC/+S/hL78T8ITkL6eAPrCP7LQfeyJ+ZkVabnC195M85fnT1c+t3wxG/CMMhsgtwVUk6A8ZdBqEiwyVwZ5RSC6SXC7aAtIk+Bum0lwr6UtwDYF5AFDuknwsDAJsiFBsy2w3NYWiGESdE1GCACgI0Bf/rfRILCa3r+EJyAtPAElNAyMnOeqyHL6eysdmOotz58mKjkzlc/KbAtEMgkKd0ACJkE5G2A3CW61mQR3JmQS3G47bniDcAdYTYKyGiDdAbIaIN0BrBpQixAAQMdhkKv224OD1XfRALARnoCU8wRU0pf/hAW+0mynv4/Skan+8vypItSZswH656NXZsTKYIS2gH1bQJ4yuNo4ZbDIcsrgJvriN1YG+baA1SS4U5gE9ZVBFgR0k6C+MsiCwEvcJHjQMAlujGgSLIprEpxBQ8BUhAAAOhpDu5Z879Fg9f/Rl/62pJoJgCdArQDU0QAwbb6v9Bqnv186ApNFCJgmKjszZRvHq7QFvFFMgsopgxaToOIOsJwroJnbArFNguaQYDST4EGbSfA9y8rgchEE1HMF5MrgbN0k6JqOEABARyWn+0fnPxas+c2QQNVY+uJ/HZ4AZzwB9OV/nP6J83n61zlz3eWXOP190RFhIWCK8fmWGW0BWbmZ441vElwaZhIsNkyCa8VsQHSToPW4YXnAUGtMgtaVQWkSXGCYBPnKoGsmQgAAQGdIsPbGIZnVT9MgsJuGgFPwBLSLJ6Ay31O6hIaAXnNc5UGnP3Ogw0LAZGX402gL2GYD4poEjVMWbSZBt1kNsJgEtWgmwbdbaBJcr5gEVynVgMgmwSqEAABAJIYGQ9fSADCUvvy3PpZZ9XlqzAQknSegaJavfN5Mb+lf5vhCP3b6MwXRod8X+ezzn0I//6nK5yrbAqZO2GYSFGczmG0BfVsgkkmQzwbQMLBei2AS5EGguSbBlxWToPW4YeuQYAyToCsfIQAAEJshvlA2ffkPoCFg/eOBqg/hCYjoCThM/3rGDG/pH6d1MO9+OqCHAP3zn6JWA2RbQHUHeMxtAWs1IIpJ0GU1CarbAnJlUG4LJG4SfEUxCW5rsUmw0jUHIQAAkDhP+Ct/9Fhm9fXDMkP3DQtUjX0ys3rtE/6qd58MVH+Rzp6Aaf7yWvpi2EP/9L+AXkPo9fuZ6N+nDfT7JJ99X8jPf6qo+MgKzyyf0hYwVjUTNAm6VJOgXhGwmgQL4pgEDyhDgq/bTII7W2gSXKCbBF3PIAQAAFpPni/042H+mhueyKzq9VRm9TgaAtbREPAevX+ZIp6AOhoCXp3iL19I70OneCv+MC2z4lL6dX3L6WcL2h8ZAiYa1QB9PmC60d4ps7UFhK/BY10ZtG8LWE2CxXw2QF0ZlNsCcmXQbAuYQ4I7DZOg2hbYYztgqDkmwUVGW6AcIQAA0J4M/tEH381z12TkBau7Dw9WXfd0oKonDQF/pi/9h2gAeJzex9P7XHpfTa/t9MX/Jr2K6FVPr1OJzQRUfkbvlWN9le/S/zPfM85XsYnel9CX/4zxmRV59D6I/p/7fRPpi318oPyXk7xlV0xylwXGacWdnX4+IDmgwTF/vKgUTWQVIaMtUEESMgl6rCZBoy1gMQmabQH1lMHIJsH3LSbBXTaToGwL7BMmQdkWOCRMgu8Ik+ARHgRWGybBYh4EFpsmQdc8hAAAQPIyLlj2w9GZFVljMiuuotf1o+ifzkdkVnjygmUXOP17A+kDCwHjxNzIRGU2QM6BRDMJzpX6ZotJ0FwZjGoSjLItYM4GxDYJvpaQSVAfEnzPZhIsMs4VeJaUuhYgBAAAAOjYjPFXTh4r2kcTxKyInA2Q2wLSJGi0BYTRUc4GGG0BMRvwnJgNMEyCbtMkaGwLGLMBRZa2gLkyqB8wZK4M6gcMmbMBLAjIlcEd3CT4lmES3BTRJFiomARLXc8iBAAAAOjY6CFAzJOImZFJymyA3BYINwmWWlYGLSZBsS0Q0SQYoS2wSdkWiG0SVM8VkCuDVpPgIWESlEOCR4RJ8KjdJIgQAAAAoKMzioaAMYpnYgKfDTC3BeTpkTMsswFlxhkPsUyC9m0Becrg8/yUweI4JsECsTKomgT3t5FJcAkpcS1GCAAAANCxYSFgtLFhorcFJhqbI2Jl0HLAkNUdEN0kWKKEgBKbSdB0B4SZBMPaAq01CW5QTIIrzQOGXEsQAgAAAHRsRvmrJo8SZ1KMVVZLJwp/hLoyaDcJzo5kElS2BSynDHrCTYJhbQHVJMhPGWyuSXCHzSS4STEJrrWaBF1LEQIAAAB0bPJECJDrp+OEZ8K+LRDNJChPGTTaAhZ3QBSTYNhsgN0kaLoDEjcJ7lZMgtvjmgQRAgAAAHR4WAgYqfgoZFtgQoRtAatJsNx2ymBZ4ibBCCuDVpNgYRyToPW44RaZBF3LEQIAAAB0bEbQEJAnDJWjFRGVdWXQdAdMt7kDjHMFpEnQG24SlNWAcJOguTJo3xYIrwboK4OsLbDLMAnuE+4Aq0lwf1yT4GoaAlYiBAAAAOjYjAhUTR4hdNXyjIoxkVYG/UpbQDUJeqOYBL1Wk+BSIRGymgSLzLaAO55J8KjFJLjbZhLcazMJHjAOGNJNgoeFSZANCXKTIEIAAACAjs5wFgLkSZa8GhAyqgHjIswGxDMJylMGrSZBfVsgpknQdsqg3SS4NY5J8NWoJsFtNpPgel4NOOpajRAAAACgY8NCwNOZ+qmW8hRLfTYgRMb6rCbBSdIk6As3Cc4xTIJiZdDWFnguwraAPGUwzCTokibBAnNlkG8L6CZBuTK4U5gE5crgq8IkqK8MsiDwEjcJHrSZBHk1wLUGIQAAAEDHhoUAdtLl0+JUS6MtoJxOOV45edJiElRWBi1tAa95yqDFJKicMhjbJFhknDIotwVimwT320yCckjQNAkeFCZBoxqAEAAAAKCj8yQNAU/xY65pEDCOsta3BaKZBOUpg9PoC181CVq3BaKbBOVsgGkSLDZMgvq2QCyT4FGbSVAfEmy2SdC1Pt/pZw8AAAA4CgsBT9IAIKsBcjZAbguY1QDRFjBMguVWk6DFHWBtCyy0tQWWKLMBK2wrg2vcUUyCWtuaBA8jBAAAAOjoPBGoGvMEDQBPBWgQoC/+EXw2IMRnA0bZVgbt2wLylEG7SXBOJJMg2xagL3yzLcAqAnoIsJsEeQhg2wJaBJOg1hYmQX7A0JNOP3sAAADAUYYFqiazEMCqAbItILcFwkyCSgiIZxLk7gCPuS0QVg2IYxK0bwvIlUG5LZC4SfAVxSS4zWgLvJ2x6Xannz0AAADgKI8FaiYPYyEgUE2DQEhvC/hlW8BmEvSZJsHJMU2C5rbAPN4WSNAk6FJNgqwiUGjZFpCzAdFNggcUkyALAnuimQQbDrk3XuL0swcAAAAchYWAx+mL36wGsPmAkF4NEG2BSCZB+7aAnA2Y6SuztQWimwTVbQGrSTD8lEG5LSBXBvVtAd0kKIcEdxomQbUtsMfWFuArgzVvunZ0cvrZAwAAAI7CQsBj9MU/LFDNg4AZAqpIbJMg2xYoV9oCFRaT4GxfFJOgx2oSNNoCFpOgfWUwukmQDQmqJsFdNpPgazaToFAKz3f6uQMAAACOM4SFABoAHqfXMEs1wLotMNrmDmgbk6C5MhjPJLg+iklwm80kuCsBk+Ab7p0ZTj93AAAAwHFYCBiaqYcA3hbgswF6CNC3BaxtARYC7CZBORsgtwVUk6C6LSBnA4y2gG02YJltZTDMJKhJk6DZFjBXBo/YVgb1A4bMlUEWBPhxw1OdfuYAAABAUkBDwNgh9MXPqwE0DIS3BUQ1IJJJUF0ZVE2CrBqgmARlNUBdGbSYBD16WyDMJBilLbBJ2RaIbRJ8k7cFFJNg44FO2y9w+pkDAAAAScHgQM3kwfTFPzRQQ+RsgNwWMFYGm2USLDe2BeynDMYzCS4JMwkWGSbBdfQe2yRYYDMJHhIrg6ZJ8HXt1Tudft4AAABA0vCICAFDeBAwZwPktoBxroA0Caorg369LTDRYhKssJoEfVZ3gGESjOQOMFYGTXeAYRJ0RTEJhrUFpEnwkM0kuHe5088aAAAASCpYCHiUh4AaYrYF9NkA+7aA1SRonjI4XjllUF0ZtJgExbZAmEkw4gFDkU2CYW0B1SToimkSPOn0cwYAAACSDhYC6EUeFSFgqAgCcjZAbgtIk+DISCZBf0XYtkA0k6A8ZXCebWXQ3BaIbxJcH2YSNN0BkUyC/3C9eaPTzxkAAABIOgYGa0cMYiEgyIKAXhGQ2wL6bIAeBOQpg/FMgpNimgRLlZXBssRNgurKoNvUCevbAmJlMIpJcJd2aKDTzxgAAABISgYGagbTi+jVABECLG2BCCbBTPOUQbtJUA8Bpjtgus0dYJwrEMUkqJ4rEG4SNFcGzbaAHgTCqwHcJDjG6ecLAAAAJC0DaAh4mL74BwVraRCoJoOV2QCLSTBQFbYtIGcDIh0wNEXZFlBNgvnRTIJeq0lQnjJoNQkWmSuDvCIQ3SS4XXsfVkAAAAAgFjQEPPlwsIYMpNcgMRswWJkNiGQSHGExCYYUd4A5GzCpVSZB4Q5IwCQoZwNsJsH1Tj9XAAAAIOlhlYABPATUEt4WUGYDhkQxCeo6YbYtUBnTJGjfFrCcMujTTxk0VgYjtAXs2wLylMHVximDRZZTBjdpBawasNTpZwoAAACkBP2yagb3pwHgYUsIqLG0BVR3gHqugLUtEH6uQJhJ0Gs1CRptAW8Uk6ByyqDFJKi4A9RzBeg13unnCQAAAKQM/bLqB/ejAWAACwJiNkBuCxhtAaETltsCcjbg6WaZBNm2QJm5MsglQmJbII5JcGmYSbDYMAmuNWYDCgc4/SwBAACAlEKGgP4iCAwUIcDcFohtEpSzAXJbYKzqDlC2BdRzBWZEmA2IaxIUswFhJkEWArRC6IABAACA5pJDQ0AuCwFZdaQ/ffGrbQH7toDFJBiQpwzaTYLmyqC5LVDOtwXkKYMWk6ByyqDFJMi2BeiL32wL6NsCdpPgal+xz+lnCAAAAKQkLATk0Be/Wg1g2wKDgno1YLBqEsy0mwRDhkkwzzAJRl4ZjGcS5O4Aj7ktYK0GhJsEV7lLipx+dgAAAEBKw0JAX/riz82qI3I2YECgxmgLmLMBdpMg2xYI6W2BBEyCk6OaBJW2gAgB8UyCy1wlE51+bgAAAEDK8yAPAXUkh165lmqAdVtAPVfgcWU2wGISVE4ZtJsEzXMFrCuDM31ltraAMAl6rCuDsi2w3H3sBqefGQAAAJAWPNilbthDLARksSDA2gJ1RK4M6tsCoi0gKgJhJkHRFhhhNwmybQH6wjfbAmxboFxpC1QkZhIUBwwt9h6rcvpZAQAAAGnFA1n1gx+kAeAhevG2QNBsCzwcaJ5J8GmLSTCyO2BygibBuSIE6NsCJX91+jkBAAAAaQcLAX2CLATUk4fEbIDRFghENgkOjWISHC5mA8JMgv4K2wFD+myA3BaQJkGjLeAxtgWOOv18AAAAgLSFhYAH6IufVwNEWyBX2RbgswERtgXkbIDaFhjOtwX02YBIJkHLAUM2d0C4SbC8p9PPBgAAAEhretMQcD998ffJqicP0hDQV84GZFnbArpJsFppC9QYswF2k+AI1SToj24SnCxCgNwWELMBi51+JgAAAECHQA8B9eQBevUxZgP0bQGrSbBGWRmsiWsStG8LyFMGx4sQoLsDxMqgXg141elnAQAAAHQoWAjoLULAA0HWFqi3tAX68yvcJChPGQwzCRorg3aTYMiYDbCZBEtnBcsucPo5AAAAAB2OXl3qc3vRF79eDRBtgSylLRDFJGjfFrCaBM1qwEjDJFhpmgT5uQKVRVP8lV6nv34AAACgw0IDwK/uy6r/Z+8ux4l9NiCeSdA4YMhiEtSDgDxlMIJJcMfkH33wXae/bgAAAKDD0ztQG6QhoIxVA3orswH2bQGLSTConjJYYzUJipXBCCbB8U5/rQAAAABQuNNV++2/B+sf69Wl/nO1LfBghG2BcJOg9ZRBi0mQbQv4Q/vzMmuucvprBAAAAEAU/nJp9YW9sk5MuC+rvqG3CALW2QDTHSBnA6KZBIdlVr37RKAKO/4AAABAqpDT/aPzewXr7uqVdXzF/cG6z3hbIGiuDFpMgkHTJPhosPbdR4PVI4fiT/wAAABA6tOry/Hre3ep+1ufrLonHwrWL3woWLsjJ1i3LidQO7FfVu3DAwK1v38kUO92+vcJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgLfl/uKyBHOHuWpMAAAAASUVORK5CYII=" alt="BugLens Logo" style="width:36px;height:36px;object-fit:contain;flex-shrink:0;filter:drop-shadow(0 0 5px rgba(255,255,255,0.5)) drop-shadow(0 1px 2px rgba(0,0,0,0.2));border-radius:6px;" />
        <div style="display: flex; flex-direction: column; line-height: 1;">
          <div class="brand-title" style="display: flex; align-items: center; font-size: 20px; font-weight: 800; letter-spacing: -0.02em;">
            <span class="brand-text-mono">Bug</span>
            <span class="brand-text-gradient">Lens</span>
            <span class="brand-report-badge">REPORT</span>
          </div>
          <div class="brand-tagline" style="display: flex; align-items: center; gap: 4px; font-size: 9px; font-weight: 800; letter-spacing: 0.12em; margin-top: 4px;">
            <span style="color: #a855f7;">•</span>
            <span style="color: var(--text, #f9fafb); opacity: 0.85;">FIND</span>
            <span style="color: var(--text, #f9fafb); opacity: 0.5;">SNEAK</span>
            <span style="color: var(--text, #f9fafb); opacity: 0.85;">RAISE</span>
            <span style="color: #f43f5e;">•</span>
          </div>
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
          ${triageResult ? `
          <div class="section-card" style="border: 1px solid rgba(129, 140, 248, 0.4); background: rgba(99, 102, 241, 0.08); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <span class="card-label" style="color: #818cf8; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;">🧠 AI Root Cause Triage</span>
              <span style="background: ${triageResult.affectedComponent === 'BACKEND' ? '#ef4444' : triageResult.affectedComponent === 'EXTERNAL_API' ? '#f59e0b' : '#3b82f6'}; color: #ffffff; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 10px; text-transform: uppercase;">
                ${triageResult.affectedComponent}
              </span>
            </div>
            <div style="font-weight: 700; font-size: 14px; margin-bottom: 6px; color: var(--text, #f9fafb);">${triageResult.rootCause}</div>
            <div class="card-content" style="margin-bottom: 10px; font-size: 12px; color: var(--text2, #94a3b8); line-height: 1.5;">${triageResult.technicalSummary}</div>
            <div style="background: rgba(99, 102, 241, 0.12); border-left: 3px solid #818cf8; padding: 8px 12px; border-radius: 4px;">
              <span style="font-size: 11px; font-weight: 700; color: #818cf8; display: block; margin-bottom: 2px;">💡 Recommended Fix:</span>
              <span style="font-size: 12px; color: var(--text, #f9fafb);">${triageResult.suggestedFix}</span>
            </div>
          </div>
          ` : ''}

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

          ${mainImageIndex !== null && screenshots[mainImageIndex] && typeof screenshots[mainImageIndex] === 'string' && (screenshots[mainImageIndex].startsWith('data:') || screenshots[mainImageIndex].startsWith('http')) ? `
          <div class="section-card">
            <span class="card-label">Main Screenshot</span>
            <div class="main-screenshot-card lightbox-trigger" data-src="${screenshots[mainImageIndex]}" data-caption="Main Screenshot">
              <img src="${screenshots[mainImageIndex]}" alt="Main Screenshot" onerror="this.onerror=null;this.parentElement.parentElement.style.display='none';" />
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
    <img class="lightbox-content" id="lightbox-img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Lightbox Preview" />
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
      var img = document.getElementById('lightbox-img');
      if (lightbox) {
        lightbox.classList.remove('open');
      }
      if (img) {
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
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
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      
      const triggerPrint = () => {
        w.print();
        w.close();
      };

      const imgs = Array.from(w.document.images || []);
      let loadedCount = 0;
      let printTriggered = false;

      const onImageFinish = () => {
        if (printTriggered) return;
        loadedCount++;
        if (loadedCount >= imgs.length) {
          printTriggered = true;
          setTimeout(triggerPrint, 250);
        }
      };

      if (imgs.length === 0) {
        setTimeout(triggerPrint, 300);
      } else {
        imgs.forEach(img => {
          if (img.complete) {
            onImageFinish();
          } else {
            img.onload = onImageFinish;
            img.onerror = onImageFinish;
          }
        });
        setTimeout(() => {
          if (!printTriggered) {
            printTriggered = true;
            triggerPrint();
          }
        }, 1200);
      }
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
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          maxHeight: '440px',
          overflowY: 'auto'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <BugLensLogo size={20} showText={true} badge="SETTINGS" />
            <button
              onClick={() => setShowSettings(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: '18px', display: 'flex', padding: 0 }}
            >
              ×
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {/* AI Providers */}
            <div>
              <span style={{ fontSize: '10px', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>🤖 AI Providers (BYOK)</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)' }}>OpenAI API Key</label>
                <input
                  type="password"
                  value={userOpenAiKey}
                  onChange={(e) => setUserOpenAiKey(e.target.value)}
                  placeholder="sk-..."
                  style={{
                    width: '100%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: 'var(--text)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Claude API Key</label>
                <input
                  type="password"
                  value={userClaudeKey}
                  onChange={(e) => setUserClaudeKey(e.target.value)}
                  placeholder="sk-ant-..."
                  style={{
                    width: '100%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: 'var(--text)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            {/* Jira */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>🎟 Jira Integration</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Jira Base Domain URL</label>
              <input
                type="text"
                value={userJiraUrl}
                onChange={(e) => setUserJiraUrl(e.target.value)}
                placeholder="https://yourcompany.atlassian.net"
                style={{
                  width: '100%',
                  background: 'var(--bg3)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  color: 'var(--text)',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  outline: 'none'
                }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Jira Email</label>
                <input
                  type="email"
                  value={userJiraEmail}
                  onChange={(e) => setUserJiraEmail(e.target.value)}
                  placeholder="you@company.com"
                  style={{
                    width: '100%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: 'var(--text)',
                    fontSize: '11px',
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Jira Project Key</label>
                <input
                  type="text"
                  value={userJiraProject}
                  onChange={(e) => setUserJiraProject(e.target.value)}
                  placeholder="KAN"
                  style={{
                    width: '100%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: 'var(--text)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    outline: 'none'
                  }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Jira API Token</label>
              <input
                type="password"
                value={userJiraToken}
                onChange={(e) => setUserJiraToken(e.target.value)}
                placeholder="ATATT3xFfGF0..."
                style={{
                  width: '100%',
                  background: 'var(--bg3)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  color: 'var(--text)',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  outline: 'none'
                }}
              />
            </div>

            {/* Slack */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>💬 Slack Integration</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Slack Webhook URL</label>
                <input
                  type="password"
                  value={userSlackWebhook}
                  onChange={(e) => setUserSlackWebhook(e.target.value)}
                  placeholder="https://hooks.slack.com/services/..."
                  style={{
                    width: '100%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: 'var(--text)',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Channel</label>
                <input
                  type="text"
                  value={userSlackChannel}
                  onChange={(e) => setUserSlackChannel(e.target.value)}
                  placeholder="#bugs"
                  style={{
                    width: '100%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: 'var(--text)',
                    fontSize: '11px',
                    outline: 'none'
                  }}
                />
              </div>
            </div>

            {/* Azure DevOps */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px' }}>
              <span style={{ fontSize: '10px', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>🔷 Azure DevOps Integration</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Org Name</label>
                <input
                  type="text"
                  value={userAzureOrg}
                  onChange={(e) => setUserAzureOrg(e.target.value)}
                  placeholder="my-org"
                  style={{
                    width: '100%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: 'var(--text)',
                    fontSize: '11px',
                    outline: 'none'
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Project Name</label>
                <input
                  type="text"
                  value={userAzureProject}
                  onChange={(e) => setUserAzureProject(e.target.value)}
                  placeholder="my-project"
                  style={{
                    width: '100%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: 'var(--text)',
                    fontSize: '11px',
                    outline: 'none'
                  }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '10px', color: 'var(--text2)' }}>Azure Personal Access Token (PAT)</label>
              <input
                type="password"
                value={userAzurePat}
                onChange={(e) => setUserAzurePat(e.target.value)}
                placeholder="PAT Token..."
                style={{
                  width: '100%',
                  background: 'var(--bg3)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  color: 'var(--text)',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  outline: 'none'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                style={{
                  flex: 1,
                  background: 'var(--bg3)',
                  border: '1px solid var(--border)',
                  color: 'var(--text2)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontWeight: 600,
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveSettings}
                style={{
                  flex: 1,
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
                Save Configuration
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
