/**
 * Fork: Apple Mail attachments on demand (src/core/mail-attachments.ts,
 * src/core/ops/mail-attachments.ts). Mail.app is replaced by a fake JXA
 * runner that "saves" attachments by writing bytes to the requested path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import {
  type JxaRunner,
  MailAttachmentError,
  isPersonalMessage,
  isPersonalPage,
  listMailAttachments,
  messageRefFromFrontmatter,
  resolveDestDir,
  safeAttachmentFilename,
  saveMailAttachments,
  selectAttachments,
} from '../src/core/mail-attachments.ts';
import { operationsByName } from '../src/core/operations.ts';

const REF = { account: 'me@example.edu', messageId: 'abc@mail.example', mailbox: 'Inbox' };

const ENVELOPE = { sender: 'Office <office@other.edu>', recipients: ['me@example.edu', 'you@example.edu'], accountAddresses: ['me@example.edu'] };

function fakeMail(files: { name: string; bytes: string }[], calls: unknown[] = [], envelope = ENVELOPE): JxaRunner {
  return async (_script, arg) => {
    const p = JSON.parse(arg);
    calls.push(p);
    if (p.save) expect(Array.isArray(p.save.refuseIfPersonal)).toBe(true);
    const saved = (p.save?.indices ?? []).map((i: number) => {
      const out = `${p.save.dir}/${i}`;
      writeFileSync(out, files[i].bytes);
      return { index: i, path: out };
    });
    return JSON.stringify({
      subject: 'Week 3',
      mailbox: 'Archive',
      ...envelope,
      attachments: files.map((f, index) => ({ index, name: f.name, size: f.bytes.length, downloaded: false })),
      saved,
    });
  };
}

let dest: string;
beforeEach(() => { dest = mkdtempSync(join(tmpdir(), 'mail-att-test-')); });
afterEach(() => { rmSync(dest, { recursive: true, force: true }); });

describe('messageRefFromFrontmatter', () => {
  test('reads the platform/mail frontmatter', () => {
    expect(messageRefFromFrontmatter({
      email_account: 'me@example.edu',
      email_message_id: 'abc@mail.example',
      email_rfc_message_id: 'abc@mail.example',
      email_mailbox: 'Inbox',
    })).toEqual(REF);
  });

  test('rejects non-email pages and synthetic ids', () => {
    expect(() => messageRefFromFrontmatter({ title: 'x' })).toThrow(MailAttachmentError);
    expect(() => messageRefFromFrontmatter({ email_account: 'a', email_message_id: 'synthetic-1234' }))
      .toThrow(/no Message-ID/);
  });
});

describe('safeAttachmentFilename', () => {
  test('keeps ordinary names', () => {
    expect(safeAttachmentFilename('Week 3 Slides (final).pptx', 0)).toBe('Week 3 Slides (final).pptx');
  });

  test('reduces hostile names to one path component', () => {
    for (const name of ['../../.zshrc', '/etc/passwd', 'a\\b', '.hidden', 'x\u0000y', 'a:b']) {
      const safe = safeAttachmentFilename(name, 1);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe.startsWith('.')).toBe(false);
      expect(safe).not.toMatch(/[\u0000-\u001f]/);
    }
    expect(safeAttachmentFilename('', 4)).toBe('attachment-4');
    expect(safeAttachmentFilename('...', 2)).toBe('attachment-2');
  });

  test('caps long names but keeps the extension', () => {
    const safe = safeAttachmentFilename('x'.repeat(400) + '.pdf', 0);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(200);
    expect(safe.endsWith('.pdf')).toBe(true);
  });
});

describe('selectAttachments', () => {
  const atts = ['a.pdf', 'image001.png', 'IMAGE001.png'].map((name, index) =>
    ({ index, name, size_bytes: 1, mime_type: null, downloaded: true }));

  test('by name, index, or all', () => {
    expect(selectAttachments(atts, { name: 'A.PDF' })).toEqual([0]);
    expect(selectAttachments(atts, { index: 2 })).toEqual([2]);
    expect(selectAttachments(atts, { all: true })).toEqual([0, 1, 2]);
  });

  test('ambiguous names ask for an index', () => {
    expect(() => selectAttachments(atts, { name: 'image001.png' })).toThrow(/pass index/);
  });

  test('missing selection or attachment fails', () => {
    expect(() => selectAttachments(atts, {})).toThrow(/Choose an attachment/);
    expect(() => selectAttachments(atts, { name: 'nope.pdf' })).toThrow(/Attachments: a.pdf/);
    expect(() => selectAttachments(atts, { index: 9 })).toThrow(/index 9/);
  });
});

describe('resolveDestDir', () => {
  test('requires an absolute path; expands ~', () => {
    expect(() => resolveDestDir('relative/dir')).toThrow(/absolute/);
    expect(resolveDestDir('~/x')).toBe(join(require('os').homedir(), 'x'));
    expect(resolveDestDir(undefined)).toContain('gbrain-mail-attachments');
  });
});

describe('list / save through Mail', () => {
  test('list infers MIME types and downloads nothing', async () => {
    const calls: any[] = [];
    const listed = await listMailAttachments(REF, [], fakeMail([{ name: 'Slides.pptx', bytes: 'pp' }], calls));
    expect(listed.mailbox).toBe('Archive');
    expect(listed.attachments[0]).toMatchObject({
      name: 'Slides.pptx',
      size_bytes: 2,
      mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    expect(calls[0].save).toBeUndefined();
  });

  test('saves only the chosen file, sanitized, and never overwrites', async () => {
    const calls: any[] = [];
    const mail = fakeMail([{ name: 'syllabus.pdf', bytes: '%PDF-1' }, { name: '../evil.sh', bytes: 'rm -rf' }], calls);

    const first = await saveMailAttachments(REF, { name: 'syllabus.pdf' }, dest, [], mail);
    expect(first.saved.map(s => s.path)).toEqual([join(dest, 'syllabus.pdf')]);
    expect(calls[1].save.indices).toEqual([0]);
    expect(readFileSync(join(dest, 'syllabus.pdf'), 'utf8')).toBe('%PDF-1');
    expect(first.saved[0].sha256).toBe(createHash('sha256').update('%PDF-1').digest('hex'));

    const again = await saveMailAttachments(REF, { all: true }, dest, [], mail);
    const paths = again.saved.map(s => s.path);
    expect(paths[0]).toBe(join(dest, 'syllabus (1).pdf'));
    expect(dirname(paths[1])).toBe(dest);
    expect(readdirSync(dest).sort()).toEqual(['_evil.sh', 'syllabus (1).pdf', 'syllabus.pdf'].sort());
    // Mail's staging dir is removed.
    expect(existsSync(calls[3].save.dir)).toBe(false);
  });

  test('reports attachments Mail failed to save', async () => {
    const mail: JxaRunner = async (_s, arg) => {
      const p = JSON.parse(arg);
      return JSON.stringify({
        subject: 's', mailbox: 'Inbox',
        attachments: [{ index: 0, name: 'big.zip', size: 9, downloaded: false }],
        saved: p.save ? [{ index: 0, error: 'Error: AppleEvent timed out.' }] : [],
      });
    };
    const result = await saveMailAttachments(REF, { index: 0 }, dest, [], mail);
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([{ index: 0, name: 'big.zip', error: 'Error: AppleEvent timed out.' }]);
  });

  test('not-found from Mail surfaces as a typed error', async () => {
    const mail: JxaRunner = async () => JSON.stringify({ error: 'not_found', message: 'Message not found' });
    await expect(listMailAttachments(REF, [], mail)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('personal email rule', () => {
  const own = ['grewestf@ttu.edu'];
  const env = (sender: string, recipients: string[]) => ({ sender, recipients, accountAddresses: own });

  test('TTU sender to only me is personal', () => {
    expect(isPersonalMessage(env('"Robb, Andrew" <anrobb@ttu.edu>', ['grewestf@ttu.edu']), ['ttu.edu'])).toBe(true);
    expect(isPersonalMessage(env('sds@TTU.edu', ['GREWESTF@ttu.edu']), ['ttu.edu'])).toBe(true);
  });

  test('anyone else on To/Cc, other domains, subdomains, or no rule: not personal', () => {
    expect(isPersonalMessage(env('prof@ttu.edu', ['grewestf@ttu.edu', 'class@ttu.edu']), ['ttu.edu'])).toBe(false);
    expect(isPersonalMessage(env('prof@ttu.edu', ['class-list@ttu.edu']), ['ttu.edu'])).toBe(false);
    expect(isPersonalMessage(env('news@mailers.ttu.edu', ['grewestf@ttu.edu']), ['ttu.edu'])).toBe(false);
    expect(isPersonalMessage(env('a@gmail.com', ['grewestf@ttu.edu']), ['ttu.edu'])).toBe(false);
    expect(isPersonalMessage(env('prof@ttu.edu', []), ['ttu.edu'])).toBe(false);
    expect(isPersonalMessage(env('prof@ttu.edu', ['grewestf@ttu.edu']), [])).toBe(false);
  });

  test('page flag from platform/mail', () => {
    expect(isPersonalPage({ email_personal: true })).toBe(true);
    expect(isPersonalPage({}, ['email', 'email-personal'])).toBe(true);
    expect(isPersonalPage({ tags: ['email-personal'] })).toBe(true);
    expect(isPersonalPage({ email_personal: false }, ['email'])).toBe(false);
  });

  test('list reports personal; save refuses before asking Mail to save anything', async () => {
    const calls: any[] = [];
    const mail = fakeMail([{ name: 'letter.pdf', bytes: 'x' }], calls,
      { sender: 'sbs@ttu.edu', recipients: ['me@example.edu'], accountAddresses: ['me@example.edu'] });
    const listed = await listMailAttachments(REF, ['ttu.edu'], mail);
    expect(listed.personal).toBe(true);
    await expect(saveMailAttachments(REF, { all: true }, dest, ['ttu.edu'], mail)).rejects.toMatchObject({ code: 'personal' });
    expect(calls.every(c => !c.save)).toBe(true);
    expect(readdirSync(dest)).toEqual([]);
  });

  test("Mail's own re-check at save time is honoured", async () => {
    let n = 0;
    const mail: JxaRunner = async (_s, arg) => {
      const p = JSON.parse(arg);
      n++;
      if (p.save) {
        expect(p.save.refuseIfPersonal).toEqual(['ttu.edu']);
        return JSON.stringify({ error: 'personal', message: 'personal email' });
      }
      return JSON.stringify({ subject: 's', mailbox: 'Inbox', ...ENVELOPE,
        attachments: [{ index: 0, name: 'a.pdf', size: 1, downloaded: true }], saved: [] });
    };
    await expect(saveMailAttachments(REF, { index: 0 }, dest, [' TTU.edu '], mail)).rejects.toMatchObject({ code: 'personal' });
    expect(n).toBe(2);
  });
});

describe('ops registration', () => {
  test('both ops are local-only and registered', () => {
    for (const name of ['list_email_attachments', 'save_email_attachment']) {
      const op = operationsByName[name];
      expect(op).toBeDefined();
      expect(op.localOnly).toBe(true);
    }
    expect(operationsByName.list_email_attachments.annotations?.readOnlyHint).toBe(true);
    for (const name of ['list_email_attachments', 'save_email_attachment']) {
      expect(operationsByName[name].description).toContain('email-personal');
    }
  });

  test('save refuses a page flagged personal without touching Mail', async () => {
    const op = operationsByName.save_email_attachment;
    const ctx = {
      config: {},
      engine: {
        getPage: async () => ({ slug: 'email/messages/x', frontmatter: {
          email_account: 'me@example.edu', email_message_id: 'id@x', email_personal: true } }),
        getTags: async () => ['email-personal'],
      },
    } as any;
    await expect(op.handler(ctx, { slug: 'email/messages/x', all: true })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('without slug, message_id and account are required', async () => {
    const op = operationsByName.save_email_attachment;
    await expect(op.handler({} as any, { message_id: 'x' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
