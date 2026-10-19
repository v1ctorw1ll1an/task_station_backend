import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SyncDirection } from './sync-rules';

const SETTINGS_ID = 'global';
/** O enfileirador consulta a direção a cada mutação: cache curto evita ida ao banco. */
const CACHE_TTL_MS = 10_000;

/**
 * Configuração global da integração (linha única). Sem linha no banco vale `both`,
 * o comportamento de antes do controle existir.
 */
@Injectable()
export class GoogleSyncSettingsService {
  private cache: { direction: SyncDirection; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async getDirection(): Promise<SyncDirection> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.direction;
    const row = await this.prisma.googleCalendarSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { syncDirection: true },
    });
    const direction: SyncDirection = row?.syncDirection ?? 'both';
    this.cache = { direction, expiresAt: Date.now() + CACHE_TTL_MS };
    return direction;
  }

  async get() {
    const row = await this.prisma.googleCalendarSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: {
        syncDirection: true,
        updatedAt: true,
        updatedBy: { select: { id: true, name: true, email: true } },
      },
    });
    return {
      direction: (row?.syncDirection ?? 'both') as SyncDirection,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  /** Devolve a direção anterior — quem chama decide se precisa ressincronizar. */
  async setDirection(direction: SyncDirection, userId: string): Promise<SyncDirection> {
    const previous = await this.prisma.googleCalendarSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { syncDirection: true },
    });
    await this.prisma.googleCalendarSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, syncDirection: direction, updatedById: userId },
      update: { syncDirection: direction, updatedById: userId },
    });
    this.cache = { direction, expiresAt: Date.now() + CACHE_TTL_MS };
    return previous?.syncDirection ?? 'both';
  }
}
