import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CepModule } from '../common/cep/cep.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AsaasClient } from './asaas/asaas.client';
import { BillingCheckoutService } from './billing-checkout.service';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { SuperadminBillingController } from './superadmin-billing.controller';
import { BillingAccessService } from './billing-access.service';
import { BillingAlertsService } from './billing-alerts.service';
import { BillingRepository } from './billing.repository';
import { BillingSchedulerService } from './billing-scheduler.service';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';
import { SuperadminBillingService } from './superadmin-billing.service';

/** Envs obrigatórias quando a cobrança está ligada (B10). */
const REQUIRED_WHEN_ENABLED = ['ASAAS_API_URL', 'ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN'] as const;

@Module({
  imports: [PrismaModule, ConfigModule, CepModule],
  controllers: [BillingController, BillingWebhookController, SuperadminBillingController],
  providers: [
    BillingRepository,
    BillingService,
    BillingCheckoutService,
    BillingWebhookService,
    SuperadminBillingService,
    BillingAccessService,
    BillingAlertsService,
    BillingSchedulerService,
    AsaasClient,
  ],
  exports: [BillingService, BillingAccessService],
})
export class BillingModule implements OnModuleInit {
  private readonly logger = new Logger(BillingModule.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Falha rápido em vez de degradar em silêncio: sem `ASAAS_WEBHOOK_TOKEN`, por
   * exemplo, o endpoint devolveria 503 a **todo** webhook e a fila do Asaas seria
   * interrompida após 15 falhas — com os eventos expirando em 14 dias.
   */
  onModuleInit(): void {
    if (this.config.get<string>('BILLING_ENABLED') !== 'true') {
      this.logger.warn('BILLING_ENABLED != true — cobrança desativada (nenhuma ação será tomada)');
      return;
    }
    const missing = REQUIRED_WHEN_ENABLED.filter((key) => !this.config.get<string>(key));
    if (missing.length > 0) {
      throw new Error(
        `Cobrança ligada (BILLING_ENABLED=true) mas faltam variáveis obrigatórias: ${missing.join(', ')}`,
      );
    }
  }
}
