import dns from 'node:dns/promises';
import net from 'node:net';

export const BUILTIN_PROVIDER_HOST_ALLOWLIST: Record<string, readonly string[]> = {
  google: ['generativelanguage.googleapis.com'],
  openrouter: ['openrouter.ai'],
  groq: ['api.groq.com'],
  nvidia: ['integrate.api.nvidia.com'],
  huggingface: ['router.huggingface.co'],
  mistral: ['api.mistral.ai'],
  sambanova: ['api.sambanova.ai'],
  cloudflare: ['api.cloudflare.com'],
  cohere: ['api.cohere.ai', 'api.cohere.com'],
};

const BLOCKED_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isPrivateOrRestrictedIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized.startsWith('::ffff:')) {
    return isPrivateOrRestrictedIp(normalized.slice(7));
  }

  if (net.isIPv4(normalized)) {
    const octets = normalized.split('.').map(Number);
    const [a, b] = octets;
    if (a === undefined || b === undefined) return true;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // Link-local / cloud metadata 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Alibaba metadata 100.64.0.0/10
    if (a >= 224) return true; // Multicast / reserved
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
    if (normalized.startsWith('fe80:')) return true; // Link-local fe80::/10
    if (normalized.startsWith('ff')) return true; // Multicast
    return false;
  }

  return true;
}

export interface UrlValidationOptions {
  providerId?: string;
  allowLoopback?: boolean;
  allowedHosts?: readonly string[];
}

export function validateProviderBaseUrl(
  rawUrl: string,
  options: UrlValidationOptions = {}
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid provider URL: "${rawUrl}"`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Provider URLs must not contain embedded credentials.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTS.has(hostname)) {
    throw new Error(`Blocked metadata hostname in provider URL: "${hostname}"`);
  }

  const loopback = isLoopbackHostname(hostname);
  if (parsed.protocol !== 'https:' && !(options.allowLoopback && loopback && parsed.protocol === 'http:')) {
    throw new Error(`Provider URL must use HTTPS (received "${parsed.protocol}")`);
  }

  const builtinAllowed = options.providerId
    ? BUILTIN_PROVIDER_HOST_ALLOWLIST[options.providerId]
    : undefined;
  const effectiveAllowlist = builtinAllowed ?? options.allowedHosts;

  if (effectiveAllowlist && effectiveAllowlist.length > 0) {
    const matched = effectiveAllowlist.some((allowed) => allowed.toLowerCase() === hostname);
    if (!matched) {
      throw new Error(
        `Host "${hostname}" is not in the allowlist for provider "${options.providerId ?? 'custom'}".`
      );
    }
    return parsed;
  }

  if (net.isIP(hostname) && isPrivateOrRestrictedIp(hostname)) {
    if (!(options.allowLoopback && loopback)) {
      throw new Error(`Private or restricted IP address blocked in provider URL: "${hostname}"`);
    }
  }

  return parsed;
}

export async function assertResolvedEndpointSafe(
  rawUrl: string,
  options: UrlValidationOptions = {}
): Promise<URL> {
  const parsed = validateProviderBaseUrl(rawUrl, options);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (options.allowLoopback && isLoopbackHostname(hostname)) {
    return parsed;
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrRestrictedIp(hostname)) {
      throw new Error(`Resolved IP "${hostname}" is private or restricted.`);
    }
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) {
    throw new Error(`DNS resolution returned no records for "${hostname}".`);
  }

  for (const record of records) {
    if (isPrivateOrRestrictedIp(record.address)) {
      throw new Error(
        `SSRF protection blocked "${hostname}" because it resolved to restricted address "${record.address}".`
      );
    }
  }

  return parsed;
}
