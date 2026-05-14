import { writeFile, statSync } from 'fs';
import { promisify } from 'util';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';

const writeFileAsync = promisify(writeFile);

export type MediaTask =
  | {
      kind: 'processImage';
      buffer: Buffer;
      fullPath: string;
      thumbPath: string;
      maxPx: number;
      quality: number;
      thumbMaxPx: number;
      thumbQuality: number;
    }
  | {
      kind: 'processVideo';
      buffer: Buffer;
      fullPath: string;
      thumbPath: string;
      thumbMaxPx: number;
    }
  | {
      kind: 'writeBytes';
      buffer: Buffer;
      fullPath: string;
    };

export type MediaResult =
  | { kind: 'processImage'; processedSize: number; hasThumbnail: true }
  | { kind: 'processVideo'; processedSize: number; hasThumbnail: boolean }
  | { kind: 'writeBytes' };

async function processImage(task: Extract<MediaTask, { kind: 'processImage' }>) {
  await sharp(task.buffer)
    .rotate()
    .resize(task.maxPx, task.maxPx, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: task.quality })
    .toFile(task.fullPath);

  await sharp(task.buffer)
    .rotate()
    .resize(task.thumbMaxPx, task.thumbMaxPx, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: task.thumbQuality })
    .toFile(task.thumbPath);

  return {
    kind: 'processImage' as const,
    processedSize: statSync(task.fullPath).size,
    hasThumbnail: true as const,
  };
}

function extractVideoThumbnail(
  videoPath: string,
  thumbPath: string,
  thumbMaxPx: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['00:00:01'],
        filename: thumbPath,
        size: `${thumbMaxPx}x?`,
      })
      .on('end', () => resolve(true))
      .on('error', () => resolve(false));
  });
}

async function processVideo(task: Extract<MediaTask, { kind: 'processVideo' }>) {
  await writeFileAsync(task.fullPath, task.buffer);
  const hasThumbnail = await extractVideoThumbnail(task.fullPath, task.thumbPath, task.thumbMaxPx);
  return {
    kind: 'processVideo' as const,
    processedSize: task.buffer.length,
    hasThumbnail,
  };
}

async function writeBytes(task: Extract<MediaTask, { kind: 'writeBytes' }>) {
  await writeFileAsync(task.fullPath, task.buffer);
  return { kind: 'writeBytes' as const };
}

export default async function run(task: MediaTask): Promise<MediaResult> {
  switch (task.kind) {
    case 'processImage':
      return processImage(task);
    case 'processVideo':
      return processVideo(task);
    case 'writeBytes':
      return writeBytes(task);
  }
}
