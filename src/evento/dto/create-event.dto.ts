import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ReminderMethod, EventVisibility } from '../../generated/prisma/client';

export class ReminderInputDto {
  @IsInt()
  @Min(0)
  @Max(40320) // até 4 semanas em minutos
  minutesBefore: number;

  @IsOptional()
  @IsEnum(ReminderMethod)
  method?: ReminderMethod;
}

export class CreateEventDto {
  @IsString()
  @MinLength(1, { message: 'Título é obrigatório' })
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsBoolean()
  allDay: boolean;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  // Aceita RRULE padrão (FREQ=...) ou formato custom RDATES= (datas personalizadas)
  @IsOptional()
  @IsString()
  @Matches(/^(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)|RDATES=)/, {
    message: 'RRULE deve começar com FREQ=DAILY|WEEKLY|MONTHLY|YEARLY ou RDATES=',
  })
  rrule?: string;

  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  attendeeUserIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true, message: 'Email inválido' })
  guestEmails?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ReminderInputDto)
  reminders?: ReminderInputDto[];

  @IsOptional()
  @IsUUID('4')
  companyId?: string;

  @IsOptional()
  @IsUUID('4')
  workspaceId?: string;

  @IsOptional()
  @IsUUID('4')
  taskId?: string;
}
