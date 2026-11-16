/**
 * The client platforms the API recognises. Lives in config (not validation)
 * because the env parser, the session model and the request schemas all
 * need it, and models never import from the edge.
 */
export const CLIENT_PLATFORMS = ['android', 'ios', 'web'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/** What the X-Client-* headers told us; both optional, garbage ignored. */
export interface ClientContext {
  platform?: ClientPlatform;
  version?: string;
}

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
