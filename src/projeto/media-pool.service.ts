import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import Piscina from 'piscina';
import { cpus } from 'os';
import { join } from 'path';
import type { MediaResult, MediaTask } from './workers/media-worker';

const WORKER_FILE = join(__dirname, 'workers', 'media-worker.js');

@Injectable()
export class MediaPoolService implements OnModuleInit, OnModuleDestroy {
  private pool!: Piscina;

  constructor(
    @InjectPinoLogger(MediaPoolService.name)
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const maxThreads = Math.max(1, cpus().length - 1);
    this.pool = new Piscina({
      filename: WORKER_FILE,
      maxThreads,
      minThreads: 0,
      idleTimeout: 30_000,
    });
    this.logger.info({ workerFile: WORKER_FILE, maxThreads }, 'Media worker pool initialized');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.destroy();
    }
  }

  run<T extends MediaResult>(task: MediaTask): Promise<T> {
    return this.pool.run(task) as Promise<T>;
  }

  processImage(args: {
    buffer: Buffer;
    fullPath: string;
    thumbPath: string;
    maxPx: number;
    quality: number;
    thumbMaxPx: number;
    thumbQuality: number;
  }) {
    return this.run<Extract<MediaResult, { kind: 'processImage' }>>({
      kind: 'processImage',
      ...args,
    });
  }

  processVideo(args: { buffer: Buffer; fullPath: string; thumbPath: string; thumbMaxPx: number }) {
    return this.run<Extract<MediaResult, { kind: 'processVideo' }>>({
      kind: 'processVideo',
      ...args,
    });
  }

  writeBytes(args: { buffer: Buffer; fullPath: string }) {
    return this.run<Extract<MediaResult, { kind: 'writeBytes' }>>({
      kind: 'writeBytes',
      ...args,
    });
  }
}
