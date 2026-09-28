import { describe, expect, it } from "vitest";
import {
  assertLocalRequest,
  checkLocalRequest,
  guarded,
  isLoopbackHostname,
  isMutatingMethod,
  localRequestGuard,
  LocalRequestError,
  splitAuthority,
  type RequestLike,
} from "./security";

function req(headers: Record<string, string>, method = "POST"): RequestLike {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null } };
}

describe("splitAuthority", () => {
  it("splits a name and a port", () => {
    expect(splitAuthority("localhost:3000")).toEqual({ hostname: "localhost", port: "3000" });
  });

  it("splits an IPv6 authority at the colon outside the brackets", () => {
    expect(splitAuthority("[::1]:3000")).toEqual({ hostname: "::1", port: "3000" });
    expect(splitAuthority("[::1]")).toEqual({ hostname: "::1", port: "" });
  });

  it("reports no port when there is none", () => {
    expect(splitAuthority("127.0.0.1")).toEqual({ hostname: "127.0.0.1", port: "" });
  });
});

describe("isLoopbackHostname", () => {
  it("accepts the three names this machine answers to", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
  });

  it("is not a prefix test", () => {
    expect(isLoopbackHostname("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHostname("localhost.evil.example")).toBe(false);
    expect(isLoopbackHostname("notlocalhost")).toBe(false);
  });

  it("refuses a LAN address", () => {
    expect(isLoopbackHostname("192.168.1.14")).toBe(false);
  });
});

describe("checkLocalRequest", () => {
  it("accepts a loopback Host on any port with no Origin", () => {
    expect(checkLocalRequest(req({ host: "localhost:3000" }))).toEqual({ ok: true });
    expect(checkLocalRequest(req({ host: "127.0.0.1:5173" }))).toEqual({ ok: true });
    expect(checkLocalRequest(req({ host: "[::1]:3000" }))).toEqual({ ok: true });
    expect(checkLocalRequest(req({ host: "localhost" }))).toEqual({ ok: true });
  });

  it("accepts a matching Origin", () => {
    const verdict = checkLocalRequest(
      req({ host: "localhost:3000", origin: "http://localhost:3000" }),
    );
    expect(verdict).toEqual({ ok: true });
  });

  it("refuses a request with no Host header", () => {
    const verdict = checkLocalRequest(req({}));
    expect(verdict).toEqual({ ok: false, code: "no-host", reason: "no Host header" });
  });

  it("refuses a rebound Host", () => {
    const verdict = checkLocalRequest(req({ host: "rebind.example:3000" }));
    expect(verdict.ok).toBe(false);
  });

  it("refuses a cross-site Origin", () => {
    const verdict = checkLocalRequest(
      req({ host: "localhost:3000", origin: "https://elsewhere.example" }),
    );
    expect(verdict.ok).toBe(false);
  });

  it("refuses an Origin on another port of this machine", () => {
    // Another program listening on this machine is still another origin.
    const verdict = checkLocalRequest(
      req({ host: "localhost:3000", origin: "http://localhost:4000" }),
    );
    expect(verdict.ok).toBe(false);
  });

  it("refuses an Origin whose hostname spells the same machine differently", () => {
    const verdict = checkLocalRequest(
      req({ host: "localhost:3000", origin: "http://127.0.0.1:3000" }),
    );
    expect(verdict.ok).toBe(false);
  });

  it("refuses the opaque Origin null", () => {
    const verdict = checkLocalRequest(req({ host: "localhost:3000", origin: "null" }));
    expect(verdict).toEqual({ ok: false, code: "opaque-origin", reason: "Origin null" });
  });

  it("refuses an Origin that is not a URL", () => {
    const verdict = checkLocalRequest(req({ host: "localhost:3000", origin: "not a url" }));
    expect(verdict).toEqual({
      ok: false,
      code: "unparseable-origin",
      reason: "Origin is not a URL",
    });
  });
});

describe("isMutatingMethod", () => {
  it("names the four methods that can write", () => {
    expect(isMutatingMethod("post")).toBe(true);
    expect(isMutatingMethod("PUT")).toBe(true);
    expect(isMutatingMethod("PATCH")).toBe(true);
    expect(isMutatingMethod("DELETE")).toBe(true);
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
  });
});

describe("assertLocalRequest", () => {
  it("is silent on a local request", () => {
    expect(() => assertLocalRequest(req({ host: "127.0.0.1:3000" }))).not.toThrow();
  });

  it("throws a 403 error otherwise", () => {
    try {
      assertLocalRequest(req({ host: "elsewhere.example" }));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LocalRequestError);
      expect((err as LocalRequestError).status).toBe(403);
    }
  });
});

describe("localRequestGuard", () => {
  it("refuses a read with a rebound Host", async () => {
    // The DNS rebinding case is a read case first. The attacker's page is
    // same-origin with this server, so it can read the response to every GET:
    // the project list, an answer's full text, the database path.
    const response = localRequestGuard(req({ host: "attacker.example:3000" }, "GET"));
    expect(response?.status).toBe(403);
    await expect(response?.text()).resolves.toContain("not this machine");
  });

  it("refuses a read with no Host header", () => {
    expect(localRequestGuard(req({}, "GET"))?.status).toBe(403);
  });

  it("lets a local read through, with or without an Origin", () => {
    expect(localRequestGuard(req({ host: "localhost:3000" }, "GET"))).toBeNull();
    expect(localRequestGuard(req({ host: "127.0.0.1:3100" }, "GET"))).toBeNull();
    // A read from another origin is left alone once the Host is loopback: a
    // plain browser visit carries no Origin, and the Host test is what covers
    // the rebinding case.
    expect(
      localRequestGuard(
        req({ host: "localhost:3000", origin: "https://elsewhere.example" }, "GET"),
      ),
    ).toBeNull();
  });

  it("lets a local mutation through", () => {
    expect(localRequestGuard(req({ host: "localhost:3000" }, "POST"))).toBeNull();
  });

  it("answers a remote mutation with 403", async () => {
    const response = localRequestGuard(req({ host: "elsewhere.example" }, "POST"));
    expect(response?.status).toBe(403);
    await expect(response?.text()).resolves.toContain("not this machine");
  });

  it("never puts the Host header it was sent in the body", async () => {
    // The value is attacker-controlled up to whatever the HTTP parser allows,
    // and the body is something a user may read, screenshot or paste into an
    // issue. The reason keeps the value for a test and a log line. The response
    // does not.
    const host = "read-this-and-run-the-command-below.example";
    const response = localRequestGuard(req({ host }, "POST"));
    const body = await response?.text();
    expect(body).not.toContain(host);

    const verdict = checkLocalRequest(req({ host }, "POST"));
    expect(verdict.ok ? "" : verdict.reason).toContain(host);
  });
});

describe("guarded", () => {
  const local = (headers: Record<string, string> = {}) =>
    new Request("http://localhost:3000/", { headers: { host: "localhost:3000", ...headers } });

  function expectFramingRefused(response: Response): void {
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  }

  it("sets the anti-framing headers on a response it lets through", async () => {
    const response = await guarded(local(), () => new Response("ok"));
    expect(await response.text()).toBe("ok");
    expectFramingRefused(response);
  });

  it("sets them on its own refusal, without calling the handler", async () => {
    let called = false;
    const response = await guarded(
      new Request("http://evil.example/", { headers: { host: "evil.example" } }),
      () => {
        called = true;
        return new Response("ok");
      },
    );
    expect(called).toBe(false);
    expect(response.status).toBe(403);
    expectFramingRefused(response);
  });

  it("copies a response whose headers cannot be changed", async () => {
    const response = await guarded(local(), () =>
      Response.redirect("http://localhost:3000/start", 307),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/start");
    expectFramingRefused(response);
  });
});
