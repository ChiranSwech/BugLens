import { Bug, ShieldCheck, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy — BugLens',
  description: 'Privacy Policy for BugLens Chrome Extension and Platform',
};

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-[#0f0f12] text-[#f1f0ff] p-6 md:p-12 font-sans">
      <div className="max-w-4xl mx-auto space-y-8">
        
        <header className="border-b border-[#2e2e3a] pb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bug className="w-8 h-8 text-[#818cf8]" />
            <h1 className="text-2xl font-bold bg-gradient-to-r from-[#818cf8] to-[#c084fc] bg-clip-text text-transparent">
              BugLens Privacy Policy
            </h1>
          </div>
          <Link
            href="/"
            className="flex items-center gap-2 text-xs font-semibold text-[#818cf8] hover:text-white transition-colors bg-[#1a1a22] border border-[#2e2e3a] px-3 py-1.5 rounded-lg"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Dashboard
          </Link>
        </header>

        <section className="bg-[#1a1a22] border border-[#2e2e3a] rounded-2xl p-6 md:p-8 space-y-6 text-sm text-[#a09dc0] leading-relaxed">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold text-xs uppercase tracking-wider bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full w-fit">
            <ShieldCheck className="w-4 h-4" /> Effective Date: August 10, 2026
          </div>

          <div>
            <h2 className="text-lg font-bold text-white mb-2">1. Overview</h2>
            <p>
              BugLens (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) is committed to protecting your privacy. This Privacy Policy explains how our Chrome Extension and Web Dashboard collect, use, and process data when software testers, developers, and QA engineers record bug sessions and generate AI triage reports.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-bold text-white mb-2">2. Information We Collect</h2>
            <ul className="list-disc pl-5 space-y-2 text-[#f1f0ff]">
              <li><strong>DOM Interaction Logs:</strong> User interactions (clicks, text entries, scroll actions, page navigations) captured during an explicit recording session initiated by the user.</li>
              <li><strong>Network &amp; Console Errors:</strong> HTTP request URLs, failure status codes (4xx/5xx), and console JavaScript error messages for root-cause diagnosis.</li>
              <li><strong>Annotated Screenshots:</strong> Canvas screenshots captured during active sessions to illustrate bug reproduction steps.</li>
              <li><strong>Authentication Data:</strong> OAuth tokens and user identity (email, profile name) when signing in via SSO.</li>
              <li><strong>Personal BYOK Credentials:</strong> API keys (OpenAI API key, Jira API token) entered in Extension Settings are stored strictly in local browser storage (`chrome.storage.local`) and transmitted directly to user-authorized endpoints.</li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-bold text-white mb-2">3. Source PII Redaction &amp; Privacy Protections</h2>
            <p>
              BugLens automatically masks sensitive user data before events leave the browser:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2 text-[#f1f0ff]">
              <li>Password fields, credit card numbers, and email inputs are automatically obfuscated.</li>
              <li>Elements tagged with `data-pii` attributes are redacted at the source in content scripts.</li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-bold text-white mb-2">4. How We Use Data</h2>
            <p>
              Collected data is processed strictly for:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2 text-[#f1f0ff]">
              <li>Generating step-by-step bug reproduction summaries and AI root-cause analysis.</li>
              <li>Exporting session replay videos (`.webm`) and bug report tickets to user-configured integration endpoints (Jira, Azure DevOps, Slack).</li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-bold text-white mb-2">5. Data Sharing &amp; Third Parties</h2>
            <p>
              We do not sell, rent, or trade your personal or session data to third parties or advertising networks. Session data is transmitted only to:
            </p>
            <ul className="list-disc pl-5 space-y-1 mt-2 text-[#f1f0ff]">
              <li>OpenAI API endpoints for AI root-cause triage generation.</li>
              <li>User-specified project management services (Atlassian Jira, Azure DevOps, Slack).</li>
            </ul>
          </div>

          <div>
            <h2 className="text-lg font-bold text-white mb-2">6. Security &amp; Data Retention</h2>
            <p>
              All data transmitted between the extension and backend API is encrypted via HTTPS (TLS 1.3). Access tokens are secured with RS256 cryptography. Local recording data can be deleted by the user at any time by clearing browser extension storage.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-bold text-white mb-2">7. Contact Us</h2>
            <p>
              If you have any questions regarding this Privacy Policy or data privacy practices, please contact our support team at <a href="mailto:support@buglens.app" className="text-[#818cf8] underline">support@buglens.app</a>.
            </p>
          </div>

        </section>

      </div>
    </main>
  );
}
