import { Module } from '@nestjs/common';
import { CepService } from './cep.service';

/**
 * Consulta de CEP. Módulo próprio (e não uma função solta em `common/`) porque o
 * serviço tem estado — o cache — e depende do logger injetado.
 */
@Module({
  providers: [CepService],
  exports: [CepService],
})
export class CepModule {}
