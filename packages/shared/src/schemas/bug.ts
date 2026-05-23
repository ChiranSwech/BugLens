import { z } from 'zod';

// ─── Enumerations ─────────────────────────────────────────────────────────────

export const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3', 'P4']);
export type Severity = z.infer<typeof SeveritySchema>;

export const BugStatusSchema = z.enum([
  'OPEN',
  'IN_PROGRESS',
  'NEEDS_CLARIFICATION',
  'RESOLVED',
  'WONT_FIX',
  'DUPLICATE',
]);
export type BugStatus = z.infer<typeof BugStatusSchema>;

// ─── Step ─────────────────────────────────────────────────────────────────────

export const StepActionTypeSchema = z.enum([
  'CLICK',
  'INPUT',
  'SCROLL',
  'NAVIGATE',
  'FOCUS',
  'BLUR',
  'SCREENSHOT',
  'ANNOTATION',
  'PAUSE',
  'RESUME',
  'NETWORK_FAILURE',
  'CONSOLE_ERROR',
  'HOVER',
]);
export type StepActionType = z.infer<typeof StepActionTypeSchema>;

export const StepSchema = z.object({
  id: z.string().uuid().optional(),
  bugId: z.string().uuid().optional(),
  order: z.number().int().nonnegative(),
  actionType: StepActionTypeSchema,
  /** Human-readable label derived from aria-label / visible text / role */
  elementLabel: z.string().max(500),
  /** CSS selector for the element (best-effort) */
  cssSelector: z.string().max(2000).optional(),
  /** XPath for the element (fallback) */
  xPath: z.string().max(2000).optional(),
  /** Masked value — passwords and PII replaced with [REDACTED] */
  valueMasked: z.string().max(1000).optional(),
  screenshotId: z.string().uuid().optional(),
  /** ISO 8601 timestamp */
  timestamp: z.string().datetime(),
  /** QA annotation: was this step expected to fail? */
  failureType: z.enum(['EXPECTED', 'UNEXPECTED', 'NONE']).default('NONE'),
  /** Edited description (overrides auto-generated elementLabel) */
  editedDescription: z.string().max(1000).optional(),
});
export type Step = z.infer<typeof StepSchema>;

// ─── Bug ──────────────────────────────────────────────────────────────────────

export const AttachmentDataSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  /** Base64 data URL from chrome.tabs.captureVisibleTab */
  dataUrl: z.string().max(5_000_000).startsWith('data:image/'),
});
export type AttachmentData = z.infer<typeof AttachmentDataSchema>;

export const NetworkLogSchema = z.object({
  id: z.string().max(100),
  method: z.string().max(10),
  url: z.string().max(20_000),
  status: z.number().nullable(),
  statusText: z.string().max(100).nullable().optional(),
  type: z.string().max(50),
  duration: z.number().nullable(),
  startTime: z.number(),
  requestHeaders: z.record(z.string()).optional(),
  responseHeaders: z.record(z.string()).optional(),
  failed: z.boolean(),
  errorText: z.string().max(500).optional(),
  requestBody: z.string().optional(),
  responseBody: z.string().optional(),
});
export type NetworkLog = z.infer<typeof NetworkLogSchema>;

export const ConsoleLogSchema = z.object({
  type: z.enum(['log', 'warn', 'error', 'info', 'debug', 'exception']),
  text: z.string().max(5000),
  url: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  timestamp: z.number(),
});
export type ConsoleLog = z.infer<typeof ConsoleLogSchema>;

export const CreateBugSchema = z.object({
  sessionId: z.string().uuid(),
  title: z
    .string()
    .min(5, 'Title must be at least 5 characters')
    .max(300, 'Title must be under 300 characters')
    .trim(),
  description: z.string().max(10_000).trim().optional(),
  severity: SeveritySchema.default('P2'),
  /** Automatically computed by the recording engine */
  reproductionConfidence: z.number().min(0).max(100).optional(),
  steps: z.array(StepSchema).min(1, 'At least one step is required'),
  templateProfileId: z.string().uuid().optional(),
  /** Base64 screenshots sent directly from the extension (max 20 per bug) */
  attachments: z.array(AttachmentDataSchema).max(20).optional(),
  /** Failed network requests to attach for debugging (max 50) */
  networkLogs: z.array(NetworkLogSchema).max(50).optional(),
  /** Explicit integrations to dispatch to (e.g., 'jira', 'slack') */
  integrations: z.array(z.string()).optional(),
  expectedResult: z.string().max(5000).optional(),
  actualResult: z.string().max(5000).optional(),
  consoleLogs: z.array(ConsoleLogSchema).max(100).optional(),
  storageSnapshot: z.record(z.string(), z.any()).optional(),
  bugUrl: z.string().max(2000).optional(),
  testData: z.string().max(5000).optional(),
  mainImageIndex: z.number().int().nonnegative().nullable().optional(),
});
export type CreateBug = z.infer<typeof CreateBugSchema>;

export const BugSchema = CreateBugSchema.extend({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  reporterId: z.string().uuid(),
  status: BugStatusSchema.default('OPEN'),
  assigneeId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable().optional(),
});
export type Bug = z.infer<typeof BugSchema>;

export const UpdateBugSchema = z.object({
  title: z.string().min(5).max(300).trim().optional(),
  description: z.string().max(10_000).trim().optional(),
  severity: SeveritySchema.optional(),
  status: BugStatusSchema.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});
export type UpdateBug = z.infer<typeof UpdateBugSchema>;

// ─── Bug list query params ─────────────────────────────────────────────────────

export const BugListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: BugStatusSchema.optional(),
  severity: SeveritySchema.optional(),
  reporterId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().max(200).optional(),
});
export type BugListQuery = z.infer<typeof BugListQuerySchema>;
