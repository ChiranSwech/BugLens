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
  url: z.string().optional(),
  expectedResult: z.string().optional(),
  actualResult: z.string().optional(),
  testSummary: z.string().optional(),
  steps: z.array(z.any()).optional(),
  networkLogs: z.array(z.any()).optional(),
  consoleLogs: z.array(z.any()).optional(),
  storageSnapshot: z.any().optional(),
  deviceFingerprint: z.any().optional(),
  screenshot: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
  triageResult: z.any().optional(),
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
  triageResult: z.any().optional(),
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

function buildJiraADFDoc(data: {
  description?: string | undefined;
  expectedResult?: string | undefined;
  actualResult?: string | undefined;
  url?: string | undefined;
  testSummary?: string | undefined;
  steps?: any[] | undefined;
  networkLogs?: any[] | undefined;
  consoleLogs?: any[] | undefined;
  storageSnapshot?: any;
  deviceFingerprint?: any;
  triageResult?: any;
  severity?: string | undefined;
}) {
  const content: any[] = [];

  // Description
  if (data.description) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: data.description }],
    });
  }

  // AI Root Cause Triage
  if (data.triageResult) {
    const tr = data.triageResult;
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: '🧠 AI Root Cause Triage' }],
    });
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Affected Component: ', marks: [{ type: 'strong' }] },
        { type: 'text', text: tr.affectedComponent || 'N/A' },
        { type: 'text', text: ' | ' },
        { type: 'text', text: 'Root Cause: ', marks: [{ type: 'strong' }] },
        { type: 'text', text: tr.rootCause || 'N/A' },
      ],
    });
    if (tr.technicalSummary) {
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Technical Summary: ', marks: [{ type: 'strong' }] },
          { type: 'text', text: tr.technicalSummary },
        ],
      });
    }
    if (tr.suggestedFix) {
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Recommended Fix: ', marks: [{ type: 'strong' }] },
          { type: 'text', text: tr.suggestedFix },
        ],
      });
    }
  }

  // Expected & Actual Results
  if (data.expectedResult || data.actualResult) {
    const resNodes: any[] = [];
    if (data.expectedResult) {
      resNodes.push({ type: 'text', text: 'Expected Result: ', marks: [{ type: 'strong' }] });
      resNodes.push({ type: 'text', text: `${data.expectedResult}\n` });
    }
    if (data.actualResult) {
      resNodes.push({ type: 'text', text: 'Actual Result: ', marks: [{ type: 'strong' }] });
      resNodes.push({ type: 'text', text: data.actualResult });
    }
    content.push({
      type: 'paragraph',
      content: resNodes,
    });
  }

  // Target URL
  if (data.url) {
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Target URL: ', marks: [{ type: 'strong' }] },
        { type: 'text', text: data.url, marks: [{ type: 'link', attrs: { href: data.url } }] },
      ],
    });
  }

  // Reproduction Steps
  if ((data.steps && data.steps.length > 0) || data.testSummary) {
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: '📋 Reproduction Steps' }],
    });

    if (data.steps && data.steps.length > 0) {
      const stepItems = data.steps.map((s: any, idx: number) => {
        const order = s.order || idx + 1;
        const action = (s.action_type || s.actionType || 'CLICK').toUpperCase();
        const target = s.element_label || s.elementLabel || 'element';
        const val = s.value_masked || s.valueMasked;
        let stepText = `${order}. ${action} on "${target}"`;
        if (val && val !== '[REDACTED]') stepText += ` (Value: "${val}")`;
        if (s.pageUrl || s.page_url) stepText += ` [${s.pageUrl || s.page_url}]`;
        return stepText;
      });
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: stepItems.join('\n') }],
      });
    }

    if (data.testSummary) {
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: data.testSummary }],
      });
    }
  }

  // Network Logs
  if (data.networkLogs && data.networkLogs.length > 0) {
    const logsToInclude = data.networkLogs.filter((l: any) => l.failed || (l.status && l.status >= 400) || l.errorText);
    const targetLogs = logsToInclude.length > 0 ? logsToInclude : data.networkLogs.slice(0, 10);
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: '🌐 Network Log Evidence' }],
    });
    const logLines = targetLogs.map((l: any) => {
      let line = `[${l.method || 'GET'}] ${l.url} -> Status: ${l.status || 'FAILED'}`;
      if (l.responseBody) {
        const bodyStr = typeof l.responseBody === 'string' ? l.responseBody : JSON.stringify(l.responseBody);
        line += `\nResponse Payload: ${bodyStr.slice(0, 400)}`;
      }
      return line;
    }).join('\n\n');

    content.push({
      type: 'codeBlock',
      attrs: { language: 'json' },
      content: [{ type: 'text', text: logLines }],
    });
  }

  // Console Logs
  if (data.consoleLogs && data.consoleLogs.length > 0) {
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: '🚨 Console Error Logs' }],
    });
    const errText = data.consoleLogs.map((l: any) => typeof l === 'string' ? l : `[${(l.type || 'LOG').toUpperCase()}] ${l.text || l.message || JSON.stringify(l)}`).join('\n');
    content.push({
      type: 'codeBlock',
      attrs: { language: 'bash' },
      content: [{ type: 'text', text: errText.slice(0, 2000) }],
    });
  }

  // App Storage
  if (data.storageSnapshot && Object.keys(data.storageSnapshot).length > 0) {
    content.push({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: '💾 Storage Snapshot' }],
    });
    content.push({
      type: 'codeBlock',
      attrs: { language: 'json' },
      content: [{ type: 'text', text: JSON.stringify(data.storageSnapshot, null, 2).slice(0, 2000) }],
    });
  }

  // Device Details Footer
  if (data.deviceFingerprint) {
    const df = data.deviceFingerprint;
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: `\nDevice Environment: OS: ${df.os || 'N/A'} | Browser: ${df.browser || 'N/A'} | Resolution: ${df.resolution || 'N/A'}` },
      ],
    });
  }

  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: `\nReported via BugLens | Severity: ${data.severity ?? 'P2'}` }],
  });

  return {
    type: 'doc',
    version: 1,
    content,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────


function buildAzureHTMLDoc(data: {
  description?: string | undefined;
  expectedResult?: string | undefined;
  actualResult?: string | undefined;
  url?: string | undefined;
  testSummary?: string | undefined;
  steps?: any[] | undefined;
  networkLogs?: any[] | undefined;
  consoleLogs?: any[] | undefined;
  storageSnapshot?: any;
  deviceFingerprint?: any;
  triageResult?: any;
  severity?: string | undefined;
}) {
  let html = '';
  if (data.description) {
    html += `<div>${data.description}</div><br/>`;
  }
  if (data.triageResult) {
    const tr = data.triageResult;
    html += `<div style="background:#f8fafc;border:1px solid #cbd5e1;padding:12px;border-radius:6px;margin-bottom:12px;">`;
    html += `<h3 style="color:#6366f1;margin-top:0;">🧠 AI Root Cause Triage</h3>`;
    html += `<p><b>Component:</b> <span style="background:#6366f1;color:#fff;padding:2px 6px;border-radius:4px;">${tr.affectedComponent || 'N/A'}</span></p>`;
    html += `<p><b>Root Cause:</b> ${tr.rootCause || 'N/A'}</p>`;
    if (tr.technicalSummary) html += `<p><b>Technical Summary:</b> ${tr.technicalSummary}</p>`;
    if (tr.suggestedFix) html += `<p style="color:#059669;"><b>💡 Recommended Fix:</b> ${tr.suggestedFix}</p>`;
    html += `</div>`;
  }
  if (data.expectedResult || data.actualResult) {
    html += `<div>`;
    if (data.expectedResult) html += `<p><b>Expected Result:</b> ${data.expectedResult}</p>`;
    if (data.actualResult) html += `<p><b>Actual Result:</b> ${data.actualResult}</p>`;
    html += `</div>`;
  }
  if (data.url) {
    html += `<p><b>Target URL:</b> <a href="${data.url}">${data.url}</a></p>`;
  }
  if (data.steps && data.steps.length > 0) {
    html += `<h3>📋 Reproduction Steps</h3><ol>`;
    data.steps.forEach((s: any) => {
      const action = (s.action_type || s.actionType || 'CLICK').toUpperCase();
      const target = s.element_label || s.elementLabel || 'element';
      const val = s.value_masked || s.valueMasked;
      let text = `<b>${action}</b> on "${target}"`;
      if (val && val !== '[REDACTED]') text += ` (Value: "${val}")`;
      html += `<li>${text}</li>`;
    });
    html += `</ol>`;
  } else if (data.testSummary) {
    html += `<h3>📋 Reproduction Steps</h3><pre>${data.testSummary}</pre>`;
  }
  if (data.networkLogs && data.networkLogs.length > 0) {
    const failed = data.networkLogs.filter((l: any) => l.failed || (l.status && l.status >= 400));
    const targetLogs = failed.length > 0 ? failed : data.networkLogs.slice(0, 10);
    html += `<h3>🌐 Failed Network Requests</h3><pre style="background:#1e293b;color:#f8fafc;padding:10px;border-radius:6px;">`;
    targetLogs.forEach((l: any) => {
      html += `[${l.method || 'GET'}] ${l.url} -> Status: ${l.status || 'FAILED'}\n`;
      if (l.responseBody) html += `Payload: ${typeof l.responseBody === 'string' ? l.responseBody.slice(0, 300) : JSON.stringify(l.responseBody).slice(0, 300)}\n\n`;
    });
    html += `</pre>`;
  }
  if (data.consoleLogs && data.consoleLogs.length > 0) {
    html += `<h3>🚨 Console Logs</h3><pre style="background:#1e293b;color:#f8fafc;padding:10px;border-radius:6px;">`;
    data.consoleLogs.forEach((l: any) => {
      html += typeof l === 'string' ? `${l}\n` : `[${(l.type || 'LOG').toUpperCase()}] ${l.text || l.message || JSON.stringify(l)}\n`;
    });
    html += `</pre>`;
  }
  if (data.deviceFingerprint) {
    const df = data.deviceFingerprint;
    html += `<p style="font-size:11px;color:#64748b;">Device: OS: ${df.os || 'N/A'} | Browser: ${df.browser || 'N/A'} | Resolution: ${df.resolution || 'N/A'}</p>`;
  }
  return html;
}


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
          elements: [{ type: 'mrkdwn', text: `Reported via *BugLens* · ${new Date().toUTCString()}` }],
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

    const {
      title, description, severity, issueType, priority, labels, assignee,
      url, expectedResult, actualResult, testSummary, steps, networkLogs, consoleLogs,
      storageSnapshot, deviceFingerprint, screenshot, triageResult,
      userJiraUrl, userJiraEmail, userJiraToken, userJiraProject
    } = body.data;

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
    const jiraLabels = ['buglens', ...(severity ? [severity.toLowerCase()] : []), ...(labels ?? [])];

    const adfDoc = buildJiraADFDoc({
      description,
      expectedResult,
      actualResult,
      url,
      testSummary,
      steps,
      networkLogs,
      consoleLogs,
      storageSnapshot,
      deviceFingerprint,
      triageResult,
      severity,
    });

    const jiraPayload: Record<string, unknown> = {
      fields: {
        project: { key: JIRA_PROJECT_KEY },
        summary: title,
        issuetype: { name: issueType },
        priority: { name: effectivePriority },
        labels: jiraLabels,
        description: adfDoc,
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

      // ── Upload Screenshot Attachments if present ───────────────────────────
      const screenshotsToUpload: string[] = [];
      if (Array.isArray(body.data.screenshots) && body.data.screenshots.length > 0) {
        screenshotsToUpload.push(...body.data.screenshots);
      } else if (screenshot) {
        screenshotsToUpload.push(screenshot);
      }

      for (let i = 0; i < screenshotsToUpload.length; i++) {
        const sc = screenshotsToUpload[i];
        if (!sc) continue;
        try {
          let imageBuffer: Buffer | null = null;
          let mimeType = 'image/png';
          let fileName = `buglens-evidence-${i + 1}.png`;

          if (sc.startsWith('data:image/')) {
            const match = sc.match(/^data:(image\/\w+);base64,(.+)$/);
            if (match && match[1] && match[2]) {
              mimeType = match[1];
              const ext = mimeType.split('/')[1] || 'png';
              fileName = `buglens-evidence-${i + 1}.${ext}`;
              imageBuffer = Buffer.from(match[2], 'base64');
            }
          } else if (sc.startsWith('http://') || sc.startsWith('https://')) {
            const imgResp = await fetch(sc);
            if (imgResp.ok) {
              const arrayBuf = await imgResp.arrayBuffer();
              imageBuffer = Buffer.from(arrayBuf);
            }
          }

          if (imageBuffer) {
            const form = new FormData();
            const blob = new Blob([imageBuffer], { type: mimeType });
            form.append('file', blob, fileName);

            const attachResp = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${data.key}/attachments`, {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${credentials}`,
                'X-Atlassian-Token': 'no-check',
              },
              body: form,
            });

            if (!attachResp.ok) {
              const attachErr = await attachResp.text();
              request.log.warn({ status: attachResp.status, body: attachErr }, `Failed to attach screenshot ${i + 1} to Jira issue`);
            }
          }
        } catch (attachErr) {
          request.log.warn({ err: attachErr }, `Exception attaching screenshot ${i + 1} to Jira issue`);
        }
      }

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
      { op: 'add', path: '/fields/System.Description', value: buildAzureHTMLDoc(body.data) },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: effectivePriority },
      { op: 'add', path: '/fields/System.Tags', value: `BugLens; ${severity ?? 'P2'}` },
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
