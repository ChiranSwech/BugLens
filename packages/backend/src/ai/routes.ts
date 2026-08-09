import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { config } from '../config.js';

const GenerateSchema = z.object({
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
    const apiKey = config.OPENAI_API_KEY;
    if (!apiKey) {
      return reply.status(503).send({
        type: 'https://bugbuddy.app/errors/not-configured',
        title: 'AI generation not configured',
        status: 503,
        detail: 'Set OPENAI_API_KEY in the backend .env to enable AI title/description generation.',
      });
    }

    const body = GenerateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        type: 'https://bugbuddy.app/errors/validation-error',
        title: 'Validation Error',
        status: 400,
        errors: body.error.errors,
      });
    }

    const { steps } = body.data;

    const stepsText = steps.map((s, i) => {
      const action = s.actionType?.toUpperCase() ?? 'ACTION';
      const label = s.elementLabel ?? 'Unknown';
      const url = s.pageUrl ? ` (on ${s.pageUrl})` : '';
      const value = s.valueMasked && s.valueMasked !== '[REDACTED]' ? ` = "${s.valueMasked}"` : '';
      return `${i + 1}. ${action} on "${label}"${value}${url}`;
    }).join('\n');

    const prompt = `You are a QA engineer writing a professional bug report. Based on the following user steps captured during a bug recording session, generate a concise bug report.

Reproduction Steps:
${stepsText}

Output a JSON object with exactly these fields:
- title: A short, specific bug title (max 80 chars, start with a verb like "Unable to", "Error when", "Button fails to")
- description: A professional description (2-3 sentences: what happened, what was expected, what impact it has)
- suggestedSeverity: One of "P0", "P1", "P2", "P3", "P4" based on severity
- stepsSummary: A string containing reproduction steps formatted as a professional numbered list, with each step on a separate line (using newline '\n' characters), written exactly how a real manual tester writes them. Each step must be clear, natural, and concise. Do NOT include any URLs, raw page paths, query parameters, HTML selectors, or technical debug info.

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
        const errText = await response.text();
        request.log.error({ status: response.status, body: errText }, 'OpenAI API error');
        return reply.status(502).send({
          type: 'https://bugbuddy.app/errors/upstream-error',
          title: 'OpenAI API error',
          status: 502,
          detail: `OpenAI returned ${response.status}`,
        });
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return reply.status(502).send({
          type: 'https://bugbuddy.app/errors/upstream-error',
          title: 'AI returned unexpected format',
          status: 502,
        });
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
      request.log.error({ err }, 'AI generation failed');
      return reply.status(500).send({
        type: 'https://bugbuddy.app/errors/internal-error',
        title: 'AI generation failed',
        status: 500,
      });
    }
  });

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

    const apiKey = config.OPENAI_API_KEY;
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
