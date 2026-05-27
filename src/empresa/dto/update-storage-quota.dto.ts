import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class UpdateStorageQuotaDto {
  @ApiProperty({
    description: 'Cota de armazenamento em bytes (1 GiB = 1073741824)',
    example: 10737418240,
    minimum: 0,
    maximum: 1_099_511_627_776, // 1 TiB
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt()
  @Min(0)
  @Max(1_099_511_627_776)
  storageQuotaBytes: number;
}
