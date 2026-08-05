import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isValidTaxId, normalizeTaxId } from '../tax-id';

/**
 * Aceita CPF ou CNPJ com dígitos verificadores válidos, com ou sem máscara.
 *
 * Vale para o cadastro da empresa e para o titular do cartão: o Asaas recusa
 * documento inválido no pagamento, e sem esta checagem o cliente só descobria
 * o erro depois de digitar o cartão inteiro.
 */
export function IsCpfCnpj(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCpfCnpj',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidTaxId(value);
        },
        defaultMessage(): string {
          return 'CPF ou CNPJ inválido — confira os números digitados';
        },
      },
    });
  };
}

/**
 * CEP brasileiro: 8 dígitos, com ou sem hífen. Não checa se o CEP existe —
 * só impede o campo de sair daqui com tamanho errado para o provedor.
 */
export function IsCep(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCep',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && normalizeTaxId(value).length === 8;
        },
        defaultMessage(): string {
          return 'CEP inválido — informe os 8 dígitos';
        },
      },
    });
  };
}

/**
 * Telefone fixo (10 dígitos) ou celular (11) com DDD. Aceita máscara.
 */
export function IsTelefoneBr(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isTelefoneBr',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          const d = normalizeTaxId(value);
          return d.length === 10 || d.length === 11;
        },
        defaultMessage(): string {
          return 'Telefone inválido — informe DDD + número';
        },
      },
    });
  };
}
