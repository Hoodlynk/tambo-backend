import PDFDocument from 'pdfkit';
import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import { openMedia } from './storage/media.storage';
import type { EvidencePack } from './pack.service';

/**
 * The human-readable half of the pack: one incident per document, shaped for
 * forwarding to an insurer and showing at a police station. Server-side by
 * design; pdfkit is pure JS (no headless browser to babysit).
 */

const streamToBuffer = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

/** Per snapshot set, and across the whole document: a police printout, not an album. */
const EMBED_PER_SET = 2;
const EMBED_TOTAL = 8;

/**
 * Frames embedded when the bytes are a format pdfkit accepts, keyed by
 * envelope id. The first front and the first back frame of each set are
 * preferred: the intruder's face and their surroundings, one of each.
 */
const loadEmbeddableFrames = async (
  pack: EvidencePack,
): Promise<Map<string, Buffer>> => {
  const buffers = new Map<string, Buffer>();

  for (const set of pack.snapshotSets) {
    if (buffers.size >= EMBED_TOTAL) break;
    const withMedia = set.frames.filter((frame) => frame.hasMedia);
    const preferred = [
      withMedia.find((frame) => frame.camera === 'front'),
      withMedia.find((frame) => frame.camera === 'back'),
      ...withMedia,
    ].filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
    const chosen = [...new Set(preferred)].slice(0, EMBED_PER_SET);

    for (const frame of chosen) {
      if (buffers.size >= EMBED_TOTAL) break;
      const envelope = await EvidenceEnvelope.findOne({
        envelopeId: frame.envelopeId,
      }).select('mediaFileId mediaContentType');
      if (!envelope?.mediaFileId) continue;
      if (!/^image\/(jpe?g|png)$/i.test(envelope.mediaContentType ?? ''))
        continue;

      try {
        buffers.set(
          frame.envelopeId,
          await streamToBuffer(openMedia(envelope.mediaFileId)),
        );
      } catch {
        // an unreadable photo must never sink the whole report
      }
    }
  }

  return buffers;
};

export const renderPackPdf = async (pack: EvidencePack): Promise<Buffer> => {
  const frameBuffers = await loadEmbeddableFrames(pack);

  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const done = streamToBuffer(doc as unknown as NodeJS.ReadableStream);

  const heading = (text: string): void => {
    doc.moveDown(0.8).fontSize(13).font('Helvetica-Bold').text(text);
    doc.moveDown(0.2).fontSize(10).font('Helvetica');
  };
  const line = (label: string, value: string): void => {
    doc
      .font('Helvetica-Bold')
      .text(`${label}: `, { continued: true })
      .font('Helvetica')
      .text(value);
  };

  // --- Header ---------------------------------------------------------------
  doc.fontSize(18).font('Helvetica-Bold').text('Tambo Theft Evidence Pack');
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor('#444444')
    .text(`Generated ${pack.generatedAt} - Episode ${pack.episode.id}`)
    .fillColor('#000000');

  // --- Incident summary -------------------------------------------------------
  heading('Incident summary');
  line('Status', pack.episode.status);
  line(
    'Protection triggered',
    pack.episode.openedBy === 'device'
      ? 'Automatically: repeated failed unlock attempts crossed the threshold'
      : pack.episode.openedBy === 'buddy'
        ? "By one of the owner's accepted Tambo buddies, on the owner's behalf"
        : 'By the owner (marked stolen from another device)',
  );
  line('Opened at', pack.episode.openedAt);
  if (pack.episode.firstAlertAt)
    line('First alert sent', pack.episode.firstAlertAt);
  if (pack.episode.resolvedAt) line('Resolved at', pack.episode.resolvedAt);
  if (pack.episode.note) line('Owner note', pack.episode.note);

  // --- Device identity --------------------------------------------------------
  heading('Device identity');
  line(
    'Owner',
    `${pack.owner.name}${pack.owner.email ? ` <${pack.owner.email}>` : ''}`,
  );
  line(
    'Device',
    `${pack.device.make} ${pack.device.model} ("${pack.device.name}")`,
  );
  line('IMEI(s)', pack.device.imeis.join(', ') || 'Not provided by the owner');
  if (pack.device.colour) line('Colour', pack.device.colour);
  if (pack.device.purchaseInfo) line('Purchase info', pack.device.purchaseInfo);
  doc
    .fontSize(8)
    .fillColor('#444444')
    .text('IMEIs are owner-entered; Android does not permit apps to read them.')
    .fillColor('#000000')
    .fontSize(10);

  // --- Unlock attempts ---------------------------------------------------------
  heading(`Failed unlock attempts (${pack.unlockAttempts.length})`);
  if (pack.unlockAttempts.length === 0) {
    doc.text('None recorded for this episode.');
  }
  for (const attempt of pack.unlockAttempts) {
    doc.text(
      `- received ${attempt.receivedAt} (device reported ${attempt.capturedAt})`,
    );
  }

  // --- Location trail -----------------------------------------------------------
  heading(`Location trail (${pack.trail.length} points)`);

  const describePoint = (point: (typeof pack.trail)[number]): string =>
    `${point.lat}, ${point.lng}` +
    (point.accuracyM !== undefined ? ` (±${point.accuracyM}m)` : '') +
    (point.familiar
      ? ` - within familiar location "${point.familiar.label}" (~${point.familiar.distanceM}m from its centre)`
      : '');
  /** Device capture time shown when it materially differs from receipt -
   *  an offline device uploading a buffered trail must not misdate fixes. */
  const timing = (point: (typeof pack.trail)[number]): string => {
    const drift =
      new Date(point.receivedAt).getTime() -
      new Date(point.capturedAt).getTime();
    return Math.abs(drift) > 60_000
      ? `${point.receivedAt} (device reported ${point.capturedAt})`
      : point.receivedAt;
  };
  const mapsLine = (link: string): void => {
    doc.fillColor('#1a56db').text(`  ${link}`, { link });
    doc.fillColor('#000000');
  };

  const firstFix = pack.trail[0];
  const latestFix = pack.trail[pack.trail.length - 1];
  if (!firstFix || !latestFix) {
    doc.text('No location points recorded for this episode.');
  } else if (pack.trailSummary.movement === 'static') {
    // one place under attack reads differently from a phone on the move -
    // lead with the single location, but keep the full per-fix timeline
    // below: continuity of reporting (and its gaps) is itself evidence
    doc.text(
      `The device remained in one place across ${pack.trail.length} location fixes.`,
    );
    doc.text(`Location: ${describePoint(firstFix)}`);
    doc.text(
      `First fix ${firstFix.receivedAt}, latest fix ${latestFix.receivedAt}.`,
    );
    mapsLine(firstFix.mapsLink);
    doc.moveDown(0.2).text('All fixes:');
    for (const point of pack.trail) {
      doc.text(`- ${timing(point)} [${point.source}]`);
    }
  } else {
    if (pack.trailSummary.movement === 'moving') {
      doc.text('The device was MOVING during this episode.');
      if (pack.trailSummary.leftFamiliar) {
        doc
          .font('Helvetica-Bold')
          .text(
            `It left familiar location "${pack.trailSummary.leftFamiliar.label}" at ~${pack.trailSummary.leftFamiliar.at}.`,
          )
          .font('Helvetica');
      }
      doc.text(`First fix ${firstFix.receivedAt}: ${describePoint(firstFix)}`);
      mapsLine(firstFix.mapsLink);
      doc.text(
        `Latest fix ${latestFix.receivedAt}: ${describePoint(latestFix)}`,
      );
      mapsLine(latestFix.mapsLink);
      doc.moveDown(0.2).text('Full trail:');
    }
    for (const point of pack.trail) {
      doc.text(`- ${timing(point)} [${point.source}]: ${describePoint(point)}`);
      mapsLine(point.mapsLink);
    }
  }
  if (pack.trailSummary.pointsWithoutFix > 0) {
    doc
      .fontSize(8)
      .fillColor('#444444')
      .text(
        `${pack.trailSummary.pointsWithoutFix} further check-in(s) arrived ` +
          'without a usable location fix; they are itemized in the signed ' +
          'integrity manifest below.',
      )
      .fillColor('#000000')
      .fontSize(10);
  }

  // --- Snapshot sets ---------------------------------------------------------------
  heading(
    `Camera snapshots (${pack.snapshotSets.length} set${pack.snapshotSets.length === 1 ? '' : 's'}, ${pack.photos.length} frame${pack.photos.length === 1 ? '' : 's'})`,
  );
  if (pack.snapshotSets.length === 0) {
    doc.text(
      'None captured. A consumer Android install can only photograph during a failed unlock with the owner-granted overlay permission, and iOS never allows it; snapshots exist only where the phone could take them.',
    );
  }
  const TRIGGER_WORDS: Record<string, string> = {
    failed_unlock: 'a failed unlock attempt',
    episode_open: 'the theft episode opening',
    owner_request: "the owner's request",
    periodic: 'the periodic capture while stolen',
    tamper: 'tampering with the phone',
    unknown: 'an unrecorded trigger',
  };
  pack.snapshotSets.forEach((set, index) => {
    doc
      .font('Helvetica-Bold')
      .text(
        `Set ${index + 1}: ${set.receivedAt}, taken on ${TRIGGER_WORDS[set.trigger] ?? set.trigger}`,
      )
      .font('Helvetica');
    doc.text(
      `  Frames: ${set.cameras.front} front camera, ${set.cameras.back} back camera` +
        (set.cameras.unknown > 0 ? `, ${set.cameras.unknown} unspecified` : ''),
    );
    if (set.location) {
      doc.text(
        `  Location: ${set.location.lat}, ${set.location.lng}` +
          (set.location.accuracyM !== undefined
            ? ` (±${set.location.accuracyM}m)`
            : '') +
          (set.familiar
            ? ` - within familiar location "${set.familiar.label}"`
            : ''),
      );
      mapsLine(set.location.mapsLink);
    } else {
      doc.text('  Location: not reported with this set.');
    }
    for (const frame of set.frames) {
      const buffer = frameBuffers.get(frame.envelopeId);
      if (!buffer) continue;
      try {
        doc.image(buffer, { fit: [220, 220] });
        doc.fontSize(8).text(`${frame.camera} camera, ${frame.receivedAt}`);
        doc.fontSize(10).moveDown(0.4);
      } catch {
        // corrupt bytes: listed in the manifest, skipped visually
      }
    }
    for (const frame of set.frames) {
      doc
        .fontSize(8)
        .text(
          `  - ${frame.envelopeId} ${frame.camera} received ${frame.receivedAt} sha256 ${frame.sha256}` +
            (frame.hasMedia ? '' : ' (bytes not received)'),
        )
        .fontSize(10);
    }
    doc.moveDown(0.3);
  });

  // --- Action checklist ------------------------------------------------------------
  heading('What to do now (Kenya)');
  pack.actionChecklist.forEach((step, index) => {
    doc.text(`${index + 1}. ${step}`);
  });

  // --- Integrity --------------------------------------------------------------------
  heading('Integrity manifest');
  doc
    .fontSize(8)
    .fillColor('#444444')
    .text(pack.integrity.statement)
    .fillColor('#000000');
  doc.moveDown(0.3).fontSize(8);
  for (const item of pack.integrity.manifest) {
    doc.text(`${item.type}  ${item.envelopeId}  ${item.sha256}`);
  }
  doc.moveDown(0.3);
  doc.text(`Public key (Ed25519, base64): ${pack.integrity.publicKeyBase64}`);
  doc.text(`Signature (base64): ${pack.integrity.signatureBase64}`);

  doc.end();
  return done;
};
