/**
 * Address classification for the egress policy (A1).
 *
 * Parsing is deliberately strict and self-contained rather than delegating to
 * `net.isIP`: an address we cannot parse with certainty is classified
 * `unknown`, and the policy denies it. Dotted-quad octets with leading zeros
 * are rejected because some resolvers and C libraries read them as octal,
 * which is a classic way to smuggle `0177.0.0.1` past a naive filter.
 */

export type IpCategory =
  | "public"
  | "private"
  | "loopback"
  | "linkLocal"
  | "metadata"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "unknown";

export type IpClassification = {
  readonly category: IpCategory;
  /** 4, 6, or 0 when the literal could not be parsed. */
  readonly family: 4 | 6 | 0;
  /** Canonical dotted-quad when an IPv4-mapped IPv6 address was unwrapped. */
  readonly normalized: string;
};

const UNKNOWN: IpClassification = {
  category: "unknown",
  family: 0,
  normalized: "",
};

/** Strict dotted-quad. No leading zeros, no shorthand, no trailing garbage. */
export function parseIpv4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

/**
 * Returns 16 bytes, or null. Zone identifiers (`fe80::1%eth0`) are rejected
 * outright: they only appear for scoped addresses we deny anyway.
 */
export function parseIpv6(input: string): number[] | null {
  if (input.includes("%") || input.length === 0) {
    return null;
  }

  let head = input;
  let embeddedV4: number[] | null = null;
  const lastColon = head.lastIndexOf(":");
  if (lastColon !== -1 && head.slice(lastColon + 1).includes(".")) {
    embeddedV4 = parseIpv4(head.slice(lastColon + 1));
    if (embeddedV4 === null) {
      return null;
    }
    head = head.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColonCount = head.split("::").length - 1;
  if (doubleColonCount > 1) {
    return null;
  }

  let groups: string[];
  if (doubleColonCount === 1) {
    const [left = "", right = ""] = head.split("::");
    const leftGroups = left === "" ? [] : left.split(":");
    const rightGroups = right === "" ? [] : right.split(":");
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 1) {
      return null;
    }
    groups = [...leftGroups, ...Array<string>(missing).fill("0"), ...rightGroups];
  } else {
    groups = head.split(":");
  }

  if (groups.length !== 8) {
    return null;
  }

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return null;
    }
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }

  if (embeddedV4 !== null) {
    bytes.splice(12, 4, ...embeddedV4);
  }
  return bytes;
}

function classifyIpv4(octets: number[]): IpCategory {
  const [a = 0, b = 0, c = 0, d = 0] = octets;

  // AWS/GCP/Azure/DO instance metadata. Checked before link-local so the
  // denial reason stays specific in logs.
  if (a === 169 && b === 254 && c === 169 && d === 254) {
    return "metadata";
  }
  // Alibaba Cloud metadata.
  if (a === 100 && b === 100 && c === 100 && d === 200) {
    return "metadata";
  }
  if (a === 127) {
    return "loopback";
  }
  if (a === 0) {
    return "unspecified";
  }
  if (a === 169 && b === 254) {
    return "linkLocal";
  }
  if (a === 10) {
    return "private";
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return "private";
  }
  if (a === 192 && b === 168) {
    return "private";
  }
  // RFC 6598 carrier-grade NAT — routable inside an operator, not the internet.
  if (a === 100 && b >= 64 && b <= 127) {
    return "private";
  }
  if (a >= 224 && a <= 239) {
    return "multicast";
  }
  // IETF protocol assignments, TEST-NET-1/2/3, benchmarking, reserved, broadcast.
  if (a === 192 && b === 0 && c === 0) {
    return "reserved";
  }
  if (a === 192 && b === 0 && c === 2) {
    return "reserved";
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return "reserved";
  }
  if (a === 198 && b === 51 && c === 100) {
    return "reserved";
  }
  if (a === 203 && b === 0 && c === 113) {
    return "reserved";
  }
  if (a >= 240) {
    return "reserved";
  }
  return "public";
}

function classifyIpv6Bytes(bytes: number[]): IpCategory {
  const [b0 = 0, b1 = 0] = bytes;

  if (bytes.every((byte) => byte === 0)) {
    return "unspecified";
  }
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return "loopback";
  }
  // fd00:ec2::254 — AWS IMDS over IPv6.
  if (
    b0 === 0xfd &&
    b1 === 0x00 &&
    bytes[2] === 0x0e &&
    bytes[3] === 0xc2 &&
    bytes.slice(4, 14).every((byte) => byte === 0) &&
    bytes[14] === 0x02 &&
    bytes[15] === 0x54
  ) {
    return "metadata";
  }
  if (b0 === 0xff) {
    return "multicast";
  }
  // fe80::/10
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) {
    return "linkLocal";
  }
  // fc00::/7 unique local
  if ((b0 & 0xfe) === 0xfc) {
    return "private";
  }
  // 2001:db8::/32 documentation
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return "reserved";
  }
  // 2002::/16 6to4 and 2001::/32 Teredo tunnel public traffic through a relay.
  if (b0 === 0x20 && b1 === 0x02) {
    return "reserved";
  }
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return "reserved";
  }
  return "public";
}

function isIpv4Mapped(bytes: number[]): boolean {
  return (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  );
}

/**
 * `::ffff:127.0.0.1` must classify as loopback, not as a public v6 address,
 * so mapped addresses are unwrapped before classification.
 */
export function classifyIpAddress(input: string): IpClassification {
  const raw = input.trim();
  if (raw.length === 0) {
    return UNKNOWN;
  }

  const bracketless =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;

  const v4 = parseIpv4(bracketless);
  if (v4 !== null) {
    return {
      category: classifyIpv4(v4),
      family: 4,
      normalized: v4.join("."),
    };
  }

  const v6 = parseIpv6(bracketless);
  if (v6 === null) {
    return UNKNOWN;
  }

  if (isIpv4Mapped(v6)) {
    const mapped = v6.slice(12);
    return {
      category: classifyIpv4(mapped),
      family: 4,
      normalized: mapped.join("."),
    };
  }

  return {
    category: classifyIpv6Bytes(v6),
    family: 6,
    normalized: bracketless.toLowerCase(),
  };
}

/** True when the string is a bare IP literal rather than a DNS name. */
export function isIpLiteral(host: string): boolean {
  return classifyIpAddress(host).family !== 0;
}
