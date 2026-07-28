const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isTrustedRendererUrl(
  value: string,
  devServerUrl: string | undefined,
  rendererFileUrl: string
): boolean {
  try {
    const candidate = new URL(value);
    const trusted = new URL(devServerUrl ?? rendererFileUrl);

    return devServerUrl
      ? candidate.origin === trusted.origin
      : candidate.protocol === trusted.protocol &&
          candidate.host === trusted.host &&
          candidate.pathname === trusted.pathname;
  } catch {
    return false;
  }
}

export function getExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
