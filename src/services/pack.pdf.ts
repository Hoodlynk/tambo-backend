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

/** Photos embedded when the bytes are a format pdfkit accepts; capped at 4. */
const loadEmbeddablePhotos = async (pack: EvidencePack): Promise<Buffer[]> => {
  const buffers: Buffer[] = [];

  for (const photo of pack.photos.slice(0, 4)) {
    const envelope = await EvidenceEnvelope.findOne({
      envelopeId: photo.envelopeId,
    }).select('mediaFileId mediaContentType');
    if (!envelope?.mediaFileId) continue;
    if (!/^image\/(jpe?g|png)$/i.test(envelope.mediaContentType ?? ''))
      continue;

    try {
      buffers.push(await streamToBuffer(openMedia(envelope.mediaFileId)));
    } catch {
      // an unreadable photo must never sink the whole report
    }
  }

  return buffers;
};

export const renderPackPdf = async (pack: EvidencePack): Promise<Buffer> => {
  const photoBuffers = await loadEmbeddablePhotos(pack);

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
  if (pack.trail.length === 0) {
    doc.text('No location points recorded for this episode.');
  }
  for (const point of pack.trail) {
    const coords =
      point.lat !== undefined && point.lng !== undefined
        ? `${point.lat}, ${point.lng}${point.accuracy !== undefined ? ` (±${point.accuracy}m)` : ''}`
        : 'no fix';
    doc.text(`- ${point.receivedAt}: ${coords}`);
    if (point.mapsLink) {
      doc
        .fillColor('#1a56db')
        .text(`  ${point.mapsLink}`, { link: point.mapsLink });
      doc.fillColor('#000000');
    }
  }

  // --- Photos --------------------------------------------------------------------
  heading(`Photos (${pack.photos.length})`);
  if (pack.photos.length === 0) {
    doc.text(
      'None captured. Android does not allow background camera capture; photos exist only if the compliant foreground path ran.',
    );
  }
  for (const buffer of photoBuffers) {
    try {
      doc.image(buffer, { fit: [220, 220] });
      doc.moveDown(0.4);
    } catch {
      // corrupt bytes: listed in the manifest, skipped visually
    }
  }
  for (const photo of pack.photos) {
    doc
      .fontSize(8)
      .text(
        `- ${photo.envelopeId} received ${photo.receivedAt} sha256 ${photo.sha256}`,
      )
      .fontSize(10);
  }

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
