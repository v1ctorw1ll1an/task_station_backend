import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { UploadService } from './upload.service';

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('image')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } }),
  )
  @ApiOperation({ summary: 'Upload de imagem para comunicado — retorna URL' })
  @ApiResponse({ status: 201, description: '{ url: string }' })
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return this.uploadService.uploadImage(file);
  }

  @Get('image/:filename')
  @ApiOperation({ summary: 'Servir imagem de comunicado' })
  serveImage(@Param('filename') filename: string, @Res() res: Response) {
    this.uploadService.serveImage(filename, res);
  }
}
