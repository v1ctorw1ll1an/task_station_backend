import { ConfigService } from '@nestjs/config';
import { BillingModule } from './billing.module';

function makeConfig(vars: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => vars[k] } as unknown as ConfigService;
}

describe('BillingModule (validação de configuração — B10)', () => {
  it('recusa subir com a cobrança ligada e variáveis do Asaas faltando', () => {
    const mod = new BillingModule(makeConfig({ BILLING_ENABLED: 'true', ASAAS_API_URL: 'u' }));
    expect(() => mod.onModuleInit()).toThrow(/ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN/);
  });

  it('sobe com a cobrança ligada e tudo configurado', () => {
    const mod = new BillingModule(
      makeConfig({
        BILLING_ENABLED: 'true',
        ASAAS_API_URL: 'u',
        ASAAS_API_KEY: 'k',
        ASAAS_WEBHOOK_TOKEN: 't',
      }),
    );
    expect(() => mod.onModuleInit()).not.toThrow();
  });

  it('cobrança desligada não exige nada', () => {
    const mod = new BillingModule(makeConfig({ BILLING_ENABLED: 'false' }));
    expect(() => mod.onModuleInit()).not.toThrow();
  });
});
