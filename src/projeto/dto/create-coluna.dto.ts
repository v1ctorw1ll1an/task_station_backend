import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateColunaDto {
  @IsString()
  @MinLength(1, { message: 'Nome é obrigatório' })
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  color?: string;

  @IsOptional()
  @IsBoolean()
  isDone?: boolean;
}
