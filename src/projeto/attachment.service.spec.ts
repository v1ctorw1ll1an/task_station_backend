import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AttachmentService } from './attachment.service';
import { MediaPoolService } from './media-pool.service';
import { ProjetoRepository } from './projeto.repository';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ size: 12345 }),
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: () => 'fixed-uuid',
}));

import * as fs from 'fs';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeRepo(
  overrides: Partial<Record<keyof ProjetoRepository, jest.Mock>> = {},
): jest.Mocked<ProjetoRepository> {
  return {
    countAttachments: jest.fn().mockResolvedValue(0),
    createAttachment: jest.fn().mockResolvedValue({ id: 'att-1' }),
    createTaskHistories: jest.fn().mockResolvedValue(undefined),
    findAttachmentById: jest.fn(),
    findAttachments: jest.fn(),
    softDeleteAttachment: jest.fn().mockResolvedValue(undefined),
    // Cota de storage por workspace — default: workspace existe e está vazio,
    // então qualquer upload cabe na cota de 10 GiB.
    findWorkspaceForTask: jest.fn().mockResolvedValue({
      workspaceId: 'ws-1',
      storageQuotaBytes: 10_737_418_240n,
    }),
    sumWorkspaceAttachmentBytes: jest.fn().mockResolvedValue(0n),
    ...overrides,
  } as unknown as jest.Mocked<ProjetoRepository>;
}

function makeMediaPool(): jest.Mocked<MediaPoolService> {
  return {
    processImage: jest.fn().mockResolvedValue({
      kind: 'processImage',
      processedSize: 12345,
      hasThumbnail: true,
    }),
    processVideo: jest.fn().mockResolvedValue({
      kind: 'processVideo',
      processedSize: 5_000_000,
      hasThumbnail: true,
    }),
    writeBytes: jest.fn().mockResolvedValue({ kind: 'writeBytes' }),
  } as unknown as jest.Mocked<MediaPoolService>;
}

function makeService(repoOverrides: Partial<Record<keyof ProjetoRepository, jest.Mock>> = {}) {
  const repo = makeRepo(repoOverrides);
  const mediaPool = makeMediaPool();
  const logger = makeLogger();
  return {
    service: new AttachmentService(repo, mediaPool, logger as any),
    repo,
    mediaPool,
    logger,
  };
}

function imageFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'foto.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 1000,
    buffer: Buffer.from('img'),
    ...overrides,
  } as any as Express.Multer.File;
}

function videoFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'video.mp4',
    encoding: '7bit',
    mimetype: 'video/mp4',
    size: 5_000_000,
    buffer: Buffer.from('vid'),
    ...overrides,
  } as any as Express.Multer.File;
}

function pdfFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'documento.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: 500_000,
    buffer: Buffer.from('pdf-content'),
    ...overrides,
  } as any as Express.Multer.File;
}

beforeEach(() => {
  (fs.existsSync as jest.Mock).mockReset().mockReturnValue(true);
  (fs.mkdirSync as jest.Mock).mockReset();
  (fs.unlinkSync as jest.Mock).mockReset();
  (fs.statSync as jest.Mock).mockReset().mockReturnValue({ size: 12345 });
});

// ── validateFile (via upload) ──────────────────────────────────────────────────

describe('AttachmentService.upload — validação', () => {
  it('UnsupportedMediaTypeException para mime inválido (zip)', async () => {
    const { service } = makeService();
    await expect(
      service.upload('t-1', { ...imageFile(), mimetype: 'application/zip' } as any, 'u-1'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('PayloadTooLargeException quando imagem > 16MB', async () => {
    const { service } = makeService();
    await expect(
      service.upload('t-1', { ...imageFile(), size: 17 * 1024 * 1024 } as any, 'u-1'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('PayloadTooLargeException quando vídeo > 64MB', async () => {
    const { service } = makeService();
    await expect(
      service.upload('t-1', videoFile({ size: 65 * 1024 * 1024 }), 'u-1'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});

// ── upload (imagem) ────────────────────────────────────────────────────────────

describe('AttachmentService.upload — imagem', () => {
  it('BadRequestException quando limite de 3 imagens atingido', async () => {
    const { service } = makeService({ countAttachments: jest.fn().mockResolvedValue(3) });
    await expect(service.upload('t-1', imageFile(), 'u-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('processa imagem com sharp e persiste attachment + history', async () => {
    const created = { id: 'att-1', originalName: 'foto.png' };
    const { service, repo } = makeService({
      countAttachments: jest.fn().mockResolvedValue(0),
      createAttachment: jest.fn().mockResolvedValue(created),
    });

    const result = await service.upload('t-1', imageFile(), 'u-1');

    expect(result).toBe(created);
    expect(repo.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 't-1',
        uploadedById: 'u-1',
        storedName: 'fixed-uuid.webp',
        mimeType: 'image/png',
        hasThumbnail: true,
        originalName: 'foto.png',
      }),
    );
    expect(repo.createTaskHistories).toHaveBeenCalledWith([
      expect.objectContaining({ field: 'attachment_added', newValue: 'foto.png' }),
    ]);
  });

  it('countAttachments filtra com prefixo "image/" para imagens', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const { service } = makeService({ countAttachments: count });
    await service.upload('t-1', imageFile(), 'u-1');
    expect(count).toHaveBeenCalledWith('t-1', 'image/');
  });
});

// ── upload (vídeo) ─────────────────────────────────────────────────────────────

describe('AttachmentService.upload — vídeo', () => {
  it('BadRequestException quando limite de 1 vídeo atingido', async () => {
    const { service } = makeService({ countAttachments: jest.fn().mockResolvedValue(1) });
    await expect(service.upload('t-1', videoFile(), 'u-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('countAttachments filtra com prefixo "video/" para vídeos', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const { service } = makeService({ countAttachments: count });
    await service.upload('t-1', videoFile(), 'u-1');
    expect(count).toHaveBeenCalledWith('t-1', 'video/');
  });

  it('persiste vídeo com storedName usando extensão do original (mp4)', async () => {
    const { service, repo } = makeService();
    await service.upload('t-1', videoFile({ originalname: 'clip.mp4' }), 'u-1');
    expect(repo.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        storedName: 'fixed-uuid.mp4',
        mimeType: 'video/mp4',
      }),
    );
  });
});

// ── findAttachmentById / listAttachments ───────────────────────────────────────

describe('AttachmentService.findAttachmentById', () => {
  it('delega ao repo', async () => {
    const att = { id: 'a-1' };
    const { service, repo } = makeService({
      findAttachmentById: jest.fn().mockResolvedValue(att),
    });
    expect(await service.findAttachmentById('a-1', 't-1')).toBe(att);
    expect(repo.findAttachmentById).toHaveBeenCalledWith('a-1', 't-1');
  });
});

describe('AttachmentService.listAttachments', () => {
  it('delega ao repo', async () => {
    const list = [{ id: 'a' }];
    const { service, repo } = makeService({ findAttachments: jest.fn().mockResolvedValue(list) });
    expect(await service.listAttachments('t-1')).toBe(list);
    expect(repo.findAttachments).toHaveBeenCalledWith('t-1');
  });
});

// ── serveFile / serveThumbnail ─────────────────────────────────────────────────

describe('AttachmentService.serveFile', () => {
  it('retorna path quando arquivo existe', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const { service } = makeService();
    expect(service.serveFile('t-1', 'a.webp')).toContain('a.webp');
  });

  it('NotFoundException quando arquivo não existe', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const { service } = makeService();
    expect(() => service.serveFile('t-1', 'x.webp')).toThrow(NotFoundException);
  });
});

describe('AttachmentService.serveThumbnail', () => {
  it('para imagem, usa mesmo storedName como thumbnail', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const { service } = makeService();
    const path = service.serveThumbnail('t-1', 'a.webp', 'image/png');
    expect(path).toContain('a.webp');
    expect(path).toContain('thumbs');
  });

  it('para vídeo, substitui extensão por .jpg', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const { service } = makeService();
    const path = service.serveThumbnail('t-1', 'v.mp4', 'video/mp4');
    expect(path).toContain('v.jpg');
  });

  it('NotFoundException quando thumb não existe', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const { service } = makeService();
    expect(() => service.serveThumbnail('t-1', 'a.webp', 'image/png')).toThrow(NotFoundException);
  });
});

// ── deleteAttachment ───────────────────────────────────────────────────────────

describe('AttachmentService.deleteAttachment', () => {
  it('NotFoundException quando attachment não existe', async () => {
    const { service } = makeService({ findAttachmentById: jest.fn().mockResolvedValue(null) });
    await expect(service.deleteAttachment('a-x', 't-1', 'u-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove arquivos do disco, soft-deleta e registra history (imagem)', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const att = {
      id: 'a-1',
      storedName: 'foo.webp',
      originalName: 'foo.png',
      mimeType: 'image/png',
    };
    const { service, repo } = makeService({
      findAttachmentById: jest.fn().mockResolvedValue(att),
    });

    await service.deleteAttachment('a-1', 't-1', 'u-1');

    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    expect(repo.softDeleteAttachment).toHaveBeenCalledWith('a-1');
    expect(repo.createTaskHistories).toHaveBeenCalledWith([
      expect.objectContaining({ field: 'attachment_removed', oldValue: 'foo.png' }),
    ]);
  });

  it('para vídeo, thumb tem extensão .jpg ao deletar', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const att = {
      id: 'a-1',
      storedName: 'foo.mp4',
      originalName: 'foo.mp4',
      mimeType: 'video/mp4',
    };
    const { service } = makeService({ findAttachmentById: jest.fn().mockResolvedValue(att) });

    await service.deleteAttachment('a-1', 't-1', 'u-1');

    const paths = (fs.unlinkSync as jest.Mock).mock.calls.map((c) => c[0]);
    expect(paths.some((p: string) => p.endsWith('foo.mp4'))).toBe(true);
    expect(paths.some((p: string) => p.endsWith('foo.jpg'))).toBe(true);
  });

  it('ignora erros de unlinkSync (tolerante)', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.unlinkSync as jest.Mock).mockImplementation(() => {
      throw new Error('EACCES');
    });
    const att = {
      id: 'a-1',
      storedName: 'foo.webp',
      originalName: 'foo.png',
      mimeType: 'image/png',
    };
    const { service, repo } = makeService({ findAttachmentById: jest.fn().mockResolvedValue(att) });

    await expect(service.deleteAttachment('a-1', 't-1', 'u-1')).resolves.toBeUndefined();
    expect(repo.softDeleteAttachment).toHaveBeenCalled();
  });
});

// ── upload (PDF) ───────────────────────────────────────────────────────────────

describe('AttachmentService.upload — PDF', () => {
  it('aceita PDF válido (mime application/pdf)', async () => {
    const created = { id: 'att-pdf', originalName: 'documento.pdf' };
    const { service } = makeService({
      countAttachments: jest.fn().mockResolvedValue(0),
      createAttachment: jest.fn().mockResolvedValue(created),
    });

    const result = await service.upload('t-1', pdfFile(), 'u-1');
    expect(result).toBe(created);
  });

  it('PayloadTooLargeException quando PDF > 32MB', async () => {
    const { service } = makeService();
    await expect(
      service.upload('t-1', pdfFile({ size: 33 * 1024 * 1024 }), 'u-1'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('aceita PDF exatamente no limite (32MB)', async () => {
    const { service } = makeService();
    await expect(
      service.upload('t-1', pdfFile({ size: 32 * 1024 * 1024 }), 'u-1'),
    ).resolves.toBeDefined();
  });

  it('BadRequestException quando limite de PDFs (1) atingido', async () => {
    const { service } = makeService({ countAttachments: jest.fn().mockResolvedValue(1) });
    await expect(service.upload('t-1', pdfFile(), 'u-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('countAttachments filtra com "application/pdf" para PDFs', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const { service } = makeService({ countAttachments: count });
    await service.upload('t-1', pdfFile(), 'u-1');
    expect(count).toHaveBeenCalledWith('t-1', 'application/pdf');
  });

  it('persiste PDF com storedName = {uuid}.pdf e hasThumbnail=false', async () => {
    const { service, repo } = makeService();
    await service.upload('t-1', pdfFile(), 'u-1');
    expect(repo.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        storedName: 'fixed-uuid.pdf',
        mimeType: 'application/pdf',
        hasThumbnail: false,
        originalName: 'documento.pdf',
      }),
    );
  });

  it('registra TaskHistory com field=attachment_added para PDF', async () => {
    const { service, repo } = makeService();
    await service.upload('t-1', pdfFile({ originalname: 'contrato.pdf' }), 'u-1');
    expect(repo.createTaskHistories).toHaveBeenCalledWith([
      expect.objectContaining({
        field: 'attachment_added',
        newValue: 'contrato.pdf',
        taskId: 't-1',
        userId: 'u-1',
      }),
    ]);
  });

  it('NÃO chama processImage nem processVideo ao processar PDF', async () => {
    const { service, mediaPool } = makeService();
    await service.upload('t-1', pdfFile(), 'u-1');

    expect(mediaPool.processImage).not.toHaveBeenCalled();
    expect(mediaPool.processVideo).not.toHaveBeenCalled();
    expect(mediaPool.writeBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        fullPath: expect.stringContaining('fixed-uuid.pdf'),
        buffer: expect.any(Buffer),
      }),
    );
  });

  it('delega escrita do PDF ao MediaPoolService.writeBytes', async () => {
    const { service, mediaPool } = makeService();
    await service.upload('t-1', pdfFile(), 'u-1');

    expect(mediaPool.writeBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        fullPath: expect.stringContaining('fixed-uuid.pdf'),
        buffer: expect.any(Buffer),
      }),
    );
  });
});

// ── serveThumbnail (PDF) ───────────────────────────────────────────────────────

describe('AttachmentService.serveThumbnail — PDF', () => {
  it('NotFoundException ao pedir thumbnail de PDF (PDF não tem thumb)', () => {
    const { service } = makeService();
    expect(() => service.serveThumbnail('t-1', 'foo.pdf', 'application/pdf')).toThrow(
      NotFoundException,
    );
  });
});

// ── deleteAttachment (PDF) ─────────────────────────────────────────────────────

describe('AttachmentService.deleteAttachment — PDF', () => {
  it('remove o PDF do disco, soft-deleta e registra history', async () => {
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p.endsWith('.pdf'));
    const att = {
      id: 'a-1',
      storedName: 'foo.pdf',
      originalName: 'foo.pdf',
      mimeType: 'application/pdf',
    };
    const { service, repo } = makeService({ findAttachmentById: jest.fn().mockResolvedValue(att) });

    await service.deleteAttachment('a-1', 't-1', 'u-1');

    const paths = (fs.unlinkSync as jest.Mock).mock.calls.map((c) => c[0]);
    expect(paths.some((p: string) => p.endsWith('foo.pdf'))).toBe(true);
    expect(repo.softDeleteAttachment).toHaveBeenCalledWith('a-1');
    expect(repo.createTaskHistories).toHaveBeenCalledWith([
      expect.objectContaining({ field: 'attachment_removed', oldValue: 'foo.pdf' }),
    ]);
  });
});
