import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './popup.css';

type RecordingState = 'idle' | 'recording' | 'paused';
type Severity = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

const SEVERITY_LABELS: Record<Severity, { label: string; color: string }> = {
  P0: { label: 'Critical', color: '#ef4444' },
  P1: { label: 'High', color: '#f97316' },
  P2: { label: 'Medium', color: '#f59e0b' },
  P3: { label: 'Low', color: '#3b82f6' },
  P4: { label: 'Trivial', color: '#6b7280' },
};

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [severity, setSeverity] = useState<Severity>('P2');
  const [stepCount, setStepCount] = useState(0);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRestrictedPage, setIsRestrictedPage] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [customApiUrl, setCustomApiUrl] = useState('http://localhost:8080');
  const [userOpenAiKey, setUserOpenAiKey] = useState('');
  const [userJiraUrl, setUserJiraUrl] = useState('');
  const [userJiraEmail, setUserJiraEmail] = useState('');
  const [userJiraToken, setUserJiraToken] = useState('');
  const [userJiraProject, setUserJiraProject] = useState('');

  useEffect(() => {
    // Immediately read persistent auth & BYOK state from chrome.storage.local
    chrome.storage.local.get([
      'accessToken', 'refreshToken', 'user', 'customApiBase',
      'currentSessionId', 'isPaused', 'stepCount',
      'userOpenAiKey', 'userJiraUrl', 'userJiraEmail', 'userJiraToken', 'userJiraProject'
    ], (res) => {
      if (res.customApiBase) setCustomApiUrl(res.customApiBase);
      if (res.userOpenAiKey) setUserOpenAiKey(res.userOpenAiKey);
      if (res.userJiraUrl) setUserJiraUrl(res.userJiraUrl);
      if (res.userJiraEmail) setUserJiraEmail(res.userJiraEmail);
      if (res.userJiraToken) setUserJiraToken(res.userJiraToken);
      if (res.userJiraProject) setUserJiraProject(res.userJiraProject);

      if (res.accessToken || res.refreshToken || res.user) {
        setIsAuthenticated(true);
      }
      if (res.currentSessionId) {
        setRecordingState(res.isPaused ? 'paused' : 'recording');
        setStepCount(res.stepCount ?? 0);
      }
    });

    // Query background worker for live status
    chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
      if (response) {
        if (typeof response.isAuthenticated === 'boolean') {
          setIsAuthenticated(response.isAuthenticated);
        }
        setRecordingState(response.sessionId ? (response.isPaused ? 'paused' : 'recording') : 'idle');
        setStepCount(response.stepCount ?? 0);
      }
    });

    // Listen for step count and state updates from background worker
    const messageListener = (message: any) => {
      if (message.type === 'STEP_COUNT_UPDATED') {
        setStepCount(message.payload.stepCount);
      }
      if (message.type === 'RECORDING_STATE_CHANGED') {
        const p = message.payload;
        if (typeof p.isAuthenticated === 'boolean') {
          setIsAuthenticated(p.isAuthenticated);
        }
        setRecordingState(p.sessionId ? (p.isPaused ? 'paused' : 'recording') : 'idle');
        if (typeof p.stepCount === 'number') {
          setStepCount(p.stepCount);
        }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    // Check if current page is restricted
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url ?? '';
      const isRestricted = url.startsWith('chrome://') || 
                          url.startsWith('edge://') || 
                          url.startsWith('https://accounts.google.com') ||
                          url.startsWith('chrome-extension://');
      setIsRestrictedPage(isRestricted);
    });

    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  const handleLogin = useCallback(async () => {
    setError(null);
    const response = await chrome.runtime.sendMessage({ type: 'LOGIN' });
    if (response?.success) {
      setIsAuthenticated(true);
    } else {
      setError(response?.error || 'Login failed. Check background logs.');
    }
  }, []);

  const handleStartRecording = useCallback(async () => {
    setError(null);
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) return;

    if (isRestrictedPage) {
      setError('Recording is not available on this page for security reasons.');
      return;
    }

    const deviceFingerprint = {
      os: navigator.platform,
      browser: 'Chrome',
      browserVersion: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown',
      viewportWidth: tab.width ?? 1280,
      viewportHeight: tab.height ?? 800,
      devicePixelRatio: window.devicePixelRatio,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      url: tab.url ?? '',
      userAgent: navigator.userAgent,
    };

    try {
      const sessionResponse = await chrome.runtime.sendMessage({
        type: 'START_SESSION',
        payload: { deviceFingerprint },
      });

      if (sessionResponse?.sessionId) {
        // Immediately set recording state in Popup UI
        setRecordingState('recording');
        setStepCount(0);

        // Notify content script (with dynamic injection fallback)
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'START_RECORDING',
            payload: { sid: sessionResponse.sessionId },
          });
        } catch {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js'],
            });
            await new Promise((r) => setTimeout(r, 100));
            await chrome.tabs.sendMessage(tab.id, {
              type: 'START_RECORDING',
              payload: { sid: sessionResponse.sessionId },
            });
          } catch (err) {
            console.warn('[Popup] Content script messaging notice:', err);
          }
        }
      } else {
        setError(sessionResponse?.error ?? 'Failed to start session. Please check your connection.');
      }
    } catch (err) {
      console.error('[Popup] START_SESSION error:', err);
      setError('An unexpected error occurred. Please try again.');
    }
  }, [isRestrictedPage]);

  const handleOpenSidePanel = useCallback(async () => {
    try {
      const win = await chrome.windows.getCurrent();
      if (win.id) {
        await chrome.sidePanel.open({ windowId: win.id });
      }
    } catch {
      await chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
    }
  }, []);

  const handleStopRecording = useCallback(async () => {
    // 1. Immediately open SidePanel before any async tick to preserve User Gesture
    try {
      const win = await chrome.windows.getCurrent();
      if (win.id) {
        await chrome.sidePanel.open({ windowId: win.id });
      }
    } catch (err) {
      console.warn('[Popup] SidePanel open warning:', err);
    }

    // 2. Reflect idle state immediately in Popup UI
    setRecordingState('idle');

    // 3. Remove recording banner & notify content scripts
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_RECORDING' }).catch(() => {});
    }

    // 4. Send END_SESSION to backend worker
    await chrome.runtime.sendMessage({ type: 'END_SESSION', payload: { status: 'COMPLETED' } });
  }, []);

  const handlePauseResume = useCallback(async () => {
    if (recordingState === 'recording') {
      setRecordingState('paused');
      await chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
    } else if (recordingState === 'paused') {
      setRecordingState('recording');
      await chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
    }
  }, [recordingState]);

  const handleSaveSettings = useCallback(() => {
    const cleanUrl = customApiUrl.trim().replace(/\/$/, '');
    chrome.storage.local.set({
      customApiBase: cleanUrl || 'http://localhost:8080',
      userOpenAiKey: userOpenAiKey.trim(),
      userJiraUrl: userJiraUrl.trim(),
      userJiraEmail: userJiraEmail.trim(),
      userJiraToken: userJiraToken.trim(),
      userJiraProject: userJiraProject.trim().toUpperCase(),
    }, () => {
      setShowSettings(false);
      setError(null);
      chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (response) => {
        if (response) {
          setIsAuthenticated(response.isAuthenticated);
          setRecordingState(response.sessionId ? (response.isPaused ? 'paused' : 'recording') : 'idle');
          setStepCount(response.stepCount ?? 0);
        }
      });
    });
  }, [customApiUrl, userOpenAiKey, userJiraUrl, userJiraEmail, userJiraToken, userJiraProject]);

  if (showSettings) {
    return (
      <div className="popup-container" style={{ maxHeight: '520px', overflowY: 'auto' }}>
        <header className="popup-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '8px', marginBottom: '8px' }}>
          <div className="logo-small" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '16px', height: '16px', color: '#818cf8', flexShrink: 0 }}>
              <rect x="6" y="8" width="12" height="11" rx="4" />
              <path d="M12 8V4" />
              <path d="M9 12h6" />
              <path d="M9 4.5a3 3 0 0 1 6 0" />
            </svg>
            <span style={{ fontWeight: 700, fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Personal Keys & Settings</span>
          </div>
        </header>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 0' }}>
          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="field-label" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>BugBuddy Backend API URL</label>
            <input
              type="text"
              value={customApiUrl}
              onChange={(e) => setCustomApiUrl(e.target.value)}
              placeholder="e.g. http://localhost:8080 or https://api.render.com"
              style={{
                width: '100%',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '6px 10px',
                color: 'var(--text-primary)',
                fontFamily: 'monospace',
                fontSize: '11px',
                outline: 'none'
              }}
            />
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px' }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>🔑 Bring Your Own Keys (BYOK)</span>
          </div>

          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="field-label" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>OpenAI API Key (Personal)</label>
            <input
              type="password"
              value={userOpenAiKey}
              onChange={(e) => setUserOpenAiKey(e.target.value)}
              placeholder="sk-..."
              style={{
                width: '100%',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '6px 10px',
                color: 'var(--text-primary)',
                fontFamily: 'monospace',
                fontSize: '11px',
                outline: 'none'
              }}
            />
          </div>

          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="field-label" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Jira Base Domain URL</label>
            <input
              type="text"
              value={userJiraUrl}
              onChange={(e) => setUserJiraUrl(e.target.value)}
              placeholder="https://yourcompany.atlassian.net"
              style={{
                width: '100%',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '6px 10px',
                color: 'var(--text-primary)',
                fontFamily: 'monospace',
                fontSize: '11px',
                outline: 'none'
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label className="field-label" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Jira Account Email</label>
              <input
                type="email"
                value={userJiraEmail}
                onChange={(e) => setUserJiraEmail(e.target.value)}
                placeholder="you@company.com"
                style={{
                  width: '100%',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  color: 'var(--text-primary)',
                  fontSize: '11px',
                  outline: 'none'
                }}
              />
            </div>
            <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label className="field-label" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Jira Project Key</label>
              <input
                type="text"
                value={userJiraProject}
                onChange={(e) => setUserJiraProject(e.target.value)}
                placeholder="KAN"
                style={{
                  width: '100%',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  color: 'var(--text-primary)',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  textTransform: 'uppercase',
                  outline: 'none'
                }}
              />
            </div>
          </div>

          <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label className="field-label" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Jira API Token</label>
            <input
              type="password"
              value={userJiraToken}
              onChange={(e) => setUserJiraToken(e.target.value)}
              placeholder="ATATT3xFfGF0..."
              style={{
                width: '100%',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '6px 10px',
                color: 'var(--text-primary)',
                fontFamily: 'monospace',
                fontSize: '11px',
                outline: 'none'
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
            <button
              className="btn"
              onClick={() => setShowSettings(false)}
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSaveSettings}
              style={{ background: 'linear-gradient(135deg, var(--accent) 0%, #818cf8 100%)', color: '#fff' }}
            >
              Save Configuration
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="popup-container auth-screen" style={{ position: 'relative' }}>
        <button
          onClick={() => setShowSettings(true)}
          style={{ position: 'absolute', top: 12, right: 12, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: 0 }}
          title="Settings"
          id="auth-settings-btn"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <div className="logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '42px', height: '42px', color: '#818cf8', filter: 'drop-shadow(0 0 15px rgba(99, 102, 241, 0.6))', margin: '0 auto 8px auto', display: 'block' }}>
            <rect x="6" y="8" width="12" height="11" rx="4" />
            <path d="M12 8V4" />
            <path d="M9 12h6" />
            <path d="M9 4.5a3 3 0 0 1 6 0" />
            <path d="M4 10h2" />
            <path d="M18 10h2" />
            <path d="M3 14h3" />
            <path d="M18 14h3" />
            <path d="M4 18h2" />
            <path d="M18 18h2" />
          </svg>
          <h1>BugBuddy</h1>
          <p>Enterprise Bug Capture</p>
        </div>
        <button className="btn btn-primary btn-google" onClick={handleLogin} id="login-btn">
          <svg className="google-icon" viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>
      </div>
    );
  }

  return (
    <div className="popup-container">
      {/* Header */}
      <header className="popup-header">
        <div className="logo-small" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: '16px', height: '16px', color: '#818cf8', flexShrink: 0 }}>
            <rect x="6" y="8" width="12" height="11" rx="4" />
            <path d="M12 8V4" />
            <path d="M9 12h6" />
            <path d="M9 4.5a3 3 0 0 1 6 0" />
            <path d="M4 10h2" />
            <path d="M18 10h2" />
            <path d="M3 14h3" />
            <path d="M18 14h3" />
            <path d="M4 18h2" />
            <path d="M18 18h2" />
          </svg>
          <span>BugBuddy</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isOffline && <span className="offline-badge" title="Offline — events queued">⚡ Offline</span>}
          <button
            onClick={() => setShowSettings(true)}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', padding: 0 }}
            title="Settings"
            id="popup-settings-btn"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Recording status */}
      <div className={`recording-indicator ${recordingState}`}>
        <div className="recording-dot" />
        <span>
          {recordingState === 'idle' && (isRestrictedPage ? 'Restricted Page' : 'Ready to record')}
          {recordingState === 'recording' && `Recording · ${stepCount} steps`}
          {recordingState === 'paused' && `Paused · ${stepCount} steps`}
        </span>
      </div>

      {/* Error messages */}
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="error-close" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Severity selector */}
      {recordingState !== 'idle' && (
        <div className="severity-section">
          <label className="field-label">Bug Severity</label>
          <div className="severity-buttons" role="group" aria-label="Bug severity">
            {(Object.keys(SEVERITY_LABELS) as Severity[]).map((s) => (
              <button
                key={s}
                id={`severity-${s}`}
                className={`severity-btn ${severity === s ? 'active' : ''}`}
                style={{ '--severity-color': SEVERITY_LABELS[s].color } as React.CSSProperties}
                onClick={() => setSeverity(s)}
                aria-pressed={severity === s}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="action-buttons">
        {recordingState === 'idle' ? (
          <button 
            className="btn btn-primary btn-record" 
            onClick={handleStartRecording} 
            id="start-recording-btn"
            disabled={isRestrictedPage}
          >
            ● Start Recording
          </button>
        ) : (
          <>
            <button
              className={`btn ${recordingState === 'paused' ? 'btn-resume' : 'btn-pause'}`}
              onClick={handlePauseResume}
              id="pause-resume-btn"
            >
              {recordingState === 'paused' ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button
              className="btn btn-stop"
              onClick={handleStopRecording}
              id="stop-recording-btn"
              disabled={stepCount === 0}
            >
              ■ Stop & Review
            </button>
          </>
        )}
      </div>

      {/* Side panel shortcut */}
      {recordingState !== 'idle' && (
        <button className="btn btn-panel" onClick={handleOpenSidePanel} id="open-panel-btn">
          📋 Open Review Panel
        </button>
      )}

      {/* Hotkey hints */}
      <div className="hotkey-hint">
        <kbd>Ctrl+I</kbd> screenshot &nbsp;·&nbsp; <kbd>Ctrl+Shift+P</kbd> pause
      </div>
    </div>
  );
}

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
