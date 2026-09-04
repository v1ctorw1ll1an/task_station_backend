/**
 * Identidade do TaskDY dentro de uma conta Asaas **compartilhada com outros produtos**.
 *
 * A regra que obriga este módulo a existir: cada produto cadastra a própria URL de
 * webhook, mas o Asaas manda **todos** os eventos da conta para **todas** elas. Não
 * existe webhook por grupo, por produto ou por cliente — filtrar é obrigação de cada
 * projeto, não otimização.
 *
 * E o corolário que economiza horas: **o grupo serve para o painel, nunca para a
 * lógica.** O webhook não manda o grupo, e nenhum endpoint da API do Asaas devolve a
 * que grupo um cliente pertence (`GET /v3/customers/{id}` simplesmente não traz o
 * campo — dá para escrevê-lo e filtrar uma listagem por ele, só isso). Quem identifica
 * o dono de um evento é o `externalReference`.
 */

/**
 * Namespace do produto no `externalReference`. **Constante, não configuração:** o valor
 * já está gravado do lado da Asaas em cada cliente, assinatura e cobrança — trocá-lo
 * orfana todos os registros existentes, que continuariam chegando com a grafia velha
 * para sempre.
 */
export const PRODUCT_NAMESPACE = 'taskdy';

const SEPARATOR = ':';

/**
 * Ids nossos são UUID. Manter o formato no parse preserva o comportamento anterior a
 * este módulo (o `UUID_RE` morava no `BillingWebhookService`) e descarta de graça
 * referência de outro produto que chegue sem namespace num formato qualquer.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Leitura de um `externalReference` que voltou da Asaas.
 *
 * **Os três campos não são redundantes** — confundi-los é o bug mais fácil de cometer
 * aqui. `!isForeign` significa *"não dá para descartar"*; `isOurs` significa *"dá para
 * confirmar"*. Tratar os dois como iguais faz a cobrança de outro produto com
 * referência sem namespace passar direto.
 */
export interface ParsedReference {
  /** Traz o prefixo de OUTRO produto — recusa imediata, sem consultar nada. */
  isForeign: boolean;
  /** Traz o nosso prefixo — dono confirmado. */
  isOurs: boolean;
  /** Id local (UUID) quando dá para extrair. Nunca use `slice`/`parseInt` na mão. */
  id: string | null;
}

/** Carimba um id nosso para gravar na Asaas: `"taskdy:<uuid>"`. */
export function externalReference(id: string): string {
  return `${PRODUCT_NAMESPACE}${SEPARATOR}${id}`;
}

/**
 * | Entrada          | isForeign | isOurs | id     | Leitura                     |
 * | ---------------- | --------- | ------ | ------ | --------------------------- |
 * | `taskdy:<uuid>`  | false     | true   | uuid   | nosso, confirmado           |
 * | `outro:99`       | true      | false  | null   | recusa imediata             |
 * | `<uuid>`         | false     | false  | uuid   | legado: id serve, dono NÃO  |
 * | `taskdy:abc`     | false     | true   | null   | nosso, sem id               |
 * | vazio/nulo       | false     | false  | null   | indefinido                  |
 *
 * O legado (linha 3) é seguro no TaskDY porque todo caminho de resolução consulta o
 * **nosso banco** antes de escrever estado: o UUID de outro produto não existe nas
 * nossas tabelas. A consulta local é o segundo sinal — e é mais forte que casar texto
 * de descrição.
 */
export function parseExternalReference(raw?: string | null): ParsedReference {
  const value = raw?.trim();
  if (!value) return { isForeign: false, isOurs: false, id: null };

  const at = value.indexOf(SEPARATOR);
  if (at < 0) {
    // Sem namespace: gravado antes deste módulo, ou de um produto que não namespaceia.
    // O id serve para procurar; o dono NÃO está confirmado.
    return { isForeign: false, isOurs: false, id: UUID_RE.test(value) ? value : null };
  }

  if (value.slice(0, at) !== PRODUCT_NAMESPACE) {
    return { isForeign: true, isOurs: false, id: null };
  }
  const rest = value.slice(at + 1);
  return { isForeign: false, isOurs: true, id: UUID_RE.test(rest) ? rest : null };
}

/**
 * Nome do grupo de clientes no painel do Asaas. Configurável (o painel pode renomear o
 * grupo) com o namespace como padrão — ao contrário do namespace, que é constante.
 *
 * Env **ausente** → `taskdy`. Env presente e **vazia** → `undefined`, e a chave fica de
 * fora do payload: mandar `groupName: ""` cria um grupo **sem nome** no Asaas.
 */
export function resolveGroupName(raw?: string | null): string | undefined {
  if (raw == null) return PRODUCT_NAMESPACE;
  const value = raw.trim();
  return value ? value : undefined;
}
