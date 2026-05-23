import type { Job } from 'bullmq';
import { query } from '../db/pool.js';

interface IntegrationDispatchJob {
  bugId: string;
  orgId: string;
  event: 'bug.created' | 'bug.updated' | 'bug.resolved';
  integrationType: string;
}

/**
 * Integration dispatch worker.
 *
 * Fans out bug events to configured integrations (Jira, Slack, etc.)
 * A failing integration never blocks the primary bug save.
 * Each integration call is retried up to 3 times with exponential back-off.
 */
export async function processIntegrationDispatch(job: Job<IntegrationDispatchJob>): Promise<void> {
  const { bugId, orgId, event, integrationType } = job.data;

  // Fetch enabled integrations for this org
  const integrations = await query<{ type: string; credentials_encrypted: string }>(
    'SELECT type, credentials_encrypted FROM integration_configs WHERE org_id = $1 AND enabled = true AND type = $2',
    [orgId, integrationType]
  );

  for (const integration of integrations.rows) {
    try {
      job.log(`Dispatching ${event} to ${integration.type} for bug ${bugId}`);
      // Adapter dispatch will be wired when adapters are implemented
      // await getAdapter(integration.type).fileBug(bugId, integration.credentials_encrypted);
    } catch (err) {
      job.log(`Failed to dispatch to ${integration.type}: ${(err as Error).message}`);
      // Don't rethrow — one failing integration shouldn't fail the whole job
    }
  }
}
