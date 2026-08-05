import { PinoLogger } from 'nestjs-pino';
import { MailerService } from '../mailer/mailer.service';
import { MetricsService } from '../metrics/metrics.service';
import { BillingAlertsService } from './billing-alerts.service';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as PinoLogger;

function make() {
  const mailer = {
    sendBillingOpsAlert: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MailerService>;
  const metrics = { billingAlert: jest.fn() } as unknown as jest.Mocked<MetricsService>;
  return { service: new BillingAlertsService(mailer, metrics, logger), mailer, metrics };
}

/**
 * O alerta é o último aviso antes de um problema de cobrança virar prejuízo — e é
 * chamado de dentro de fluxos que não podem quebrar (webhook, cron). Logo: sempre
 * emite métrica + log + e-mail, e **nunca lança**.
 */
describe('BillingAlertsService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emite métrica, log de erro e e-mail interno', async () => {
    const { service, mailer, metrics } = make();
    await service.raise('payment_unmatched', { paymentId: 'pay_1' });

    expect(metrics.billingAlert).toHaveBeenCalledWith('payment_unmatched');
    expect(logger.error).toHaveBeenCalled();
    expect(mailer.sendBillingOpsAlert).toHaveBeenCalledWith(
      expect.stringContaining('Pagamento'),
      expect.objectContaining({ kind: 'payment_unmatched', paymentId: 'pay_1' }),
    );
  });

  it('falha no envio do e-mail não propaga (quem alertou continua vivo)', async () => {
    const { service, mailer } = make();
    mailer.sendBillingOpsAlert.mockRejectedValue(new Error('resend fora'));
    await expect(service.raise('webhook_dead', { id: 'evt_1' })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('falha na métrica não impede o e-mail', async () => {
    const { service, mailer, metrics } = make();
    metrics.billingAlert.mockImplementation(() => {
      throw new Error('prom fora');
    });
    await expect(service.raise('webhook_silence', {})).resolves.toBeUndefined();
    expect(mailer.sendBillingOpsAlert).toHaveBeenCalled();
  });
});
