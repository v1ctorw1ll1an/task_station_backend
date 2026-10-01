import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingAccessService, BillingSummary } from '../billing/billing-access.service';
import { PrismaService } from '../prisma/prisma.service';

/** Planos que dão direito à integração (Q14): trial NÃO conta. */
const ELIGIBLE_STATUSES = new Set(['active', 'courtesy', 'past_due']);

export interface CompanyEligibility {
  companyId: string;
  name: string;
  status: string | null;
  eligible: boolean;
}

export interface UserEligibility {
  companies: CompanyEligibility[];
  eligibleIds: Set<string>;
  /** Eventos pessoais sincronizam enquanto houver ≥1 empresa elegível (Q17). */
  personalAllowed: boolean;
}

/**
 * Quais empresas do usuário podem mandar itens para o Google. Usado ao conectar
 * (precisa de ≥1), no push e no pull (empresa inelegível = congelada, Q18).
 */
@Injectable()
export class SyncEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BillingAccessService,
    private readonly config: ConfigService,
  ) {}

  static isEligible(summary: BillingSummary, billingEnabled: boolean): boolean {
    // Somente-leitura / suspensa nunca sincroniza, qualquer que seja o status.
    if (summary.mode !== 'ok') return false;
    // Cobrança desligada (dev/CI): tudo liberado, como no resto do app.
    if (!billingEnabled) return true;
    return summary.status != null && ELIGIBLE_STATUSES.has(summary.status);
  }

  async forUser(userId: string): Promise<UserEligibility> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, resourceType: 'company', deletedAt: null },
      select: { resourceId: true },
    });
    const ids = [...new Set(memberships.map((m) => m.resourceId))];
    const companies =
      ids.length === 0
        ? []
        : await this.prisma.company.findMany({
            where: { id: { in: ids }, deletedAt: null, isActive: true },
            select: { id: true, legalName: true },
          });

    const billingEnabled = this.config.get<string>('BILLING_ENABLED') === 'true';
    const result: CompanyEligibility[] = [];
    for (const c of companies) {
      const summary = await this.access.getSummary(c.id);
      result.push({
        companyId: c.id,
        name: c.legalName,
        status: summary.status,
        eligible: SyncEligibilityService.isEligible(summary, billingEnabled),
      });
    }

    const eligibleIds = new Set(result.filter((c) => c.eligible).map((c) => c.companyId));
    return { companies: result, eligibleIds, personalAllowed: eligibleIds.size > 0 };
  }

  /** Uma empresa, ao vivo (sujeito só ao cache curto do BillingAccessService). */
  async isCompanyEligible(companyId: string): Promise<boolean> {
    const billingEnabled = this.config.get<string>('BILLING_ENABLED') === 'true';
    return SyncEligibilityService.isEligible(
      await this.access.getSummary(companyId),
      billingEnabled,
    );
  }

  async eligibleCompanyIds(userId: string): Promise<Set<string>> {
    return (await this.forUser(userId)).eligibleIds;
  }
}

/** O item (empresa ou pessoal) pode sincronizar agora? false = congelado. */
export function isItemSyncable(companyId: string | null, e: UserEligibility): boolean {
  return companyId ? e.eligibleIds.has(companyId) : e.personalAllowed;
}
