import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateColunaDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(7)
  color?: string;
}
