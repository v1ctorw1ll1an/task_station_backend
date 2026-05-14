import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { join } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { MediaPoolService } from './media-pool.service';
import { ProjetoRepository } from './projeto.repository';

// ── Limits ───────────────────────────────────────────────────────────────────

const IMAGE_MAX_BYTES = 16 * 1024 * 1024; // 16 MB
const VIDEO_MAX_BYTES = 64 * 1024 * 1024; // 64 MB
const PDF_MAX_BYTES = 32 * 1024 * 1024; // 32 MB
const IMAGE_MAX_COUNT = 3;
const VIDEO_MAX_COUNT = 1;
const PDF_MAX_COUNT = 1;
const IMAGE_MAX_PX = 1920;
const IMAGE_QUALITY = 85;
const THUMB_MAX_PX = 400;
const THUMB_QUALITY = 75;

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
]);

const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]);

const ALLOWED_PDF_TYPES = new Set(['application/pdf']);

// ── Paths ─────────────────────────────────────────────────────────────────────

const UPLOADS_ROOT = join(process.cwd(), 'uploads', 'attachments');

function taskDir(taskId: string) {
  return join(UPLOADS_ROOT, taskId);
}

function thumbDir(taskId: string) {
  return join(UPLOADS_ROOT, taskId, 'thumbs');
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

@Injectable()
export class AttachmentService {
  constructor(
    private readonly repo: ProjetoRepository,
    private readonly mediaPool: MediaPoolService,
    @InjectPinoLogger(AttachmentService.name)
    private readonly logger: PinoLogger,
  ) {}

  // ── Helpers ────────────────────────────────────────────────────────────────

  private isImage(mime: string) {
    return ALLOWED_IMAGE_TYPES.has(mime);
  }

  private isVideo(mime: string) {
    return ALLOWED_VIDEO_TYPES.has(mime);
  }

  private isPdf(mime: string) {
    return ALLOWED_PDF_TYPES.has(mime);
  }

  private validateFile(file: Express.Multer.File) {
    const mime = file.mimetype;
    if (!this.isImage(mime) && !this.isVideo(mime) && !this.isPdf(mime)) {
      throw new UnsupportedMediaTypeException(
        'Tipo de arquivo não suportado. Envie uma imagem, vídeo ou PDF.',
      );
    }
    if (this.isImage(mime) && file.size > IMAGE_MAX_BYTES) {
      throw new PayloadTooLargeException('Imagem excede o limite de 16 MB.');
    }
    if (this.isVideo(mime) && file.size > VIDEO_MAX_BYTES) {
      throw new PayloadTooLargeException('Vídeo excede o limite de 64 MB.');
    }
    if (this.isPdf(mime) && file.size > PDF_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `PDF excede o limite de ${PDF_MAX_BYTES / 1024 / 1024} MB.`,
      );
    }
  }

  // ── Media processing (delegated to worker thread pool) ────────────────────

  private async processImage(
    buffer: Buffer,
    destDir: string,
    thumbDestDir: string,
    uuid: string,
  ): Promise<{ storedName: string; processedSize: number; hasThumbnail: boolean }> {
    ensureDir(destDir);
    ensureDir(thumbDestDir);

    const storedName = `${uuid}.webp`;
    const result = await this.mediaPool.processImage({
      buffer,
      fullPath: join(destDir, storedName),
      thumbPath: join(thumbDestDir, storedName),
      maxPx: IMAGE_MAX_PX,
      quality: IMAGE_QUALITY,
      thumbMaxPx: THUMB_MAX_PX,
      thumbQuality: THUMB_QUALITY,
    });

    return { storedName, processedSize: result.processedSize, hasThumbnail: result.hasThumbnail };
  }

  private async processVideo(
    buffer: Buffer,
    destDir: string,
    thumbDestDir: string,
    uuid: string,
    originalName: string,
  ): Promise<{ storedName: string; processedSize: number; hasThumbnail: boolean }> {
    ensureDir(destDir);
    ensureDir(thumbDestDir);

    const ext = originalName.split('.').pop()?.toLowerCase() ?? 'mp4';
    const storedName = `${uuid}.${ext}`;
    const thumbName = `${uuid}.jpg`;

    const result = await this.mediaPool.processVideo({
      buffer,
      fullPath: join(destDir, storedName),
      thumbPath: join(thumbDestDir, thumbName),
      thumbMaxPx: THUMB_MAX_PX,
    });

    if (!result.hasThumbnail) {
      this.logger.warn({ storedName }, 'Video thumbnail extraction failed — skipping');
    }

    return { storedName, processedSize: result.processedSize, hasThumbnail: result.hasThumbnail };
  }

  private async processPdf(
    buffer: Buffer,
    destDir: string,
    uuid: string,
  ): Promise<{ storedName: string; processedSize: number; hasThumbnail: boolean }> {
    ensureDir(destDir);

    const storedName = `${uuid}.pdf`;
    await this.mediaPool.writeBytes({ buffer, fullPath: join(destDir, storedName) });

    return { storedName, processedSize: buffer.length, hasThumbnail: false };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async upload(taskId: string, file: Express.Multer.File, uploadedById: string) {
    this.validateFile(file);

    const mime = file.mimetype;

    if (this.isImage(mime)) {
      const count = await this.repo.countAttachments(taskId, 'image/');
      if (count >= IMAGE_MAX_COUNT) {
        throw new BadRequestException(`Limite de ${IMAGE_MAX_COUNT} imagens por task atingido.`);
      }
    } else if (this.isVideo(mime)) {
      const count = await this.repo.countAttachments(taskId, 'video/');
      if (count >= VIDEO_MAX_COUNT) {
        throw new BadRequestException(`Limite de ${VIDEO_MAX_COUNT} vídeo por task atingido.`);
      }
    } else {
      const count = await this.repo.countAttachments(taskId, 'application/pdf');
      if (count >= PDF_MAX_COUNT) {
        throw new BadRequestException(`Limite de ${PDF_MAX_COUNT} PDF por task atingido.`);
      }
    }

    const uuid = randomUUID();
    const dir = taskDir(taskId);
    const tDir = thumbDir(taskId);

    let storedName: string;
    let processedSize: number;
    let hasThumbnail: boolean;

    if (this.isImage(mime)) {
      ({ storedName, processedSize, hasThumbnail } = await this.processImage(
        file.buffer,
        dir,
        tDir,
        uuid,
      ));
    } else if (this.isVideo(mime)) {
      ({ storedName, processedSize, hasThumbnail } = await this.processVideo(
        file.buffer,
        dir,
        tDir,
        uuid,
        file.originalname,
      ));
    } else {
      ({ storedName, processedSize, hasThumbnail } = await this.processPdf(file.buffer, dir, uuid));
    }

    const attachment = await this.repo.createAttachment({
      taskId,
      uploadedById,
      originalName: file.originalname,
      storedName,
      mimeType: mime,
      size: processedSize,
      hasThumbnail,
    });

    await this.repo.createTaskHistories([
      {
        taskId,
        userId: uploadedById,
        field: 'attachment_added',
        oldValue: null,
        newValue: file.originalname,
      },
    ]);

    this.logger.info({ taskId, attachmentId: attachment.id, uploadedById }, 'Attachment uploaded');
    return attachment;
  }

  async findAttachmentById(attachmentId: string, taskId: string) {
    return this.repo.findAttachmentById(attachmentId, taskId);
  }

  async listAttachments(taskId: string) {
    return this.repo.findAttachments(taskId);
  }

  serveFile(taskId: string, storedName: string): string {
    const filePath = join(taskDir(taskId), storedName);
    if (!existsSync(filePath)) throw new NotFoundException('Arquivo não encontrado');
    return filePath;
  }

  serveThumbnail(taskId: string, storedName: string, mimeType: string): string {
    if (this.isPdf(mimeType)) {
      throw new NotFoundException('PDF não possui thumbnail');
    }
    const isVideo = this.isVideo(mimeType);
    const thumbName = isVideo ? storedName.replace(/\.[^.]+$/, '.jpg') : storedName;
    const thumbPath = join(thumbDir(taskId), thumbName);
    if (!existsSync(thumbPath)) throw new NotFoundException('Thumbnail não encontrado');
    return thumbPath;
  }

  async deleteAttachment(attachmentId: string, taskId: string, userId: string) {
    const att = await this.repo.findAttachmentById(attachmentId, taskId);
    if (!att) throw new NotFoundException('Anexo não encontrado');

    // Remove files from disk
    const fullPath = join(taskDir(taskId), att.storedName);
    const thumbName = att.mimeType.startsWith('video/')
      ? att.storedName.replace(/\.[^.]+$/, '.jpg')
      : att.storedName;
    const thumbPath = join(thumbDir(taskId), thumbName);

    [fullPath, thumbPath].forEach((p) => {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    });

    await this.repo.softDeleteAttachment(attachmentId);

    await this.repo.createTaskHistories([
      {
        taskId,
        userId,
        field: 'attachment_removed',
        oldValue: att.originalName,
        newValue: null,
      },
    ]);

    this.logger.info({ taskId, attachmentId, userId }, 'Attachment deleted');
  }
}
