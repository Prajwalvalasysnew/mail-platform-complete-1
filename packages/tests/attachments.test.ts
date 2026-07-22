import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClamAvAttachmentScanner,
  scanAttachmentsForMalware,
  setAttachmentMalwareScanner,
  validateAttachments,
  type AttachmentMalwareScanner,
} from '@platform/shared';

const pdf = () => validateAttachments([{
  filename: 'invoice.pdf',
  content: Buffer.from('%PDF-1.4\nclean invoice').toString('base64'),
}]);

afterEach(() => {
  setAttachmentMalwareScanner(undefined);
  delete process.env.ATTACHMENT_SCAN_REQUIRED;
  delete process.env.ATTACHMENT_SCAN_FAILURE_POLICY;
});

describe('attachment content and malware scanning', () => {
  it('rejects renamed PE and ELF binaries by file signature', () => {
    const pe = validateAttachments([{ filename: 'safe.pdf', content: Buffer.from('MZ executable').toString('base64') }]);
    const elf = validateAttachments([{ filename: 'safe.txt', content: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]).toString('base64') }]);
    expect(pe).toMatchObject({ ok: false, error: 'attachment_rejected' });
    expect(elf).toMatchObject({ ok: false, error: 'attachment_rejected' });
  });

  it('rejects an infected result and does not expose scanner details as success', async () => {
    const validated = pdf();
    expect(validated.ok).toBe(true);
    const scanner: AttachmentMalwareScanner = {
      name: 'fake-av',
      async scan() { return { clean: false, threat: 'Eicar-Test-Signature' }; },
    };
    setAttachmentMalwareScanner(scanner);
    await expect(scanAttachmentsForMalware(validated.ok ? validated.attachments : [])).resolves.toMatchObject({
      ok: false,
      error: 'attachment_malware_detected',
      threat: 'Eicar-Test-Signature',
    });
  });

  it('fails closed on scanner errors unless an optional deployment explicitly allows bypass', async () => {
    const validated = pdf();
    const attachments = validated.ok ? validated.attachments : [];
    setAttachmentMalwareScanner({ name: 'offline-av', async scan() { throw new Error('offline'); } });
    await expect(scanAttachmentsForMalware(attachments)).resolves.toMatchObject({ ok: false, error: 'attachment_scan_unavailable' });
    await expect(scanAttachmentsForMalware(attachments, { failurePolicy: 'allow' })).resolves.toEqual({ ok: true, scanned: true });
    await expect(scanAttachmentsForMalware(attachments, { failurePolicy: 'allow', required: true })).resolves.toMatchObject({ ok: false, error: 'attachment_scan_unavailable' });
  });

  it('speaks the bounded clamd INSTREAM protocol', async () => {
    const server = net.createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= 4 && received.subarray(-4).equals(Buffer.alloc(4))) {
          expect(received.subarray(0, 10).toString()).toBe('zINSTREAM\0');
          socket.end('stream: Eicar-Test-Signature FOUND\0');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as net.AddressInfo;
    try {
      const scanner = new ClamAvAttachmentScanner('127.0.0.1', address.port, 2_000);
      await expect(scanner.scan({ filename: 'eicar.txt', content_type: 'text/plain', content: Buffer.from('EICAR') }))
        .resolves.toEqual({ clean: false, threat: 'Eicar-Test-Signature' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
