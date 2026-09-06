import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchPage,
  isBlockedIpAddress,
  parseFetchTarget,
  type FetchPageDnsResolver,
} from "./fetch-page.server.ts";

const publicDns: FetchPageDnsResolver = async () => [
  { address: "93.184.216.34", family: 4 },
];

test("fetch targets allow only HTTP(S) on their standard ports", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.test/file",
    "http://example.test:443/",
    "https://example.test:80/",
    "https://example.test:8443/",
  ]) {
    assert.throws(() => parseFetchTarget(url));
  }
  assert.doesNotThrow(() => parseFetchTarget("http://example.test:80/"));
  assert.doesNotThrow(() => parseFetchTarget("https://example.test:443/"));
  assert.throws(() => parseFetchTarget("https://user:pass@example.test/"));
});

test("localhost and cloud metadata hostnames are blocked", () => {
  for (const url of [
    "http://localhost/",
    "http://service.localhost/",
    "http://localhost.localdomain/",
    "http://metadata.google.internal/",
    "http://instance-data.ec2.internal/",
    "http://metadata/",
  ]) {
    assert.throws(() => parseFetchTarget(url), /Blocked URL hostname/);
  }
});

test("private and special-use IPv4 ranges are blocked", () => {
  for (const address of [
    "0.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isBlockedIpAddress(address), true, address);
  }
  assert.equal(isBlockedIpAddress("8.8.8.8"), false);
  assert.throws(() => parseFetchTarget("http://2130706433/"), /Blocked IP address/);
});

test("private and special-use IPv6 ranges are blocked", () => {
  for (const address of [
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "2001:db8::1",
    "2001:2::1",
    "2002::1",
    "3fff::1",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
  ]) {
    assert.equal(isBlockedIpAddress(address), true, address);
  }
  assert.equal(isBlockedIpAddress("2606:4700:4700::1111"), false);
  assert.equal(isBlockedIpAddress("::ffff:8.8.8.8"), false);
  assert.throws(() => parseFetchTarget("http://[::1]/"), /Blocked IP address/);
});

test("a private DNS answer is rejected before fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response("unreachable");
  };

  await assert.rejects(
    fetchPage("https://public-name.example/", {
      resolver: async () => [{ address: "10.0.0.8", family: 4 }],
      fetchImpl,
    }),
    /resolved to a blocked address/,
  );
  assert.equal(fetchCalls, 0);
});

test("a public DNS answer permits a manually redirected fetch mode", async () => {
  let resolved = 0;
  const resolver: FetchPageDnsResolver = async (hostname) => {
    assert.equal(hostname, "public-name.example");
    resolved += 1;
    return [{ address: "2606:4700:4700::1111", family: 6 }];
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(
      "<html><head><title>Public page</title></head><body><p>Safe content</p></body></html>",
      { headers: { "content-type": "text/html" } },
    );
  };

  const page = await fetchPage("https://public-name.example/article", {
    resolver,
    fetchImpl,
  });
  assert.equal(resolved, 1);
  assert.equal(page.title, "Public page");
  assert.match(page.text, /Safe content/);
});

test("redirect targets are resolved and revalidated before another request", async () => {
  const resolved: string[] = [];
  const resolver: FetchPageDnsResolver = async (hostname) => {
    resolved.push(hostname);
    return [
      {
        address: hostname === "private-target.example" ? "172.20.0.4" : "93.184.216.34",
        family: 4,
      },
    ];
  };
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://private-target.example/secret" },
    });
  };

  await assert.rejects(
    fetchPage("https://start.example/", { resolver, fetchImpl }),
    /resolved to a blocked address/,
  );
  assert.deepEqual(resolved, ["start.example", "private-target.example"]);
  assert.equal(fetchCalls, 1);
});

test("redirect count is capped and every request repeats DNS validation", async () => {
  let dnsCalls = 0;
  let fetchCalls = 0;
  const resolver: FetchPageDnsResolver = async () => {
    dnsCalls += 1;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `/hop-${fetchCalls}` },
    });
  };

  await assert.rejects(
    fetchPage("https://loop.example/", {
      resolver,
      fetchImpl,
      maxRedirects: 2,
    }),
    /Too many redirects/,
  );
  assert.equal(fetchCalls, 3);
  assert.equal(dnsCalls, 3);
});

test("response streaming stops at the hard byte cap", async () => {
  const encoder = new TextEncoder();
  const fetchImpl: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("1234"));
          controller.enqueue(encoder.encode("5678"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );

  await assert.rejects(
    fetchPage("https://large.example/", {
      resolver: publicDns,
      fetchImpl,
      maxBytes: 6,
    }),
    /6-byte limit/,
  );
});

test("timeout aborts an in-flight request with a bounded error", async () => {
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });

  await assert.rejects(
    fetchPage("https://slow.example/", {
      resolver: publicDns,
      fetchImpl,
      timeoutMs: 10,
    }),
    /timed out after 10ms/,
  );
});

test("caller abort reason is propagated without a network request", async () => {
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  controller.abort(reason);
  let fetchCalls = 0;

  await assert.rejects(
    fetchPage("https://public-name.example/", {
      resolver: publicDns,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("unreachable");
      },
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(fetchCalls, 0);
});
