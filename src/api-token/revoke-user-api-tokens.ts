import type { Prisma } from '../generated/prisma/client';

type Db = Pick<Prisma.TransactionClient, 'apiToken'>;

/**
 * Revoga todos os tokens de acesso pessoal do usuário.
 *
 * Chamar em **toda** troca ou invalidação de senha: quem troca a senha porque
 * desconfia de vazamento espera que todo acesso antigo morra, e o token dura até
 * 365 dias. Recebe o client (ou a transação) de quem já está gravando a senha, para
 * as duas coisas acontecerem juntas.
 */
export function revokeUserApiTokens(db: Db, userId: string, now = new Date()) {
  return db.apiToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
}
