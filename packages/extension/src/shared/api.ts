/**
 * BugBuddy — Extension Typed API Client
 *
 * Provides strongly-typed async wrappers around chrome.runtime.sendMessage
 * so that popup, sidepanel, and devtools never send raw message strings.
 *
 * All functions return a typed result or throw with a descriptive error.
 */

import type { CreateSession } from '@bugbuddy/shared';

// ─── Generic message sender ───────────────────────────────────────────────────

function sendMessage<T>(message: { type: string; payload?: unknown }): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response as T);
    });
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function login(): Promise<{ success: boolean; error?: string }> {
  return sendMessage({ type: 'LOGIN' });
}

export async function logout(): Promise<{ success: boolean }> {
  return sendMessage({ type: 'LOGOUT' });
}

export async function getAuthState(): Promise<{ isAuthenticated: boolean }> {
  return sendMessage({ type: 'GET_AUTH' });
}

// ─── Recording State ──────────────────────────────────────────────────────────

export interface RecordingState {
  sessionId: string | null;
  isPaused: boolean;
  stepCount: number;
  isAuthenticated: boolean;
}

export async function getRecordingState(): Promise<RecordingState> {
  return sendMessage({ type: 'GET_RECORDING_STATE' });
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function startSession(
  payload: CreateSession
): Promise<{ sessionId: string } | { error: string; status?: number }> {
  return sendMessage({ type: 'START_SESSION', payload });
}

export async function endSession(status: 'COMPLETED' | 'ABANDONED'): Promise<{ success: boolean }> {
  return sendMessage({ type: 'END_SESSION', payload: { status } });
}

export async function pauseRecording(): Promise<{ paused: boolean }> {
  return sendMessage({ type: 'PAUSE_RECORDING' });
}

export async function resumeRecording(): Promise<{ paused: boolean }> {
  return sendMessage({ type: 'RESUME_RECORDING' });
}

// ─── Session Data ─────────────────────────────────────────────────────────────

export interface SessionEvent {
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

export interface NetworkLog {
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
  responseBody?: string;
}

export async function getSessionEvents(): Promise<{
  sessionId: string | null;
  events: SessionEvent[];
}> {
  return sendMessage({ type: 'GET_SESSION_EVENTS' });
}

export async function getScreenshots(): Promise<{
  screenshots: Record<number, string>;
  sessionId: string | null;
}> {
  return sendMessage({ type: 'GET_SCREENSHOTS' });
}

export async function clearScreenshots(): Promise<{ success: boolean }> {
  return sendMessage({ type: 'CLEAR_SCREENSHOTS' });
}

export async function deleteScreenshot(stepIndex: number): Promise<{ success: boolean }> {
  return sendMessage({ type: 'DELETE_SCREENSHOT', payload: { stepIndex } });
}

export async function getNetworkLogs(): Promise<{
  logs: NetworkLog[];
  sessionId: string | null;
}> {
  return sendMessage({ type: 'GET_NETWORK_LOGS' });
}

// ─── Screenshot Capture ───────────────────────────────────────────────────────

export async function captureScreenshot(
  tabId?: number
): Promise<{ dataUrl: string; stepIndex: number } | { error: string }> {
  return sendMessage({ type: 'CAPTURE_SCREENSHOT', payload: { tabId } });
}

// ─── AI Generation ────────────────────────────────────────────────────────────

export interface AIGeneratedContent {
  title: string;
  description: string;
  suggestedSeverity: string;
}

export async function generateAIContent(
  steps: SessionEvent[],
  screenshots: Record<number, string>
): Promise<AIGeneratedContent | { error: string }> {
  return sendMessage({ type: 'GENERATE_AI_CONTENT', payload: { steps, screenshots } });
}

// ─── Bug Submission ───────────────────────────────────────────────────────────

export interface CreateBugPayload {
  sessionId: string;
  title: string;
  description?: string;
  severity: string;
  reproductionConfidence?: number;
  steps: Array<{
    order: number;
    actionType: string;
    elementLabel: string;
    timestamp: string;
    valueMasked?: string;
    cssSelector?: string;
    pageUrl?: string;
    pageTitle?: string;
  }>;
  attachments?: Array<{ stepIndex: number; dataUrl: string }>;
  networkLogs?: NetworkLog[];
}

export async function submitBug(payload: CreateBugPayload): Promise<{ data: { id: string } } | { error: string; status?: number }> {
  return sendMessage({
    type: 'API_REQUEST',
    payload: { url: '/v1/bugs', options: { method: 'POST', body: JSON.stringify(payload) } },
  });
}

// ─── Integrations ─────────────────────────────────────────────────────────────

export async function createJiraIssue(payload: unknown): Promise<unknown> {
  return sendMessage({ type: 'CREATE_JIRA_ISSUE', payload });
}

export async function createAzureWorkItem(payload: unknown): Promise<unknown> {
  return sendMessage({ type: 'CREATE_AZURE_WORK_ITEM', payload });
}

export async function sendSlackNotification(payload: unknown): Promise<unknown> {
  return sendMessage({ type: 'SEND_SLACK_NOTIFICATION', payload });
}

// ─── Side Panel ───────────────────────────────────────────────────────────────

export async function openSidePanel(): Promise<{ success: boolean }> {
  return sendMessage({ type: 'OPEN_SIDE_PANEL' });
}

// ─── Report Download ──────────────────────────────────────────────────────────

export async function downloadReport(reportData: unknown, filename: string): Promise<{ success: boolean }> {
  return sendMessage({ type: 'DOWNLOAD_REPORT', payload: { reportData, filename } });
}
