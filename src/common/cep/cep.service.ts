import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

/** Endereço resolvido a partir de um CEP. Tudo opcional: o ViaCEP nem sempre preenche. */
export interface EnderecoCep {
  cep: string; // só dígitos
  street: string;
  neighborhood: string;
  city: string;
  state: string; // UF
}

interface ViaCepResponse {
  cep?: string;
  logradouro?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  erro?: boolean | string;
}

const VIACEP_URL = 'https://viacep.com.br/ws';
const TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
/** Teto do cache. CEP é dado estável e minúsculo; o limite é só contra crescimento infinito. */
const CACHE_MAX = 2_000;

/**
 * Consulta de CEP para preencher o endereço de cobrança.
 *
 * **Nunca lança.** CEP fora do ar, timeout, CEP inexistente ou malformado devolvem
 * `null` e a tela segue com os campos vazios para o cliente digitar. Travar o cadastro
 * por causa de um serviço de terceiro seria trocar um atrito pequeno (digitar a rua)
 * por um grande (não conseguir pagar).
 */
@Injectable()
export class CepService {
  private readonly cache = new Map<string, { value: EnderecoCep | null; expiresAt: number }>();

  constructor(
    @InjectPinoLogger(CepService.name)
    private readonly logger: PinoLogger,
  ) {}

  async lookup(cep: string): Promise<EnderecoCep | null> {
    const digits = (cep ?? '').replace(/\D/g, '');
    if (digits.length !== 8) return null;

    const hit = this.cache.get(digits);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    let endereco: EnderecoCep | null = null;
    try {
      const res = await fetch(`${VIACEP_URL}/${digits}/json/`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'TaskDY' },
      });
      if (res.ok) {
        const data = (await res.json()) as ViaCepResponse;
        // O ViaCEP responde 200 com `{ "erro": true }` para CEP inexistente.
        if (!data.erro) {
          endereco = {
            cep: digits,
            street: data.logradouro?.trim() ?? '',
            neighborhood: data.bairro?.trim() ?? '',
            city: data.localidade?.trim() ?? '',
            state: data.uf?.trim().toUpperCase() ?? '',
          };
        }
      } else {
        this.logger.warn({ cep: digits, status: res.status }, 'ViaCEP respondeu com erro');
      }
    } catch (err: unknown) {
      // Inclui o timeout do AbortSignal. Só observabilidade — o fluxo segue.
      this.logger.warn({ cep: digits, err }, 'Falha ao consultar o CEP');
      return null;
    }

    this.remember(digits, endereco);
    return endereco;
  }

  /** Guarda inclusive o `null` de "CEP não existe": repetir a consulta não mudaria. */
  private remember(cep: string, value: EnderecoCep | null): void {
    if (this.cache.size >= CACHE_MAX) {
      const [oldest] = this.cache.keys();
      if (oldest != null) this.cache.delete(oldest);
    }
    this.cache.set(cep, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
