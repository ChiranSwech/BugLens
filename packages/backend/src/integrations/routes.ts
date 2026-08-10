import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { config } from '../config.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const SlackSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  severity: z.string().optional(),
  channel: z.string().optional(), // e.g. '#bugs' — used as display hint only; webhook determines real channel
  bugUrl: z.string().url().optional(),
  stepCount: z.number().int().nonnegative().optional(),
  userSlackWebhook: z.string().optional(),
});

const JiraSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(32000).optional(),
  severity: z.string().optional(),
  issueType: z.enum(['Bug', 'Task', 'Story', 'Improvement']).default('Bug'),
  priority: z.enum(['Highest', 'High', 'Medium', 'Low', 'Lowest']).default('Medium'),
  labels: z.array(z.string()).max(10).optional(),
  assignee: z.string().optional(),
  userJiraUrl: z.string().optional(),
  userJiraEmail: z.string().optional(),
  userJiraToken: z.string().optional(),
  userJiraProject: z.string().optional(),
});

const AzureSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(32000).optional(),
  severity: z.string().optional(),
  workItemType: z.enum(['Bug', 'Task', 'User Story', 'Feature']).default('Bug'),
  priority: z.number().int().min(1).max(4).default(2),
  assignee: z.string().optional(),
  userAzureOrg: z.string().optional(),
  userAzureProject: z.string().optional(),
  userAzurePat: z.string().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function severityToJiraPriority(sev?: string): string {
  const map: Record<string, string> = {
    P0: 'Highest', P1: 'High', P2: 'Medium', P3: 'Low', P4: 'Lowest',
  };
  return map[sev ?? ''] ?? 'Medium';
}

function severityToAzurePriority(sev?: string): number {
  const map: Record<string, number> = {
    P0: 1, P1: 1, P2: 2, P3: 3, P4: 4,
  };
  return map[sev ?? ''] ?? 2;
}

function severityEmoji(sev?: string): string {
  const map: Record<string, string> = {
    P0: '🔴', P1: '🟠', P2: '🟡', P3: '🔵', P4: '⚪',
  };
  return map[sev ?? ''] ?? '🟡';
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function integrationRoutes(app: FastifyInstance) {
  // ── Slack ──────────────────────────────────────────────────────────────────
  app.post('/slack', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const body = SlackSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ status: 400, errors: body.error.errors });
    }

    const { title, description, severity, channel, bugUrl, stepCount, userSlackWebhook } = body.data;
    const webhookUrl = userSlackWebhook?.trim() || config.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      return reply.status(503).send({
        type: 'https://bugbuddy.app/errors/not-configured',
        title: 'Slack not configured',
        status: 503,
        detail: 'Configure Slack Webhook URL in your Extension Settings or backend .env.',
      });
    }

    const emoji = severityEmoji(severity);
    const channelHint = channel ? ` → ${channel}` : '';

    const slackPayload = {
      text: `${emoji} *New Bug Reported${channelHint}*`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${emoji} ${title}`, emoji: true },
        },
        ...(description ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: description.slice(0, 500) },
        }] : []),
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Severity:*\n${severity ?? 'P2'}` },
            ...(stepCount !== undefined ? [{ type: 'mrkdwn', text: `*Steps:*\n${stepCount}` }] : []),
          ],
        },
        ...(bugUrl ? [{
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '🐛 View Bug Report', emoji: true },
            url: bugUrl,
            style: 'primary',
          }],
        }] : []),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Reported via *BugBuddy* · ${new Date().toUTCString()}` }],
        },
      ],
    };

    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackPayload),
      });

      if (!resp.ok) {
        const text = await resp.text();
        request.log.error({ status: resp.status, body: text }, 'Slack webhook error');
        return reply.status(502).send({ status: 502, detail: `Slack returned: ${text}` });
      }

      return reply.send({ success: true, integration: 'slack' });
    } catch (err) {
      request.log.error({ err }, 'Slack notification failed');
      return reply.status(500).send({ status: 500 });
    }
  });

  // ── Jira ───────────────────────────────────────────────────────────────────
  app.post('/jira', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const body = JiraSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ status: 400, errors: body.error.errors });
    }

    const { title, description, severity, issueType, priority, labels, assignee, userJiraUrl, userJiraEmail, userJiraToken, userJiraProject } = body.data;

    let JIRA_BASE_URL = (userJiraUrl?.trim() || config.JIRA_BASE_URL).replace(/\/+$/, '');
    if (JIRA_BASE_URL && !JIRA_BASE_URL.startsWith('http://') && !JIRA_BASE_URL.startsWith('https://')) {
      JIRA_BASE_URL = `https://${JIRA_BASE_URL}`;
    }
    const JIRA_EMAIL = userJiraEmail?.trim() || config.JIRA_EMAIL;
    const JIRA_API_TOKEN = userJiraToken?.trim() || config.JIRA_API_TOKEN;
    const JIRA_PROJECT_KEY = (userJiraProject?.trim() || config.JIRA_PROJECT_KEY).toUpperCase();

    const missingKeys: string[] = [];
    if (!JIRA_BASE_URL) missingKeys.push('JIRA_BASE_URL');
    if (!JIRA_EMAIL) missingKeys.push('JIRA_EMAIL');
    if (!JIRA_API_TOKEN) missingKeys.push('JIRA_API_TOKEN');
    if (!JIRA_PROJECT_KEY) missingKeys.push('JIRA_PROJECT_KEY');

    if (missingKeys.length > 0) {
      return reply.status(503).send({
        type: 'https://bugbuddy.app/errors/not-configured',
        title: 'Jira not configured',
        status: 503,
        detail: `Missing Jira key(s): ${missingKeys.join(', ')}. Please configure your personal Jira credentials in Extension Settings or backend .env.`,
      });
    }

    const effectivePriority = priority ?? severityToJiraPriority(severity);
    const jiraLabels = ['bugbuddy', ...(severity ? [severity.toLowerCase()] : []), ...(labels ?? [])];

    const jiraPayload: Record<string, unknown> = {
      fields: {
        project: { key: JIRA_PROJECT_KEY },
        summary: title,
        issuetype: { name: issueType },
        priority: { name: effectivePriority },
        labels: jiraLabels,
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: description ?? title }],
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: `\nReported via BugBuddy | Severity: ${severity ?? 'P2'}` }],
            },
          ],
        },
      },
    };

    if (assignee) {
      (jiraPayload['fields'] as Record<string, unknown>)['assignee'] = { accountId: assignee };
    }

    const credentials = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

    try {
      const resp = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(jiraPayload),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        request.log.error({ status: resp.status, body: errBody }, 'Jira API error');
        return reply.status(502).send({ status: 502, detail: `Jira returned ${resp.status}: ${errBody.slice(0, 200)}` });
      }

      const data = await resp.json() as { id: string; key: string; self: string };
      return reply.status(201).send({
        success: true,
        integration: 'jira',
        issueKey: data.key,
        issueUrl: `${JIRA_BASE_URL}/browse/${data.key}`,
      });
    } catch (err) {
      request.log.error({ err }, 'Jira issue creation failed');
      return reply.status(500).send({ status: 500 });
    }
  });

  // ── Azure DevOps ───────────────────────────────────────────────────────────
  app.post('/azure-devops', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const body = AzureSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ status: 400, errors: body.error.errors });
    }

    const { title, description, severity, workItemType, priority, assignee, userAzureOrg, userAzureProject, userAzurePat } = body.data;

    const AZURE_ORG = userAzureOrg?.trim() || config.AZURE_ORG;
    const AZURE_PROJECT = userAzureProject?.trim() || config.AZURE_PROJECT;
    const AZURE_PAT = userAzurePat?.trim() || config.AZURE_PAT;

    const missingKeys: string[] = [];
    if (!AZURE_ORG) missingKeys.push('AZURE_ORG');
    if (!AZURE_PROJECT) missingKeys.push('AZURE_PROJECT');
    if (!AZURE_PAT) missingKeys.push('AZURE_PAT');

    if (missingKeys.length > 0) {
      return reply.status(503).send({
        type: 'https://bugbuddy.app/errors/not-configured',
        title: 'Azure DevOps not configured',
        status: 503,
        detail: `Missing Azure key(s): ${missingKeys.join(', ')}. Configure your Azure DevOps credentials in Extension Settings or backend .env.`,
      });
    }

    const effectivePriority = priority ?? severityToAzurePriority(severity);
    const encodedType = encodeURIComponent(workItemType);
    const encodedProject = encodeURIComponent(AZURE_PROJECT);
    const apiUrl = `https://dev.azure.com/${AZURE_ORG}/${encodedProject}/_apis/wit/workitems/$${encodedType}?api-version=7.1`;

    const patchDoc: Array<{ op: string; path: string; value: unknown }> = [
      { op: 'add', path: '/fields/System.Title', value: title },
      { op: 'add', path: '/fields/System.Description', value: description ?? title },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: effectivePriority },
      { op: 'add', path: '/fields/System.Tags', value: `BugBuddy; ${severity ?? 'P2'}` },
    ];

    if (assignee) {
      patchDoc.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignee });
    }

    const credentials = Buffer.from(`:${AZURE_PAT}`).toString('base64');

    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json-patch+json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(patchDoc),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        request.log.error({ status: resp.status, body: errBody }, 'Azure DevOps API error');
        return reply.status(502).send({ status: 502, detail: `Azure returned ${resp.status}: ${errBody.slice(0, 200)}` });
      }

      const data = await resp.json() as { id: number; _links?: { html?: { href?: string } } };
      return reply.status(201).send({
        success: true,
        integration: 'azure-devops',
        workItemId: data.id,
        workItemUrl: data._links?.html?.href,
      });
    } catch (err) {
      request.log.error({ err }, 'Azure DevOps work item creation failed');
      return reply.status(500).send({ status: 500 });
    }
  });
}
