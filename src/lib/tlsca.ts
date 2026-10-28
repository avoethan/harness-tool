/**
 * The certificate authorities the harness trusts for its own HTTPS calls
 * (Jira, GitHub): Node's bundled list plus NODE_EXTRA_CA_CERTS, and the
 * operating system's store where Node can read it (22.15+, 23.5+). A company
 * network that inspects traffic re-signs it with a company root the system
 * store trusts; without the system store Node reports "self-signed
 * certificate in certificate chain". Verification is never turned off.
 */
import * as tls from 'node:tls';

let cached: string[] | null | undefined;

type GetCa = (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];

/** The CA list to pass as `ca`, or undefined to keep Node's default (when the system store cannot be read). */
export function trustedCa(): string[] | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const get = (tls as unknown as { getCACertificates?: GetCa }).getCACertificates;
  if (typeof get !== 'function') {
    cached = null;
    return undefined;
  }
  try {
    const all = new Set<string>([...get('default'), ...get('system')]);
    cached = [...all];
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}

/** True when the error is a certificate problem a company root certificate would explain. */
export function isCertChainError(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? '';
  return /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT/.test(code) || /self[- ]signed certificate|unable to get local issuer certificate/i.test(String((e as Error)?.message ?? ''));
}

export const CERT_HELP =
  'Your network re-signs HTTPS with a company certificate that Node does not trust. Fix: export your company root certificate (Windows: certmgr.msc > Trusted Root Certification Authorities > the company root > All Tasks > Export, "Base-64 encoded X.509 (.CER)") and set the user environment variable NODE_EXTRA_CA_CERTS to that file, then open a new terminal. Node 22.15 or later also reads the Windows store itself. Never turn certificate checks off.';
