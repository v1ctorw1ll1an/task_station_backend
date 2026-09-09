import * as fs from 'fs';
import * as path from 'path';

/**
 * O limite de assentos só é sustentável se a cobertura for **garantida**, não lembrada.
 *
 * Assento ocupado = uma `Membership` com `resourceType: 'company'` ativa
 * (`BillingRepository.countOccupiedSeats`). Quem cria essa linha está colocando alguém
 * dentro da empresa — e isso é o que a assinatura cobra.
 *
 * O furo que originou este teste: quatro fluxos de workspace criavam o vínculo de
 * empresa direto, com o comentário "ensure company membership", sem passar por
 * `assertSeatAvailable`. Com o plano lotado, adicionar alguém a um workspace era um
 * jeito de ocupar assento sem cobrança. O teste passava, porque ninguém testa o que
 * não sabe que existe.
 *
 * Este teste varre o código-fonte atrás de toda criação de membership de empresa e
 * exige que cada uma esteja declarada abaixo, com motivo. Ponto novo = CI vermelho,
 * com o arquivo na mensagem. Se você chegou aqui por causa de uma falha: mande o
 * fluxo passar por `BillingService.ensureCompanySeat` — não "conserte" adicionando
 * o seu arquivo à lista sem entender por que ele ocupa assento.
 */

/** Pontos autorizados a criar membership de empresa, e por quê. */
const PORTAS_DE_ASSENTO: Record<string, string> = {
  'billing/billing.service.ts':
    'a porta única: `ensureCompanySeat` checa o assento e grava o vínculo dentro do mesmo lock',
  'billing/billing.repository.ts':
    'o `createCompanyMembership` que a porta única usa — só `ensureCompanySeat` deve chamar',
  'auth/auth.repository.ts':
    'auto-cadastro: cria a empresa e o dono junto com a assinatura trial; não há empresa anterior a que o limite se aplique',
  'superadmin/superadmin.repository.ts':
    'superusuário criando empresa nova com o primeiro admin, junto da assinatura trial',
  'empresa/empresa.repository.ts':
    'contratar membro — `EmpresaService.contratarMembro` checa o assento dentro do lock antes de chamar',
  'convite/convite.repository.ts':
    'aceite de convite — `ConviteService.aceitar` checa o assento dentro do lock antes de chamar',
};

/** Chamadas que gravam uma membership. */
const CRIACAO =
  /(membership\.create(?:Many)?|createMembership(?:Select)?|createCompanyMembership)\s*\(/g;

/** Quanto texto olhar depois da chamada para saber o escopo do que está sendo criado. */
const JANELA = 400;

function arquivosFonte(dir: string, encontrados: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const alvo = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated' || entry.name === 'node_modules') continue;
      arquivosFonte(alvo, encontrados);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      encontrados.push(alvo);
    }
  }
  return encontrados;
}

/** Caminho relativo a `src/`, com barras normais — é a chave da lista acima. */
function chave(arquivo: string): string {
  return path.relative(path.join(__dirname, '..'), arquivo).split(path.sep).join('/');
}

describe('Cobertura do limite de assentos', () => {
  const arquivos = arquivosFonte(path.join(__dirname, '..'));

  /**
   * Uma criação conta como "de empresa" quando o escopo aparece perto da chamada:
   * `resourceType: ResourceType.company`, `resourceType: 'company'` ou o helper
   * dedicado `createCompanyMembership`.
   */
  const criadores = new Set<string>();
  for (const arquivo of arquivos) {
    const codigo = fs.readFileSync(arquivo, 'utf-8');
    for (const match of codigo.matchAll(CRIACAO)) {
      const trecho = codigo.slice(match.index ?? 0, (match.index ?? 0) + JANELA);
      const deEmpresa =
        match[1] === 'createCompanyMembership' ||
        /resourceType:\s*(?:ResourceType\.company|'company'|"company")/.test(trecho);
      if (deEmpresa) criadores.add(chave(arquivo));
    }
  }

  it('encontra as criações de membership da aplicação', () => {
    // Sanidade: se a varredura quebrar, o teste inteiro viraria um falso "tudo ok".
    expect(arquivos.length).toBeGreaterThan(50);
    expect(criadores.size).toBeGreaterThan(0);
  });

  it('todo ponto que ocupa assento está declarado', () => {
    const naoDeclarados = [...criadores].filter((f) => !PORTAS_DE_ASSENTO[f]).sort();

    // Mensagem que aparece no CI: passe o fluxo por `BillingService.ensureCompanySeat`
    // ou, se ele realmente não deve ser cobrado, declare o motivo em PORTAS_DE_ASSENTO.
    expect(naoDeclarados).toEqual([]);
  });

  it('não sobra registro velho na lista (ponto que deixou de existir)', () => {
    const orfaos = Object.keys(PORTAS_DE_ASSENTO)
      .filter((f) => !criadores.has(f))
      .sort();
    expect(orfaos).toEqual([]);
  });

  it('toda porta declarada tem motivo escrito', () => {
    const semMotivo = Object.entries(PORTAS_DE_ASSENTO)
      .filter(([, motivo]) => motivo.trim().length < 15)
      .map(([arquivo]) => arquivo);
    expect(semMotivo).toEqual([]);
  });

  /**
   * Os serviços de workspace foram a origem do furo. Eles podem colocar alguém num
   * workspace, mas a entrada na EMPRESA tem que passar pela porta que cobra.
   */
  it('os fluxos de workspace não criam vínculo de empresa por conta própria', () => {
    const suspeitos = [...criadores].filter(
      (f) => f.startsWith('workspace/') || f === 'empresa/empresa.service.ts',
    );
    expect(suspeitos).toEqual([]);
  });
});
