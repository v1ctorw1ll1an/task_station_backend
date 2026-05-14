import {
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { UploadService } from './upload.service';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  createReadStream: jest.fn().mockReturnValue({ pipe: jest.fn() }),
}));

jest.mock('sharp', () => {
  const chain = {
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
    toFile: jest.fn().mockResolvedValue({ size: 1234 }),
  };
  return Object.assign(
    jest.fn(() => chain),
    { __chain: chain },
  );
});

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: () => 'fixed-uuid',
}));

import * as fs from 'fs';
import sharp from 'sharp';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeService() {
  const logger = makeLogger();
  return { service: new UploadService(logger as any), logger };
}

function imageFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'pic.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 1000,
    buffer: Buffer.from('img'),
    ...overrides,
  } as any;
}

beforeEach(() => {
  (fs.existsSync as jest.Mock).mockReset().mockReturnValue(true);
  (fs.mkdirSync as jest.Mock).mockReset();
  const chain = (sharp as any).__chain;
  chain.rotate.mockClear();
  chain.resize.mockClear();
  chain.webp.mockClear();
  chain.toFile.mockClear();
  (sharp as unknown as jest.Mock).mockClear();
});

// ── uploadImage ────────────────────────────────────────────────────────────────

describe('UploadService.uploadImage', () => {
  it('UnsupportedMediaTypeException para mime inválido', async () => {
    const { service } = makeService();
    await expect(
      service.uploadImage(imageFile({ mimetype: 'application/pdf' })),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('PayloadTooLargeException quando arquivo > 16MB', async () => {
    const { service } = makeService();
    await expect(service.uploadImage(imageFile({ size: 17 * 1024 * 1024 }))).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });

  it('aceita mimes válidos (jpeg, png, gif, webp, avif, heic, heif)', async () => {
    const { service } = makeService();
    for (const mime of [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/avif',
      'image/heic',
      'image/heif',
    ]) {
      await expect(service.uploadImage(imageFile({ mimetype: mime }))).resolves.toEqual(
        expect.objectContaining({ url: expect.stringMatching(/^\/api\/files\/uploads\/image\//) }),
      );
    }
  });

  it('cria diretório de broadcasts quando não existe', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const { service } = makeService();
    await service.uploadImage(imageFile());
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('processa via sharp com pipeline rotate→resize→webp', async () => {
    const { service } = makeService();
    await service.uploadImage(imageFile());

    const chain = (sharp as any).__chain;
    expect(sharp).toHaveBeenCalledWith(expect.any(Buffer));
    expect(chain.rotate).toHaveBeenCalled();
    expect(chain.resize).toHaveBeenCalledWith(1920, 1920, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(chain.webp).toHaveBeenCalledWith({ quality: 85 });
    expect(chain.toFile).toHaveBeenCalled();
  });

  it('retorna URL com UUID fixo e extensão .webp', async () => {
    const { service } = makeService();
    const result = await service.uploadImage(imageFile());
    expect(result.url).toBe('/api/files/uploads/image/fixed-uuid.webp');
  });

  it('loga info em caso de sucesso', async () => {
    const { service, logger } = makeService();
    await service.uploadImage(imageFile());
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'fixed-uuid.webp', mimetype: 'image/png' }),
      expect.stringContaining('Broadcast image uploaded'),
    );
  });
});

// ── serveImage ─────────────────────────────────────────────────────────────────

describe('UploadService.serveImage', () => {
  function makeRes() {
    return { setHeader: jest.fn() } as any;
  }

  it('NotFoundException quando arquivo não existe', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const { service } = makeService();
    expect(() => service.serveImage('x.webp', makeRes())).toThrow(NotFoundException);
  });

  it('seta headers Content-Type e Cache-Control e faz pipe', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const pipe = jest.fn();
    (fs.createReadStream as jest.Mock).mockReturnValue({ pipe });
    const { service } = makeService();
    const res = makeRes();

    service.serveImage('foo.webp', res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/webp');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=31536000, immutable',
    );
    expect(pipe).toHaveBeenCalledWith(res);
  });
});
