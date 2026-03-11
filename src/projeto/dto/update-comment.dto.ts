import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateCommentDto {
  @IsString()
  @MinLength(1, { message: 'Comentário não pode ser vazio' })
  @MaxLength(5000)
  content: string;
}
