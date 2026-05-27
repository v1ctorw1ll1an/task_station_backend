import {
  IsBoolean,
  IsHexColor,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateColunaDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === null ? null : value))
  @ValidateIf((o: UpdateColunaDto) => o.color !== null)
  @IsHexColor()
  color?: string | null;

  @IsOptional()
  @IsBoolean()
  isDone?: boolean;
}
