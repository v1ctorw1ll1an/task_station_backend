import { IsOptional, IsUUID } from 'class-validator';

export class DeleteColunaDto {
  @IsOptional()
  @IsUUID('4', { message: 'ID da coluna de destino inválido' })
  targetColumnId?: string;
}
