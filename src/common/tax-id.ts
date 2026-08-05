/**
 * Normaliza CNPJ/CPF para só dígitos. Usado antes de checar unicidade e gravar,
 * para que "12.345.678/0001-99" e "12345678000199" não criem empresas duplicadas
 * (drible do @unique) nem passem formatação inconsistente ao provedor de cobrança.
 */
export function normalizeTaxId(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Validação dos dígitos verificadores de CPF e CNPJ.
 *
 * Existe porque o Asaas recusa documento inválido na hora do pagamento ("O CPF/CNPJ
 * informado é inválido"), e até agora o erro só aparecia lá — depois de o cliente
 * ter digitado o cartão inteiro. Barrar no formulário é mais barato para todo mundo.
 *
 * **Espelhado em `frontend/lib/tax-id.ts`**: mesmo algoritmo dos dois lados, então
 * mudança aqui vai junto lá. O backend é quem vale; o front só evita a viagem
 * perdida até o provedor.
 */
export function isValidTaxId(raw: string): boolean {
  const digits = normalizeTaxId(raw);
  if (digits.length === 11) return isValidCpf(digits);
  if (digits.length === 14) return isValidCnpj(digits);
  return false;
}

/**
 * Dígito verificador por soma ponderada módulo 11 — a regra é a mesma para CPF e
 * CNPJ, muda só a sequência de pesos.
 */
function digitoVerificador(base: string, pesos: number[]): number {
  const soma = base.split('').reduce((acc, char, i) => acc + Number(char) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function isValidCpf(digits: string): boolean {
  if (digits.length !== 11) return false;
  // Sequência repetida (000.000.000-00, 111...) passa no cálculo dos dígitos, mas
  // não é CPF de ninguém — é o erro de digitação mais comum, e todo validador barra.
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const dv1 = digitoVerificador(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (dv1 !== Number(digits[9])) return false;

  const dv2 = digitoVerificador(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv2 === Number(digits[10]);
}

export function isValidCnpj(digits: string): boolean {
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const dv1 = digitoVerificador(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (dv1 !== Number(digits[12])) return false;

  const dv2 = digitoVerificador(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv2 === Number(digits[13]);
}
