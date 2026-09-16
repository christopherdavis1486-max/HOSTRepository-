import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_CALENDAR_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 12_000;

type ResolvedAddress = {
  address: string;
  family: number;
};

type HostResolver = (
  hostname: string,
) => Promise<ResolvedAddress[]>;

export type CalendarFetchOptions = {
  etag?: string | null;
  lastModified?: string | null;
};

export type CalendarFetchResult =
  | {
      notModified: true;
      etag: string | null;
      lastModified: string | null;
    }
  | {
      notModified: false;
      body: string;
      etag: string | null;
      lastModified: string | null;
    };

export class CalendarFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarFetchError";
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const numbers = parts.map((part) => Number(part));

  if (
    numbers.some(
      (part) =>
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255,
    )
  ) {
    return null;
  }

  return numbers;
}

function isBlockedIpv4(address: string): boolean {
  const parts = parseIpv4(address);

  if (!parts) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address
    .toLowerCase()
    .split("%")[0];

  if (
    normalized === "::" ||
    normalized === "::1"
  ) {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);

    return isBlockedIpv4(mapped);
  }

  const firstSegment = normalized.split(":")[0];
  const firstValue = Number.parseInt(firstSegment || "0", 16);

  if (!Number.isFinite(firstValue)) {
    return true;
  }

  return (
    (firstValue >= 0xfc00 && firstValue <= 0xfdff) ||
    (firstValue >= 0xfe80 && firstValue <= 0xfebf) ||
    (firstValue >= 0xff00 && firstValue <= 0xffff) ||
    normalized.startsWith("2001:db8:")
  );
}

export function isBlockedNetworkAddress(
  address: string,
): boolean {
  const version = isIP(address);

  if (version === 4) {
    return isBlockedIpv4(address);
  }

  if (version === 6) {
    return isBlockedIpv6(address);
  }

  return true;
}

const defaultResolver: HostResolver = async (
  hostname,
) => {
  return lookup(hostname, {
    all: true,
    verbatim: true,
  });
};

export async function assertSafeCalendarUrl(
  rawUrl: string,
  resolver: HostResolver = defaultResolver,
): Promise<URL> {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new CalendarFetchError(
      "Enter a valid HTTPS calendar URL",
    );
  }

  if (url.protocol !== "https:") {
    throw new CalendarFetchError(
      "Calendar URL must use HTTPS",
    );
  }

  if (url.username || url.password) {
    throw new CalendarFetchError(
      "Calendar URL must not contain embedded credentials",
    );
  }

  if (url.port && url.port !== "443") {
    throw new CalendarFetchError(
      "Calendar URL must use the standard HTTPS port",
    );
  }

  const hostname = normalizeHostname(url.hostname);

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan")
  ) {
    throw new CalendarFetchError(
      "Calendar URL hostname is not allowed",
    );
  }

  const literalVersion = isIP(hostname);
  const addresses = literalVersion
    ? [
        {
          address: hostname,
          family: literalVersion,
        },
      ]
    : await resolver(hostname).catch(() => {
        throw new CalendarFetchError(
          "Calendar URL hostname could not be resolved",
        );
      });

  if (addresses.length === 0) {
    throw new CalendarFetchError(
      "Calendar URL hostname could not be resolved",
    );
  }

  if (
    addresses.some((record) =>
      isBlockedNetworkAddress(record.address),
    )
  ) {
    throw new CalendarFetchError(
      "Calendar URL resolves to a private or reserved network",
    );
  }

  return url;
}

async function readLimitedBody(
  response: Response,
): Promise<string> {
  const declaredLength = Number(
    response.headers.get("content-length") ?? "0",
  );

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_CALENDAR_BYTES
  ) {
    throw new CalendarFetchError(
      "Calendar response is larger than 2 MB",
    );
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    totalBytes += result.value.byteLength;

    if (totalBytes > MAX_CALENDAR_BYTES) {
      await reader.cancel();

      throw new CalendarFetchError(
        "Calendar response is larger than 2 MB",
      );
    }

    chunks.push(result.value);
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes,
  ).toString("utf8");
}

function isRedirect(status: number): boolean {
  return [
    301,
    302,
    303,
    307,
    308,
  ].includes(status);
}

export async function fetchCalendar(
  rawUrl: string,
  options: CalendarFetchOptions = {},
): Promise<CalendarFetchResult> {
  let currentUrl = rawUrl;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    const safeUrl = await assertSafeCalendarUrl(
      currentUrl,
    );

    const headers = new Headers({
      Accept:
        "text/calendar, text/plain;q=0.9, application/octet-stream;q=0.5",
      "User-Agent": "HOST-Calendar-Sync/1.0",
    });

    if (options.etag) {
      headers.set("If-None-Match", options.etag);
    }

    if (options.lastModified) {
      headers.set(
        "If-Modified-Since",
        options.lastModified,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );

    let response: Response;

    try {
      response = await fetch(safeUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      throw new CalendarFetchError(
        "Calendar provider could not be reached",
      );
    } finally {
      clearTimeout(timeout);
    }

    const etag = response.headers.get("etag");
    const lastModified =
      response.headers.get("last-modified");

    if (response.status === 304) {
      return {
        notModified: true,
        etag,
        lastModified,
      };
    }

    if (isRedirect(response.status)) {
      if (redirectCount === MAX_REDIRECTS) {
        throw new CalendarFetchError(
          "Calendar URL redirected too many times",
        );
      }

      const location = response.headers.get("location");

      if (!location) {
        throw new CalendarFetchError(
          "Calendar provider returned an invalid redirect",
        );
      }

      currentUrl = new URL(
        location,
        safeUrl,
      ).toString();

      continue;
    }

    if (!response.ok) {
      throw new CalendarFetchError(
        `Calendar provider returned HTTP ${response.status}`,
      );
    }

    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml")
    ) {
      throw new CalendarFetchError(
        "Calendar URL returned a web page instead of an iCalendar file",
      );
    }

    return {
      notModified: false,
      body: await readLimitedBody(response),
      etag,
      lastModified,
    };
  }

  throw new CalendarFetchError(
    "Calendar URL redirected too many times",
  );
}