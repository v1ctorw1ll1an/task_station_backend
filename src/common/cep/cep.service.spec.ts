import { CepService } from './cep.service';

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

function make(): CepService {
  return new CepService(logger as never);
}

function respondeCom(body: unknown, ok = true, status = 200): jest.Mock {
  const fn = jest.fn().mockResolvedValue({ ok, status, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const VIACEP_OK = {
  cep: '01310-100',
  logradouro: 'Avenida Paulista',
  bairro: 'Bela Vista',
  localidade: 'São Paulo',
  uf: 'SP',
};

describe('CepService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolve o endereço e devolve o CEP só com dígitos', async () => {
    respondeCom(VIACEP_OK);
    await expect(make().lookup('01310-100')).resolves.toEqual({
      cep: '01310100',
      street: 'Avenida Paulista',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
    });
  });

  it('não chama a rede com CEP de tamanho errado', async () => {
    const fetchMock = respondeCom(VIACEP_OK);
    await expect(make().lookup('123')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trata o 200 com `erro: true` do ViaCEP como CEP inexistente', async () => {
    respondeCom({ erro: true });
    await expect(make().lookup('99999999')).resolves.toBeNull();
  });

  it('nunca lança quando a rede falha — devolve null e segue', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout')) as unknown as typeof fetch;
    await expect(make().lookup('01310100')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('nunca lança em resposta HTTP de erro', async () => {
    respondeCom({}, false, 503);
    await expect(make().lookup('01310100')).resolves.toBeNull();
  });

  it('serve do cache na segunda consulta do mesmo CEP', async () => {
    const fetchMock = respondeCom(VIACEP_OK);
    const service = make();
    await service.lookup('01310100');
    await service.lookup('01310-100'); // mesma coisa, com máscara
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('também cacheia o "não existe" — repetir não mudaria a resposta', async () => {
    const fetchMock = respondeCom({ erro: true });
    const service = make();
    await service.lookup('99999999');
    await service.lookup('99999999');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
