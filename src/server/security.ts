/**
 * The gate between a local database and the rest of the machine's network:
 * every request must be addressed to this machine, and every mutating request
 * must also come from a tab already looking at this machine.
 *
 * There is no login, so there is no session to steal. There is a server bound
 * to 127.0.0.1 holding a file full of the user's work, and two attacks survive
 * that binding:
 *
 * - DNS rebinding. A page on the public internet resolves its own name to
 *   127.0.0.1 and then asks this server for things. The browser sends
 *   Host: attacker.example, so refusing a non-loopback Host refuses the request.
 * - Ordinary cross-site posting. A page on another origin posts a form. The
 *   browser sends Origin: https://that-site.example, which does not match the
 *   Host, so refusing a mismatched Origin refuses the request.
 *
 * The Host test runs on every request, reads included. A cross-site page cannot
 * read the response to a GET, but under DNS rebinding the attacker's page is
 * same-origin with this server, so it reads every response. Every read here is
 * a GET, and together they return every project, prompt, answer and metric on
 * the machine, plus the database path.
 *
 * The Origin comparison runs on mutations only. A plain browser visit, a curl
 * call and a server-side fetch all send no Origin, and a rebound page cannot
 * forge a loopback Host, so the Host test covers reads.
 */

/** Everything the check reads. A real `Request` satisfies it. */
export interface RequestLike {
  method: string;
  headers: { get(name: string): string | null };
}

/**
 * The closed set of reasons a request is refused. The code picks the response
 * body. The reason is for tests and log lines, and only the reason ever
 * contains a header value.
 */
export type RefusalCode =
  | "no-host"
  | "non-loopback-host"
  | "opaque-origin"
  | "unparseable-origin"
  | "origin-mismatch";

export type LocalRequestCheck = { ok: true } | { ok: false; code: RefusalCode; reason: string };

/**
 * What the person on the other end is told. Fixed sentences, because the Host
 * and Origin headers are attacker-controlled strings and a body a user may
 * read, screenshot or paste into an issue is not the place to echo one.
 */
const REFUSAL_BODY: Record<RefusalCode, string> = {
  "no-host": "Refused: this request carried no Host header.",
  "non-loopback-host":
    "Refused: that Host is not this machine. Overheard AI only answers to localhost.",
  "opaque-origin": "Refused: this request came from an opaque origin.",
  "unparseable-origin": "Refused: this request carried an Origin that is not a URL.",
  "origin-mismatch": "Refused: this request came from another site.",
};

/** Methods that can change the database. Everything else is read-only. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The three names this machine answers to. Not a prefix test: `127.0.0.1.evil`
 * starts with 127.0.0.1 and is somebody else's name.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export class LocalRequestError extends Error {
  readonly status = 403;
  constructor(reason: string) {
    super(reason);
    this.name = "LocalRequestError";
  }
}

/** Strips the brackets an IPv6 authority carries, so `[::1]` compares as `::1`. */
function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Split an authority into hostname and port. `[::1]:3000` splits at the colon
 * after the closing bracket, and `localhost:3000` at its only colon.
 * `localhost` has no port.
 */
export function splitAuthority(authority: string): { hostname: string; port: string } {
  const value = authority.trim().toLowerCase();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return { hostname: value, port: "" };
    const rest = value.slice(close + 1);
    return {
      hostname: unbracket(value.slice(0, close + 1)),
      port: rest.startsWith(":") ? rest.slice(1) : "",
    };
  }
  const colon = value.indexOf(":");
  if (colon === -1) return { hostname: value, port: "" };
  return { hostname: value.slice(0, colon), port: value.slice(colon + 1) };
}

/** Whether a hostname names this machine. Any port is accepted, because the port is not a boundary. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(unbracket(hostname.trim().toLowerCase()));
}

/**
 * Whether this request may change anything.
 *
 * Returns a reason rather than throwing so the caller can decide between a 403
 * and a thrown error, and so the reason can be tested as a value.
 */
export function checkLocalRequest(request: RequestLike): LocalRequestCheck {
  const hostVerdict = checkLocalHost(request);
  if (!hostVerdict.ok) return hostVerdict;

  const host = request.headers.get("host") ?? "";
  const target = splitAuthority(host);
  const origin = request.headers.get("origin");
  // A same-origin navigation, a curl call and a server-side fetch all send no
  // Origin. A sandboxed iframe or a redirected form sends `null`, which hides
  // the real origin, so it is refused.
  if (origin === null || origin === "") return { ok: true };
  if (origin === "null") return { ok: false, code: "opaque-origin", reason: "Origin null" };

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, code: "unparseable-origin", reason: "Origin is not a URL" };
  }

  const source = splitAuthority(parsed.host);
  if (source.hostname !== target.hostname || source.port !== target.port) {
    return {
      ok: false,
      code: "origin-mismatch",
      reason: `Origin ${parsed.origin} does not match Host ${host}`,
    };
  }

  return { ok: true };
}

/**
 * Whether this request is addressed to this machine by a name this machine
 * answers to. Runs on every method, because this is the DNS rebinding test and
 * rebinding reads as easily as it writes.
 */
export function checkLocalHost(request: RequestLike): LocalRequestCheck {
  const host = request.headers.get("host");
  if (!host || host.trim() === "") {
    return { ok: false, code: "no-host", reason: "no Host header" };
  }

  const target = splitAuthority(host);
  if (!isLoopbackHostname(target.hostname)) {
    return {
      ok: false,
      code: "non-loopback-host",
      reason: `Host ${target.hostname} is not this machine`,
    };
  }

  return { ok: true };
}

/** Whether a method can change the database. */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** The same check, raised, for a caller that would rather throw than reply. */
export function assertLocalRequest(request: RequestLike): void {
  const verdict = checkLocalRequest(request);
  if (!verdict.ok) throw new LocalRequestError(verdict.reason);
}

/**
 * The gate the server entry puts in front of every request: a 403 to send back,
 * or null to carry on.
 *
 * Two tests, in this order. Every request must be addressed to this machine,
 * which is what refuses a rebound page whatever method it uses. Then a mutation
 * must also come from a tab already looking at this machine.
 */
export function localRequestGuard(request: RequestLike): Response | null {
  const host = checkLocalHost(request);
  if (!host.ok) return refuse(host.code);

  if (!isMutatingMethod(request.method)) return null;

  const verdict = checkLocalRequest(request);
  if (verdict.ok) return null;
  return refuse(verdict.code);
}

/**
 * Sent on every response. A page framed by another site makes requests that
 * really are same-origin, so neither the Host nor the Origin test can refuse
 * them. The browser has to be told not to frame the app at all.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

/**
 * Names the app on every response, so a second start of server/index.mjs can
 * tell Overheard AI from another program holding the port. That file sends the
 * same header on the pages it shows before the app has loaded.
 */
export const APP_HEADER = "x-overheard-ai";

const RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY_HEADERS,
  [APP_HEADER]: "1",
};

/** The response with SECURITY_HEADERS and APP_HEADER set, copied first if its headers are immutable. */
export function withSecurityHeaders(response: Response): Response {
  try {
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) copy.headers.set(name, value);
    return copy;
  }
}

/** The gate and the headers together: what every entry puts in front of a request. */
export async function guarded(
  request: Request,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  return withSecurityHeaders(localRequestGuard(request) ?? (await next()));
}

function refuse(code: RefusalCode): Response {
  return new Response(`${REFUSAL_BODY[code]} Overheard AI only accepts local requests.`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
