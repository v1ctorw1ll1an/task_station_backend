import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * Sanidade do boot: a aplicação inteira sobe e responde. Nasceu como o teste de
 * scaffold do Nest (esperando um `AppController` com "Hello World!" que nunca
 * existiu neste projeto) e falhava desde sempre — agora aponta para o `/health`,
 * que é a rota pública de verdade.
 */
describe('Boot da aplicação (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('responde no /health sem autenticação', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toHaveProperty('status');
  });
});
