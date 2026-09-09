import config from '../config/config';
import LegalAcceptance, { LEGAL_DOCS } from '../models/legalAcceptance.model';
import type { LegalDoc } from '../models/legalAcceptance.model';
import { AppError } from '../utils/appError';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import type { LegalAcceptInput } from '../validation/legal.schema';

/**
 * Legal documents (T&C, privacy policy): the CONTENT lives on the website, the
 * API is the system of record for versions and acceptances. The app shows the
 * document in-app (linking/rendering the website copy), gates the accept
 * button on scroll-to-end, and posts the acceptance here; login-time staleness
 * is answered by `statusFor`.
 */

export interface LegalDocInfo {
  doc: LegalDoc;
  version: string;
  url: string;
}

export interface LegalDocStatus extends LegalDocInfo {
  acceptedVersion: string | null;
  acceptedAt: string | null;
  /** False until the CURRENT version has been accepted - the app's re-prompt cue. */
  upToDate: boolean;
}

const current = (doc: LegalDoc): LegalDocInfo => ({
  doc,
  version: config.legal[doc].version,
  url: config.legal[doc].url,
});

/** The current documents - public, the app can show these pre-login. */
export const currentDocuments = (): LegalDocInfo[] =>
  LEGAL_DOCS.map((doc) => current(doc));

export interface AcceptanceMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/**
 * Records an acceptance of the CURRENT version. A stale version (the app cached
 * an old modal) is rejected with the current document so the client can
 * re-present it; re-accepting an already-accepted version is idempotent.
 */
export const accept = async (
  userId: string,
  input: LegalAcceptInput,
  meta: AcceptanceMeta = {},
): Promise<LegalDocStatus> => {
  const doc = current(input.doc);

  if (input.version !== doc.version) {
    // the client re-fetches GET /api/v1/legal and re-presents the document
    throw AppError.conflict(
      `The ${input.doc} document has changed (current version ${doc.version}). ` +
        'Please review and accept the current version.',
      'stale_legal_version',
    );
  }

  try {
    await LegalAcceptance.create({
      user: userId,
      doc: input.doc,
      version: input.version,
      url: doc.url,
      scrolledToEnd: input.scrolledToEnd,
      acceptedAt: new Date(),
      ...(meta.userAgent ? { userAgent: meta.userAgent } : {}),
      ...(meta.ip ? { ip: meta.ip } : {}),
    });
  } catch (error) {
    // same (user, doc, version) already recorded - an idempotent re-accept
    if (!isDuplicateKeyError(error)) throw error;
  }

  const [status] = await statusFor(userId, [input.doc]);
  if (!status) throw new Error('unreachable: status for accepted doc');
  return status;
};

/** True only when the CURRENT version of every legal document is accepted. */
export const hasAcceptedCurrent = async (userId: string): Promise<boolean> => {
  const statuses = await statusFor(userId);
  return statuses.every((status) => status.upToDate);
};

/**
 * Per-document acceptance state for a user - what the app reads after login to
 * decide whether to show the T&C / privacy modal.
 */
export const statusFor = async (
  userId: string,
  docs: readonly LegalDoc[] = LEGAL_DOCS,
): Promise<LegalDocStatus[]> => {
  const acceptances = await LegalAcceptance.find({
    user: userId,
    doc: { $in: [...docs] },
  })
    .sort({ acceptedAt: -1 })
    .select('doc version acceptedAt');

  return docs.map((docName) => {
    const info = current(docName);
    const onCurrent = acceptances.find(
      (row) => row.doc === docName && row.version === info.version,
    );
    const latest = acceptances.find((row) => row.doc === docName);

    return {
      ...info,
      acceptedVersion: onCurrent?.version ?? latest?.version ?? null,
      acceptedAt: (onCurrent ?? latest)?.acceptedAt.toISOString() ?? null,
      upToDate: Boolean(onCurrent),
    };
  });
};
