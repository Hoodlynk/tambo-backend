/**
 * The Play Integrity seam for device claims (B4). A claim made with
 * CLAIM_INTEGRITY=required must carry a token this verifier accepts.
 *
 * Only the placeholder exists: it rejects every token, and config refuses to
 * boot with integrity required outside development/test, so the placeholder
 * can never silently refuse a real fleet. The Google driver (decode the token
 * server-side, check the package name, the request hash and a
 * MEETS_DEVICE_INTEGRITY verdict) is a roadmap item; tests replace `verify`.
 */
export interface IntegrityVerifier {
  /**
   * `requestHash` is what the app must have bound into the token request, so
   * a token minted for one claim cannot be replayed on another.
   */
  verify(token: string, requestHash: string): Promise<boolean>;
}

export const integrityVerifier: IntegrityVerifier = {
  verify: () => Promise.resolve(false),
};
