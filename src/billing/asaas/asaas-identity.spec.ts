import {
  externalReference,
  parseExternalReference,
  PRODUCT_NAMESPACE,
  resolveGroupName,
} from './asaas-identity';

const UUID = '00000000-0000-4000-8000-000000000001';

/**
 * A conta Asaas é compartilhada com outros produtos e o Asaas manda TODOS os eventos da
 * conta para TODAS as URLs de webhook cadastradas. Esta função é a única coisa entre um
 * pagamento alheio e o nosso banco.
 */
describe('asaas-identity', () => {
  describe('externalReference', () => {
    it('carimba o id com o namespace do produto', () => {
      expect(externalReference(UUID)).toBe(`taskdy:${UUID}`);
    });

    it('o namespace é o do produto — trocá-lo orfanaria o que já está gravado na Asaas', () => {
      expect(PRODUCT_NAMESPACE).toBe('taskdy');
    });
  });

  /**
   * `isForeign` e `isOurs` NÃO são o mesmo predicado negado. `!isForeign` significa "não
   * dá para descartar"; `isOurs` significa "dá para confirmar". A linha do UUID cru é a
   * que separa os dois — e é a que trava o bug.
   */
  describe('parseExternalReference', () => {
    it('prefixo nosso: confirma o dono e devolve o id', () => {
      expect(parseExternalReference(`taskdy:${UUID}`)).toEqual({
        isForeign: false,
        isOurs: true,
        id: UUID,
      });
    });

    it('prefixo de outro produto: recusa imediata, sem id', () => {
      expect(parseExternalReference('outro:99')).toEqual({
        isForeign: true,
        isOurs: false,
        id: null,
      });
    });

    it('UUID puro (legado): devolve o id mas NÃO confirma o dono', () => {
      const ref = parseExternalReference(UUID);
      expect(ref.id).toBe(UUID);
      expect(ref.isOurs).toBe(false); // ← o caso que faz cobrança alheia passar direto
      expect(ref.isForeign).toBe(false); // não dá para descartar: pode ser nosso
    });

    it('prefixo nosso com id que não é UUID: nosso, mas sem id utilizável', () => {
      expect(parseExternalReference('taskdy:abc')).toEqual({
        isForeign: false,
        isOurs: true,
        id: null,
      });
    });

    it('vazio, nulo ou indefinido: indefinido em tudo', () => {
      for (const raw of [undefined, null, '', '   ']) {
        expect(parseExternalReference(raw)).toEqual({
          isForeign: false,
          isOurs: false,
          id: null,
        });
      }
    });

    it('referência sem namespace e fora do formato de id não vira id nenhum', () => {
      // Preserva o comportamento do antigo `UUID_RE` no BillingWebhookService.
      expect(parseExternalReference('12345').id).toBeNull();
    });

    it('só o primeiro separador conta — resto com `:` não vira id', () => {
      expect(parseExternalReference(`taskdy:${UUID}:extra`)).toEqual({
        isForeign: false,
        isOurs: true,
        id: null,
      });
    });

    it('namespace vazio antes do separador é de outro produto, não nosso', () => {
      expect(parseExternalReference(`:${UUID}`).isForeign).toBe(true);
    });

    it('apara o espaço que sobra no copiar-e-colar antes de decidir', () => {
      expect(parseExternalReference(`  taskdy:${UUID}  `).id).toBe(UUID);
    });
  });

  describe('resolveGroupName', () => {
    it('env ausente → o namespace do produto', () => {
      expect(resolveGroupName(undefined)).toBe('taskdy');
      expect(resolveGroupName(null)).toBe('taskdy');
    });

    it('env vazia → undefined (mandar `groupName: ""` cria um grupo SEM NOME no Asaas)', () => {
      expect(resolveGroupName('')).toBeUndefined();
      expect(resolveGroupName('   ')).toBeUndefined();
    });

    it('nome próprio é aparado — o grupo do painel pode ter sido renomeado', () => {
      expect(resolveGroupName(' outro-nome ')).toBe('outro-nome');
    });
  });
});
