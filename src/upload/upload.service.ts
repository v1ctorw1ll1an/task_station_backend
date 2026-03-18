import {
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { join } from 'path';
import { createReadStream, existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import type { Response } from 'express';

const BROADCASTS_DIR = join(process.cwd(), 'uploads', 'broadcasts');
const MAX_BYTES = 16 * 1024 * 1024;
const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
]);

@Injectable()
export class UploadService {
  constructor(@InjectPinoLogger(UploadService.name) private readonly logger: PinoLogger) {}

  async uploadImage(file: Express.Multer.File): Promise<{ url: string }> {
    if (!ALLOWED.has(file.mimetype))
      throw new UnsupportedMediaTypeException('Tipo não suportado. Envie uma imagem.');
    if (file.size > MAX_BYTES)
      throw new PayloadTooLargeException('Imagem excede o limite de 16 MB.');

    if (!existsSync(BROADCASTS_DIR)) mkdirSync(BROADCASTS_DIR, { recursive: true });

    const uuid = randomUUID();
    const filename = `${uuid}.webp`;
    await sharp(file.buffer)
      .rotate()
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(join(BROADCASTS_DIR, filename));

    this.logger.info({ filename, mimetype: file.mimetype }, 'Broadcast image uploaded');
    return { url: `/api/files/uploads/image/${filename}` };
  }

  serveImage(filename: string, res: Response): void {
    const filePath = join(BROADCASTS_DIR, filename);
    if (!existsSync(filePath)) throw new NotFoundException('Imagem não encontrada');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    createReadStream(filePath).pipe(res);
  }
}
