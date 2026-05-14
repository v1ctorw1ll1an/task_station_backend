import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { join } from 'path';
import { existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';
import { PrismaService } from '../prisma/prisma.service';

const UPLOADS_ROOT = join(process.cwd(), 'uploads', 'attachments');
const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class AttachmentJanitorService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(AttachmentJanitorService.name)
    private readonly logger: PinoLogger,
  ) {}

  private get retentionMs(): number {
    const days = parseInt(
      process.env.ATTACHMENT_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS),
      10,
    );
    return days * 24 * 60 * 60 * 1000;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runDaily(): Promise<void> {
    await this.run();
  }

  // Exposed for manual/testing invocation.
  async run(): Promise<{ rowsHardDeleted: number; filesUnlinked: number; dirsRemoved: number }> {
    const cutoff = new Date(Date.now() - this.retentionMs);

    const rowsHardDeleted = await this.hardDeleteOldSoftDeleted(cutoff);
    const { filesUnlinked, dirsRemoved } = await this.sweepOrphanFiles();

    this.logger.info(
      { rowsHardDeleted, filesUnlinked, dirsRemoved, cutoff: cutoff.toISOString() },
      'Attachment GC tick complete',
    );

    return { rowsHardDeleted, filesUnlinked, dirsRemoved };
  }

  private async hardDeleteOldSoftDeleted(cutoff: Date): Promise<number> {
    const stale = await this.prisma.taskAttachment.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: { id: true, taskId: true, storedName: true, mimeType: true },
    });

    if (stale.length === 0) return 0;

    // Best-effort: physical files were unlinked at soft-delete time, but make sure
    // anything still around goes away before dropping the row.
    for (const att of stale) {
      const dir = join(UPLOADS_ROOT, att.taskId);
      this.tryUnlink(join(dir, att.storedName));
      this.tryUnlink(join(dir, 'thumbs', this.thumbNameFor(att.storedName, att.mimeType)));
    }

    const result = await this.prisma.taskAttachment.deleteMany({
      where: { id: { in: stale.map((s) => s.id) } },
    });
    return result.count;
  }

  private async sweepOrphanFiles(): Promise<{ filesUnlinked: number; dirsRemoved: number }> {
    if (!existsSync(UPLOADS_ROOT)) return { filesUnlinked: 0, dirsRemoved: 0 };

    // Build the set of files that should exist on disk: every active attachment
    // (deletedAt: null) — full path of the main file plus its thumbnail when applicable.
    const active = await this.prisma.taskAttachment.findMany({
      where: { deletedAt: null },
      select: { taskId: true, storedName: true, mimeType: true, hasThumbnail: true },
    });

    const expected = new Set<string>();
    for (const att of active) {
      const dir = join(UPLOADS_ROOT, att.taskId);
      expected.add(join(dir, att.storedName));
      if (att.hasThumbnail) {
        expected.add(join(dir, 'thumbs', this.thumbNameFor(att.storedName, att.mimeType)));
      }
    }

    let filesUnlinked = 0;
    let dirsRemoved = 0;

    const taskDirs = readdirSync(UPLOADS_ROOT).filter((entry) => {
      try {
        return statSync(join(UPLOADS_ROOT, entry)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const taskId of taskDirs) {
      const dir = join(UPLOADS_ROOT, taskId);
      const thumbsDir = join(dir, 'thumbs');

      // Sweep thumbs first, then main dir, then try to remove empty dirs.
      filesUnlinked += this.sweepDir(thumbsDir, expected);
      filesUnlinked += this.sweepDir(dir, expected, /* skipSubdir */ 'thumbs');

      if (this.tryRemoveDirIfEmpty(thumbsDir)) dirsRemoved++;
      if (this.tryRemoveDirIfEmpty(dir)) dirsRemoved++;
    }

    return { filesUnlinked, dirsRemoved };
  }

  private sweepDir(dir: string, expected: Set<string>, skipSubdir?: string): number {
    if (!existsSync(dir)) return 0;
    let unlinked = 0;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (skipSubdir && entry === skipSubdir) continue;
      const full = join(dir, entry);
      let isFile = false;
      try {
        isFile = statSync(full).isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;
      if (!expected.has(full)) {
        this.tryUnlink(full);
        unlinked++;
      }
    }
    return unlinked;
  }

  private tryRemoveDirIfEmpty(dir: string): boolean {
    if (!existsSync(dir)) return false;
    try {
      const entries = readdirSync(dir);
      if (entries.length === 0) {
        rmdirSync(dir);
        return true;
      }
    } catch (err) {
      this.logger.warn({ dir, err: (err as Error).message }, 'Failed to remove empty dir');
    }
    return false;
  }

  private thumbNameFor(storedName: string, mimeType: string): string {
    return mimeType.startsWith('video/') ? storedName.replace(/\.[^.]+$/, '.jpg') : storedName;
  }

  private tryUnlink(path: string): void {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch (err) {
      this.logger.warn({ path, err: (err as Error).message }, 'Failed to unlink file during GC');
    }
  }
}
