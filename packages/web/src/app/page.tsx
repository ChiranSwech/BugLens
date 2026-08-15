/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useEffect, useState } from 'react';
import { BugLensLogo } from '@/components/BugLensLogo';
import {
  Bug,
  Activity,
  User,
  LogOut,
  ExternalLink,
  Layers,
  Wifi,
  Terminal,
  Database,
  X,
  Clipboard,
  Check,
  Globe,
  Monitor,
} from 'lucide-react';

const BACKEND_URL = 'http://localhost:8080';

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [bugs, setBugs] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail View State
  const [selectedBug, setSelectedBug] = useState<any | null>(null);
  const [isDetailsLoading, setIsDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'steps' | 'network' | 'console' | 'storage'>('steps');
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);
  const [copiedSteps, setCopiedSteps] = useState(false);
  
  // Tabular Log Filtering
  const [netSearch, setNetSearch] = useState('');
  const [showFailedOnly, setShowFailedOnly] = useState(true);

  useEffect(() => {
    // 1. Check for token in URL (callback flow)
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('access_token');

    if (urlToken) {
      localStorage.setItem('buglens_token', urlToken);
      setToken(urlToken);
      // Clean up URL without refreshing
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
    } else {
      // 2. Check for existing token in localStorage
      const savedToken = localStorage.getItem('buglens_token') || localStorage.getItem('bugbuddy_token');
      if (savedToken) {
        setToken(savedToken);
      }
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (token) {
      fetchBugs();
    }
  }, [token]);

  const fetchBugs = async () => {
    try {
      setError(null);
      const res = await fetch(`${BACKEND_URL}/v1/bugs`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        // API returns { data: [], pagination: { ... } }
        setBugs(data.data || []);
      } else if (res.status === 401) {
        handleLogout();
      } else {
        const errData = await res.json().catch(() => ({}));
        setError(errData.title || 'Failed to fetch bugs from server');
      }
    } catch (err) {
      console.error('Failed to fetch bugs:', err);
      setError('Network error: Is the backend server running?');
    }
  };

  const viewDetails = async (bugId: string) => {
    try {
      setIsDetailsLoading(true);
      setDetailsError(null);
      const res = await fetch(`${BACKEND_URL}/v1/bugs/${bugId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setSelectedBug(data);
        setDetailTab('steps');
        setNetSearch('');
        setShowFailedOnly(true);
      } else {
        const errData = await res.json().catch(() => ({}));
        setDetailsError(errData.title || 'Failed to fetch bug details');
      }
    } catch (err) {
      console.error('Failed to fetch details:', err);
      setDetailsError('Network error while loading bug details.');
    } finally {
      setIsDetailsLoading(false);
    }
  };

  const closeDetails = () => {
    setSelectedBug(null);
    setDetailsError(null);
  };

  const handleLogin = () => {
    const redirectUri = encodeURIComponent('http://localhost:3000');
    // We send the frontend URL in the state param via redirect_uri query
    window.location.href = `${BACKEND_URL}/auth/google?redirect_uri=${redirectUri}`;
  };

  const handleLogout = () => {
    localStorage.removeItem('buglens_token');
    localStorage.removeItem('bugbuddy_token');
    setToken(null);
    setBugs([]);
    closeDetails();
  };

  const copyStepsToClipboard = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedSteps(true);
      setTimeout(() => setCopiedSteps(false), 2000);
    }).catch(() => {});
  };

  const highlightJson = (jsonObj: any) => {
    if (!jsonObj) return <div className="text-[#a09dc0] italic">No storage snapshot available.</div>;
    const jsonStr = typeof jsonObj === 'string' ? jsonObj : JSON.stringify(jsonObj, null, 2);
    try {
      const parsed = typeof jsonObj === 'string' ? JSON.parse(jsonObj) : jsonObj;
      return Object.entries(parsed).map(([key, val], i) => (
        <div key={i} className="font-mono text-xs py-1 border-b border-[#2e2e3a]/30 last:border-0 flex items-start gap-2">
          <span className="text-[#818cf8] font-semibold shrink-0">"{key}":</span>
          <span className="text-[#34d399] break-all">
            {typeof val === 'object' ? JSON.stringify(val) : `"${val}"`}
          </span>
        </div>
      ));
    } catch (e) {
      return <pre className="font-mono text-xs text-[#a09dc0] whitespace-pre-wrap">{jsonStr}</pre>;
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0f0f12] flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#818cf8]"></div>
      </div>
    );
  }

  // Filter logs for network tab
  const networkLogs = selectedBug?.network_logs || selectedBug?.networkLogs || [];
  const filteredNetLogs = networkLogs.filter((l: any) => {
    if (!l || !l.url) return false;
    const matchesSearch = l.url.toLowerCase().includes(netSearch.toLowerCase());
    return showFailedOnly ? l.failed && matchesSearch : matchesSearch;
  });

  // Decode device fingerprint
  const device = selectedBug?.device_fingerprint || selectedBug?.deviceFingerprint || {};
  const os = device.os || 'Unknown OS';
  const browser = device.browser || 'Unknown Browser';
  const resolution = device.resolution || 'Unknown Resolution';
  const userAgent = device.userAgent || device.user_agent || 'Unknown UA';

  // Format steps summary list
  const steps = selectedBug?.steps || [];
  const formattedSummarySteps = steps.map((s: any, idx: number) => {
    const order = s.order || idx + 1;
    const action = (s.action_type || s.actionType || 'CLICK').toUpperCase();
    const target = s.element_label || s.elementLabel || 'element';
    const value = s.value_masked || s.valueMasked;
    if (action === 'CLICK') return `${order}. Click on the "${target}".`;
    if (action === 'INPUT') return `${order}. Enter${value && value !== '[REDACTED]' ? ` "${value}"` : ''} in the "${target}" field.`;
    if (action === 'NAVIGATE') return `${order}. Navigate to the next page.`;
    if (action === 'SCROLL') return `${order}. Scroll the page.`;
    if (action === 'HOVER') return `${order}. Hover over "${target}".`;
    return `${order}. Perform ${action.toLowerCase()} on "${target}".`;
  }).join('\n');

  // Main Screenshot resolving
  const mainImageIndex = selectedBug?.main_image_index !== undefined ? selectedBug?.main_image_index : selectedBug?.mainImageIndex;
  const mainScreenshotUrl = mainImageIndex !== null && steps[mainImageIndex]?.screenshotUrl;

  return (
    <main className="min-h-screen bg-[#0f0f12] text-[#f1f0ff] p-8 font-sans relative">
      <div className="max-w-6xl mx-auto space-y-8">

        <header className="flex justify-between items-end border-b border-[#2e2e3a] pb-6">
          <div>
            <BugLensLogo size={42} showText={true} showSubtitle={true} monoColorClass="text-slate-900 dark:text-white" />
            <p className="text-[#a09dc0] mt-2">Enterprise QA Dashboard</p>
          </div>

          {token ? (
            <div className="flex items-center gap-4">
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 text-[#a09dc0] hover:text-[#f1f0ff] transition-colors px-4 py-2"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
              <div className="w-10 h-10 rounded-full bg-[#1a1a22] border border-[#2e2e3a] flex items-center justify-center">
                <User className="w-5 h-5 text-[#818cf8]" />
              </div>
            </div>
          ) : (
            <button
              onClick={handleLogin}
              className="bg-gradient-to-br from-[#6366f1] to-[#818cf8] hover:scale-[1.02] active:scale-95 transition-transform px-6 py-2.5 rounded-lg font-semibold shadow-[0_4px_14px_rgba(99,102,241,0.25)]"
            >
              Login via SSO
            </button>
          )}
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-6">
            <h3 className="text-[#a09dc0] font-semibold text-sm uppercase tracking-wider mb-2">Active Bugs</h3>
            <p className="text-4xl font-bold text-[#ef4444]">{bugs.length}</p>
          </div>
          <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-6">
            <h3 className="text-[#a09dc0] font-semibold text-sm uppercase tracking-wider mb-2">Sessions Recorded</h3>
            <p className="text-4xl font-bold text-[#f59e0b]">{bugs.filter(b => b.sessionId || b.session_id).length}</p>
          </div>
          <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-6">
            <h3 className="text-[#a09dc0] font-semibold text-sm uppercase tracking-wider mb-2">Critical P3+</h3>
            <p className="text-4xl font-bold text-[#10b981]">{bugs.filter(b => b.severity === 'P0' || b.severity === 'P1').length}</p>
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400 flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
            {error}
          </div>
        )}

        <section className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl overflow-hidden">
          <div className="p-6 border-b border-[#2e2e3a] flex justify-between items-center">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Activity className="w-5 h-5 text-[#818cf8]" />
              Recent Reports
            </h2>
          </div>

          <div className="overflow-x-auto">
            {bugs.length > 0 ? (
              <table className="w-full text-left border-collapse">
                <thead className="bg-[#14141a] text-[#5f5c7a] text-xs uppercase tracking-wider">
                  <tr>
                    <th className="px-6 py-4 font-semibold">Title</th>
                    <th className="px-6 py-4 font-semibold">Severity</th>
                    <th className="px-6 py-4 font-semibold">Status</th>
                    <th className="px-6 py-4 font-semibold">Created</th>
                    <th className="px-6 py-4 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2e2e3a]">
                  {bugs.map((bug) => (
                    <tr key={bug.id} className="hover:bg-[#1f1f2a] transition-colors group">
                      <td className="px-6 py-4 font-medium">{bug.title}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded text-xs font-bold ${bug.severity === 'P0' ? 'bg-red-500/20 text-red-500' :
                            bug.severity === 'P1' ? 'bg-orange-500/20 text-orange-500' :
                              'bg-blue-500/20 text-blue-500'
                          }`}>
                          {bug.severity}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-[#a09dc0] capitalize">{bug.status.toLowerCase()}</span>
                      </td>
                      <td className="px-6 py-4 text-sm text-[#5f5c7a]">
                        {new Date(bug.createdAt || bug.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4">
                        <button
                          onClick={() => viewDetails(bug.id)}
                          className="text-[#818cf8] hover:text-[#c084fc] flex items-center gap-1 text-sm transition-colors"
                        >
                          View Details <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="p-12 text-center text-[#5f5c7a]">
                <p>No bugs reported yet. Use the BugLens extension to start capturing.</p>
              </div>
            )}
          </div>
        </section>

      </div>

      {/* ─── Bug Details Modal (Redesigned Single Page + Tabular) ─── */}
      {selectedBug && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-40 flex items-center justify-center p-4 md:p-8 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-[#0f172a] border border-[#2e2e3a] w-full max-w-6xl h-[90vh] rounded-2xl flex flex-col overflow-hidden shadow-2xl relative animate-in zoom-in-95 duration-200">
            
            {/* Modal Header */}
            <div className="p-6 border-b border-[#2e2e3a] flex justify-between items-start shrink-0 bg-[#0b0f19]">
              <div>
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  <BugLensLogo size={20} showText={true} monoColorClass="text-slate-900 dark:text-white" />
                  <span className="text-[#2e2e3a] hidden sm:inline">|</span>
                  <span className={`px-2.5 py-1 rounded text-xs font-bold ${
                    selectedBug.severity === 'P0' ? 'bg-red-500/20 text-red-500 border border-red-500/30' :
                    selectedBug.severity === 'P1' ? 'bg-orange-500/20 text-orange-500 border border-orange-500/30' :
                    'bg-blue-500/20 text-blue-500 border border-blue-500/30'
                  }`}>
                    {selectedBug.severity}
                  </span>
                  <span className="text-xs text-[#a09dc0]">Report ID: {selectedBug.id}</span>
                </div>
                <h2 className="text-2xl font-bold text-white line-clamp-1">{selectedBug.title}</h2>
              </div>
              <button
                onClick={closeDetails}
                className="text-[#a09dc0] hover:text-white p-2 hover:bg-[#1a1a22] rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Scrollable Container */}
            <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
              
              {/* Section 1: Test Details (Main Section) */}
              <div className="p-6 border-b border-[#2e2e3a]/50 bg-[#0f172a] space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  
                  {/* Left columns */}
                  <div className="lg:col-span-2 space-y-4">
                    
                    <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5">
                      <span className="text-xs font-bold text-[#818cf8] uppercase tracking-wider block mb-2">Description</span>
                      <p className="text-sm text-[#f1f0ff] whitespace-pre-wrap">{selectedBug.description || 'No description provided.'}</p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {(selectedBug.expected_result || selectedBug.expectedResult) && (
                        <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5">
                          <span className="text-xs font-bold text-[#818cf8] uppercase tracking-wider block mb-2">Expected Result</span>
                          <p className="text-sm text-[#a09dc0]">{selectedBug.expected_result || selectedBug.expectedResult}</p>
                        </div>
                      )}
                      {(selectedBug.actual_result || selectedBug.actualResult) && (
                        <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5">
                          <span className="text-xs font-bold text-[#818cf8] uppercase tracking-wider block mb-2">Actual Result</span>
                          <p className="text-sm text-[#a09dc0]">{selectedBug.actual_result || selectedBug.actualResult}</p>
                        </div>
                      )}
                    </div>

                    {(selectedBug.bug_url || selectedBug.bugUrl) && (
                      <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5">
                        <span className="text-xs font-bold text-[#818cf8] uppercase tracking-wider block mb-2">Target URL</span>
                        <a
                          href={selectedBug.bug_url || selectedBug.bugUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-[#818cf8] hover:underline flex items-center gap-1.5 break-all"
                        >
                          {selectedBug.bug_url || selectedBug.bugUrl} <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    )}

                    {(selectedBug.test_data || selectedBug.testData) && (
                      <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5">
                        <span className="text-xs font-bold text-[#818cf8] uppercase tracking-wider block mb-2">Test Data Details</span>
                        <pre className="text-xs text-[#a09dc0] font-mono bg-black/20 p-3 rounded-lg border border-[#2e2e3a]/30 whitespace-pre-wrap">{selectedBug.test_data || selectedBug.testData}</pre>
                      </div>
                    )}

                    {/* Device fingerprint */}
                    <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5">
                      <span className="text-xs font-bold text-[#818cf8] uppercase tracking-wider block mb-4">Device details</span>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="bg-[#0f0f12] border border-[#2e2e3a]/50 p-3 rounded-lg flex items-center gap-3">
                          <Monitor className="w-5 h-5 text-[#818cf8] shrink-0" />
                          <div className="min-w-0">
                            <span className="text-[10px] text-[#5f5c7a] uppercase tracking-wider block">OS</span>
                            <span className="text-xs text-[#f1f0ff] font-semibold truncate block" title={os}>{os}</span>
                          </div>
                        </div>
                        <div className="bg-[#0f0f12] border border-[#2e2e3a]/50 p-3 rounded-lg flex items-center gap-3">
                          <Globe className="w-5 h-5 text-[#818cf8] shrink-0" />
                          <div className="min-w-0">
                            <span className="text-[10px] text-[#5f5c7a] uppercase tracking-wider block">Browser</span>
                            <span className="text-xs text-[#f1f0ff] font-semibold truncate block" title={browser}>{browser}</span>
                          </div>
                        </div>
                        <div className="bg-[#0f0f12] border border-[#2e2e3a]/50 p-3 rounded-lg flex items-center gap-3">
                          <Layers className="w-5 h-5 text-[#818cf8] shrink-0" />
                          <div className="min-w-0">
                            <span className="text-[10px] text-[#5f5c7a] uppercase tracking-wider block">Resolution</span>
                            <span className="text-xs text-[#f1f0ff] font-semibold truncate block" title={resolution}>{resolution}</span>
                          </div>
                        </div>
                        <div className="bg-[#0f0f12] border border-[#2e2e3a]/50 p-3 rounded-lg flex items-center gap-3">
                          <User className="w-5 h-5 text-[#818cf8] shrink-0" />
                          <div className="min-w-0">
                            <span className="text-[10px] text-[#5f5c7a] uppercase tracking-wider block">Reporter</span>
                            <span className="text-xs text-[#f1f0ff] font-semibold truncate block" title={selectedBug.reporter_name || 'tester'}>{selectedBug.reporter_name || 'Tester'}</span>
                          </div>
                        </div>
                      </div>
                      {userAgent && (
                        <div className="mt-3 text-[11px] text-[#5f5c7a] font-mono break-all bg-black/10 p-2 rounded-lg border border-[#2e2e3a]/25">
                          UA: {userAgent}
                        </div>
                      )}
                    </div>

                  </div>

                  {/* Right columns */}
                  <div className="space-y-4">
                    
                    <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5 relative">
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-xs font-bold text-[#818cf8] uppercase tracking-wider">Test Summary</span>
                        <button
                          onClick={() => copyStepsToClipboard(formattedSummarySteps)}
                          className="text-[#a09dc0] hover:text-[#f1f0ff] p-1.5 hover:bg-[#0f0f12] rounded-lg transition-colors border border-transparent hover:border-[#2e2e3a]"
                          title="Copy summary steps"
                        >
                          {copiedSteps ? <Check className="w-4 h-4 text-[#10b981]" /> : <Clipboard className="w-4 h-4" />}
                        </button>
                      </div>
                      <pre className="text-xs text-[#a09dc0] font-mono whitespace-pre-wrap leading-relaxed max-h-[220px] overflow-y-auto">{formattedSummarySteps || 'No summary steps available.'}</pre>
                    </div>

                    {mainScreenshotUrl ? (
                      <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-4 flex flex-col items-center">
                        <span className="text-xs font-bold text-[#818cf8] uppercase tracking-wider block self-start mb-3">Main Screenshot</span>
                        <div
                          onClick={() => setLightboxImg(mainScreenshotUrl)}
                          className="cursor-zoom-in border border-[#2e2e3a] rounded-lg overflow-hidden group w-full"
                        >
                          <img
                            src={mainScreenshotUrl}
                            alt="Main screenshot"
                            className="w-full h-auto object-contain max-h-[200px] group-hover:scale-[1.02] transition-transform duration-200"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-6 text-center text-[#5f5c7a] italic text-sm">
                        No main screenshot selected.
                      </div>
                    )}

                  </div>
                </div>
              </div>

              {/* Section 2: Tabular Module Section */}
              <div className="flex-1 flex flex-col min-h-[400px]">
                
                {/* Tab buttons */}
                <div className="flex border-b border-[#2e2e3a] bg-[#0b0f19]/50 shrink-0 px-6 overflow-x-auto">
                  <button
                    onClick={() => setDetailTab('steps')}
                    className={`px-4 py-4 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
                      detailTab === 'steps' ? 'border-[#818cf8] text-[#818cf8] bg-[#818cf8]/5' : 'border-transparent text-[#a09dc0] hover:text-[#f1f0ff]'
                    }`}
                  >
                    <Layers className="w-4 h-4" />
                    Detailed Steps ({steps.length})
                  </button>
                  <button
                    onClick={() => setDetailTab('network')}
                    className={`px-4 py-4 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
                      detailTab === 'network' ? 'border-[#818cf8] text-[#818cf8] bg-[#818cf8]/5' : 'border-transparent text-[#a09dc0] hover:text-[#f1f0ff]'
                    }`}
                  >
                    <Wifi className="w-4 h-4" />
                    Failed Network Logs ({networkLogs.filter((l: any) => l.failed).length})
                  </button>
                  <button
                    onClick={() => setDetailTab('console')}
                    className={`px-4 py-4 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
                      detailTab === 'console' ? 'border-[#818cf8] text-[#818cf8] bg-[#818cf8]/5' : 'border-transparent text-[#a09dc0] hover:text-[#f1f0ff]'
                    }`}
                  >
                    <Terminal className="w-4 h-4" />
                    Console Logs ({(selectedBug.console_logs || selectedBug.consoleLogs || []).length})
                  </button>
                  <button
                    onClick={() => setDetailTab('storage')}
                    className={`px-4 py-4 text-sm font-semibold border-b-2 flex items-center gap-2 transition-colors ${
                      detailTab === 'storage' ? 'border-[#818cf8] text-[#818cf8] bg-[#818cf8]/5' : 'border-transparent text-[#a09dc0] hover:text-[#f1f0ff]'
                    }`}
                  >
                    <Database className="w-4 h-4" />
                    App Storage
                  </button>
                </div>

                {/* Tab content panel */}
                <div className="flex-1 p-6 bg-[#0b0f19]/20 min-h-0 overflow-y-auto">
                  
                  {/* Detailed Steps Panel */}
                  {detailTab === 'steps' && (
                    <div className="space-y-4">
                      {steps.length > 0 ? (
                        steps.map((step: any, idx: number) => {
                          const order = step.order || idx + 1;
                          const action = (step.action_type || step.actionType || 'CLICK').toUpperCase();
                          const label = step.element_label || step.elementLabel;
                          const url = step.page_url || step.pageUrl;
                          const date = step.timestamp ? new Date(step.timestamp).toLocaleTimeString() : '';
                          const screenshot = step.screenshotUrl;

                          return (
                            <div key={idx} className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5 flex flex-col md:flex-row gap-5 shadow-sm">
                              <div className="flex-1 space-y-3">
                                <div className="flex items-center gap-3">
                                  <span className="w-7 h-7 rounded-lg bg-[#818cf8] text-white flex items-center justify-center font-bold text-xs shrink-0">{order}</span>
                                  <div>
                                    <span className="text-[10px] font-bold tracking-wider text-[#818cf8] uppercase">{action}</span>
                                    <h4 className="text-sm font-semibold text-white mt-0.5">{action} on <strong className="text-[#c084fc] font-semibold">{label}</strong></h4>
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-4 text-xs text-[#a09dc0] pt-1">
                                  {url && (
                                    <span className="bg-[#0f0f12] border border-[#2e2e3a]/40 px-2 py-1 rounded truncate max-w-[300px]" title={url}>
                                      {url.replace(/^https?:\/\//, '')}
                                    </span>
                                  )}
                                  {date && <span className="flex items-center gap-1"><Activity className="w-3.5 h-3.5" /> {date}</span>}
                                </div>
                              </div>
                              {screenshot && (
                                <div
                                  onClick={() => setLightboxImg(screenshot)}
                                  className="w-full md:w-44 h-24 shrink-0 rounded-lg overflow-hidden border border-[#2e2e3a] cursor-zoom-in bg-[#0f0f12] flex items-center justify-center relative group"
                                >
                                  <img src={screenshot} alt={`step ${order}`} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" />
                                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-xs font-semibold text-white transition-opacity">Zoom</div>
                                </div>
                              )}
                            </div>
                          );
                        })
                      ) : (
                        <div className="p-12 text-center text-[#5f5c7a] italic">No steps recorded for this bug.</div>
                      )}
                    </div>
                  )}

                  {/* Failed Network Logs Panel */}
                  {detailTab === 'network' && (
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                        <input
                          type="text"
                          placeholder="Filter network logs by URL..."
                          className="flex-1 bg-[#1a1a22] border border-[#2e2e3a] rounded-lg px-4 py-2 text-sm text-[#f1f0ff] focus:outline-none focus:border-[#818cf8] transition-colors"
                          value={netSearch}
                          onChange={(e) => setNetSearch(e.target.value)}
                        />
                        <button
                          onClick={() => setShowFailedOnly(!showFailedOnly)}
                          className={`px-4 py-2 border rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                            showFailedOnly ? 'border-red-500/40 text-red-400 bg-red-500/10 hover:bg-red-500/20' : 'border-[#2e2e3a] text-[#a09dc0] hover:text-white bg-[#1a1a22]'
                          }`}
                        >
                          {showFailedOnly ? 'Showing Failed Only' : 'Showing All Requests'}
                        </button>
                      </div>
                      
                      {filteredNetLogs.length > 0 ? (
                        <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                          {filteredNetLogs.map((log: any, i: number) => (
                            <details key={i} className={`group bg-[#1a1a22] border rounded-lg overflow-hidden ${log.failed ? 'border-red-500/20' : 'border-[#2e2e3a]'}`}>
                              <summary className="list-none flex items-center justify-between p-4 cursor-pointer hover:bg-[#20202c]/50 transition-colors select-none">
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${log.method === 'POST' ? 'bg-emerald-500/20 text-emerald-400' : log.method === 'DELETE' ? 'bg-rose-500/20 text-rose-400' : 'bg-indigo-500/20 text-indigo-400'}`}>
                                    {log.method}
                                  </span>
                                  <span className="text-xs text-[#f1f0ff] truncate font-mono" title={log.url}>{log.url.replace(/^https?:\/\/[^/]+/, '')}</span>
                                </div>
                                <div className="flex items-center gap-4 shrink-0 font-mono text-xs">
                                  <span className={log.failed ? 'text-red-400 font-bold' : 'text-emerald-400'}>
                                    {log.failed ? `✕ ${log.errorText || 'Failed'}` : log.status}
                                  </span>
                                  {log.duration && <span className="text-[#5f5c7a]">{Math.round(log.duration)}ms</span>}
                                  <span className="text-[#5f5c7a] group-open:rotate-180 transition-transform">▼</span>
                                </div>
                              </summary>
                              <div className="p-4 border-t border-[#2e2e3a] bg-black/30 font-mono text-xs space-y-3">
                                <div>
                                  <span className="text-[#5f5c7a] uppercase font-bold block mb-1">Full URL:</span>
                                  <span className="text-[#a09dc0] break-all">{log.url}</span>
                                </div>
                                <div>
                                  <span className="text-[#5f5c7a] uppercase font-bold block mb-1">Response Body:</span>
                                  {log.responseBody ? (
                                    <pre className="bg-[#0f0f12] border border-[#2e2e3a]/50 p-3 rounded-lg overflow-x-auto text-[#e2e8f0] whitespace-pre-wrap max-h-[250px]">{log.responseBody}</pre>
                                  ) : (
                                    <span className="text-[#5f5c7a] italic">No response body captured.</span>
                                  )}
                                </div>
                              </div>
                            </details>
                          ))}
                        </div>
                      ) : (
                        <div className="p-12 text-center text-[#5f5c7a] italic">No matching network logs found.</div>
                      )}
                    </div>
                  )}

                  {/* Console Logs Panel */}
                  {detailTab === 'console' && (
                    <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                      {(selectedBug.console_logs || selectedBug.consoleLogs || []).length > 0 ? (
                        (selectedBug.console_logs || selectedBug.consoleLogs || []).map((log: any, i: number) => (
                          <div key={i} className={`flex items-start gap-4 p-3 rounded-lg border font-mono text-xs ${
                            log.type === 'error' || log.type === 'exception' ? 'bg-red-500/5 border-red-500/20 text-red-400' :
                            log.type === 'warn' ? 'bg-amber-500/5 border-amber-500/20 text-amber-400' :
                            'bg-[#1a1a22] border-[#2e2e3a] text-[#a09dc0]'
                          }`}>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 ${
                              log.type === 'error' || log.type === 'exception' ? 'bg-red-500/20' :
                              log.type === 'warn' ? 'bg-amber-500/20' :
                              'bg-indigo-500/20 text-indigo-400'
                            }`}>{log.type}</span>
                            <span className="break-all whitespace-pre-wrap">{log.text}</span>
                          </div>
                        ))
                      ) : (
                        <div className="p-12 text-center text-[#5f5c7a] italic">No console logs captured.</div>
                      )}
                    </div>
                  )}

                  {/* App Storage Panel */}
                  {detailTab === 'storage' && (
                    <div className="bg-[#1a1a22] border border-[#2e2e3a] rounded-xl p-5 overflow-x-auto max-h-[500px] overflow-y-auto">
                      <div className="space-y-1">
                        {highlightJson(selectedBug.storage_snapshot || selectedBug.storageSnapshot)}
                      </div>
                    </div>
                  )}

                </div>

              </div>

            </div>

          </div>
        </div>
      )}

      {/* Loading Overlay */}
      {isDetailsLoading && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#818cf8]"></div>
        </div>
      )}

      {/* Details Error Toast */}
      {detailsError && (
        <div className="fixed bottom-4 right-4 bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400 flex items-center gap-3 z-50 animate-in slide-in-from-bottom-5 duration-200">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
          {detailsError}
          <button onClick={() => setDetailsError(null)} className="text-red-400 hover:text-white ml-2">&times;</button>
        </div>
      )}

      {/* ─── Lightbox Zoom Modal ─── */}
      {lightboxImg && (
        <div
          onClick={() => setLightboxImg(null)}
          className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-4 cursor-zoom-out animate-in fade-in duration-200"
        >
          <button
            onClick={() => setLightboxImg(null)}
            className="absolute top-6 right-6 text-white/70 hover:text-white p-2 hover:bg-white/10 rounded-full transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={lightboxImg}
            alt="Enlarged preview"
            className="max-w-[95%] max-h-[90%] object-contain rounded-lg border border-[#2e2e3a]/60 shadow-2xl animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

    </main>
  );
}
