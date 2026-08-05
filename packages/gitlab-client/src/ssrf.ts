/**
 * Egress guard (A1). Runs before every attempt, including retries, so a name
 * that resolves publicly once and privately a moment later gets caught on the
 * second pass instead of riding a cached decision.
 *
 * Fail-closed rules:
 *  - the canonical origin must be an exact allowlist entry;
 *  - every DNS answer must pass classification, not just the first;
 *  - loopback / link-local / metadata / multicast / reserved / unparseable are
 *    denied unconditionally;
 *  - RFC1918, ULA, and CGNAT are denied unless the entry is marked `internal`;
 *  - an empty answer or a resolver failure denies the request.
 *
 * The decision carries the validated IP so the socket can be pinned to it
 * while the original hostname is still used for TLS SNI and the Host header.
 */

import { promises as dns } from "node:dns";

import { GitLabSsrfBlockedError } from "./errors.js";
import { classifyIpAddress, isIpLiteral, type IpCategory } from "./ip.js";
import { originOf, type GitLabAllowlist } from "./url.js";

export type ResolvedAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type SsrfDecision = {
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly protocol: "http:" | "https:";
  /** Validated address the socket must connect to. */
  readonly pinnedAddress: string;
  readonly pinnedFamily: 4 | 6;
  /** Every address that was validated, for diagnostics. */
  readonly validatedAddresses: readonly string[];
};

export interface SsrfGuard {
  check(url: URL): Promise<SsrfDecision>;
  /** Same-origin enforcement for pagination targets. */
  assertSameOrigin(url: URL, expectedOrigin: string): void;
}

/** Denied no matter what the allowlist says. */
const ALWAYS_DENIED: ReadonlySet<IpCategory> = new Set<IpCategory>([
  "loopback",
  "linkLocal",
  "metadata",
  "unspecified",
  "multicast",
  "reserved",
  "unknown",
]);

export const defaultDnsResolver: DnsResolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

export type SsrfGuardOptions = {
  readonly allowlist: GitLabAllowlist;
  readonly resolve?: DnsResolver;
};

export function createSsrfGuard(options: SsrfGuardOptions): SsrfGuard {
  const resolve = options.resolve ?? defaultDnsResolver;
  const { allowlist } = options;

  return {
    async check(url: URL): Promise<SsrfDecision> {
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new GitLabSsrfBlockedError({ reason: "unsupported_scheme" });
      }
      if (url.username !== "" || url.password !== "") {
        throw new GitLabSsrfBlockedError({ reason: "userinfo_not_allowed" });
      }

      const origin = originOf(url);
      const entry = allowlist.find(origin);
      if (entry === null) {
        throw new GitLabSsrfBlockedError({ reason: "origin_not_allowlisted" });
      }

      const hostname = url.hostname.toLowerCase();
      const bare =
        hostname.startsWith("[") && hostname.endsWith("]")
          ? hostname.slice(1, -1)
          : hostname;

      const candidates: ResolvedAddress[] = isIpLiteral(hostname)
        ? [
            {
              address: bare,
              family: classifyIpAddress(hostname).family === 6 ? 6 : 4,
            },
          ]
        : await resolveOrBlock(resolve, hostname);

      if (candidates.length === 0) {
        throw new GitLabSsrfBlockedError({ reason: "dns_no_answer" });
      }

      // Every answer is validated. One denied address blocks the request:
      // otherwise a resolver returning [public, metadata] would let a racing
      // connection reach the denied address.
      for (const candidate of candidates) {
        const classification = classifyIpAddress(candidate.address);
        if (ALWAYS_DENIED.has(classification.category)) {
          throw new GitLabSsrfBlockedError({
            reason: "denied_address_class",
            category: classification.category,
          });
        }
        if (classification.category === "private" && !entry.internal) {
          throw new GitLabSsrfBlockedError({
            reason: "private_address_not_permitted",
          });
        }
      }

      const pinned = candidates[0];
      if (pinned === undefined) {
        throw new GitLabSsrfBlockedError({ reason: "dns_no_answer" });
      }
      // Pin to the parsed form, so `::ffff:203.0.113.9` connects as IPv4
      // rather than being handed back to the stack as an ambiguous literal.
      const pinnedClass = classifyIpAddress(pinned.address);

      const defaultPort = url.protocol === "https:" ? 443 : 80;
      const port = url.port === "" ? defaultPort : Number(url.port);

      return {
        origin,
        hostname: bare,
        port,
        protocol: url.protocol,
        pinnedAddress: pinnedClass.normalized,
        pinnedFamily: pinnedClass.family === 6 ? 6 : 4,
        validatedAddresses: candidates.map((candidate) => candidate.address),
      };
    },

    assertSameOrigin(url: URL, expectedOrigin: string): void {
      if (originOf(url) !== expectedOrigin) {
        throw new GitLabSsrfBlockedError({ reason: "cross_origin_target" });
      }
    },
  };
}

async function resolveOrBlock(
  resolve: DnsResolver,
  hostname: string,
): Promise<ResolvedAddress[]> {
  try {
    return await resolve(hostname);
  } catch {
    // The resolver error can carry the queried name; it never reaches the
    // caller, only the fixed block reason does.
    throw new GitLabSsrfBlockedError({ reason: "dns_failure" });
  }
}
