import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { config } from '../config.js';

const GenerateSchema = z.object({
  userOpenAiKey: z.string().optional(),
  steps: z.array(
    z.object({
      actionType: z.string(),
      elementLabel: z.string().optional(),
      pageUrl: z.string().optional(),
      valueMasked: z.string().optional(),
    })
  ).min(1).max(200),
});

const TriageSchema = z.object({
  userOpenAiKey: z.string().optional(),
  steps: z.array(
    z.object({
      actionType: z.string().optional(),
      elementLabel: z.string().optional(),
      pageUrl: z.string().optional(),
      valueMasked: z.string().optional(),
    })
  ).optional(),
  networkLogs: z.array(
    z.object({
      method: z.string().optional(),
      url: z.string().optional(),
      status: z.number().nullable().optional(),
      failed: z.boolean().optional(),
      errorText: z.string().optional(),
      responseBody: z.string().optional(),
    })
  ).optional(),
  consoleLogs: z.array(
    z.object({
      type: z.string().optional(),
      text: z.string().optional(),
      url: z.string().optional(),
      line: z.number().optional(),
    })
  ).optional(),
  bugUrl: z.string().optional(),
  testData: z.string().optional(),
});

export async function aiRoutes(app: FastifyInstance) {
  /**
   * POST /v1/ai/generate
   */
  app.post('/generate', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const body = GenerateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        type: 'https://bugbuddy.app/errors/validation-error',
        title: 'Validation Error',
        status: 400,
        errors: body.error.errors,
      });
    }

    const { steps, userOpenAiKey } = body.data;

    const apiKey = userOpenAiKey?.trim() || config.OPENAI_API_KEY;
    if (!apiKey) {
      // Fallback: Smart heuristic step deduplication and consolidation when offline / no key
      return reply.send(summarizeStepsHeuristically(steps));
    }

    const stepsText = steps.map((s, i) => {
      const action = s.actionType?.toUpperCase() ?? 'ACTION';
      const label = s.elementLabel ?? 'Unknown';
      const url = s.pageUrl ? ` (on ${s.pageUrl})` : '';
      const value = s.valueMasked && s.valueMasked !== '[REDACTED]' ? ` = "${s.valueMasked}"` : '';
      return `${i + 1}. ${action} on "${label}"${value}${url}`;
    }).join('\n');

    const prompt = `You are a Principal QA Engineer. Based on the following raw recorded user steps (which contain ${steps.length} raw micro-events like repetitive clicks, character inputs, and scroll events), produce a clean, concise, high-level Reproduction Steps list.

RAW CAPTURED EVENTS (${steps.length} total):
${stepsText}

REQUIREMENTS FOR STEP CONSOLIDATION:
1. CONSOLIDATION: If there are many raw granular steps (e.g. 10 to 50+ events), DO NOT list all 50 raw steps. Consolidate consecutive form field inputs, rapid double clicks, scroll noise, and page transitions into 4 to 8 high-level, human-readable reproduction steps (e.g., '1. Open Login page', '2. Enter username and password credentials', '3. Click Login button', '4. Observe error toast').
2. PRESERVE INTENT & CONTEXT: Do not lose key button targets, essential input values, or critical failure context.
3. NO NOISE: Do NOT include raw CSS selectors, HTML tags, full query string URLs, or debug noise.

Output a JSON object with exactly these fields:
- title: Short, specific bug title (max 80 chars, starting with a verb e.g. "Unable to submit registration form")
- description: Concise professional bug description (2-3 sentences explaining what happened, expected behavior, and user impact)
- suggestedSeverity: One of "P0", "P1", "P2", "P3", "P4"
- stepsSummary: A clean, consolidated numbered list string of 4 to 8 steps, separated by newline ('\n') characters.

Return ONLY valid JSON, no markdown.`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1000,
        }),
      });

      if (!response.ok) {
        request.log.warn({ status: response.status }, 'OpenAI API error, falling back to heuristic summarizer');
        return reply.send(summarizeStepsHeuristically(steps));
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return reply.send(summarizeStepsHeuristically(steps));
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        title?: string;
        description?: string;
        suggestedSeverity?: string;
        stepsSummary?: string;
      };

      return reply.send({
        title: parsed.title ?? '',
        description: parsed.description ?? '',
        suggestedSeverity: parsed.suggestedSeverity ?? 'P2',
        stepsSummary: parsed.stepsSummary ?? '',
      });
    } catch (err) {
      request.log.error({ err }, 'AI generation failed, using heuristic summary');
      return reply.send(summarizeStepsHeuristically(steps));
    }
  });

// ─── Offline Heuristic Step Summarizer ────────────────────────────────────────

type RawStepInput = { actionType?: string | undefined; elementLabel?: string | undefined; pageUrl?: string | undefined; valueMasked?: string | undefined };

function summarizeStepsHeuristically(steps: RawStepInput[]): { title: string; description: string; suggestedSeverity: string; stepsSummary: string } {
  if (steps.length === 0) {
    return { title: 'User Bug Report', description: 'Bug report recorded via BugLens.', suggestedSeverity: 'P2', stepsSummary: '1. Navigate to target URL.' };
  }

  const consolidated: string[] = [];
  let currentGroupType: string | null = null;
  let currentTargetLabel: string | null = null;

  for (const s of steps) {
    const action = (s.actionType ?? 'click').toLowerCase();
    const label = s.elementLabel ? s.elementLabel.trim() : 'element';
    const val = s.valueMasked && s.valueMasked !== '[REDACTED]' ? ` "${s.valueMasked}"` : '';

    if (action.includes('input') || action.includes('change') || action.includes('type')) {
      if (currentGroupType === 'input' && currentTargetLabel === label) {
        continue;
      }
      currentGroupType = 'input';
      currentTargetLabel = label;
      consolidated.push(`Enter${val} into "${label}" field`);
    } else if (action.includes('click')) {
      if (currentGroupType === 'click' && currentTargetLabel === label) {
        continue;
      }
      currentGroupType = 'click';
      currentTargetLabel = label;
      consolidated.push(`Click on "${label}"`);
    } else if (action.includes('navigate') || action.includes('url')) {
      currentGroupType = 'navigate';
      currentTargetLabel = s.pageUrl ?? label;
      consolidated.push(`Navigate to ${s.pageUrl ?? label}`);
    } else {
      currentGroupType = null;
      currentTargetLabel = null;
      consolidated.push(`Perform ${action} on "${label}"`);
    }
  }

  const finalSteps = consolidated.slice(0, 10);
  const stepsSummary = finalSteps.map((step, idx) => `${idx + 1}. ${step}`).join('\n');
  const lastStep = steps[steps.length - 1];
  const lastAction = lastStep?.elementLabel ? `on "${lastStep.elementLabel}"` : '';

  return {
    title: `Issue encountered during interaction ${lastAction}`,
    description: `Recorded session containing ${steps.length} interaction steps leading to an issue ${lastAction}.`,
    suggestedSeverity: 'P2',
    stepsSummary,
  };
}

  /**
   * POST /v1/ai/triage
   *
   * Analyzes console stacktraces, network failures, and captured user steps
   * to produce an AI root cause diagnosis and recommended developer fix.
   */
  app.post('/triage', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const body = TriageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        type: 'https://bugbuddy.app/errors/validation-error',
        title: 'Validation Error',
        status: 400,
        errors: body.error.errors,
      });
    }

    const { steps = [], networkLogs = [], consoleLogs = [], bugUrl, testData } = body.data;

    // Helper: Heuristic offline triage analysis fallback
    const runHeuristicTriage = () => {
      const failedRequests = networkLogs.filter(n => n.failed || (n.status && n.status >= 400));
      const consoleErrors = consoleLogs.filter(c => c.type === 'error' || c.type === 'exception');

      if (failedRequests.length > 0) {
        const topErr = failedRequests[0]!;
        const status = topErr.status;
        let rootCause = `HTTP Network Failure on ${topErr.method || 'GET'} ${topErr.url ? new URL(topErr.url, 'http://localhost').pathname : 'endpoint'}`;
        let technicalSummary = `The application attempted to send a network request to '${topErr.url}' which failed with status ${status ?? 'Connection Error'}. ${topErr.errorText ? `Error details: ${topErr.errorText}.` : ''}`;
        let affectedComponent = 'BACKEND';
        let suggestedFix = 'Check API endpoint availability, authentication headers, and database connection pools.';

        if (status === 500) {
          rootCause = `Internal Server Error (HTTP 500) on ${topErr.method || 'API'} request`;
          technicalSummary = `The backend API server encountered an unhandled error while processing the request to ${topErr.url}. ${topErr.responseBody ? `Response snippet: ${topErr.responseBody.slice(0, 300)}` : ''}`;
          suggestedFix = 'Inspect server error logs around the request timestamp and verify database query constraints.';
        } else if (status === 401 || status === 403) {
          rootCause = `Unauthorized / Forbidden Request (HTTP ${status})`;
          technicalSummary = `Access to ${topErr.url} was denied due to missing or expired authorization headers or invalid permissions.`;
          affectedComponent = 'EXTERNAL_API';
          suggestedFix = 'Verify user session tokens, JWT validity, and RBAC authorization middleware scopes.';
        } else if (status === 404) {
          rootCause = `Endpoint Not Found (HTTP 404)`;
          technicalSummary = `The requested route '${topErr.url}' does not exist on the destination server.`;
          suggestedFix = 'Check client URL routing path and verify backend route registration.';
        } else if (!status || topErr.failed) {
          rootCause = `CORS or Network Disconnection Error`;
          technicalSummary = `Browser blocked or failed the network request to ${topErr.url}. Likely caused by CORS policy headers or SSL validation issues.`;
          affectedComponent = 'FRONTEND';
          suggestedFix = 'Verify Access-Control-Allow-Origin headers on the backend server and ensure proper CORS preflight handling.';
        }

        return {
          rootCause,
          technicalSummary,
          suggestedFix,
          affectedComponent,
          confidenceScore: 88,
        };
      }

      if (consoleErrors.length > 0) {
        const topConsole = consoleErrors[0]!;
        return {
          rootCause: `Frontend Uncaught Exception: ${topConsole.text ? topConsole.text.slice(0, 100) : 'JavaScript Error'}`,
          technicalSummary: `An uncaught error was triggered in the frontend application runtime: "${topConsole.text}" ${topConsole.url ? `at ${topConsole.url}:${topConsole.line}` : ''}`,
          suggestedFix: 'Add null-coalescing check, verify state initialization before dereferencing properties, or wrap rendering logic in a React Error Boundary.',
          affectedComponent: 'FRONTEND',
          confidenceScore: 85,
        };
      }

      return {
        rootCause: `Unexpected Behavior on "${steps[steps.length - 1]?.elementLabel || 'Page Element'}"`,
        technicalSummary: `User executed ${steps.length} interaction step(s). No network failure or console exception was logged, indicating a visual or workflow state logic issue.`,
        suggestedFix: 'Review frontend UI state handlers and conditional rendering logic for the targeted interaction component.',
        affectedComponent: 'FRONTEND',
        confidenceScore: 75,
      };
    };

    const apiKey = body.data.userOpenAiKey?.trim() || config.OPENAI_API_KEY;
    if (!apiKey) {
      return reply.send(runHeuristicTriage());
    }

    const stepsText = steps.map((s, i) => `${i + 1}. ${s.actionType || 'ACTION'} on "${s.elementLabel || 'Element'}"`).join('\n');
    const netText = networkLogs.filter(n => n.failed || (n.status && n.status >= 400)).map(n => `${n.method || 'GET'} ${n.url} (Status: ${n.status ?? 'Failed'}) — Error: ${n.errorText || 'N/A'}`).join('\n');
    const consoleText = consoleLogs.filter(c => c.type === 'error' || c.type === 'exception').map(c => `[${(c.type || 'ERROR').toUpperCase()}] ${c.text || ''}`).join('\n');

    const prompt = `You are an expert Principal Software Architect doing Automated Root Cause Analysis on a recorded software bug.

CONTEXT:
URL: ${bugUrl || 'N/A'}
Captured Reproduction Steps:
${stepsText || 'None'}

Failed Network Requests:
${netText || 'None'}

Console Log Errors & Exceptions:
${consoleText || 'None'}

Test Data Provided:
${testData || 'None'}

Analyze the failure evidence and return a JSON object with:
- rootCause: Concise 1-sentence identification of the primary root cause.
- technicalSummary: 2-3 sentence technical explanation of what went wrong.
- suggestedFix: Specific code or configuration fix recommendation for developers.
- affectedComponent: Must be one of "FRONTEND", "BACKEND", or "EXTERNAL_API".
- confidenceScore: Integer percentage from 50 to 99 representing diagnosis confidence.

Return ONLY valid JSON, no markdown formatting.`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 800,
        }),
      });

      if (!response.ok) {
        return reply.send(runHeuristicTriage());
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return reply.send(runHeuristicTriage());

      const parsed = JSON.parse(jsonMatch[0]);
      return reply.send({
        rootCause: parsed.rootCause || 'Unspecified runtime error',
        technicalSummary: parsed.technicalSummary || 'Issue occurred during user step execution.',
        suggestedFix: parsed.suggestedFix || 'Inspect developer console logs.',
        affectedComponent: parsed.affectedComponent || 'FRONTEND',
        confidenceScore: typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : 85,
      });
    } catch {
      return reply.send(runHeuristicTriage());
    }
  });
}
