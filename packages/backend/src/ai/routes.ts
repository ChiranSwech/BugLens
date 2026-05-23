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

export async function aiRoutes(app: FastifyInstance) {
  /**
   * POST /v1/ai/generate
   *
   * Accepts recorded steps and uses OpenAI (server-side) to generate a
   * professional bug title, description, and suggested severity.
   * The OpenAI API key is stored in the backend .env — never sent to the browser.
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
}
