import { IsArray, IsUUID } from 'class-validator';

export class ReorderColunasDto {
  @IsArray()
  @IsUUID('4', { each: true, message: 'Cada item deve ser um UUID válido' })
  columnIds: string[];
}
