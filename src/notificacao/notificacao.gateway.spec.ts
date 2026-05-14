import { NotificacaoGateway } from './notificacao.gateway';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeMetrics() {
  return { wsConnect: jest.fn(), wsDisconnect: jest.fn(), recordHttp: jest.fn() };
}

function makeGateway() {
  const logger = makeLogger();
  const metrics = makeMetrics();
  const gateway = new NotificacaoGateway(logger as any, metrics as any);
  const emit = jest.fn();
  (gateway as any).server = {
    to: jest.fn().mockReturnValue({ emit }),
  };
  return { gateway, logger, metrics, emit };
}

function makeSocket(user?: { id: string }) {
  return {
    id: 'sock-1',
    data: user ? { user } : {},
    join: jest.fn(),
    emit: jest.fn(),
  } as any;
}

// ── handleConnection / handleDisconnect ───────────────────────────────────────

describe('NotificacaoGateway.handleConnection', () => {
  it('apenas loga em debug', () => {
    const { gateway, logger } = makeGateway();
    gateway.handleConnection(makeSocket());
    expect(logger.debug).toHaveBeenCalledWith(
      { socketId: 'sock-1' },
      expect.stringContaining('conectado'),
    );
  });
});

describe('NotificacaoGateway.handleDisconnect', () => {
  it('apenas loga em debug', () => {
    const { gateway, logger } = makeGateway();
    gateway.handleDisconnect(makeSocket());
    expect(logger.debug).toHaveBeenCalledWith(
      { socketId: 'sock-1' },
      expect.stringContaining('desconectado'),
    );
  });
});

// ── handleSubscribe ────────────────────────────────────────────────────────────

describe('NotificacaoGateway.handleSubscribe', () => {
  it('coloca socket na sala user:<id> e emite ack', () => {
    const { gateway } = makeGateway();
    const client = makeSocket({ id: 'u-1' });

    gateway.handleSubscribe(client);

    expect(client.join).toHaveBeenCalledWith('user:u-1');
    expect(client.emit).toHaveBeenCalledWith('subscribedNotifications', { ok: true });
  });
});

// ── emitToUser ─────────────────────────────────────────────────────────────────

describe('NotificacaoGateway.emitToUser', () => {
  it('emite para sala user:<userId>', () => {
    const { gateway, emit } = makeGateway();
    gateway.emitToUser('u-1', 'notification:new', { id: 'n-1' });
    expect((gateway as any).server.to).toHaveBeenCalledWith('user:u-1');
    expect(emit).toHaveBeenCalledWith('notification:new', { id: 'n-1' });
  });
});
