import { ConfigService } from '@nestjs/config';
import { BillingAccessService, BillingSummary } from '../billing/billing-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { isItemSyncable, SyncEligibilityService } from './sync-eligibility.service';

function summary(status: string | null, mode: BillingSummary['mode'] = 'ok'): BillingSummary {
  return {
    status,
    mode,
    blocked: mode !== 'ok',
    blockReason: null,
    needsSubscription: false,
    trialEndsAt: null,
  };
}

describe('SyncEligibilityService (google-calendar)', () => {
  describe('isEligible', () => {
    it.each(['active', 'courtesy', 'past_due'])('%s é elegível', (status) => {
      expect(SyncEligibilityService.isEligible(summary(status), true)).toBe(true);
    });

    it.each(['trial', 'readonly', 'canceled', null])('%s não é elegível', (status) => {
      expect(SyncEligibilityService.isEligible(summary(status), true)).toBe(false);
    });

    it('somente-leitura/suspensa nunca, mesmo com status pago', () => {
      expect(SyncEligibilityService.isEligible(summary('active', 'read_only'), true)).toBe(false);
      expect(SyncEligibilityService.isEligible(summary('courtesy', 'suspended'), true)).toBe(false);
    });

    it('cobrança desligada libera tudo que não está bloqueado', () => {
      expect(SyncEligibilityService.isEligible(summary('trial'), false)).toBe(true);
      expect(SyncEligibilityService.isEligible(summary('trial', 'suspended'), false)).toBe(false);
    });
  });

  describe('forUser', () => {
    const statuses: Record<string, string> = { a: 'active', b: 'trial', c: 'past_due' };
    const prisma = {
      membership: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { resourceId: 'a' },
            { resourceId: 'b' },
            { resourceId: 'c' },
            { resourceId: 'a' },
          ]),
      },
      company: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', legalName: 'A' },
          { id: 'b', legalName: 'B' },
          { id: 'c', legalName: 'C' },
        ]),
      },
    } as unknown as PrismaService;
    const access = {
      getSummary: jest.fn((id: string) => Promise.resolve(summary(statuses[id]))),
    } as unknown as BillingAccessService;
    const config = { get: () => 'true' } as unknown as ConfigService;

    it('separa elegíveis (active/past_due) do trial e libera pessoais', async () => {
      const svc = new SyncEligibilityService(prisma, access, config);
      const e = await svc.forUser('u1');
      expect([...e.eligibleIds].sort()).toEqual(['a', 'c']);
      expect(e.companies.find((c) => c.companyId === 'b')).toMatchObject({
        eligible: false,
        status: 'trial',
      });
      expect(e.personalAllowed).toBe(true);
      expect(isItemSyncable('a', e)).toBe(true);
      expect(isItemSyncable('b', e)).toBe(false);
      expect(isItemSyncable(null, e)).toBe(true);
    });

    it('sem nenhuma elegível, pessoais também congelam', () => {
      const e = { companies: [], eligibleIds: new Set<string>(), personalAllowed: false };
      expect(isItemSyncable(null, e)).toBe(false);
    });
  });
});
