import { SetMetadata } from '@nestjs/common';

/**
 * Marca uma rota/controller como isenta do gate global de escrita (somente
 * leitura). Usado pelas próprias rotas de cobrança, webhook e superadmin. O
 * `BillingGateGuard` (F4) lê esta metadata via Reflector — espelha `@Public()`.
 */
export const SKIP_BILLING_GATE_KEY = 'skipBillingGate';
export const SkipBillingGate = () => SetMetadata(SKIP_BILLING_GATE_KEY, true);
