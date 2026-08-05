import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyIpAddress, isIpLiteral, parseIpv6 } from "./ip.js";

describe("classifyIpAddress — IPv4", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["93.184.216.34", "public"],
    ["8.8.8.8", "public"],
    ["127.0.0.1", "loopback"],
    ["127.99.1.5", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["169.254.169.254", "metadata"],
    ["100.100.100.200", "metadata"],
    ["169.254.1.1", "linkLocal"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.254", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.10", "private"],
    ["100.64.0.1", "private"],
    ["224.0.0.1", "multicast"],
    ["203.0.113.9", "reserved"],
    ["198.51.100.9", "reserved"],
    ["192.0.2.9", "reserved"],
    ["255.255.255.255", "reserved"],
  ];

  for (const [address, expected] of cases) {
    it(`${address} -> ${expected}`, () => {
      assert.equal(classifyIpAddress(address).category, expected);
    });
  }

  it("rejects octal-looking octets rather than guessing a base", () => {
    // 0177.0.0.1 is 127.0.0.1 to some resolvers. Unknown means denied.
    assert.equal(classifyIpAddress("0177.0.0.1").category, "unknown");
    assert.equal(classifyIpAddress("010.0.0.1").category, "unknown");
  });

  it("rejects shorthand and out-of-range forms", () => {
    for (const bad of ["127.1", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.-1"]) {
      assert.equal(classifyIpAddress(bad).category, "unknown", bad);
    }
  });
});

describe("classifyIpAddress — IPv6", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "linkLocal"],
    ["febf::1", "linkLocal"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["fd00:ec2::254", "metadata"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["2606:2800:220:1:248:1893:25c8:1946", "public"],
  ];

  for (const [address, expected] of cases) {
    it(`${address} -> ${expected}`, () => {
      assert.equal(classifyIpAddress(address).category, expected);
    });
  }

  it("classifies bracketed literals the same as bare ones", () => {
    assert.equal(classifyIpAddress("[::1]").category, "loopback");
  });

  it("unwraps IPv4-mapped addresses before classifying", () => {
    assert.equal(classifyIpAddress("::ffff:127.0.0.1").category, "loopback");
    assert.equal(
      classifyIpAddress("::ffff:169.254.169.254").category,
      "metadata",
    );
    assert.equal(classifyIpAddress("::ffff:10.0.0.1").category, "private");

    const mapped = classifyIpAddress("::ffff:93.184.216.34");
    assert.equal(mapped.category, "public");
    assert.equal(mapped.family, 4);
    assert.equal(mapped.normalized, "93.184.216.34");
  });

  it("rejects zone identifiers and malformed groups", () => {
    for (const bad of [
      "fe80::1%eth0",
      "::1::2",
      "12345::1",
      "gggg::1",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
    ]) {
      assert.equal(parseIpv6(bad), null, bad);
      assert.equal(classifyIpAddress(bad).category, "unknown", bad);
    }
  });
});

describe("isIpLiteral", () => {
  it("separates literals from DNS names", () => {
    assert.equal(isIpLiteral("10.0.0.1"), true);
    assert.equal(isIpLiteral("[::1]"), true);
    assert.equal(isIpLiteral("gitlab.example.com"), false);
    assert.equal(isIpLiteral(""), false);
  });
});
